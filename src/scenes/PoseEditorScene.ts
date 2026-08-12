/**
 * THE POSE EDITOR — `?scene=poseedit`, and behind the dev PIN from the menu.
 *
 * Asked for as an animation editor with measurements and custom poses: pose
 * her by hand for climbing, jumping, stinging, and save it. Built on Beyond
 * Extinction's shape rather than from scratch, because its `AnimationEditor`
 * had already answered the two questions that matter — group the bones into
 * handles a person can think in, and store the result as bone rotations with
 * no root translation anywhere. See `anim/pose.ts` for the second one, which
 * is enforced by the type.
 *
 * WHAT IT DELIBERATELY IS NOT is a timeline. Her legs are IK'd to world foot
 * anchors and her body is driven every frame by gait, spine and walker, so a
 * recorded leg track played back over real terrain fights the solver putting
 * her feet on the ground. A named POSE is a target the live system can be
 * blended toward, which composes with all of that instead of overriding it.
 *
 * ONE ANGLE PER GROUP PER AXIS, spread down the chain. A six-bone leg given
 * its whole bend at the coxa is a hinge; the same bend divided along the
 * chain is a curl, which is what a leg does and what the fire-ant sting arch
 * needs through the petiole and gaster. So a slider's angle is divided by
 * the number of bones in its group — the reason the editor works in groups
 * at all rather than offering fifty bones.
 */

import * as THREE from 'three';

import './PoseEditorScene.css';

import { QueenModel } from '../anim/QueenModel';
import { CASTE_LENGTH_MM, VOXEL_MM, type RigMap } from '../anim/hexapod';
import {
  blendInto, emptyPose, poseGroups, type AntPose, type PoseGroup, type PoseQuat,
} from '../anim/pose';
import { PoseStore } from '../anim/poseStore';
import {
  dropKey, emptyClip, keyAt, neededDuration, putKey, sampleClip, type AntClip,
} from '../anim/clip';
import { ClipStore } from '../anim/clipStore';

type Axis = 'pitch' | 'yaw' | 'roll';
const AXES: { key: Axis; label: string; vec: THREE.Vector3 }[] = [
  { key: 'pitch', label: 'Pitch', vec: new THREE.Vector3(1, 0, 0) },
  { key: 'yaw', label: 'Yaw', vec: new THREE.Vector3(0, 1, 0) },
  { key: 'roll', label: 'Roll', vec: new THREE.Vector3(0, 0, 1) },
];

/**
 * How far a group may be turned on one axis, in degrees.
 *
 * Generous on purpose, and larger than the anatomical clamps the game keeps:
 * an editor is where you find out what a pose LOOKS like, and a tool that
 * will not let you overshoot cannot show you where the limit should be. The
 * game's own limits still apply when a pose is blended in — see
 * `SPINE_LIMITS` — so nothing authored here can smuggle a fold past them.
 */
const SWING_DEG = 120;

const Q = new THREE.Quaternion();

export class PoseEditorScene {
  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private readonly queen: QueenModel;

  private readonly store: PoseStore;

  private groups: PoseGroup[] = [];

  private picked: PoseGroup | null = null;

  /** Degrees per axis per group — the editor's own state, not the pose's. */
  private dial = new Map<string, Record<Axis, number>>();

  private pose: AntPose = emptyPose('Untitled');

  /* ------------------------------------------------------------ the clip */

  /**
   * The timeline. A clip is keys, each a WHOLE pose — see `clip.ts` for why
   * that rather than per-bone tracks.
   */
  private clip: AntClip = emptyClip('Untitled');

  /** Where the playhead is, in seconds. */
  private head = 0;

  private playing = false;

  private lastFrameMs = 0;

  private readonly clipStore: ClipStore;

  private scrub: HTMLInputElement | null = null;

  private timeLabel: HTMLSpanElement | null = null;

  private playButton: HTMLButtonElement | null = null;

  private orbit = 0.6;

  private tilt = 0.15;

  /** A multiple of HER OWN length, not a distance in world units. */
  private zoom = 4;

  /** How much of the frame the control panel eats, 0..1 — see `frame`. */
  private panelShare = 0;

  private dragging: number | null = null;

  private lastX = 0;

  private lastY = 0;

  private disposed = false;

  private readonly cleanups: (() => void)[] = [];

  private readout: HTMLDivElement | null = null;

  private list: HTMLSelectElement | null = null;

  private nameBox: HTMLInputElement | null = null;

