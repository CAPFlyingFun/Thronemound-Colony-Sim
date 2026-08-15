/**
 * THE MACRO LOOK — a sharp band across the middle, blurring to the edges.
 *
 * Asked for in these words: "adding the macro effect where the middle third
 * of the camera is clear with no blur, but the top third and bottom third
 * start to blur ... at max".
 *
 * This is TILT-SHIFT, which blurs by where a pixel is ON SCREEN rather than
 * by how far away it is, and it is the right tool rather than the cheap one.
 * Faking a miniature with a tilted plane of focus is exactly how the effect
 * is done in photography, and it is why a tilt-shift photo of a real city
 * looks like a model railway. It also happens to cost a fraction of true
 * depth of field: no depth buffer, no per-pixel circle of confusion, and at
 * ground level the screen's vertical axis correlates with distance anyway —
 * near ground at the bottom, far away at the top — so it approximates the
 * honest thing for free in the view she is in most of the time.
 *
 * IT EASES OUT WHEN SHE LOOKS DOWN, and that is the one thing this effect
 * cannot be shipped without. Aimed at her feet — digging, which is where the
 * player concentrates hardest — every pixel in frame is the same short
 * distance away, so a fixed band would blur the top and bottom of a flat,
 * uniformly close surface. That does not read as macro; it reads as a
 * smeared screen. `strengthFor` folds the camera's own pitch into the
 * effect so it fades away exactly where its assumption stops holding.
 *
 * HOW IT IS DRAWN, and why not `EffectComposer`:
 *
 *   scene -> full-res target
 *          -> half-res, blurred across  }  separable Gaussian, two passes
 *          -> half-res, blurred down    }
 *   composite: mix(sharp, blurred, band) -> screen
 *
 * The blur runs at HALF RESOLUTION on purpose. Blur is low-frequency by
 * definition, so half-res is visually indistinguishable and a quarter of the
 * work — which is the difference between this being free on a phone and
 * being the reason the frame rate drops. `EffectComposer` would have run
 * every pass at full size, and driving four targets by hand is less code
 * than fighting it.
 */
import * as THREE from 'three';

/** How the band is shaped and how hard it blurs. All tunable at runtime. */
export interface TiltTuning {
  /** Radius of the fully sharp circle, in screen HEIGHTS from her. */
  sharp: number;
  /** Where the blur stops growing, measured the same way. */
  full: number;
  /** Blur radius at maximum, in half-res pixels. */
  radius: number;
  /**
   * How much WIDER than tall the sharp area is — 1 is a circle, 2 is an
   * ellipse twice as wide as it is high.
   *
   * Directly the width-to-height ratio, because the shader divides the
   * horizontal term by it: at 1 the aspect correction alone makes a true
   * circle in pixels, and anything above that stretches it sideways.
   */
  wide: number;
  /**
   * The most of the blurred image that may ever be mixed in, 0..1.
   *
   * Below 1 on purpose. It keeps a little of the sharp frame in even the
   * softest corner, which is the difference between a background you can
   * still read and a pane of frosted glass.
   */
  most: number;
}

/*
 * A CIRCLE AROUND HER, NOT A BAND ACROSS THE SCREEN — and gentle enough to
 * see through.
 *
 * The band was the first reading of the request and it was the wrong shape.
 * It blurs everything at HER OWN HEIGHT out to the left and right, which the
 * reference photograph plainly does not: there the falloff runs outward from
 * the subject in every direction. Spotted exactly: "maybe it was a circle
 * reference point around the ant, but it was also gradual and you could
 * still see it."
 *
 * AND THE STRENGTH IS THE OTHER HALF. Too much blur stops being a lens and
 * becomes frosted glass — "I want the background to be still visible, not
 * like a dirty screen". A real macro background is SOFT but READABLE: you
 * can see the nest hole and the leaf in the reference, you just cannot read
 * their texture. So the radius comes down to where detail survives, and
 * `most` caps how far the mix can go, which guarantees some of the sharp
 * frame is always in there no matter how far out a pixel is.
 */
