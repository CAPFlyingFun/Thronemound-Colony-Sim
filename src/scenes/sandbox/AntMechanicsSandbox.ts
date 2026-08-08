import * as THREE from 'three';

import { QueenModel } from '../../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../../anim/legDrive';
import {
  AIR, VOXEL_MM, VoxelWorld, isSolid, materialOf,
} from '../../voxel/VoxelWorld';
import {
  digAwareCornerHeight, groundHeight, isSurfaceCell,
  surfaceCornerHeight, surfaceFill, surfaceSlope,
  terrainGenerator, type TerrainOptions,
} from '../../voxel/terrain';
import { meshChunk } from '../../voxel/mesher';
import { raycastVoxel } from '../../voxel/raycast';
import { DigSession } from '../../voxel/DigSession';
import {
  createVoxelMaterial, type VoxelMaterialBundle,
} from '../../voxel/voxelMaterial';

/**
 * Ant mechanics sandbox — visual alignment + real digging pass.
 *
 * Preserves the working controls:
 *   W/S walk, A/D turn, arrows aim the head, Space starts/cancels digging.
 *
 * Presentation follows Joshy's current ?scene=sandbox scale/camera while the
 * terrain uses DigScene's smooth voxel-material path so it no longer looks
 * like a raw block/chunk debug world.
 */

const MODEL_SCALE = 5;
const WALK_SPEED_MM_S = 12;
const TURN_RATE = 2.4;
const RIDE_MM = 1.2;

const CAM_DIST_MM = 42;
const CAM_MIN_DIST_MM = 24;
const CAM_MAX_DIST_MM = 85;
const CAM_PITCH = 0.34;
const CAM_MIN_PITCH = -0.05;
const CAM_MAX_PITCH = 1.05;
const CAMERA_CHASE = 10;
const ORBIT_DRAG_YAW = 0.008;
const ORBIT_DRAG_PITCH = 0.006;

const WORLD_SIZE = 56;
const SURFACE_Y = 32;
const DIG_REACH_VOXELS = 2.2;

const TERRAIN: TerrainOptions = {
  surfaceY: SURFACE_Y,
  size: WORLD_SIZE,
  seed: 7,
};

const SKY_FALLBACK = 0xb9c7d4;
const SKY_URL = `${import.meta.env.BASE_URL}sky/puresky_2k.jpg`;

export class AntMechanicsSandbox {
  ready = false;

  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  private readonly worker = new QueenModel('worker');
  private workerReady = false;

  private readonly world = new VoxelWorld(
    WORLD_SIZE,
    WORLD_SIZE,
    WORLD_SIZE,
    terrainGenerator(TERRAIN),
  );

  private readonly session = new DigSession(this.world, {
    capacityVoxels: 1,
    fractionOf: (x, y, z) => this.cellSoilFraction(x, y, z),

    // Sandbox tuning: immediate-feeling digging for interaction testing.
    // The full DigScene can keep its longer progression curve.
    digStart: 1.25,
    digStep: 0.04,
    digFloor: 0.65,
  });

  private readonly terrainRoot = new THREE.Group();
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly materialBundle: VoxelMaterialBundle;
  private readonly material: THREE.MeshStandardMaterial;

  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private sky: THREE.Texture | null = null;
  private environment: THREE.Texture | null = null;

  private readonly keys = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly antPos = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly jawScratch = new THREE.Vector3();
  private readonly soilFractionCache = new Map<string, number>();

  private facing = 0;
  private headYaw = 0;
  private headPitch = 0;

  // Free third-person orbit. Zero means directly behind the ant.
  private orbitYaw = 0;
  private orbitPitch = CAM_PITCH;
  private orbitDistance = CAM_DIST_MM;
  private orbitPointer: number | null = null;
  private orbitLast = { x: 0, y: 0 };