  constructor(private readonly host: HTMLElement, caste: RigMap['caste'] = 'queen') {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.scene.background = new THREE.Color(0x14181f);
    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2118, 1.1));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.2);
    key.position.set(3, 5, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
    rim.position.set(-3, 2, -3);
    this.scene.add(rim);
    /* A one-voxel grid: her size against the world has to be readable, since
     * the whole point of the measurements is that they are in millimetres. */
    this.scene.add(new THREE.GridHelper(20, 20, 0x4a4f57, 0x2e3238));

    this.queen = new QueenModel(caste);
    this.scene.add(this.queen.root);
    const disk = typeof localStorage === 'undefined' ? undefined : localStorage;
    this.store = new PoseStore(this.queen.rig, disk);
    this.clipStore = new ClipStore(this.queen.rig, disk);

    this.buildUi();
    this.bindOrbit();
    void this.queen.load().then(() => {
      /* Groups come from the RIG, then are filtered by what this model
       * actually carries — the rig is a table and the GLB is the truth, and
       * offering a handle for a bone that is not there is a slider that does
       * nothing. */
      this.groups = poseGroups(this.queen.rig)
        .map((g) => ({ ...g, bones: g.bones.filter((b) => this.queen.hasBone(b)) }))
        .filter((g) => g.bones.length > 0);
      this.pick(this.groups[0] ?? null);
      this.buildGroupRow();
      this.refreshList();
    });
    void this.loadBaked();

    const resize = () => this.resize();
    window.addEventListener('resize', resize);
    this.cleanups.push(() => window.removeEventListener('resize', resize));
    this.resize();
    this.frame();
    (window as unknown as { poseEditor?: unknown }).poseEditor = this;
  }

  /** The committed book, if one has been published. Absent is not an error. */
  private async loadBaked(): Promise<void> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}poses/poses.json`);
      if (!res.ok) return;
      this.store.setBaked(await res.json());
      this.refreshList();
    } catch { /* No published book yet — local edits still work. */ }
  }

  /* ------------------------------------------------------------ the pose */

  /**
   * Rebuild the pose from the dials.
   *
   * Rebuilt WHOLE rather than nudged, because a pose accumulated from
   * increments drifts: the same slider dragged back and forth would not
   * return her to where it started. The dials are the truth and the pose is
   * derived, so dragging any slider to nought is exactly rest.
   */
  private rebuild(): void {
    const rotations: Record<string, PoseQuat> = {};
    for (const group of this.groups) {
      const d = this.dial.get(group.key);
      if (!d) continue;
      if (!d.pitch && !d.yaw && !d.roll) continue;
      /* Spread down the chain: a leg curls, it does not hinge. */
      const share = 1 / group.bones.length;
      Q.identity();
      for (const axis of AXES) {
        const deg = d[axis.key];
        if (!deg) continue;
        Q.multiply(new THREE.Quaternion().setFromAxisAngle(
          axis.vec, (deg * Math.PI) / 180 * share,
        ));
      }
      const q: PoseQuat = [Q.x, Q.y, Q.z, Q.w];
      for (const bone of group.bones) rotations[bone] = q;
    }
    this.pose = { name: this.nameBox?.value.trim() || 'Untitled', rotations };
    this.applyToModel();
    this.draw();
  }

  /**
   * Load a clip: its keys, its length, and its first key onto the dials.
   *
   * The dials land on the FIRST key rather than on nothing, so an author who
   * loads a clip is immediately editing something they can see, and pressing
   * KEY without touching anything re-keys what is already there instead of
   * flattening it to rest.
   */
  private loadClip(clip: AntClip): void {
    this.clip = { ...clip, keys: [...clip.keys] };
    this.head = 0;
    this.playing = false;
    if (this.nameBox) this.nameBox.value = clip.name;
    const first = clip.keys[0];
    if (first) this.load({ ...first.pose, name: clip.name });
    this.syncLine();
    this.showAt(0);
    this.draw();
  }

  /** Draw the clip at a moment, without touching the dials. */
  private showAt(t: number): void {
    const sampled = sampleClip(this.clip, t);
    if (!sampled) { this.applyToModel(); return; }
    this.queen.restore(this.groups.flatMap((g) => g.bones));
    this.queen.applyRotations(blendInto(new Map<string, PoseQuat>(), sampled, 1));
  }

  /** Put the scrubber, the clock and the PLAY label back in agreement. */
  private syncLine(): void {
    if (this.scrub) {
      this.scrub.max = String(Math.max(0.1, this.clip.duration));
      this.scrub.value = String(Math.min(this.head, this.clip.duration));
    }
    if (this.playButton) this.playButton.textContent = this.playing ? 'STOP' : 'PLAY';
    if (this.timeLabel) {
      const on = keyAt(this.clip, this.head) ? '*' : '';
      this.timeLabel.textContent =
        `${this.head.toFixed(2)}${on}/${this.clip.duration.toFixed(1)}s · ${this.clip.keys.length}k`;
    }
  }

  private applyToModel(): void {
    /* Rest first, then the pose — otherwise a bone dropped from the pose
     * keeps the last rotation it was given and the editor slowly fills up
     * with corrections nothing is asking for. */
    this.queen.restore(this.groups.flatMap((g) => g.bones));
    this.queen.applyRotations(blendInto(new Map<string, PoseQuat>(), this.pose, 1));
  }

  private pick(group: PoseGroup | null): void {
    this.picked = group;
    if (group && !this.dial.has(group.key)) {
      this.dial.set(group.key, { pitch: 0, yaw: 0, roll: 0 });
    }
    this.buildGroupRow();
    this.draw();
  }

  /* --------------------------------------------------------------- the UI */

  private buildUi(): void {
    const panel = document.createElement('div');
    panel.className = 'pose-panel';
    this.host.appendChild(panel);
    this.cleanups.push(() => panel.remove());

    const row = document.createElement('div');
    row.className = 'pose-row';
    row.id = 'pose-groups';
    panel.appendChild(row);

    const sliders = document.createElement('div');
    sliders.className = 'pose-sliders';
    panel.appendChild(sliders);

    for (const axis of AXES) {
      const wrap = document.createElement('label');
      wrap.className = 'pose-slider';
      const label = document.createElement('span');
      label.textContent = axis.label;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(-SWING_DEG);
      slider.max = String(SWING_DEG);
      slider.step = '1';
      slider.value = '0';
      slider.dataset.axis = axis.key;
      slider.addEventListener('input', () => {
        if (!this.picked) return;
        const d = this.dial.get(this.picked.key);
        if (!d) return;
        d[axis.key] = Number(slider.value);
        this.rebuild();
      });
      wrap.append(label, slider);
      sliders.appendChild(wrap);
    }

    const buttons = document.createElement('div');
    buttons.className = 'pose-row';
    const button = (text: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.className = 'pose-button';
      b.textContent = text;
      b.addEventListener('click', onClick);
      buttons.appendChild(b);
    };
    button('ZERO', () => {
      if (!this.picked) return;
      this.dial.set(this.picked.key, { pitch: 0, yaw: 0, roll: 0 });
      this.buildGroupRow();
      this.rebuild();
    });
    button('ZERO ALL', () => {
      this.dial.clear();
      for (const g of this.groups) this.dial.set(g.key, { pitch: 0, yaw: 0, roll: 0 });
      this.buildGroupRow();
      this.rebuild();
    });
    button('SAVE', () => {
      this.rebuild();
      const name = this.pose.name;
      if (!name || name === 'Untitled') return;
      /*
       * A CLIP IF IT HAS KEYS, A POSE IF IT HAS NOT, and the author never has
       * to say which. A single shape held still is a pose; the moment it has
       * a timeline it is a clip. Two books, one button — and the list below
       * offers both, so loading is the same act either way.
       */
      if (this.clip.keys.length > 0) this.clipStore.save({ ...this.clip, name });
      else this.store.save(this.pose);
      this.refreshList();
      this.draw();
    });
    button('REVERT', () => {
      const name = this.list?.value;
      if (!name) return;
      if (this.clipStore.get(name)) {
        const clip = this.clipStore.revert(name);
        this.refreshList();
        if (clip) this.loadClip(clip);
        return;
      }
      const back = this.store.revert(name);
      this.refreshList();
      if (back) this.load(back);
    });
    button('EXPORT', () => {
      /* Both books, in one file, under the names the game will look them up
       * by — a download that only carried half of what is on screen would be
       * a trap. */
      const text = `${JSON.stringify({
        poses: JSON.parse(this.store.exportJson()),
        clips: JSON.parse(this.clipStore.exportJson()),
      }, null, 2)}\n`;
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'poses.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    /* The actions and the name share ONE row. Two rows cost a whole line of
     * a 430-pixel-tall phone held sideways, which is the shape this is most
     * likely to be used in; wrapping puts them back on two when there is no
     * width for one. */
    this.nameBox = document.createElement('input');
    this.nameBox.type = 'text';
    this.nameBox.value = 'Untitled';
    this.nameBox.className = 'pose-text';
    this.nameBox.addEventListener('input', () => this.rebuild());
    this.list = document.createElement('select');
    this.list.className = 'pose-button';
    this.list.addEventListener('change', () => {
      const name = this.list?.value;
      if (!name) return;
      /* Clips first: a name in both books is one the author has turned from a
       * pose into an animation, and the animation is what they meant. */
      const clip = this.clipStore.get(name);
      if (clip) { this.loadClip(clip); return; }
      const found = this.store.get(name);
      if (found) this.load(found);
    });
    buttons.append(this.nameBox, this.list);
    panel.appendChild(buttons);

    /*
     * THE TIMELINE. Key, delete, play, and a scrubber.
     *
     * The dials stay the truth while the playhead sits ON a key or on empty
     * time — that is authoring. The moment playback runs, the CLIP is the
     * truth and the dials follow it, so what you see playing is what is
     * stored rather than a second interpretation of it.
     */
    const line = document.createElement('div');
    line.className = 'pose-row pose-line';

    const lineButton = (text: string, onClick: () => void): HTMLButtonElement => {
      const el = document.createElement('button');
      el.className = 'pose-button';
      el.textContent = text;
      el.addEventListener('click', onClick);
      line.appendChild(el);
      return el;
    };

    lineButton('KEY', () => {
      this.rebuild();
      this.clip = putKey(this.clip, this.head, {
        name: this.clip.name, rotations: { ...this.pose.rotations },
      });
      /* A key past the end would be unreachable — the clip grows to hold it
       * rather than silently swallowing the thing just asked for. */
      this.clip.duration = Math.max(this.clip.duration, neededDuration(this.clip));
      this.syncLine();
      this.draw();
    });
    lineButton('DEL', () => {
      this.clip = dropKey(this.clip, this.head);
      this.syncLine();
      this.draw();
    });
    this.playButton = lineButton('PLAY', () => {
      this.playing = !this.playing;
      this.lastFrameMs = 0;
      this.syncLine();
    });
    lineButton('CLEAR', () => {
      this.clip = emptyClip(this.clip.name, this.clip.duration);
      this.head = 0;
      this.playing = false;
      this.syncLine();
      this.draw();
    });

    this.scrub = document.createElement('input');
    this.scrub.type = 'range';
    this.scrub.min = '0';
    this.scrub.step = '0.01';
    this.scrub.value = '0';
    this.scrub.className = 'pose-scrub';
    this.scrub.addEventListener('input', () => {
      this.playing = false;
      this.head = Number(this.scrub?.value ?? 0);
      /* Scrubbing SHOWS the clip; it does not rewrite the dials, so letting
       * go leaves the pose you were building exactly as it was. */
      this.showAt(this.head);
      this.syncLine();
      this.draw();
    });
    line.appendChild(this.scrub);

    this.timeLabel = document.createElement('span');
    this.timeLabel.className = 'pose-time';
    line.appendChild(this.timeLabel);

    panel.appendChild(line);

    this.readout = document.createElement('div');
    this.readout.className = 'pose-readout';
    this.readout.style.pointerEvents = 'none';
    this.host.appendChild(this.readout);
    this.cleanups.push(() => this.readout?.remove());
  }

  private buildGroupRow(): void {
    const row = this.host.querySelector('#pose-groups');
    if (!row) return;
    row.textContent = '';
    for (const group of this.groups) {
      const b = document.createElement('button');
      b.className = 'pose-button';
      if (this.picked?.key === group.key) b.classList.add('is-on');
      const d = this.dial.get(group.key);
      const posed = d && (d.pitch || d.yaw || d.roll);
      /* A dot on every group that has been moved — otherwise a pose with one
       * bent antenna is indistinguishable from rest until you click all
       * fourteen handles looking for it. */
      b.textContent = posed ? `${group.label} •` : group.label;
      b.addEventListener('click', () => this.pick(group));
      row.appendChild(b);
    }
    const d = this.picked ? this.dial.get(this.picked.key) : null;
    for (const slider of this.host.querySelectorAll<HTMLInputElement>('input[data-axis]')) {
      slider.value = String(d ? d[slider.dataset.axis as Axis] : 0);
    }
    /* The row only exists once the model has loaded, and it is most of the
     * panel's height — so what the camera has to clear is only knowable
     * after this has run. */
    this.resize();
  }

  private refreshList(): void {
    if (!this.list) return;
    const chosen = this.list.value;
    this.list.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— saved —';
    this.list.appendChild(none);
    /* Both books in one list, clips marked, so loading a saved thing is one
     * act whether it is a single shape or an animation. */
    const seen = new Set<string>();
    for (const name of this.clipStore.names()) {
      seen.add(name);
      const o = document.createElement('option');
      o.value = name;
      const keys = this.clipStore.get(name)?.keys.length ?? 0;
      o.textContent = `${name} (${keys}k)${this.clipStore.isEdited(name) ? ' *' : ''}`;
      this.list.appendChild(o);
    }
    for (const name of this.store.names()) {
      if (seen.has(name)) continue;
      const o = document.createElement('option');
      o.value = name;
      o.textContent = this.store.isEdited(name) ? `${name} *` : name;
      this.list.appendChild(o);
    }
    this.list.value = chosen;
  }

  /**
   * Put a saved pose back on the dials.
   *
   * The dials are the editor's truth, so loading has to run the rebuild
   * BACKWARDS: read each group's stored quaternion, undo the per-bone share,
   * and recover the angles. Only groups the pose actually names are touched.
   */
  private load(pose: AntPose): void {
    this.dial.clear();
    for (const group of this.groups) {
      const q = pose.rotations[group.bones[0]!];
      const dial: Record<Axis, number> = { pitch: 0, yaw: 0, roll: 0 };
      if (q) {
        const e = new THREE.Euler().setFromQuaternion(
          Q.set(q[0], q[1], q[2], q[3]), 'XYZ',
        );
        const back = group.bones.length * (180 / Math.PI);
        dial.pitch = Math.round(e.x * back);
        dial.yaw = Math.round(e.y * back);
        dial.roll = Math.round(e.z * back);
      }
      this.dial.set(group.key, dial);
    }
    if (this.nameBox) this.nameBox.value = pose.name;
    this.buildGroupRow();
    this.rebuild();
  }

  private draw(): void {
    if (!this.readout) return;
    const mm = CASTE_LENGTH_MM[this.queen.rig.caste];
    const posed = this.groups.filter((g) => {
      const d = this.dial.get(g.key);
      return d && (d.pitch || d.yaw || d.roll);
    });
    const d = this.picked ? this.dial.get(this.picked.key) : null;
    /* THREE SHORT LINES. It was five, and with the panel below it the ant
     * had a strip of screen left to be looked at in — which is the whole
     * point of the scene. Everything still here is something you cannot get
     * from looking at her: what the pose is called, what the selected handle
     * is doing in degrees, and how much of her is posed at all. */
    this.readout.innerHTML = [
      `<b>${this.pose.name}</b> · ${this.queen.rig.caste} ${mm} mm`
        + `${this.store.persistent ? '' : ' · memory only'}`,
      this.picked
        ? `${this.picked.label} (${this.picked.bones.length}) `
          + `${d?.pitch ?? 0}° / ${d?.yaw ?? 0}° / ${d?.roll ?? 0}°`
        : 'no group',
      this.clip.keys.length
        ? `${this.playing ? '▶' : '❚❚'} ${this.clip.keys.length} keys · `
          + `${this.head.toFixed(2)}/${this.clip.duration.toFixed(1)}s`
          + `${this.clip.loop ? ' · loop' : ''}`
        : `posed ${posed.length}/${this.groups.length} · `
          + `${Object.keys(this.pose.rotations).length} bones`,
    ].join('<br>');
  }

  /* ----------------------------------------------------------- the camera */

  private bindOrbit(): void {
    const el = this.renderer.domElement;
    const down = (e: PointerEvent) => {
      this.dragging = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (this.dragging !== e.pointerId) return;
      this.orbit -= (e.clientX - this.lastX) * 0.01;
      this.tilt = Math.max(-1.2, Math.min(1.2, this.tilt + (e.clientY - this.lastY) * 0.01));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (this.dragging === e.pointerId) this.dragging = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.zoom = Math.max(1.2, Math.min(14, this.zoom * (1 + e.deltaY * 0.001)));
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    this.cleanups.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    });
  }

  private resize(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    const panel = this.host.querySelector('.pose-panel');
    this.panelShare = panel ? Math.min(0.6, panel.getBoundingClientRect().height / h) : 0;
    /*
     * `setSize(w, h)` — WITHOUT the third argument, and that argument was the
     * whole bug.
     *
     * `updateStyle: false` skips setting the canvas's CSS size, leaving it to
     * fall back on its width/height ATTRIBUTES as if they were CSS pixels.
     * Those attributes are the drawing buffer, which is `size x pixelRatio` —
     * so on a device at two dots per pixel the canvas was laid out at 2560 by
     * 1600 inside a 1280 by 800 window and only its top-left quarter was on
     * screen. The render was correct throughout: an ant centred in the full
     * image lands exactly in the bottom-right corner of a quarter of it,
     * which is precisely what the device showed and what every projection
     * measurement said could not be happening.
     */
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private frame = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.frame);
    /*
     * HER OWN PER-FRAME PASS RUNS FIRST, then the pose on top.
     *
     * The editor used to skip `update` entirely — it has no gait to show, so
     * it looked like dead weight. It is not: `update` is where the body bone
     * is placed each frame, and without it she was drawn somewhere other than
     * where her own scene graph said she was. Every measurement said centred
     * and the picture said bottom-right, which is exactly what a skeleton
     * that has never been posed looks like.
     *
     * `dt` is nought, so the gait's cycle does not advance and she stands
     * still — and running it in this order is also how a pose is meant to
     * compose in the game: the live system writes, the pose blends over it.
     */
    if (this.queen.ready) {
      this.queen.update(0, {
        speed: 0, turn: 0, digging: 0, carrying: 0,
      });
      /*
       * PLAYING, THE CLIP IS THE TRUTH. Real elapsed time rather than a
       * fixed step, so a clip authored at two seconds lasts two seconds on a
       * slow phone as well as a fast desktop — a timeline that ran at frame
       * rate would be a different animation on every device.
       */
      if (this.playing && this.clip.keys.length > 0) {
        const now = performance.now();
        const dt = this.lastFrameMs ? Math.min(0.25, (now - this.lastFrameMs) / 1000) : 0;
        this.lastFrameMs = now;
        this.head += dt;
        if (this.head > this.clip.duration) {
          if (this.clip.loop) this.head %= Math.max(0.001, this.clip.duration);
          else { this.head = this.clip.duration; this.playing = false; }
        }
        this.showAt(this.head);
        this.syncLine();
      } else {
        this.applyToModel();
      }
    }
    /*
     * FRAMED FROM HER OWN SIZE, the way the queen preview does it. The first
     * cut hard-coded four world units and a look-target of 0.35, which put a
     * nine-millimetre ant — 1.8 voxels long — off in a corner of the shot,
     * and would have silently re-framed itself the next time a caste's
     * length changed. `zoom` is a multiple of however big she happens to be.
     */
    const reach = Math.max(0.4, this.queen.lengthVoxels) * this.zoom * 0.75;
    const centre = this.queen.lengthVoxels * 0.18;
    /*
     * AND LIFTED CLEAR OF THE PANEL. The controls cover the bottom of the
     * canvas, so centring her in the CANVAS centres her behind them. Looking
     * a little below her centre lifts her into the part that is actually
     * visible, by however much the panel is actually covering — measured, so
     * it stays right when the panel wraps to another row on a narrow phone.
     */
    const lift = reach * this.panelShare * 0.5;
    this.camera.position.set(
      Math.sin(this.orbit) * Math.cos(this.tilt) * reach,
      centre + Math.sin(this.tilt) * reach + reach * 0.22,
      Math.cos(this.orbit) * Math.cos(this.tilt) * reach,
    );
    this.camera.lookAt(0, centre - lift, 0);
    this.renderer.render(this.scene, this.camera);
  };

  /** For tests and probes: the pose as it stands, without touching the DOM. */
  poseForTest(): AntPose {
    return this.pose;
  }

  /** For probes: turn a group by hand, as the sliders would. */
  setDialForTest(key: string, axis: Axis, deg: number): void {
    if (!this.dial.has(key)) this.dial.set(key, { pitch: 0, yaw: 0, roll: 0 });
    this.dial.get(key)![axis] = deg;
    this.rebuild();
  }

  get ready(): boolean {
    return this.queen.ready && this.groups.length > 0;
  }

  dispose(): void {
    this.disposed = true;
    for (const fn of this.cleanups) fn();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export const POSE_SWING_DEG = SWING_DEG;
export const POSE_VOXEL_MM = VOXEL_MM;
