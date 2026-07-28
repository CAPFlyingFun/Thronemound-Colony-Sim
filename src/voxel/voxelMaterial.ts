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
 * MeshStandardMaterial is patched rather than replaced so three.js keeps
 * providing lighting, fog and tone mapping. The patch deliberately uses its
 * OWN uv/tangent varyings instead of three's built-in `vMapUv`/tangent
 * plumbing, because those names move between three versions and this way an
 * upgrade can't silently break the ground.
 */

import * as THREE from 'three';
import { buildTileArrays, type TileArrays } from './tileTextures';

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

export function createVoxelMaterial(arrays: TileArrays = buildTileArrays()): VoxelMaterialBundle {
  const { size, layers } = arrays;
  const albedo = makeArrayTexture(arrays.albedo, size, layers, THREE.SRGBColorSpace);
  const normal = makeArrayTexture(arrays.normal, size, layers, THREE.NoColorSpace);
  const rough = makeArrayTexture(arrays.rough, size, layers, THREE.NoColorSpace);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, // carries ambient occlusion only
    metalness: 0,
    roughness: 1,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAlbedoArray = { value: albedo };
    shader.uniforms.uNormalArray = { value: normal };
    shader.uniforms.uRoughArray = { value: rough };
    shader.uniforms.uNormalScale = { value: 1.35 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2 aTileUv;
         attribute float aLayer;
         attribute vec3 aTangent;
         varying vec2 vTileUv;
         varying float vLayer;
         varying vec3 vTileTangent;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vTileUv = aTileUv;
         vLayer = aLayer;
         vTileTangent = normalize(mat3(modelMatrix) * aTangent);`,
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
         varying vec2 vTileUv;
         varying float vLayer;
         varying vec3 vTileTangent;`,
      )
      // Base colour from the array; vertex colour then applies AO on top.
      .replace(
        '#include <map_fragment>',
        `diffuseColor *= texture(uAlbedoArray, vec3(vTileUv, vLayer));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness * texture(uRoughArray, vec3(vTileUv, vLayer)).g;`,
      )
      // Faces are axis-aligned, so a correct TBN is just the face normal and
      // the tangent the mesher already emitted — no derivative tricks needed.
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 tileNormal = texture(uNormalArray, vec3(vTileUv, vLayer)).xyz * 2.0 - 1.0;
         tileNormal.xy *= uNormalScale;
         vec3 tbnN = normalize(normal);
         vec3 tbnT = normalize(vTileTangent - tbnN * dot(tbnN, vTileTangent));
         vec3 tbnB = cross(tbnN, tbnT);
         normal = normalize(mat3(tbnT, tbnB, tbnN) * tileNormal);`,
      );
  };

  // Changing onBeforeCompile after a program exists requires a new key.
  material.customProgramCacheKey = () => 'voxel-array-v1';

  return {
    material,
    textures: [albedo, normal, rough],
    dispose() {
      albedo.dispose();
      normal.dispose();
      rough.dispose();
      material.dispose();
    },
  };
}