export const DEFAULT_TILT: TiltTuning = {
  /*
   * THE RAMP STARTS ALMOST AT HER AND ENDS PAST THE CORNER, on purpose.
   *
   * A generous sharp circle sounds kinder and is the reason the edge shows:
   * it puts a RADIUS on screen where blur visibly begins, and the eye finds
   * it immediately however smooth the curve is after that. Starting the
   * ramp close in and running it past the far corner means the gradient
   * spans the whole frame and never announces itself — there is no ring,
   * because there is nowhere for one to be.
   *
   * `sharp` went 0.08 -> 0.104, which is the 30% wider sharp circle asked
   * for. Only the START of the ramp moves: `full` stays where it is, so the
   * gradient gets slightly shorter rather than the whole thing sliding
   * outward, and the falloff still runs off the edge of the frame.
   *
   * The corner of a 932 x 430 frame is about 0.62 screen-heights from the
   * middle, so a `full` of 0.95 is never actually reached. The maximum blur
   * on screen is roughly two thirds of what the numbers allow, which is
   * also why the radius can stay generous without the corners turning to
   * frost.
   */
  sharp: 0.104,
  full: 0.95,
  radius: 0.5,
  most: 0.82,
  /*
   * AN OVAL, WIDER THAN TALL — asked for, and it suits the frame.
   *
   * A true circle is the wrong shape for a 932 x 430 window: it runs out of
   * room top and bottom long before it does left and right, so the sides of
   * the screen blur while there is still sharp headroom going spare. The
   * frame itself is 2.17 to 1, and 1.8 sits just inside that — wide enough
   * to read as an oval and follow the shape of the screen, short of
   * matching it exactly, which would push the falloff into the corners and
   * leave nothing soft at the sides at all.
   */
  wide: 1.8,
};

/**
 * How much of the effect applies, given where the camera is looking.
 *
 * `fwdY` is the camera's forward vector's vertical part: 0 looking level,
 * -1 straight down. Full strength while she is within about thirty degrees
 * of level, gone by about sixty-five — see the note at the top of the file
 * on why this is not optional.
 */
export function strengthFor(fwdY: number): number {
  const steep = Math.abs(fwdY);
  if (steep <= 0.5) return 1;
  if (steep >= 0.9) return 0;
  return 1 - (steep - 0.5) / 0.4;
}

/** How much wider the second blur level is than the first. They COMPOUND,
 *  so this is a multiplier on an already-blurred image, not on the source. */
const BLUR_STEP = 1.5;

const QUAD = new THREE.PlaneGeometry(2, 2);
const FLAT = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** One direction of a separable Gaussian, nine taps. */
const BLUR_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uStep;
  varying vec2 vUv;
  void main() {
    /* Weights of a 9-tap Gaussian, normalised. Written out rather than
     * computed so the shader has no loop to unroll on a weak driver. */
    vec4 sum = texture2D(tSrc, vUv) * 0.2270270270;
    sum += texture2D(tSrc, vUv + uStep * 1.3846153846) * 0.3162162162;
    sum += texture2D(tSrc, vUv - uStep * 1.3846153846) * 0.3162162162;
    sum += texture2D(tSrc, vUv + uStep * 3.2307692308) * 0.0702702703;
    sum += texture2D(tSrc, vUv - uStep * 3.2307692308) * 0.0702702703;
    gl_FragColor = sum;
  }
