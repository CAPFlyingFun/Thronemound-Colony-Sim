/**
 * The underground sense: how soil looks to an animal that cannot see it.
 *
 * Above ground the world is lit dirt. Inside it, every wall is the same brown
 * and a tunnel is a featureless void — reported from play as getting lost
 * enough to end up somewhere she should not have been, and it is a real
 * problem rather than a taste one: a first-person camera in a 7 mm bore has
 * no landmarks, no horizon and no parallax to read shape from.
 *
 * So underground the terrain is lit by SENSE rather than by the sun, and a
 * contour grid is laid over it. The soil keeps its own texture — an early
 * cut replaced it with lines on darkness, which read as a wireframe model
 * rather than as dirt — and the grid is an overlay on top of that, fading
 * with distance so what is past her reach goes dark. That gives a tunnel
 * an obvious shape, a working face an obvious distance, and an old tunnel a
 * visible mouth — the three things you need to navigate — while keeping the
 * map honest: this is a bubble around her, NOT an x-ray. Soil fifty
 * millimetres away is unknown, so where the nest goes next is still a
 * decision rather than a readout.
 *
 * ## Why it is a shader and not geometry
 *
 * The terrain already exists as a meshed signed-density field with one shared
 * material. Contours are a function of world position and surface normal, so
 * they cost a few instructions in the fragment shader and no new vertices, no
 * second pass and no CPU work at all — which matters, because the thing this
 * runs on is a phone that is already meshing soil.
 *
 * ## The bands
 *
 * Three distances, in millimetres, and they are the whole design:
 *
 *   0 - 15 mm   the tunnel she is in: shaded, readable, solid
 *  15 - 30 mm   contours on darkness — shape without detail
 *  30 - 50 mm   contours fading out
 *      > 50 mm  unknown
 *
 * Lines are drawn on a world-anchored grid rather than a screen one, so they
 * belong to the soil and slide past as she moves. Each axis is weighted by
 * how much the surface faces ACROSS it: a floor gets the two horizontal
 * families and none of the elevation family, which is the same reason a
 * contour map has no lines on flat ground.
 */

import * as THREE from 'three';

/** Millimetres per world unit — the scene's own scale, restated locally. */
const MM = 5;

export interface SenseUniforms {
  uSense: { value: number };
  uNear: { value: number };
  uMid: { value: number };
  uFar: { value: number };
  uBand: { value: number };
  uLine: { value: THREE.Color };
  uWash: { value: THREE.Color };
  uDeep: { value: THREE.Color };
}

/** How fast the view crosses over, as an exponential rate per second. */
export const SENSE_EASE = 5.5;

/**
 * IS THERE A ROOF OVER HER — which is what "underground" actually means.
 *
 * Reported: "whenever going underground, the sky looks nighttime and
 * everything goes dark."
 *
 * The sense was ramped on DEPTH BELOW HER ORIGINAL GRADE alone, full by
 * five millimetres, and the sky is blended to near-black by the same
 * number. Five millimetres is about her own height. So scooping a shallow
 * hollow — or walking into any dip below where the ground used to be, since
 * the depth is measured against the ORIGINAL heightfield and that knows
 * nothing about digging — put the whole world at full sense with the sky
 * wide open above her. Below grade, yes. Underground, no. Nighttime is
 * exactly what that looks like.
 *
 * Depth was never the wrong question, it was only half of it. The other
 * half is whether anything is actually between her and the sky, and the
 * file already knew this: `enclosed` exists because "below grade" is the
 * right question for choosing a camera and the wrong one for choosing a
 * way of SEEING. It was just derived from the same depth number, so the
 * distinction it was written for never existed.
 *
 * THE QUESTION IS WHETHER THERE IS SKY, NOT HOW LOW THE CEILING IS, and
 * the first cut at these numbers got that wrong: 8 and 30 read a real
 * queen chamber — 22 mm tall, eighty millimetres down, with the whole hill
 * on top of it — as a third underground, because its roof is a long way
 * from her head. Measured at 0.341, which would have left a buried room
 * lit like an overcast afternoon.
 *
 * So the band is set where a ROOM still counts as inside. Anything within
 * 25 mm overhead is a roof and nothing else; past 60 mm it stops mattering
 * whether it is a roof or a cloud. The fade between is a rock ledge outdoors
 * and the underside of a tunnel mouth, both of which should read as partly
 * shut in, which they are.
 */
export const ROOF_TIGHT_MM = 25;
export const ROOF_OPEN_MM = 60;

/**
 * How much roof a given gap counts as, 0..1.
 *
 * `null` — nothing solid overhead within reach — is open sky and answers 0.
 * A pure function of one number, so the shape can be pinned in a test
 * without a soil field.
 */
export function roofShare(gapMm: number | null): number {
  if (gapMm === null) return 0;
  if (gapMm <= ROOF_TIGHT_MM) return 1;
  if (gapMm >= ROOF_OPEN_MM) return 0;
  return (ROOF_OPEN_MM - gapMm) / (ROOF_OPEN_MM - ROOF_TIGHT_MM);
}

/**
 * Teach a material to be sensed as well as seen.
 *
 * Returns the uniforms so the scene can ramp `uSense` — 0 is the lit world,
 * 1 is full sense, and everything between is the dissolve. The transition is
 * deliberately not instant: breaking the surface is one of the moments this
 * game has, and half a second of contours resolving into daylight is the
 * whole of the effect.
 */