  // Immediate visual feedback while DigSession is counting down.
  private readonly digPreviewMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6b35a,
    emissive: 0x5a2f08,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.38,
    wireframe: true,
    depthWrite: false,
  });
  private readonly digPreview = new THREE.Mesh(
    new THREE.BoxGeometry(VOXEL_MM * 0.92, VOXEL_MM * 0.92, VOXEL_MM * 0.92),
    this.digPreviewMaterial,
  );

  private disposed = false;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(SKY_FALLBACK);
    this.scene.fog = new THREE.Fog(SKY_FALLBACK, 120, 700);

    // Matches Joshy's current sandbox presentation.
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);

    // Same stand-in lighting family as DigScene.
    this.hemisphere = new THREE.HemisphereLight(0xd8e8ff, 0x4a3a26, 1.15);
    this.sun = new THREE.DirectionalLight(0xfff2d0, 1.5);
    this.sun.position.set(60, 120, 40);
    this.scene.add(this.hemisphere, this.sun);

    // Use DigScene's actual terrain material instead of a flat brown material.
    this.materialBundle = createVoxelMaterial();
    this.material = this.materialBundle.material;

    // meshChunk outputs voxel-space coordinates; sandbox/world presentation is mm.
    this.terrainRoot.scale.setScalar(VOXEL_MM);
    this.scene.add(this.terrainRoot);
    this.buildInitialMeshes();

    this.worker.root.scale.setScalar(MODEL_SCALE);
    this.scene.add(this.worker.root);

    this.digPreview.visible = false;
    this.digPreview.renderOrder = 4;
    this.scene.add(this.digPreview);

    const sx = Math.floor(WORLD_SIZE / 2);
    const sz = Math.floor(WORLD_SIZE / 2);
    const surfaceMm = groundHeight(sx, sz, TERRAIN) * VOXEL_MM;
    this.antPos.set(
      (sx + 0.5) * VOXEL_MM,
      surfaceMm + RIDE_MM,
      (sz + 0.5) * VOXEL_MM - 20,
    );

    void this.worker.load().then((ok) => {
      this.workerReady = ok;
    });

    this.loadSky();

    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.renderer.domElement.addEventListener('pointerdown', this.onOrbitDown);
    this.renderer.domElement.addEventListener('pointermove', this.onOrbitMove);
    this.renderer.domElement.addEventListener('pointerup', this.onOrbitUp);
    this.renderer.domElement.addEventListener('pointercancel', this.onOrbitUp);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });

    this.resize();
    this.ready = true;
    this.animate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);

    this.renderer.domElement.removeEventListener('pointerdown', this.onOrbitDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onOrbitMove);
    this.renderer.domElement.removeEventListener('pointerup', this.onOrbitUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.onOrbitUp);
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);

    for (const mesh of this.meshes.values()) {
      this.terrainRoot.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();

    this.materialBundle.dispose();
    this.sky?.dispose();
    this.environment?.dispose();

    this.scene.remove(this.digPreview);
    this.digPreview.geometry.dispose();
    this.digPreviewMaterial.dispose();

    this.worker.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loadSky(): void {
    new THREE.TextureLoader().load(
      SKY_URL,
      (texture) => {
        if (this.disposed) {
          texture.dispose();
          return;
        }

        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;

        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const environment = pmrem.fromEquirectangular(texture).texture;
        pmrem.dispose();

        this.sky = texture;
        this.environment = environment;
        this.scene.background = texture;
        this.scene.environment = environment;
        this.scene.environmentIntensity = 0.85;
        this.hemisphere.intensity = 0.35;
      },
      undefined,
      () => {
        // Cosmetic only: keep fallback sky if the texture is unavailable.
      },
    );
  }

  // ---------------------------------------------------------- smooth terrain

  private static cellKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private readonly soilFill = (x: number, y: number, z: number): number => (
    surfaceFill(x, y, z, TERRAIN)
  );

  private readonly soilSlope = (
    x: number,
    y: number,
    z: number,
  ): readonly [number, number, number] | null => (
    isSurfaceCell(x, y, z, TERRAIN) ? surfaceSlope(x, z, TERRAIN) : null
  );

  private readonly readVoxel = (x: number, y: number, z: number): number => (
    this.world.get(x, y, z)
  );

  private readonly soilCorner = (cx: number, cz: number): number => (
    this.world.excavated === 0
      ? surfaceCornerHeight(cx, cz, TERRAIN)
      : digAwareCornerHeight(this.readVoxel, cx, cz, TERRAIN)
  );

  private cellSoilFraction(x: number, y: number, z: number): number {
    if (!isSurfaceCell(x, y, z, TERRAIN)) return 1;

    const key = AntMechanicsSandbox.cellKey(x, y, z);
    const cached = this.soilFractionCache.get(key);
    if (cached !== undefined) return cached;

    const c00 = this.soilCorner(x, z) - y;
    const c10 = this.soilCorner(x + 1, z) - y;
    const c01 = this.soilCorner(x, z + 1) - y;
    const c11 = this.soilCorner(x + 1, z + 1) - y;

    let sum = 0;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const u = (i + 0.5) / 3;
        const v = (j + 0.5) / 3;
        const fill = (
          c00 * (1 - u) * (1 - v)
          + c10 * u * (1 - v)
          + c01 * (1 - u) * v
          + c11 * u * v
        );
        sum += Math.min(1, Math.max(0, fill));
      }
    }

    const fraction = Math.max(0.05, sum / 9);
    this.soilFractionCache.set(key, fraction);
    return fraction;
  }

  private meshSampler(): {
    get(x: number, y: number, z: number): number;
    fill(x: number, y: number, z: number): number;
    slope(x: number, y: number, z: number): readonly [number, number, number] | null;
    cornerHeight(cx: number, cz: number): number;
  } {
    return {
      get: (x, y, z) => this.world.get(x, y, z),
      fill: this.soilFill,
      slope: this.soilSlope,
      cornerHeight: this.soilCorner,
    };
  }

  private buildInitialMeshes(): void {
    for (const index of this.world.allMeshableChunks()) {
      this.rebuildChunk(index);
    }
    this.world.dirty.clear();
  }

  private rebuildChunk(index: number): void {
    const [cx, cy, cz] = this.world.chunkCoords(index);
    const data = meshChunk(this.meshSampler(), cx, cy, cz);
    const existing = this.meshes.get(index);

    if (!data) {
      if (existing) {
        this.terrainRoot.remove(existing);
        existing.geometry.dispose();
        this.meshes.delete(index);
      }
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('aTileUv', new THREE.BufferAttribute(data.uvs, 2));
    geometry.setAttribute('aLayer', new THREE.BufferAttribute(data.layers, 1));
    geometry.setAttribute('aTangent', new THREE.BufferAttribute(data.tangents, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();

    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = true;
    this.terrainRoot.add(mesh);
    this.meshes.set(index, mesh);
  }

  private drainDirty(): void {
    if (this.world.dirty.size === 0) return;
    for (const index of this.world.dirty) this.rebuildChunk(index);
    this.world.dirty.clear();
  }

  // --------------------------------------------------------------------- input

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const code = event.code.toLowerCase();

    if (
      code === 'space'
      || code.startsWith('arrow')
      || code === 'keyw'
      || code === 'keya'
      || code === 'keys'
      || code === 'keyd'
      || code === 'keyr'
    ) {
      event.preventDefault();
    }

    // Match DigScene's action behavior: press starts a locked dig; press again cancels.
    if (code === 'space' && !event.repeat) {
      if (this.session.digging) {
        this.session.cancelDig();
        this.digPreview.visible = false;
      } else {
        this.startReachableDig();
      }
    }

    // R returns to a familiar rear chase view after free orbiting.
    if (code === 'keyr' && !event.repeat) {
      this.orbitYaw = 0;
      this.orbitPitch = CAM_PITCH;
      this.orbitDistance = CAM_DIST_MM;
    }

    this.keys.add(code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code.toLowerCase());
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.session.cancelDig();
  };

  private readonly onOrbitDown = (event: PointerEvent): void => {
    // Mouse/touch drag orbits the camera. Ant movement remains ant-relative.
    if (this.orbitPointer !== null) return;

    this.orbitPointer = event.pointerId;
    this.orbitLast = { x: event.clientX, y: event.clientY };
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
  };

  private readonly onOrbitMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.orbitPointer) return;

    const dx = event.clientX - this.orbitLast.x;
    const dy = event.clientY - this.orbitLast.y;
    this.orbitLast = { x: event.clientX, y: event.clientY };

    this.orbitYaw -= dx * ORBIT_DRAG_YAW;
    this.orbitPitch = THREE.MathUtils.clamp(
      this.orbitPitch + dy * ORBIT_DRAG_PITCH,
      CAM_MIN_PITCH,
      CAM_MAX_PITCH,
    );
  };

  private readonly onOrbitUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.orbitPointer) return;

    this.renderer.domElement.releasePointerCapture?.(event.pointerId);
    this.orbitPointer = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();

    this.orbitDistance = THREE.MathUtils.clamp(
      this.orbitDistance + event.deltaY * 0.04,
      CAM_MIN_DIST_MM,
      CAM_MAX_DIST_MM,
    );
  };

  private readonly resize = (): void => {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  // ------------------------------------------------------------------- digging

  private jawPositionMm(into: THREE.Vector3): THREE.Vector3 {
    if (this.workerReady && this.worker.jawPosition(into)) return into;

    into.set(
      this.antPos.x + Math.sin(this.facing) * 3.4,
      this.antPos.y + 1,
      this.antPos.z + Math.cos(this.facing) * 3.4,
    );
    return into;
  }

  private startReachableDig(): void {
    const jaw = this.jawPositionMm(this.jawScratch);
    const dir = this.scratch.set(
      Math.sin(this.facing),
      -0.6,
      Math.cos(this.facing),
    ).normalize();

    const hit = raycastVoxel(
      this.world,
      jaw.x / VOXEL_MM,
      jaw.y / VOXEL_MM,
      jaw.z / VOXEL_MM,
      dir.x,
      dir.y,
      dir.z,
      DIG_REACH_VOXELS,
    );

    if (!hit) return;
    if (!isSolid(hit.voxel) || !materialOf(hit.voxel).diggable) return;

    const outcome = this.session.toggleDig(hit.x, hit.y, hit.z);

    if (outcome.kind === 'progress') {
      this.digPreview.position.set(
        (hit.x + 0.5) * VOXEL_MM,
        (hit.y + 0.5) * VOXEL_MM,
        (hit.z + 0.5) * VOXEL_MM,
      );
      this.digPreview.scale.setScalar(1);
      this.digPreviewMaterial.opacity = 0.38;
      this.digPreview.visible = true;
    }
  }

  private updateDig(dt: number): void {
    const working = this.session.digging;

    if (!working) {
      this.digPreview.visible = false;
      return;
    }

    // The target appears immediately, then visibly "works loose" while the
    // DigSession timer advances. The hole itself is still authoritative:
    // VoxelWorld changes only when the dig completes.
    const ratio = this.session.chewRatio;
    this.digPreview.visible = true;
    this.digPreview.rotation.y += dt * (0.8 + ratio * 2.5);
    this.digPreview.rotation.x = ratio * 0.18;
    this.digPreview.scale.setScalar(1 - ratio * 0.28);
    this.digPreviewMaterial.opacity = 0.30 + ratio * 0.42;

    const outcome = this.session.tickDig(dt);

    if (outcome.kind === 'progress') {
      const next = outcome.ratio;
      this.digPreview.scale.setScalar(1 - next * 0.28);
      this.digPreviewMaterial.opacity = 0.30 + next * 0.42;
      return;
    }

    if (outcome.kind === 'dug') {
      this.digPreview.visible = false;
      this.drainDirty();
      return;
    }

    if (
      outcome.kind === 'cancelled'
      || outcome.kind === 'none'
      || outcome.kind === 'full'
      || outcome.kind === 'bedrock'
    ) {
      this.digPreview.visible = false;
    }
  }

  // -------------------------------------------------------------- movement/gait

  private surfaceAtMm(xMm: number, zMm: number): number {
    const vx = xMm / VOXEL_MM;
    const vz = zMm / VOXEL_MM;

    if (vx < 0 || vz < 0 || vx >= WORLD_SIZE || vz >= WORLD_SIZE) return 0;

    if (this.world.excavated === 0) {
      return groundHeight(vx, vz, TERRAIN) * VOXEL_MM;
    }

    const x = Math.floor(vx);
    const z = Math.floor(vz);
    let y = Math.min(WORLD_SIZE - 1, Math.floor(this.antPos.y / VOXEL_MM) + 2);

    while (y >= 0 && this.world.get(x, y, z) === AIR) y -= 1;
    return (y + 1) * VOXEL_MM;
  }

  private poseWorker(dt: number, walk: number, turn: number): void {
    if (!this.workerReady) return;

    const digging = this.session.digging !== null;

    this.worker.root.position.copy(this.antPos);
    this.worker.root.position.y = this.antPos.y - RIDE_MM;
    this.worker.root.rotation.set(0, this.facing, 0);

    this.worker.update(dt, {
      speed: Math.abs(walk) > 0.05 ? WALK_SPEED_MM_S / MODEL_SCALE : 0,
      turn: turn * TURN_RATE,
      digging: digging ? 1 : 0,
      carrying: 0,
      headYaw: this.headYaw,
      headPitch: this.headPitch,
    });

    this.worker.solveFeet(
      (x, z) => this.surfaceAtMm(x, z),
      FOOT_CLEARANCE_MM,
      RIDE_MM * 2,
    );
  }

  private updateCamera(dt: number): void {
    // Orbit is relative to the ant's heading:
    //   0 = behind, ±PI/2 = either side, PI = looking back at her face.
    const viewYaw = this.facing + this.orbitYaw;
    const cp = Math.cos(this.orbitPitch);

    const desired = new THREE.Vector3(
      this.antPos.x - Math.sin(viewYaw) * this.orbitDistance * cp,
      this.antPos.y + Math.sin(this.orbitPitch) * this.orbitDistance,
      this.antPos.z - Math.cos(viewYaw) * this.orbitDistance * cp,
    );

    const cameraFloor = this.surfaceAtMm(desired.x, desired.z);
    desired.y = Math.max(desired.y, cameraFloor + 3);

    this.camera.position.lerp(desired, Math.min(1, dt * CAMERA_CHASE));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(
      this.antPos.x,
      this.antPos.y + 1.5,
      this.antPos.z,
    );
  }

  // ---------------------------------------------------------------- animation

  private animate = (): void => {
    if (this.disposed) return;

    const dt = Math.min(this.clock.getDelta(), 0.05);

    const walk =
      (this.keys.has('keyw') ? 1 : 0)
      - (this.keys.has('keys') ? 1 : 0);

    const turn =
      (this.keys.has('keya') ? 1 : 0)
      - (this.keys.has('keyd') ? 1 : 0);

    const headAimSpeed = 1.5;
    if (this.keys.has('arrowleft')) this.headYaw += headAimSpeed * dt;
    if (this.keys.has('arrowright')) this.headYaw -= headAimSpeed * dt;
    if (this.keys.has('arrowup')) this.headPitch += headAimSpeed * dt;
    if (this.keys.has('arrowdown')) this.headPitch -= headAimSpeed * dt;

    this.headYaw = THREE.MathUtils.clamp(
      this.headYaw,
      THREE.MathUtils.degToRad(-45),
      THREE.MathUtils.degToRad(45),
    );
    this.headPitch = THREE.MathUtils.clamp(
      this.headPitch,
      THREE.MathUtils.degToRad(-30),
      THREE.MathUtils.degToRad(30),
    );

    // The locked dig owns the worker while active; turning remains available.
    const canWalk = !this.session.digging;

    this.facing += turn * TURN_RATE * dt;

    if (canWalk && walk !== 0) {
      this.antPos.x += Math.sin(this.facing) * walk * WALK_SPEED_MM_S * dt;
      this.antPos.z += Math.cos(this.facing) * walk * WALK_SPEED_MM_S * dt;
    }

    const floor = this.surfaceAtMm(this.antPos.x, this.antPos.z) + RIDE_MM;
    this.antPos.y += (floor - this.antPos.y) * Math.min(1, dt * 12);

    this.updateDig(dt);
    this.poseWorker(dt, canWalk ? walk : 0, turn);
    this.updateCamera(dt);
    this.drainDirty();

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  };
}