`;

const MIX_FRAG = /* glsl */`
  /*
   * AND THE LAST PASS PUTS THE COLOUR BACK, which is not optional.
   *
   * three.js converts linear to sRGB when it draws to the CANVAS and not
   * when it draws into a render target. So a scene routed through targets
   * and blitted out raw arrives dark — measured, and obviously so: the same
   * frame with the effect off was bright and with it on was nearly black.
   * That is the single most common way a first post-processing pass goes
   * wrong, and it looks like a lighting bug rather than a colour one.
   *
   * The BLUR passes deliberately do not do this. Blurring is an average of
   * light, and averaging light is only correct in linear space — encoding
   * early would darken every soft edge. So the whole chain stays linear and
   * exactly one pass, this one, converts at the very end.
   *
   * The real curve rather than a 1/2.2 approximation: sRGB has a linear toe
   * near black, and skipping it lifts the darkest tones, which on a game
   * that spends its time underground is the half you would notice.
   */
  vec3 toSRGB(vec3 c) {
    return mix(
      pow(c, vec3(0.41666666)) * 1.055 - 0.055,
      c * 12.92,
      step(c, vec3(0.0031308))
    );
  }

  uniform sampler2D tSharp;
  uniform sampler2D tBlur;
  uniform sampler2D tBlur2;
  uniform vec2 uFocus;
  uniform float uAspect;
  uniform float uWide;
  uniform float uSharp;
  uniform float uFull;
  uniform float uStrength;
  uniform float uMost;
  varying vec2 vUv;
  void main() {
    vec4 sharp = texture2D(tSharp, vUv);
    /*
     * DISTANCE FROM HER, as an OVAL rather than a band or a circle.
     *
     * The x term is scaled by the aspect, which alone would make a true
     * circle in pixels — without it the sides of a 932 by 430 frame would
     * blur more than two times sooner than the top and bottom and look
     * like a fault. Dividing that by uWide then stretches the circle back
     * out sideways, so uWide IS the width-to-height ratio: 1 is a circle,
     * 2 is twice as wide as tall. (No backticks in here — this is inside a
     * template literal and a stray pair ends the shader.)
     *
     * Ramped with smoothstep: a linear ramp shows its start and end as
     * faint rings, which reads as a rendering artefact rather than a lens.
     */
    float d = length((vUv - uFocus) * vec2(uAspect / max(0.05, uWide), 1.0));
    float amount = smoothstep(uSharp, uFull, d) * uStrength * uMost;
    /* The sharp middle costs one texture read and the encode, nothing else. */
    if (amount <= 0.002) {
      gl_FragColor = vec4(toSRGB(sharp.rgb), sharp.a);
      return;
    }
    /*
     * THREE LAYERS, WEIGHTED — not two lerps stitched together.
     *
     * The first version ran sharp-to-soft across the first half of the ramp
     * and soft-to-heavy across the second. The VALUE is continuous where
     * they meet, so it looked correct written down, but the RATE of change
     * jumps at the join: blur stops growing at one speed and starts growing
     * at another. The eye is very good at spotting that, and it shows up as
     * a ring — reported as "the transition from sharp to blur is too
     * obvious", which is exactly what a C1 discontinuity looks like.
     *
     * Weighting all three with overlapping smoothsteps has no join to see.
     * The weights sum to one everywhere, and each one enters and leaves with
     * zero slope, so there is no radius at which anything changes abruptly.
     *
     * (No backticks in this comment: it lives inside a template literal, and
     * a stray pair closes the shader string mid-sentence.)
     */
    vec4 soft = texture2D(tBlur, vUv);
    vec4 heavy = texture2D(tBlur2, vUv);
    float wHeavy = smoothstep(0.30, 1.00, amount);
    float wSoft = (1.0 - wHeavy) * smoothstep(0.0, 0.55, amount);
    float wSharp = 1.0 - wHeavy - wSoft;
    vec4 mixed = sharp * wSharp + soft * wSoft + heavy * wHeavy;
    gl_FragColor = vec4(toSRGB(mixed.rgb), mixed.a);
  }
