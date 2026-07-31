import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildSurfaceNets } from '../density/SurfaceNets';
import {
  BITE_DEPTH, BITE_DEPTH_MM, BITE_WIDTH_MM, BRUSH_RADIUS, CELLS_X, CELLS_Y, CELLS_Z,
  CELL_SIZE, CHUNK_CELLS, PELLET_SOLIDITY, WORLD_UNIT_MM, clodJitter, makeMoundField,
} from '../density/labMound';
import './DensityTerrainLabScene.css';

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
  private readonly field = makeMoundField();
  private readonly pellets: Pellet[] = [];
  /**
   * One mesh per chunk of cells, keyed by chunk coordinate.
   *
   * There used to be a single mesh for the whole field, rebuilt from scratch
   * on every bite — which made the cost of digging track the size of the map
   * and is the reason the mound had to be a pea. Only chunks whose cells the
   * brush actually touched are rebuilt now, so a tap costs the same whatever
   * the world is. Chunks with no surface in them hold no mesh at all, so a
   * solid interior and open sky are both free.
   */
  private readonly chunks = new Map<string, any>();
  private readonly terrainMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f4931, roughness: 0.96, metalness: 0, flatShading: false, side: THREE.FrontSide,
  });
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
    /*
     * Framing in fractions of the world, not in absolute units. The mound is
     * a twentieth of the size it was, and every one of these was a constant
     * tuned against the old one — a camera 12.5 units up would now be eight
     * mound-heights away, looking at a speck.
     */
    this.camera.position.set(width * 0.52, width * 0.52, depth * 1.12);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(width * 0.5, width * 0.3, depth * 0.5);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = width * 0.09;
    this.controls.maxDistance = width * 1.9;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

    this.scene.background = new THREE.Color(0x8db4d6);
    this.scene.fog = new THREE.Fog(0x8db4d6, width * 1.4, width * 2.9);
    this.addLighting();
    this.addReferenceFloor();

    const hud = document.createElement('div');
    hud.className = 'density-lab-hud';
    hud.innerHTML = `
      <div class="density-lab-title">DENSITY TERRAIN LAB <span>${BITE_WIDTH_MM} mm bite \u00b7 ${BITE_DEPTH_MM} mm deep</span></div>
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
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.terrainMaterial.dispose();
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
      new THREE.PlaneGeometry(width * 1.34, depth * 1.34),
      new THREE.MeshStandardMaterial({ color: 0x4f4032, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(width / 2, width * 0.0075, depth / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  /**
   * Back to a pristine mound.
   *
   * Copies the shared field rather than rebuilding a second definition of the
   * world here — the scene and the watertightness test both read `labMound`,
   * and a scene that grew its own copy is how the test came to be proving
   * things about a mound that had been rescaled out from under it.
   */
  private resetField(): void {
    this.field.values.set(makeMoundField().values);
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

  /** Rebuild every chunk. Startup and RESET only — a bite uses the region. */
  private rebuildTerrain(): void {
    const started = performance.now();
    for (let cz = 0; cz < CELLS_Z; cz += CHUNK_CELLS)
      for (let cy = 0; cy < CELLS_Y; cy += CHUNK_CELLS)
        for (let cx = 0; cx < CELLS_X; cx += CHUNK_CELLS) this.rebuildChunk(cx, cy, cz);
    this.lastMeshMs = performance.now() - started;
    this.updateStatus();
  }

  /**
   * Rebuild only the chunks a brush actually touched.
   *
   * `bounds` arrives in SAMPLE indices and a sample is a cell corner, so a
   * changed sample at index i is shared by cells i-1 and i — hence the extra
   * cell of slack on the low side. Miss it and the chunk holding the far half
   * of the bite keeps its old surface, which reads as the dig only working on
   * one side of the crosshair.
   */
  private rebuildAround(bounds: {
    minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  }): void {
    const started = performance.now();
    const lo = (v: number) => Math.floor(Math.max(0, v - 1) / CHUNK_CELLS) * CHUNK_CELLS;
    const hi = (v: number, cells: number) => Math.min(cells - 1, v);
    for (let cz = lo(bounds.minZ); cz <= hi(bounds.maxZ, CELLS_Z); cz += CHUNK_CELLS)
      for (let cy = lo(bounds.minY); cy <= hi(bounds.maxY, CELLS_Y); cy += CHUNK_CELLS)
        for (let cx = lo(bounds.minX); cx <= hi(bounds.maxX, CELLS_X); cx += CHUNK_CELLS)
          this.rebuildChunk(cx, cy, cz);
    this.lastMeshMs = performance.now() - started;
    this.updateStatus();
  }

  private rebuildChunk(cx: number, cy: number, cz: number): void {
    const key = `${cx},${cy},${cz}`;
    const data = buildSurfaceNets(this.field, 0, {
      x0: cx, y0: cy, z0: cz,
      x1: cx + CHUNK_CELLS, y1: cy + CHUNK_CELLS, z1: cz + CHUNK_CELLS,
    });
    const existing = this.chunks.get(key);
    // No surface in this chunk: solid soil or open sky, and neither is drawn.
    if (data.indices.length === 0) {
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        this.chunks.delete(key);
      }
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }
    const mesh = new THREE.Mesh(geometry, this.terrainMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `density-chunk-${key}`;
    this.scene.add(mesh);
    this.chunks.set(key, mesh);
  }

  private carveAtCrosshair(): void {
    if (this.chunks.size === 0) return;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = this.raycaster.intersectObjects([...this.chunks.values()], false)[0];
    if (!hit) {
      this.status.dataset.message = 'Aim the ring at soil';
      this.updateStatus();
      return;
    }

    const inward = this.raycaster.ray.direction.clone().normalize();
    /*
     * The brush RIDES the surface and only dips in by BITE_DEPTH.
     *
     * Sinking the centre below the hit, as this did, buries most of the
     * sphere and the crater ends up as deep as the centre plus the whole
     * radius — 7.9 mm for what was advertised as a 5 mm scoop. A mandible
     * does not do that; it scrapes. Putting the centre (radius - depth)
     * ABOVE the surface leaves exactly a cap of height BITE_DEPTH below it,
     * which is the bite, and the offset is negative because `inward` points
     * into the soil.
     */
    const center = hit.point.clone()
      .addScaledVector(inward, BITE_DEPTH - BRUSH_RADIUS);
    const result = this.field.subtractSphere(center, BRUSH_RADIUS);
    if (result.changedSamples === 0 || result.removedVolume <= 0.0001) {
      this.status.dataset.message = 'No packed soil in that scoop';
      this.updateStatus();
      return;
    }

    this.totalRemoved += result.removedVolume;
    this.rebuildAround(result.bounds);
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

    /*
     * Sized so the pellet HOLDS the soil that was removed — by the volume of
     * the octagonal frustum it is actually drawn as, not by a sphere it is
     * not. One number travels: brush geometry decides removed volume, removed
     * volume decides pellet size, and nothing else gets a vote.
     *
     * The clamps are safety rails against a degenerate scoop, an order of
     * magnitude either side of a real bite. They used to sit at 0.18 and 0.92
     * world units, which at this scale is 0.9 mm to 4.6 mm — a floor ABOVE
     * every legitimate pellet, so every clod would have come out the same
     * size and carried soil that never existed.
     */
    const radius = THREE.MathUtils.clamp(
      Math.cbrt(volume / PELLET_SOLIDITY), 0.004, 0.4,
    );
    /*
     * A knobbly lump, not a drum.
     *
     * This was `CylinderGeometry(r, 0.92r, 1.45r, 8)` — an octagonal tube,
     * and it read as exactly that. An icosahedron at detail 0 is twenty flat
     * triangles, which under flat shading is already closer to a chip of
     * earth than anything round; roughening each vertex breaks the symmetry
     * so no two clods are the same lump.
     *
     * Detail 0 on purpose. A pellet is about a millimetre across and will
     * usually be a few pixels, so subdividing it buys nothing but triangles,
     * and the facets are the whole point.
     */
    const geometry = new THREE.IcosahedronGeometry(radius, 0);
    const pos = geometry.getAttribute('position');
    const seed = this.pellets.length + volume * 1e4;
    for (let i = 0; i < pos.count; i++) {
      const k = clodJitter(seed, i);
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.86, pos.getZ(i) * k);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: 0x81583a,
      roughness: 1,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Chunk meshes sit at the origin unrotated, so the face normal is already
    // in world space; the identity keeps the call honest if that ever changes.
    const normal = localNormal.clone().transformDirection(new THREE.Matrix4());
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
