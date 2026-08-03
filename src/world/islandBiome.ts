/**
 * Beyond Extinction's Kauai biome material, ported for the 1:1000 island.
 *
 * This is BE's `makeBiomeMaterial` (KauaiTileStreamer.ts) with its shader
 * kept nearly verbatim — the same seven ground textures painted by elevation
 * and slope: sand at the waterline → grass → jungle → rock → mountain → snow,
 * steep faces reading as cliff at any height, jittered band thresholds,
 * dual-scale anti-repeat tiling, triplanar rock, and the wet-sand splash
 * zone. Comments on the tricky parts are BE's own lessons, kept.
 *
 * Two ports for ant scale:
 *  - UVs and band thresholds are in REAL METRES. One world unit here is
 *    5 in-world mm = 5 real metres at 1:1000, so the shader multiplies
 *    world position by 5 and every BE constant then applies unchanged.
 *  - `aElev` is per-vertex elevation in real metres (= in-world mm).
 *
 * The same material paints the diggable soil chunks: their walls are steep,
 * so the slope term dresses tunnels as cliff rock with no extra logic, and
 * their tops sit at the same elevation as the island around them, so the
 * fine window doesn't read as a patch. The island surface takes the variant
 * WITH the window-discard clip; the soil takes the variant without.
 */

import * as THREE from 'three';

/** Real metres per world unit at 1:1000 (1 wu = 5 mm = 5 m full-scale). */
const M_PER_WU = 5;

export const BIOME_TEXTURES = [
  'sand', 'grass', 'jungle', 'cliff', 'mountain', 'snow', 'reef',
] as const;

export type BiomeTextureSet = Record<(typeof BIOME_TEXTURES)[number], THREE.Texture>;

export async function loadBiomeTextures(baseUrl: string): Promise<BiomeTextureSet> {
  const loader = new THREE.TextureLoader();
  const out = {} as Record<string, THREE.Texture>;
  await Promise.all(BIOME_TEXTURES.map(async (name) => {
    const tex = await loader.loadAsync(`${baseUrl}kauai-tex/${name}.jpg`);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    out[name] = tex;
  }));
  return out as BiomeTextureSet;
}

