/**
 * Hex-grid test room — an experiment, reachable only at `?scene=hex`.
 *
 * The question it exists to answer: does soil made of hex prisms look better
 * than soil made of cubes, and does taking one cell read as picking up a clod?
 *
 * Deliberately NOT built on DigScene. The cube scene's raycasting, collision
 * and six-axis wall walking are all cube-specific — a hex prism has eight faces
 * and its six sides are not axis-aligned, so reusing any of it would mean
 * bending the parts that currently work. This is a free-fly room with its own
 * small controller: enough to judge the look and the grab, and nothing else.
 *
 * If the answer turns out to be yes, this is the sketch a real port starts
 * from. If it is no, deleting this file costs nothing.
 */

import * as THREE from 'three';
import { HEX_AIR, HEX_HEIGHT, HEX_RADIUS, HexWorld, hexAt, hexCentre, meshHexWorld } from '../voxel/HexGrid';
import { voxelTint } from '../voxel/mesher';

const ROOM_RADIUS = 9;
const ROOM_DEPTH = 10;
const SURFACE = 0;

/** Colours matched to the cube world's soil so the comparison is fair. */
const SOIL = [0x000000, 0x9c8460, 0xa8735c, 0xc7b487];

export class HexScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world = new HexWorld(ROOM_RADIUS, ROOM_DEPTH, SURFACE);

  private mesh: THREE.Mesh | null = null;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly highlight: THREE.LineLoop;
  private readonly hud: HTMLDivElement;

  private yaw = 0;
  private pitch = -0.5;
  private readonly orbit = { distance: 16 };
  private taken = 0;
  private disposed = false;
  private frame = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 400);
    this.scene.background = new THREE.Color(0xb9c7d4);
    this.scene.fog = new THREE.Fog(0xb9c7d4, 30, 90);

    this.scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x4a3a26, 1.5));
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.4);
    sun.position.set(20, 40, 15);
    this.scene.add(sun);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0, flatShading: true,
    });

    // Outline of the cell under the crosshair, drawn as the hex it actually is.
    const ring = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 7 }, (_, i) => {
        const a = (Math.PI / 180) * (60 * (i % 6) + 30);
        return new THREE.Vector3(HEX_RADIUS * Math.cos(a), 0, HEX_RADIUS * Math.sin(a));
      }),
    );
    // LineLoop, not EdgesGeometry — the ring is already an ordered outline, and
    // EdgesGeometry over an empty geometry throws before anything renders.
    this.highlight = new THREE.LineLoop(
      ring,
      new THREE.LineBasicMaterial({ color: 0xfff2a8, depthTest: false }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.hud = document.createElement('div');
    this.hud.className = 'dig-hud';
    host.appendChild(this.hud);

    this.rebuild();
    this.bindInput();
    this.resize();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));
    this.renderer.setAnimationLoop(this.tick);
  }

  private rebuild(): void {
    const data = meshHexWorld(this.world, (q, r, y) => voxelTint(q, y, r));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    // Vertex colour carries shading; the soil hue comes from the cell's layer.
    const rgb = new Float32Array(data.positions.length);
    for (let i = 0, v = 0; i < data.positions.length; i += 3, v++) {
      const y = data.positions[i + 1]!;
      const depth = SURFACE - Math.round(y / HEX_HEIGHT);
      const colour = new THREE.Color(SOIL[depth < 2 ? 1 : depth < 8 ? 2 : 3]!);
      const shade = data.colors[i]!;
      rgb[i] = colour.r * shade;
      rgb[i + 1] = colour.g * shade;
      rgb[i + 2] = colour.b * shade;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();

    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
    } else {
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.scene.add(this.mesh);
    }
    this.paintHud(data.faceCount);
  }

  private paintHud(faces: number): void {
    this.hud.innerHTML = `
      <div class="dig-readout" id="hex-readout">
        <b>Hex test room</b> &nbsp; <b>Taken</b> ${this.taken} &nbsp; <b>Faces</b> ${faces}<br>
        <span class="dim">v${__APP_VERSION__} · ${__BUILD_TIME__} · experiment · drag to orbit · pinch or scroll to zoom · tap a cell to take it</span>
      </div>
      <div class="dig-crosshair"></div>
    `;
  }

  /**
   * Which cell the pointer is over.
   *
   * Uses three's mesh raycast rather than a grid DDA: the cubic Amanatides &
   * Woo walk does not apply to hex prisms, and writing a hex traversal is only
   * worth it if this experiment wins. The hit point plus the face normal is
   * enough to name the cell it belongs to.
   */
  private pick(clientX: number, clientY: number) {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const caster = new THREE.Raycaster();
    caster.setFromCamera(ndc, this.camera);
    const hit = caster.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    // Step just inside the surface that was hit, then name that cell.
    const inward = hit.point.clone().addScaledVector(hit.face!.normal, -HEX_RADIUS * 0.35);
    const cell = hexAtSafe(inward);
    return this.world.get(cell.q, cell.r, cell.y) === HEX_AIR ? null : cell;
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement;
    let dragging = false;
    let travelled = 0;
    let last = { x: 0, y: 0 };

    const down = (e: PointerEvent) => {
      if (e.cancelable) e.preventDefault();
      dragging = true;
      travelled = 0;
      last = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      travelled += Math.hypot(dx, dy);
      last = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.005, -1.4, -0.05);
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      // A press that went nowhere is a tap: take that cell.
      if (travelled > 10) return;
      const cell = this.pick(e.clientX, e.clientY);
      if (!cell) return;
      if (this.world.dig(cell.q, cell.r, cell.y) !== HEX_AIR) {
        this.taken++;
        this.rebuild();
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.orbit.distance = THREE.MathUtils.clamp(this.orbit.distance + e.deltaY * 0.02, 4, 60);
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    this.cleanups.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
    });
  }

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (): void => {
    if (this.disposed) return;
    this.frame++;
    const d = this.orbit.distance;
    this.camera.position.set(
      Math.sin(this.yaw) * Math.cos(this.pitch) * d,
      -Math.sin(this.pitch) * d,
      Math.cos(this.yaw) * Math.cos(this.pitch) * d,
    );
    this.camera.lookAt(0, -ROOM_DEPTH / 3, 0);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    for (const fn of this.cleanups) fn();
    this.mesh?.geometry.dispose();
    this.material.dispose();
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.hud.remove();
    this.renderer.domElement.remove();
  }
}

/** Wrapper so a stray NaN from a grazing hit cannot poison the grid lookup. */
function hexAtSafe(point: THREE.Vector3) {
  const cell = hexAt(point.x, point.y, point.z);
  return {
    q: Number.isFinite(cell.q) ? cell.q : 0,
    r: Number.isFinite(cell.r) ? cell.r : 0,
    y: Number.isFinite(cell.y) ? cell.y : 0,
  };
}

/** Where a cell sits, for anything that wants to place something on one. */
export { hexCentre };
