/**
 * One material for the entire world.
 *
 * Every chunk shares this instance, so the whole voxel volume stays a handful
 * of draw calls no matter how many soil types are on screen. Material choice
 * travels per-vertex as a texture-array LAYER rather than as a separate
 * material or a UV offset into an atlas — an atlas would bleed neighbouring
 * cells into each other once mipmaps kick in at distance, which is exactly the
 * artefact you cannot fix later without re-authoring the art.
 *
 * Texturing is TRIPLANAR, in object space. The old path gave every face UVs
 * from its own plane, which was correct while every face was a whole cube's:
 * once the surface conforms to the height field its side walls span several
 * voxels of height with UVs derived from (x, z), and the texture smeared down
 * them in streaks. Projecting from all three axes and blending by the normal
 * gives walls, treads and everything between the same 4 cm grain with no
 * seams and no stretching, whatever shape the mesher cuts. Object space
 * rather than world space because mesh positions ARE global voxel
 * coordinates, so projection is continuous across chunk boundaries by
 * construction.
 *
 * MeshStandardMaterial is patched rather than replaced so three.js keeps
 * providing lighting, fog and tone mapping. The patch deliberately uses its
 * OWN varyings instead of three's built-in `vMapUv`/tangent plumbing, because
 * those names move between three versions and this way an upgrade can't
 * silently break the ground.
 */

import * as THREE from 'three';
import { TILE_VOXELS, buildTileArrays, type TileArrays } from './tileTextures';
import { loadPhotoTileArrays } from './tilePhotos';

export interface VoxelMaterialBundle {
  material: THREE.MeshStandardMaterial;
  textures: THREE.DataArrayTexture[];
  dispose(): void;
}