export function makeBiomeMaterial(
  tex: BiomeTextureSet,
  clip?: { value: THREE.Vector4 },
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tSand = { value: tex.sand };
    shader.uniforms.tGrass = { value: tex.grass };
    shader.uniforms.tJungle = { value: tex.jungle };
    shader.uniforms.tRock = { value: tex.cliff };
    shader.uniforms.tMtn = { value: tex.mountain };
    shader.uniforms.tSnow = { value: tex.snow };
    shader.uniforms.tReef = { value: tex.reef };
    if (clip) shader.uniforms.uClip = clip;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aElev;\nvarying float vElev;\nvarying vec3 vBiomeW;\nvarying vec3 vBiomeN;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vBiomeN = normalize(mat3(modelMatrix) * objectNormal);',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vBiomeW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vElev = aElev;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vElev;
varying vec3 vBiomeW;
varying vec3 vBiomeN;
uniform sampler2D tSand, tGrass, tJungle, tRock, tMtn, tSnow, tReef;
${clip ? 'uniform vec4 uClip;' : ''}
float gWet = 0.0; // shoreline wetness (set in map_fragment, used for roughness)
// three uploads sRGB textures with an sRGB internal format on WebGL2, so
// texture2D already returns LINEAR — no manual decode needed.
vec3 s2l(vec3 c) { return c; }
// Cheap world-space value noise (no texture fetch) — used to jitter biome
// band thresholds and to modulate brightness so repeats/contours break up.
// Sinless hash (Dave Hoskins): stays artifact-free at large world
// coordinates, where sin()-based hashes lose precision on mobile GPUs.
float bhash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float bnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bhash(i), bhash(i + vec2(1.0, 0.0)), f.x),
             mix(bhash(i + vec2(0.0, 1.0)), bhash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Anti-repetition tiling: the same texture at two offset scales, blended.
// The second (4.3x larger, irrational-ish ratio) de-phases the repeat grid so
// the pattern stops reading as a checkerboard at distance.
vec3 tile2(sampler2D tex, vec2 uv, float scale) {
  vec3 a = texture2D(tex, uv / scale).rgb;
  vec3 b = texture2D(tex, uv / (scale * 4.3) + vec2(0.37, 0.71)).rgb;
  return mix(a, b, 0.45);
}
// Triplanar sample: blend the three world-axis projections by the surface
// normal so vertical faces tile from the side instead of smearing the
// top-down projection down a cliff.
vec3 triplanar(sampler2D tex, vec3 wp, vec3 n, float scale) {
  vec3 bw = abs(n); bw = pow(bw, vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
  vec3 cx = texture2D(tex, wp.zy / scale).rgb;
  vec3 cy = texture2D(tex, wp.xz / scale).rgb;
  vec3 cz = texture2D(tex, wp.xy / scale).rgb;
  return cx * bw.x + cy * bw.y + cz * bw.z;
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        (clip
          ? 'if (vBiomeW.x > uClip.x && vBiomeW.x < uClip.z\n'
            + '  && vBiomeW.z > uClip.y && vBiomeW.z < uClip.w) discard;\n'
          : '')
        + '#include <clipping_planes_fragment>',
      )
      .replace(
        '#include <map_fragment>',
        `{
  float e = vElev;                               // elevation (real m)
  vec3 nrm = normalize(vBiomeN);                 // varying denormalizes across a triangle
  float slope = 1.0 - clamp(nrm.y, 0.0, 1.0);
  vec3 wpM = vBiomeW * ${M_PER_WU.toFixed(1)};   // ant world units -> real metres
  vec2 uv = wpM.xz;                              // world-space tiling (flat areas)
  // Jittered band elevation: two octaves of world noise wobble the biome
  // thresholds so transitions are patchy and organic instead of following
  // exact height contours. Ramped in above the beach so the waterline bands
  // (wet sand / reef, which use the raw e) stay put.
  float jit = bnoise(uv * 0.011) * 0.65 + bnoise(uv * 0.047) * 0.35 - 0.5;
  float ej = e + jit * 90.0 * min(1.0, max(e, 0.0) / 60.0);
  vec3 sand = s2l(tile2(tSand,   uv, 4.5));
  vec3 grass= s2l(tile2(tGrass,  uv, 5.5));
  vec3 jung = s2l(tile2(tJungle, uv, 6.5));
  // rock + mountain are what shows on steep faces -> triplanar so they tile
  vec3 rock = s2l(triplanar(tRock, wpM, nrm, 9.0));
  vec3 mtn  = s2l(triplanar(tMtn,  wpM, nrm, 11.0));
  vec3 snow = s2l(tile2(tSnow,   uv, 3.0));
  // Lush Kauai bands, straight from BE's data-tuned pass: sand < 3 m,
  // grass 3-9 m, jungle above, rock and summit bands high on the mountain.
  vec3 c = sand;
  c = mix(c, grass, smoothstep(3.0, 5.0, ej));
  c = mix(c, jung,  smoothstep(9.0, 13.0, ej));
  c = mix(c, rock,  smoothstep(680.0, 980.0, ej));
  c = mix(c, mtn,   smoothstep(1020.0, 1220.0, ej));
  c = mix(c, snow,  smoothstep(1300.0, 1540.0, ej));
  // Steep faces -> cliff rock at ANY elevation (triplanar, so it tiles
  // instead of smearing). No height gate: coastal bluffs and TUNNEL WALLS
  // need it most.
  float rockAmt = smoothstep(0.30, 0.55, slope);
  c = mix(c, rock, rockAmt);
  // Large-scale brightness variation breaks the wallpaper uniformity of
  // tiled ground seen from altitude.
  c *= 0.90 + 0.20 * (bnoise(uv * 0.0016) * 0.6 + bnoise(uv * 0.0085) * 0.4);
  // Soft shoreline: wet sand hugging the waterline, reef fading in only
  // BELOW it, deepening with depth. BE tuned these bands through three
  // releases; the numbers are theirs.
  gWet = 0.7 * smoothstep(0.3, -0.9, e) * smoothstep(-4.0, -0.9, e);
  c = mix(c, c * 0.8, smoothstep(0.25, -0.45, e));
  {
    float d = clamp(-e / 55.0, 0.0, 1.0);
    vec3 reef = s2l(texture2D(tReef, uv / 5.0).rgb);
    vec3 underwater = mix(reef, vec3(0.015, 0.06, 0.10), d * d);
    c = mix(c, underwater, smoothstep(-0.5, -3.6, e));
  }
  diffuseColor.rgb *= c;
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.25, gWet); // wet sheen at the shore',
      )
      .replace(
        '#include <lights_fragment_end>',
        // Dry ground is matte — kill its specular so the sun stops laying a
        // sheen band across the sand. The wet splash-zone keeps its glint.
        '#include <lights_fragment_end>\n  reflectedLight.directSpecular *= mix(0.06, 1.0, gWet);\n  reflectedLight.indirectSpecular *= mix(0.06, 1.0, gWet);',
      );
  };
  mat.customProgramCacheKey = () => `kauai-biome-${clip ? 'clip' : 'solid'}`;
  return mat;
}
