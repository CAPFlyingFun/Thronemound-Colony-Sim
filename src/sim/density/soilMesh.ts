/**
 * THE SOIL, DRAWN IN CHUNKS — so a bite costs a bite.
 *
 * One mesh for the whole tray is the right thing right up until something
 * digs. 12.7 M cells meshed into 473 k triangles is fine once, at boot, and
 * ruinous sixty times a second: a queen taking a bite would rebuild every
 * triangle in the formicarium to change the few hundred around her jaws.
 *
 * So the tray is a grid of independent meshes. A carve reports the cells it
 * touched, and only the chunks overlapping them are rebuilt. The rest of the
 * tray is not re-examined, re-uploaded, or even looked at.
 *
 * ## Why the chunks cannot crack
 *
 * `buildSurfaceNets` emits one quad per CELL, from that cell's own corner
 * samples, and a cell belongs to exactly one region. So the union of chunk
 * meshes is precisely the mesh the whole field would have produced — not an
 * approximation of it, the same triangles. That is a property of the mesher
 * rather than of this file, and it is the reason chunking is safe here and
 * would not be with a mesher that emitted per-vertex.
 *
 * ## Why the normals come from the FIELD and not from the triangles
 *
 * `computeVertexNormals` averages the faces a vertex belongs to — and a
 * vertex on a chunk boundary belongs, as far as that chunk knows, to only the
 * faces on its own side. The average is therefore wrong there, and wrong in a
 * way that draws a visible crease along every chunk edge: geometrically
 * seamless, and lit like a grid.
 *
 * The gradient has no such problem. It is a property of the field at a point,
 * so two chunks that meet compute the same normal for the same vertex without
 * having to know about each other. Six samples a vertex, and the seams cannot
 * exist. It is also what `DensityGround` already uses for gameplay, so the
 * shading and the physics finally agree by construction rather than by
 * coincidence.
 */

import * as THREE from 'three';
import type { DensityField } from '../../density/DensityField';
import { buildSurfaceNets, type CellRegion } from '../../density/SurfaceNets';

/**
 * Cells per chunk edge. MEASURED, over twelve bites at scattered positions,
 * because whether an edit straddles a boundary changes how many chunks it
 * dirties by four times and one sample says more about where the probe dug
 * than about the size:
 *
 *     chunk   chunks   live   boot ms   rebuild mean   worst
 *       16      3072    852      1685           17.0   105.1
 *       24       968    386      1628            9.3    15.7   <-- this
 *       32       384    203      1583           18.4    34.8
 *       48       144    101      1483           37.9    58.3
 *       64        48     32      1462           52.0   136.7
 *
 * The cost of a rebuild is chunks-touched times chunk-volume, so it should
 * fall all the way down — and it does not. At 16 the volume is tiny but a
 * bite dirties nine to twelve chunks, and the per-chunk cost (a mesher call,
 * three typed arrays, a geometry) starts to dominate: the WORST case is seven
 * times the mean and six times worse than at 24. A mean would have chosen it.
 *
 * 24 is the floor of that curve. The price is 386 drawn chunks against 203 at
 * 32 — one material, frustum-culled, and far short of where draw calls start
 * to matter on the target device. A hitch is felt and a draw call is not, so
 * the worst case is what this is tuned on.
 */
export const CHUNK_CELLS = 24;

/** Overridable for a measurement sweep. See `scripts/_chunks.mjs`. */
export let chunkCells = CHUNK_CELLS;

export function setChunkCells(n: number): void { chunkCells = n; }

/** What a caller must supply to colour a vertex. */
export type ColourAt = (
  x: number, y: number, z: number, into: [number, number, number],
) => void;

export class SoilMesh {
  readonly group = new THREE.Group();

  private readonly chunks: (THREE.Mesh | null)[] = [];

  private readonly nx: number;

  private readonly ny: number;

  private readonly nz: number;

  private readonly material: THREE.MeshStandardMaterial;

  /** Milliseconds spent in the last `rebuild`, and how many chunks it took. */
  lastRebuildMs = 0;

  lastRebuildChunks = 0;

  /** Split of the last rebuild: meshing against per-vertex attributes. */
  lastMeshMs = 0;