export function makeSensed(material: THREE.Material): SenseUniforms {
  const uniforms: SenseUniforms = {
    uSense: { value: 0 },
    // 15, 30 and 50 mm, in world units.
    uNear: { value: 15 / MM },
    uMid: { value: 30 / MM },
    uFar: { value: 50 / MM },
    /*
     * One line every 2 mm. Her body is 9 mm long and a bore is 7 mm across,
     * so this puts three or four lines across a tunnel — enough to read its
     * curve, few enough not to moiré into a grey smear at a distance, which
     * a 1 mm grid did.
     */
    uBand: { value: 2 / MM },
    uLine: { value: new THREE.Color(0x9dffd8) },
    /*
     * The surface wash, and it is LIT BY THE SENSE rather than by the scene.
     *
     * The first cut dimmed the scene's own shading instead, and underground
     * the scene's own shading is nothing — a tunnel has no sun in it, so
     * multiplying it produced a black screen with a few hairlines on it and
     * none of the "clear tunnel geometry" the near band is supposed to be.
     * A wash that brightens with how squarely a surface faces her gives the
     * bore back its shape without pretending there is a light down there.
     */
    uWash: { value: new THREE.Color(0x2f7a5e) },
    uDeep: { value: new THREE.Color(0x040c09) },
  };

  /*
   * CHAIN the hook, never replace it. This material may already carry a
   * shader hook — the soil's is the whole biome paint job — and assigning
   * over it silently erased that: the soil window rendered as a bald white
   * MeshStandardMaterial wherever she walked, textures gone. The sense is
   * a LAYER over whatever the material already is, so its injections run
   * after the prior hook's (none of the includes it edits are ones the
   * biome hook removes). The program cache key chains for the same reason:
   * three.js keys compiled programs on the hook's source text, and two
   * different hooks with a colliding key would hand one material the
   * other's program.
   */
  const prior = material.onBeforeCompile;
  const priorKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${priorKey()}-sensed`;
  material.onBeforeCompile = (shader, renderer) => {
    prior.call(material, shader, renderer);
    for (const [name, uniform] of Object.entries(uniforms)) {
      shader.uniforms[name] = uniform as THREE.IUniform;
    }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSenseWorld;
        varying vec3 vSenseNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSenseWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSenseNormal = normalize(mat3(modelMatrix) * normal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSenseWorld;
        varying vec3 vSenseNormal;
        uniform float uSense;
        uniform float uNear;
        uniform float uMid;
        uniform float uFar;
        uniform float uBand;
        uniform vec3 uLine;
        uniform vec3 uWash;
        uniform vec3 uDeep;

        /*
         * One family of lines, anti-aliased by its own screen derivative.
         * Without the derivative the grid aliases into noise the moment a
         * band is thinner than a pixel, which at a glancing angle down a
         * tunnel is most of the screen.
         */
        float senseBand(float coordinate) {
          // 1.6 widens the line to about a pixel and a half. A hairline is
          // invisible on a phone at arm's length and shimmers when she moves.
          float w = fwidth(coordinate) * 1.6;
          float g = abs(fract(coordinate - 0.5) - 0.5) / max(w, 1e-5);
          return 1.0 - clamp(g, 0.0, 1.0);
        }`)
      /*
       * Composited where the fog would be, and the fog is faded out by the
       * same amount: the fog colour is the SKY, and a sky-blue haze over a
       * tunnel wall is the one thing that would give the whole effect away.
       * The replacement is three.js's own fog block with `(1.0 - uSense)`
       * folded into the mix.
       */
      .replace('#include <fog_fragment>', `
        if (uSense > 0.001) {
          float senseDist = distance(vSenseWorld, cameraPosition);
          vec3 senseCoord = vSenseWorld / uBand;
          vec3 senseFacing = abs(normalize(vSenseNormal));
          float senseLines = max(
            max(senseBand(senseCoord.x) * (1.0 - senseFacing.x),
                senseBand(senseCoord.y) * (1.0 - senseFacing.y)),
            senseBand(senseCoord.z) * (1.0 - senseFacing.z));

          // Near: the tunnel she is in, washed enough to read. Far: contours
          // alone. Past the far reach: nothing, which is the point.
          float senseClose = 1.0 - smoothstep(uNear, uMid, senseDist);
          float senseReach = 1.0 - smoothstep(uMid, uFar, senseDist);

          /*
           * How squarely the surface faces her, standing in for a light she
           * does not have. A wall she is looking straight at is bright, one
           * running away down the tunnel falls off — which is exactly the
           * cue that tells a bore from a chamber.
           */
          vec3 senseView = normalize(cameraPosition - vSenseWorld);
          float senseFace = max(dot(normalize(vSenseNormal), senseView), 0.0);

          /*
           * THE TEXTURE STAYS, AND THE GRID GOES OVER IT.
           *
           * The first cut REPLACED the soil with contours on darkness,
           * which read well and threw away the thing the artist made: the
           * dirt looked like a wireframe model rather than dirt. So the
           * albedo is kept and merely LIT — by how squarely a surface
           * faces her, standing in for a lamp she does not have — and the
           * lines are drawn on top as an overlay.
           *
           * The distance bands still do their job on the light rather
           * than on the texture: near soil is bright and detailed, soil
           * past her reach falls away toward the deep colour, so the map
           * stays a bubble around her rather than an x-ray of the hill.
           */
          float senseLamp = (0.35 + 0.65 * senseFace) * (0.30 + 0.70 * senseClose);
          vec3 sensed = mix(uDeep, gl_FragColor.rgb * (0.55 + 1.05 * senseLamp), senseReach);
          // A breath of the wash keeps damp earth from reading as grey
          // stone once the sun is off it.
          sensed += uWash * 0.12 * senseLamp * senseReach;
          sensed += uLine * senseLines * (0.45 + 0.55 * senseClose) * senseReach;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, sensed, uSense);
        }
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
          #else
            float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
          #endif
          gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * (1.0 - uSense) );
        #endif`);
  };
  material.needsUpdate = true;

  return uniforms;
}
