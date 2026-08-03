/**
 * The MACRO surface: the landscape as a cheap smooth sheet, drawn everywhere
 * the fine window is not.
 *
 * Tiles of 256 mm at a 16 mm vertex pitch, built once from the same
 * `heightMmAt` the fine soil fills from — same function, so where the two
 * layers meet they agree to within mesh resolution and there is nothing to
 * stitch. The whole 4 m world is 256 tiles and ~75k vertices, which is small
 * enough that LOD rings are not yet worth their pop; the plan doc's question
 * 10 records the two-pitch upgrade path for bigger worlds.
 *
 * THE HAND-OFF, which is the whole trick: fragments inside the fine window's
 * rectangle are DISCARDED. Inside that rectangle the streamed density mesh is
 * the only surface — so a bite, a vent, a tunnel breaking through are simply
 * visible, because there is no macro blanket over them to cut holes in. The
 * rectangle is one vec4 uniform, updated when the window scrolls; the discard
 * is two comparisons in the fragment shader. No masks, no patches, no
 * geometry edits.
 */

import * as THREE from 'three';

import { MM, WORLD_MM, groundHeightAt } from './worldScape';

/** Macro streaming tile: deliberately DECOUPLED from the 32 mm soil tile. */
export const MACRO_TILE_MM = 256;

/** Vertex pitch. Sixteen millimetres reads smooth against ~1.5 m hills. */
const PITCH_MM = 16;

const TILES = WORLD_MM / MACRO_TILE_MM;
const SEGMENTS = MACRO_TILE_MM / PITCH_MM;

export class MacroSurface {
  readonly root = new THREE.Group();

  /** The fine window's rectangle, in world units. Fragments inside die. */
  private readonly clip = { value: new THREE.Vector4(0, 0, 0, 0) };

  private readonly material: THREE.MeshLambertMaterial;

  private readonly skirtMaterial: THREE.MeshLambertMaterial;

  readonly tileCount = TILES * TILES;

  readonly vertexCount: number;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ color: 0x8a6a45 });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uClip = this.clip;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n'
          + 'vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vWorldPos;\nuniform vec4 uClip;',
        )
        .replace(
          '#include <clipping_planes_fragment>',
          'if (vWorldPos.x > uClip.x && vWorldPos.x < uClip.z\n'
          + '  && vWorldPos.z > uClip.y && vWorldPos.z < uClip.w) discard;\n'
          + '#include <clipping_planes_fragment>',
        );
    };

    /*
     * The skirt shares the sheet's clip material but draws both faces: the
     * camera lives INSIDE the world, so it sees the curtain's inner side.
     * The clone shares `this.clip` through the copied onBeforeCompile, so
     * one setWindow moves both.
     */
    this.skirtMaterial = this.material.clone();
    this.skirtMaterial.side = THREE.DoubleSide;

    let vertices = 0;
    for (let tz = 0; tz < TILES; tz += 1) {
      for (let tx = 0; tx < TILES; tx += 1) {
        const mesh = this.buildTile(tx, tz);
        vertices += mesh.geometry.getAttribute('position').count;
        this.root.add(mesh);
      }
    }
    const skirt = this.buildSkirt();
    vertices += skirt.geometry.getAttribute('position').count;
    this.root.add(skirt);
    this.vertexCount = vertices;
  }

  /**
   * THE WORLD'S EDGE, CLOSED. A finite heightfield seen from a low camera
   * shows sky under its own silhouette: the far slopes of the last ridge are
   * back-face culled and nothing stands behind them, so slivers of sky open
   * along distant ridgelines. (Beyond Extinction hit the same thing.) The
   * cure is a curtain around the perimeter, from the ground line down to the
   * soil column's floor — same global grid indices as the tile edges, so the
   * top seam is bit-identical and crackless.
   */
  private buildSkirt(): THREE.Mesh {
    const step = PITCH_MM / MM;
    const count = WORLD_MM / PITCH_MM;
    const positions: number[] = [];
    const index: number[] = [];
    const edge = (gx0: number, gz0: number, dx: number, dz: number) => {
      const base = positions.length / 3;
      for (let s = 0; s <= count; s += 1) {
        const x = (gx0 + dx * s) * step;
        const z = (gz0 + dz * s) * step;
        positions.push(x, groundHeightAt(x, z), z, x, 0, z);
      }
      for (let s = 0; s < count; s += 1) {
        const a = base + s * 2;
        index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    };
    edge(0, 0, 1, 0);
    edge(0, count, 1, 0);
    edge(0, 0, 0, 1);
    edge(count, 0, 0, 1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.skirtMaterial);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /**
   * One tile: a displaced grid. Positions are WORLD-anchored (the mesh sits
   * at the origin) so the clip test needs no per-tile bookkeeping, and
   * heights come from the shared ground function — mound included, so the
   * anthill shows from across the map.
   *
   * Vertices are computed from GLOBAL grid indices, never from a per-tile
   * origin plus a local offset. `x0 + i * step` and the neighbour's
   * `x0' + 0 * step` are the same point in exact arithmetic and different
   * points in floats, and the difference rendered as hairline cracks of sky
   * along every tile seam — brightest on distant ridgelines, where a
   * fraction of a millimetre of gap is silhouetted against the sky. One
   * multiplication of an integer makes shared-edge vertices bit-identical.
   */
  private buildTile(tx: number, tz: number): THREE.Mesh {
    const step = PITCH_MM / MM;
    const side = SEGMENTS + 1;
    const positions = new Float32Array(side * side * 3);
    let at = 0;
    for (let j = 0; j < side; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = (tx * SEGMENTS + i) * step;
        const z = (tz * SEGMENTS + j) * step;
        positions[at] = x;
        positions[at + 1] = groundHeightAt(x, z);
        positions[at + 2] = z;
        at += 3;
      }
    }
    const index: number[] = [];
    for (let j = 0; j < SEGMENTS; j += 1) {
      for (let i = 0; i < SEGMENTS; i += 1) {
        const a = j * side + i;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Move the hand-off rectangle to the fine window's footprint. */
  setWindow(x0: number, z0: number, x1: number, z1: number): void {
    this.clip.value.set(x0, z0, x1, z1);
  }

  dispose(): void {
    for (const child of this.root.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
    }
    this.material.dispose();
    this.skirtMaterial.dispose();
    this.root.clear();
  }
}