`;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class TiltShift {
  tuning: TiltTuning = { ...DEFAULT_TILT };

  /** Off entirely — the composite is skipped and the scene draws direct. */
  enabled = true;

  /**
   * WHERE THE SHARP CIRCLE IS CENTRED, in screen uv — HER, projected.
   *
   * Written by the scene each frame rather than fixed at the middle of the
   * screen, because she is not at the middle of the screen: the chase camera
   * sits her low and the HUD's own weight is at the bottom. A fixed centre
   * would put the sharp spot above her head while she walks around under it.
   */
  readonly focus = new THREE.Vector2(0.5, 0.5);

  private scene: THREE.Scene | null = null;

  private full: THREE.WebGLRenderTarget | null = null;

  private halfA: THREE.WebGLRenderTarget | null = null;

  private halfB: THREE.WebGLRenderTarget | null = null;

  /** The SECOND blur level — see `render` for why one is not enough. */
  private halfC: THREE.WebGLRenderTarget | null = null;

  private readonly blurMat: THREE.ShaderMaterial;

  private readonly mixMat: THREE.ShaderMaterial;

  private readonly quadScene = new THREE.Scene();

  private readonly quad: THREE.Mesh;

  constructor() {
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.mixMat = new THREE.ShaderMaterial({
      uniforms: {
        tSharp: { value: null },
        tBlur: { value: null },
        tBlur2: { value: null },
        uFocus: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
        uWide: { value: DEFAULT_TILT.wide },
        uMost: { value: DEFAULT_TILT.most },
        uSharp: { value: DEFAULT_TILT.sharp },
        uFull: { value: DEFAULT_TILT.full },
        uStrength: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: MIX_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(QUAD, this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Size the targets. Called from the scene's own resize, with the same
   * pixel size the renderer was just given — including the adaptive pixel
   * ratio, so the effect shrinks when the renderer does rather than quietly
   * costing more as the frame rate falls.
   */
  setSize(w: number, h: number): void {
    const width = Math.max(2, Math.floor(w));
    const height = Math.max(2, Math.floor(h));
    const half = { w: Math.max(1, width >> 1), h: Math.max(1, height >> 1) };
    if (!this.full) {
      /* No depth on the half targets: they only ever receive a fullscreen
       * quad, and asking for a depth buffer on each would be two more
       * allocations doing nothing. The full target DOES need one — the
       * scene is drawn into it. */
      this.full = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
      this.halfA = new THREE.WebGLRenderTarget(half.w, half.h, { depthBuffer: false });
      this.halfB = new THREE.WebGLRenderTarget(half.w, half.h, { depthBuffer: false });
      this.halfC = new THREE.WebGLRenderTarget(half.w, half.h, { depthBuffer: false });
      for (const t of [this.full, this.halfA, this.halfB, this.halfC]) {
        t.texture.minFilter = THREE.LinearFilter;
        t.texture.magFilter = THREE.LinearFilter;
        t.texture.generateMipmaps = false;
      }
      return;
    }
    this.full.setSize(width, height);
    this.halfA?.setSize(half.w, half.h);
    this.halfB?.setSize(half.w, half.h);
    this.halfC?.setSize(half.w, half.h);
  }

  /**
   * Draw the scene through the effect.
   *
   * Falls back to a direct render whenever it is off or a target is missing,
   * so a caller never has to ask whether it is safe to use — and so the one
   * line at the call site stays one line.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    strength: number,
  ): void {
    const use = this.enabled && strength > 0.002
      && this.full && this.halfA && this.halfB && this.halfC;
    if (!use) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    const full = this.full!;
    const a = this.halfA!;
    const b = this.halfB!;
    const c = this.halfC!;
    this.scene = scene;

    renderer.setRenderTarget(full);
    renderer.clear();
    renderer.render(scene, camera);

    const r = this.tuning.radius;
    this.quad.material = this.blurMat;
    /* Across, then down. The two together are a 2D Gaussian for the cost of
     * two 1D ones, which is the only reason a blur this wide is affordable. */
    this.blurMat.uniforms.tSrc!.value = full.texture;
    (this.blurMat.uniforms.uStep!.value as THREE.Vector2).set(r / a.width, 0);
    renderer.setRenderTarget(a);
    renderer.render(this.quadScene, FLAT);

    this.blurMat.uniforms.tSrc!.value = a.texture;
    (this.blurMat.uniforms.uStep!.value as THREE.Vector2).set(0, r / b.height);
    renderer.setRenderTarget(b);
    renderer.render(this.quadScene, FLAT);

    /*
     * A SECOND, WIDER BLUR — and this is what makes the fade smooth rather
     * than rough.
     *
     * With ONE blurred image the composite can only cross-fade sharp
     * against it, so halfway through the ramp you get a 50/50 of a crisp
     * frame and a heavily blurred one. That is not what half-focus looks
     * like: it reads as a DOUBLE IMAGE, a ghost of the sharp edges sitting
     * on top of the soft ones, and the eye picks it out as a hard boundary
     * exactly where the blend is strongest. Reported as the transition
     * being "roughy", which is precisely it.
     *
     * Real defocus grows its RADIUS. Two levels approximate that: the
     * composite runs sharp -> lightly blurred -> heavily blurred, so every
     * point on the ramp is an actual blur of some width rather than a
     * mixture of two different ones. Blurring `b` again rather than
     * re-blurring the source is what makes the second level cheap — the
     * widths compound, so this is a much larger radius for the same four
     * taps.
     */
    this.blurMat.uniforms.tSrc!.value = b.texture;
    (this.blurMat.uniforms.uStep!.value as THREE.Vector2).set(r * BLUR_STEP / a.width, 0);
    renderer.setRenderTarget(a);
    renderer.render(this.quadScene, FLAT);

    this.blurMat.uniforms.tSrc!.value = a.texture;
    (this.blurMat.uniforms.uStep!.value as THREE.Vector2).set(0, r * BLUR_STEP / c.height);
    renderer.setRenderTarget(c);
    renderer.render(this.quadScene, FLAT);

    this.quad.material = this.mixMat;
    this.mixMat.uniforms.tSharp!.value = full.texture;
    this.mixMat.uniforms.tBlur!.value = b.texture;
    this.mixMat.uniforms.tBlur2!.value = c.texture;
    (this.mixMat.uniforms.uFocus!.value as THREE.Vector2).copy(this.focus);
    this.mixMat.uniforms.uAspect!.value = full.width / Math.max(1, full.height);
    this.mixMat.uniforms.uMost!.value = this.tuning.most;
    this.mixMat.uniforms.uWide!.value = this.tuning.wide;
    this.mixMat.uniforms.uSharp!.value = this.tuning.sharp;
    this.mixMat.uniforms.uFull!.value = this.tuning.full;
    this.mixMat.uniforms.uStrength!.value = strength;
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, FLAT);
  }

  dispose(): void {
    this.full?.dispose();
    this.halfA?.dispose();
    this.halfB?.dispose();
    this.halfC?.dispose();
    this.blurMat.dispose();
    this.mixMat.dispose();
    this.scene = null;
  }
}
