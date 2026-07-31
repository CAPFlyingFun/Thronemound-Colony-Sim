import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DensityField } from '../density/DensityField';
import { buildSurfaceNets } from '../density/SurfaceNets';
import './DensityTerrainLabScene.css';

const WORLD_UNIT_MM = 5;
const CELL_SIZE = 0.5;
const CELLS_X = 48;
const CELLS_Y = 32;
const CELLS_Z = 48;
const BRUSH_RADIUS = 1;
const MAX_PELLETS = 36;

interface Pellet {
  mesh: any;
  velocity: any;
  age: number;
}

/**
 * Isolated density-terrain experiment. It deliberately does not share the
 * production voxel mesher, so failures here cannot disturb the main map.
 */
export class DensityTerrainLabScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 250);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  private readonly controls: any;
  private readonly raycaster = new THREE.Raycaster();
  private readonly field = new DensityField({
    cellsX: CELLS_X,
    cellsY: CELLS_Y,
    cellsZ: CELLS_Z,
    cellSize: CELL_SIZE,
  });
  private readonly pellets: Pellet[] = [];
  private terrain: any = null;
  private animationFrame = 0;
  private previousTime = performance.now();
  private totalRemoved = 0;
  private lastMeshMs = 0;
  private readonly status: HTMLDivElement;
  private readonly digButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly host: HTMLElement) {
    host.replaceChildren();
    host.classList.add('density-lab-host');

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    const width = CELLS_X * CELL_SIZE;
    const depth = CELLS_Z * CELL_SIZE;
    this.camera.position.set(width * 0.52, 12.5, depth * 1.12);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(width * 0.5, 7.2, depth * 0.5);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 45;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

    this.scene.background = new THREE.Color(0x8db4d6);
    this.scene.fog = new THREE.Fog(0x8db4d6, 34, 70);
    this.addLighting();
    this.addReferenceFloor();

    const hud = document.createElement('div');
    hud.className = 'density-lab-hud';
    hud.innerHTML = `
      <div class="density-lab-title">DENSITY TERRAIN LAB <span>5 mm scoop</span></div>
      <div class="density-lab-status"></div>
      <div class="density-lab-crosshair" aria-hidden="true"></div>
      <div class="density-lab-hint">Drag to orbit · pinch or wheel to zoom · aim with the center ring</div>
      <div class="density-lab-actions"></div>
    `;
    host.appendChild(hud);

    const status = hud.querySelector<HTMLDivElement>('.density-lab-status');
    const actions = hud.querySelector<HTMLDivElement>('.density-lab-actions');
    if (!status || !actions) throw new Error('Density terrain lab HUD failed to initialize');
    this.status = status;

    this.digButton = document.createElement('button');
    this.digButton.className = 'density-lab-button density-lab-dig';
    this.digButton.textContent = 'DIG';
    this.digButton.setAttribute('aria-label', 'Carve a five millimetre radius scoop');
    actions.appendChild(this.digButton);

    this.resetButton = document.createElement('button');
    this.resetButton.className = 'density-lab-button density-lab-reset';
    this.resetButton.textContent = 'RESET';
    actions.appendChild(this.resetButton);

    this.digButton.addEventListener('pointerdown', this.onDigPointerDown);
    this.resetButton.addEventListener('click', this.resetTerrain);
    window.addEventListener('keydown', this.onKeyDown);

    this.resetField();
    this.rebuildTerrain();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.animate();
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.digButton.removeEventListener('pointerdown', this.onDigPointerDown);
    this.resetButton.removeEventListener('click', this.resetTerrain);
    window.removeEventListener('keydown', this.onKeyDown);
    this.terrain?.geometry.dispose();
    if (this.terrain?.material instanceof THREE.Material) this.terrain.material.dispose();
    for (const pellet of this.pellets) {
      pellet.mesh.geometry.dispose();
      if (pellet.mesh.material instanceof THREE.Material) pellet.mesh.material.dispose();
    }
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private readonly onDigPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.carveAtCrosshair();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      event.preventDefault();
      this.carveAtCrosshair();
    } else if (event.key.toLowerCase() === 'r') {
      this.resetTerrain();
    }
  };

  private addLighting(): void {
    const hemisphere = new THREE.HemisphereLight(0xc9e6ff, 0x4a2f1f, 1.65);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(0xfff1ce, 3.1);
    sun.position.set(18, 28, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    this.scene.add(sun);
  }

  private addReferenceFloor(): void {
    const width = CELLS_X * CELL_SIZE;
    const depth = CELLS_Z * CELL_SIZE;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 8, depth + 8),
      new THREE.MeshStandardMaterial({ color: 0x4f4032, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(width / 2, 0.18, depth / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private resetField(): void {
    const width = CELLS_X * CELL_SIZE;
    const height = CELLS_Y * CELL_SIZE;
    const depth = CELLS_Z * CELL_SIZE;
    const margin = CELL_SIZE * 1.5;

    this.field.fill((x, y, z) => {
      const nx = (x - width * 0.5) / (width * 0.5);
      const nz = (z - depth * 0.5) / (depth * 0.5);
      const radial = nx * nx + nz * nz;
      const rolling = 0.28 * Math.sin(x * 0.55) * Math.cos(z * 0.43);
      const summit = 6.4 + 4.5 * Math.exp(-radial * 2.45) + rolling;
      const top = summit - y;
      const bottom = y - margin;
      const left = x - margin;
      const right = width - margin - x;
      const front = z - margin;
      const back = depth - margin - z;
      const ceilingGuard = height - margin - y;
      return Math.min(top, bottom, left, right, front, back, ceilingGuard);
    });
  }

  private readonly resetTerrain = (): void => {
    this.resetField();
    this.totalRemoved = 0;
    for (const pellet of this.pellets) {
      this.scene.remove(pellet.mesh);
      pellet.mesh.geometry.dispose();
      if (pellet.mesh.material instanceof THREE.Material) pellet.mesh.material.dispose();
    }
    this.pellets.length = 0;
    this.rebuildTerrain();
  };

  private rebuildTerrain(): void {
    const started = performance.now();
    const data = buildSurfaceNets(this.field);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: 0x6f4931,
      roughness: 0.96,
      metalness: 0,
      flatShading: false,
      side: THREE.FrontSide,
    });
    const next = new THREE.Mesh(geometry, material);
    next.castShadow = true;
    next.receiveShadow = true;
    next.name = 'density-terrain';

    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
      if (this.terrain.material instanceof THREE.Material) this.terrain.material.dispose();
    }
    this.terrain = next;
    this.scene.add(next);
    this.lastMeshMs = performance.now() - started;
    this.updateStatus();
  }

  private carveAtCrosshair(): void {
    if (!this.terrain) return;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (!hit) {
      this.status.dataset.message = 'Aim the ring at soil';
      this.updateStatus();
      return;
    }

    const inward = this.raycaster.ray.direction.clone().normalize();
    const center = hit.point.clone().addScaledVector(inward, BRUSH_RADIUS * 0.58);
    const result = this.field.subtractSphere(center, BRUSH_RADIUS);
    if (result.changedSamples === 0 || result.removedVolume <= 0.0001) {
      this.status.dataset.message = 'No packed soil in that scoop';
      this.updateStatus();
      return;
    }

    this.totalRemoved += result.removedVolume;
    this.rebuildTerrain();
    this.spawnPellet(hit.point, hit.face?.normal ?? new THREE.Vector3(0, 1, 0), result.removedVolume);
    this.status.dataset.message = `${result.removedVolume.toFixed(2)} voxel³ pellet freed`;
    this.updateStatus();
  }

  private spawnPellet(point: any, localNormal: any, volume: number): void {
    if (this.pellets.length >= MAX_PELLETS) {
      const oldest = this.pellets.shift();
      if (oldest) {
        this.scene.remove(oldest.mesh);
        oldest.mesh.geometry.dispose();
        if (oldest.mesh.material instanceof THREE.Material) oldest.mesh.material.dispose();
      }
    }

    const sphereEquivalent = Math.cbrt((3 * volume) / (4 * Math.PI));
    const radius = THREE.MathUtils.clamp(sphereEquivalent, 0.18, 0.92);
    const geometry = new THREE.CylinderGeometry(radius, radius * 0.92, radius * 1.45, 8, 1, false);
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: 0x81583a,
      roughness: 1,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    const normal = localNormal.clone().transformDirection(this.terrain?.matrixWorld ?? new THREE.Matrix4());
    mesh.position.copy(point).addScaledVector(normal, radius * 1.8);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.volume = volume;
    this.scene.add(mesh);

    this.pellets.push({
      mesh,
      velocity: normal.multiplyScalar(1.4).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.8,
        1.3 + Math.random() * 0.7,
        (Math.random() - 0.5) * 0.8,
      )),
      age: 0,
    });
  }

  private updatePellets(delta: number): void {
    for (const pellet of this.pellets) {
      pellet.age += delta;
      pellet.velocity.y -= 9.5 * delta;
      pellet.mesh.position.addScaledVector(pellet.velocity, delta);
      pellet.mesh.rotation.x += delta * 1.7;
      pellet.mesh.rotation.z += delta * 1.2;
      const radius = (pellet.mesh.geometry.boundingSphere?.radius ?? 0.35) * 0.55;
      const floorY = 0.2 + radius;
      if (pellet.mesh.position.y < floorY) {
        pellet.mesh.position.y = floorY;
        if (Math.abs(pellet.velocity.y) > 0.22) pellet.velocity.y *= -0.28;
        else pellet.velocity.y = 0;
        pellet.velocity.x *= 0.82;
        pellet.velocity.z *= 0.82;
      }
    }
  }

  private updateStatus(): void {
    const message = this.status.dataset.message ?? 'Aim at the mound and press DIG';
    const physicalVolumeMm3 = this.totalRemoved * WORLD_UNIT_MM ** 3;
    this.status.innerHTML = `
      <b>${message}</b><br>
      Removed: ${this.totalRemoved.toFixed(1)} voxel³ · ${physicalVolumeMm3.toFixed(0)} mm³<br>
      Mesh: ${this.lastMeshMs.toFixed(1)} ms · ${CELLS_X}×${CELLS_Y}×${CELLS_Z} cells
    `;
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    /*
     * Let three.js set the canvas CSS size as well as its buffer.
     *
     * The third argument is `updateStyle`, and passing false was why digging
     * landed at the bottom right instead of under the crosshair. With no CSS
     * size a canvas displays at its ATTRIBUTE size in CSS pixels, and the
     * attributes are the buffer — width x devicePixelRatio. On a phone at
     * ratio 2 that is a canvas twice the viewport, pinned to the host's top
     * left and clipped by its `overflow: hidden`, so only the top-left quarter
     * of the render is on screen. The dig ray is NDC (0,0), dead centre of the
     * frustum and correct throughout; it was the picture that was off, by
     * exactly half a viewport down and right.
     *
     * Measured before the fix, on a 430x932 host: offset (-1,-1) at ratio 1,
     * (+214,+465) at ratio 2. Which is also the reason it survived a headless
     * check — a phone-sized viewport at ratio 1 is not a phone.
     */
    this.renderer.setSize(width, height);
  }

  private animate = (): void => {
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.previousTime) / 1000);
    this.previousTime = now;
    this.controls.update();
    this.updatePellets(delta);
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