  lastAttrMs = 0;

  constructor(
    private readonly field: DensityField,
    private readonly colourAt: ColourAt,
  ) {
    this.nx = Math.ceil(field.cellsX / chunkCells);
    this.ny = Math.ceil(field.cellsY / chunkCells);
    this.nz = Math.ceil(field.cellsZ / chunkCells);
    this.chunks.length = this.nx * this.ny * this.nz;
    this.chunks.fill(null);
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      /*
       * A tunnel CEILING is a -Y surface, and `buildSurfaceNets` winds
       * negative-facing quads inward — measured, 31,752 of them on the block
       * scene, none correct. Backface culling would delete exactly the
       * surfaces a burrow is made of. Double-siding is the workaround; fixing
       * the winding is not a one-line flip and is not this file's job.
       */
      side: THREE.DoubleSide,
    });
    /*
     * THE CUTAWAY HIDES THE LID, NOT THE TRAY.
     *
     * A clipping plane was the first cut and it took too much: everything
     * above the line went, including the tank's own side walls, so the
     * strata went with them and the formicarium stopped looking like one.
     * Joshua: "as the ant digs, I lost all the layers from the surface
     * downward which was weird and why I suggested only the top surface
     * layer, not the walls and sides."
     *
     * What has to go is the UP-FACING soil between the camera and her — the
     * lid. A wall faces sideways and a tunnel ceiling faces down, and both
     * should stay: the walls are where the strata are legible and the
     * ceiling is what makes a burrow a burrow rather than a groove.
     *
     * So the test is on the NORMAL as well as the height, which a clipping
     * plane cannot express. Discarding in the fragment shader can, and it
     * leaves the geometry completely untouched — the mesh stays authoritative
     * and the cutaway is purely a way of drawing it, which is the property
     * worth keeping.
     */
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.tmCutY = this.cutY;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTmWorld;\nvarying vec3 vTmNormal;')
        .replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vTmWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vTmNormal = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float tmCutY;\nvarying vec3 vTmWorld;\nvarying vec3 vTmNormal;')
        .replace('#include <clipping_planes_fragment>',
          /* Up-facing, and above the cut. 0.4 is about 66 degrees off
           * vertical — steep enough that a tunnel wall survives, shallow
           * enough that a rolling surface is taken whole. */
          '  if (vTmWorld.y > tmCutY && vTmNormal.y > 0.4) discard;\n#include <clipping_planes_fragment>');
    };
  }

  /**
   * CUT THE SOIL AWAY ABOVE A HEIGHT — the formicarium's own view.
   *
   * Following an ant underground put the camera INSIDE the soil, and because
   * the material is double-sided (the mesher winds its negative-facing quads
   * backwards, so culling would delete every tunnel ceiling) you then see
   * straight through the soil to the far inside of the tray. It reads as a
   * lit room with strata for walls, and her tunnels read as solid white
   * tubes — you are looking at their outside from within the ground. Joshua
   * reported it as "walking into the open space in un-digged dirt", which is
   * exactly what it looks like and nothing like what is happening.
   *
   * Pulling the camera out to open air would frame her from above through
   * however much soil is in the way. A cutaway is what a real formicarium
   * does and what card 07 asks for: take the lid off at her level and look
   * down into the nest. It also fixes the burial for free, since everything
   * between her and a camera above her is what gets removed.
   *
   * `null` restores the whole tray.
   */
  setCut(y: number | null): void {
    /* A height nothing can be above switches it off without branching in the
     * shader — the uniform is always there, the test simply never passes. */
    this.cutY.value = y ?? 1e9;
    this.cutOn = y !== null;
  }

  private readonly cutY = { value: 1e9 };

  private cutOn = false;

  /** Where the soil is currently cut, or null for a whole tray. */
  cutForTest(): number | null {
    return this.cutOn ? this.cutY.value : null;
  }


  /** Mesh the lot. Called once; after that only `rebuild` runs. */
  buildAll(): void {
    for (let z = 0; z < this.nz; z += 1) {
      for (let y = 0; y < this.ny; y += 1) {
        for (let x = 0; x < this.nx; x += 1) this.meshChunk(x, y, z);
      }
    }
  }

  /** Total triangles currently drawn, across every chunk. */
  triangles(): number {
    let n = 0;
    for (const chunk of this.chunks) n += (chunk?.geometry.index?.count ?? 0) / 3;
    return n;
  }

  /** How many chunks hold geometry — the rest are absent, not empty. */
  liveChunks(): number {
    return this.chunks.reduce((n, c) => n + (c ? 1 : 0), 0);
  }

  chunkCount(): number { return this.chunks.length; }

  /**
   * Redraw every chunk the edited cells touch, and nothing else.
   *
   * The region has already been grown by a cell where it was produced; this
   * converts it to chunk indices, which is a second widening because a region
   * covering one cell at a chunk's edge still lands in one chunk only.
   */
  rebuild(region: CellRegion): void {
    const t0 = performance.now();
    this.lastMeshMs = 0;
    this.lastAttrMs = 0;
    const cx0 = Math.max(0, Math.floor(region.x0 / chunkCells));
    const cy0 = Math.max(0, Math.floor(region.y0 / chunkCells));
    const cz0 = Math.max(0, Math.floor(region.z0 / chunkCells));
    const cx1 = Math.min(this.nx - 1, Math.floor(region.x1 / chunkCells));
    const cy1 = Math.min(this.ny - 1, Math.floor(region.y1 / chunkCells));
    const cz1 = Math.min(this.nz - 1, Math.floor(region.z1 / chunkCells));
    let n = 0;
    for (let z = cz0; z <= cz1; z += 1) {
      for (let y = cy0; y <= cy1; y += 1) {
        for (let x = cx0; x <= cx1; x += 1) { this.meshChunk(x, y, z); n += 1; }
      }
    }
    this.lastRebuildChunks = n;
    this.lastRebuildMs = performance.now() - t0;
  }

  private index(x: number, y: number, z: number): number {
    return (z * this.ny + y) * this.nx + x;
  }

  private meshChunk(cx: number, cy: number, cz: number): void {
    const at = this.index(cx, cy, cz);
    const old = this.chunks[at];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.chunks[at] = null;
    }
    const region: CellRegion = {
      x0: cx * chunkCells, y0: cy * chunkCells, z0: cz * chunkCells,
      x1: Math.min((cx + 1) * chunkCells, this.field.cellsX),
      y1: Math.min((cy + 1) * chunkCells, this.field.cellsY),
      z1: Math.min((cz + 1) * chunkCells, this.field.cellsZ),
    };
    const tMesh = performance.now();
    const data = buildSurfaceNets(this.field, 0, region);
    this.lastMeshMs += performance.now() - tMesh;
    if (data.indices.length === 0) return;
    const tAttr = performance.now();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

    const pos = data.positions;
    const normals = new Float32Array(pos.length);
    const colours = new Float32Array(pos.length);
    const band: [number, number, number] = [0, 0, 0];
    /* One cell for the gradient: small enough to follow the surface, large
     * enough not to be reading arithmetic noise between two samples. */
    const h = this.field.cellSize;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!; const y = pos[i + 1]!; const z = pos[i + 2]!;
      const dx = this.field.sample(x + h, y, z) - this.field.sample(x - h, y, z);
      const dy = this.field.sample(x, y + h, z) - this.field.sample(x, y - h, z);
      const dz = this.field.sample(x, y, z + h) - this.field.sample(x, y, z - h);
      /* The field grows INTO the soil, so out of it is the negative gradient. */
      let nx = -dx; let ny = -dy; let nz = -dz;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) { nx = 0; ny = 1; nz = 0; } else { nx /= len; ny /= len; nz /= len; }
      normals[i] = nx; normals[i + 1] = ny; normals[i + 2] = nz;
      this.colourAt(x, y, z, band);
      colours[i] = band[0]; colours[i + 1] = band[1]; colours[i + 2] = band[2];
    }
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.lastAttrMs += performance.now() - tAttr;

    const mesh = new THREE.Mesh(geometry, this.material);
    this.chunks[at] = mesh;
    this.group.add(mesh);
  }

  dispose(): void {
    for (const chunk of this.chunks) chunk?.geometry.dispose();
    this.chunks.fill(null);
    this.material.dispose();
  }
}