function makeArrayTexture(
  data: Uint8Array<ArrayBuffer>,
  size: number,
  layers: number,
  colorSpace: THREE.ColorSpace,
): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(data, size, size, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function makeTextureSet(arrays: TileArrays): {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  rough: THREE.DataArrayTexture;
} {
  return {
    albedo: makeArrayTexture(arrays.albedo, arrays.size, arrays.layers, THREE.SRGBColorSpace),
    normal: makeArrayTexture(arrays.normal, arrays.size, arrays.layers, THREE.NoColorSpace),
    rough: makeArrayTexture(arrays.rough, arrays.size, arrays.layers, THREE.NoColorSpace),
  };
}

export function createVoxelMaterial(arrays: TileArrays = buildTileArrays()): VoxelMaterialBundle {
  // Mutable so the photographic pack can swap in when it finishes decoding —
  // the procedural 128s are the cheap first paint, not the destination.
  let maps = makeTextureSet(arrays);
  let liveUniforms: Record<string, THREE.IUniform> | null = null;
  let disposed = false;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, // carries ambient occlusion only
    metalness: 0,
    roughness: 1,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAlbedoArray = { value: maps.albedo };
    shader.uniforms.uNormalArray = { value: maps.normal };
    shader.uniforms.uRoughArray = { value: maps.rough };
    shader.uniforms.uNormalScale = { value: 1.35 };
    liveUniforms = shader.uniforms;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aLayer;
         varying float vLayer;
         varying vec3 vTriPos;
         varying vec3 vTriNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLayer = aLayer;
         // Object space IS global voxel space — the mesher writes world voxel
         // coordinates into the position attribute — so these varyings are
         // continuous across chunks without touching the model matrix.
         vTriPos = transformed;
         vTriNormal = objectNormal;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         precision highp sampler2DArray;
         uniform sampler2DArray uAlbedoArray;
         uniform sampler2DArray uNormalArray;
         uniform sampler2DArray uRoughArray;
         uniform float uNormalScale;
         // Vertex-stage-only in three's prelude; declared here too so the
         // fragment side can take the perturbed normal to view space. GLSL
         // links uniforms across stages by name, and the renderer uploads
         // normalMatrix to the program wherever it is referenced.
         uniform mat3 normalMatrix;
         varying float vLayer;
         varying vec3 vTriPos;
         varying vec3 vTriNormal;
         // One tile spans TILE_VOXELS voxels — same 4 cm the old UVs meant.
         const float TRI_TEX_SCALE = ${(1 / TILE_VOXELS).toFixed(6)};`,
      )
      /*
       * The blend weights and the three plane UVs, declared once in main()'s
       * scope: roughness and normal sampling below reuse them, so all three
       * maps always agree about where on the tile they are looking.
       *
       * pow(|n|, 4) keeps each face committed to its own projection until the
       * surface genuinely turns — a flat tread is pure top projection, and the
       * crossfade band on a conforming slope is narrow enough that the double
       * image blending causes reads as soil, not ghosting.
       */
      .replace(
        '#include <map_fragment>',
        `vec3 triN = normalize(vTriNormal);
         vec3 triW = pow(abs(triN), vec3(4.0));
         triW /= (triW.x + triW.y + triW.z);
         vec2 uvX = vTriPos.zy * TRI_TEX_SCALE;
         vec2 uvY = vTriPos.xz * TRI_TEX_SCALE;
         vec2 uvZ = vTriPos.xy * TRI_TEX_SCALE;
         diffuseColor *= texture(uAlbedoArray, vec3(uvX, vLayer)) * triW.x
           + texture(uAlbedoArray, vec3(uvY, vLayer)) * triW.y
           + texture(uAlbedoArray, vec3(uvZ, vLayer)) * triW.z;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness * (
           texture(uRoughArray, vec3(uvX, vLayer)).g * triW.x
           + texture(uRoughArray, vec3(uvY, vLayer)).g * triW.y
           + texture(uRoughArray, vec3(uvZ, vLayer)).g * triW.z);`,
      )
      /*
       * UDN-style triplanar normals: each projection's tangent-space nudge is
       * swizzled onto the two object axes of its plane and ADDED to the
       * geometric normal, rather than rotated by a per-face TBN — there is no
       * per-face tangent any more, because a conforming surface cell's wall
       * is not axis-aligned. The sum is normalized in object space, then
       * taken to view space by the same normalMatrix the vertex stage uses
       * (GLSL links uniforms across stages by name).
       */
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 tnX = texture(uNormalArray, vec3(uvX, vLayer)).xyz * 2.0 - 1.0;
         vec3 tnY = texture(uNormalArray, vec3(uvY, vLayer)).xyz * 2.0 - 1.0;
         vec3 tnZ = texture(uNormalArray, vec3(uvZ, vLayer)).xyz * 2.0 - 1.0;
         vec3 triPerturb = vec3(0.0, tnX.y, tnX.x) * triW.x
           + vec3(tnY.x, 0.0, tnY.y) * triW.y
           + vec3(tnZ.x, tnZ.y, 0.0) * triW.z;
         vec3 triObjN = normalize(triN + triPerturb * uNormalScale);
         normal = normalize(normalMatrix * triObjN);`,
      );
  };

  // Changing onBeforeCompile after a program exists requires a new key.
  material.customProgramCacheKey = () => 'voxel-triplanar-v2';

  const bundle: VoxelMaterialBundle = {
    material,
    textures: [maps.albedo, maps.normal, maps.rough],
    dispose() {
      disposed = true;
      maps.albedo.dispose();
      maps.normal.dispose();
      maps.rough.dispose();
      material.dispose();
    },
  };

  /*
   * Photographic upgrade, fire-and-forget. First paint never waits on a
   * network fetch; when (and only when) the whole 512 px pack decodes, the
   * texture objects are swapped under the SAME program — sampler types and
   * uniforms are unchanged, so no recompile, no flash. Failure of any kind
   * just leaves the procedural tiles, which are correct, only plainer.
   */
  if (typeof document !== 'undefined') {
    void loadPhotoTileArrays().then((photo) => {
      if (!photo || disposed) return;
      const next = makeTextureSet(photo);
      const old = maps;
      maps = next;
      bundle.textures = [next.albedo, next.normal, next.rough];
      if (liveUniforms) {
        liveUniforms.uAlbedoArray!.value = next.albedo;
        liveUniforms.uNormalArray!.value = next.normal;
        liveUniforms.uRoughArray!.value = next.rough;
      }
      old.albedo.dispose();
      old.normal.dispose();
      old.rough.dispose();
    }).catch(() => { /* keep procedural tiles */ });
  }

  return bundle;
}
