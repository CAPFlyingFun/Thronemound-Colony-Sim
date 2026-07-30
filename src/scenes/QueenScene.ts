/**
 * Queen preview — `?scene=queen`.
 *
 * The gait has to be judged by eye and there is nowhere else to see her: in the
 * dig prototype you are looking OUT of her head, so the one character in the
 * game is the one thing you never get a look at. This is a turntable with the
 * gait inputs on sliders, so walk speed, turning, digging and carrying can each
 * be pushed to the extremes where procedural animation breaks.
 *
 * Deliberately not part of the game. It loads the model, drives `QueenModel`
 * and draws a ground plane, and that is all.
 */

import * as THREE from 'three';
import { QueenModel } from '../anim/QueenModel';
import { VOXEL_MM } from '../anim/hexapod';

export class QueenScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly queen = new QueenModel();
  private readonly readout: HTMLDivElement;

  private speed = 2;
  private turn = 0;
  private digging = 0;
  private carrying = 0;
  private orbit = 0.6;
  private orbitting = false;
  private lastX = 0;
  private distance = 4;
  private lastTime = 0;
  private frames = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.scene.background = new THREE.Color(0x1b1d22);

    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2118, 1.1));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.2);
    key.position.set(3, 5, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
    rim.position.set(-3, 2, -3);
    this.scene.add(rim);

    // A one-voxel grid, so her size against the world is readable rather than
    // asserted — this is the whole reason the preview exists at real scale.
    const grid = new THREE.GridHelper(20, 20, 0x4a4f57, 0x2e3238);
    this.scene.add(grid);
    this.scene.add(this.queen.root);

    this.readout = document.createElement('div');
    this.readout.className = 'dig-hud';
    this.readout.style.pointerEvents = 'none';
    host.appendChild(this.readout);
    this.buildControls(host);
    this.bindInput();
    this.resize();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));

    void this.queen.load().then((ok) => {
      if (!ok) this.readout.textContent = 'Queen model failed to load.';
    });
    this.renderer.setAnimationLoop(this.tick);
  }

  private buildControls(host: HTMLElement): void {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:absolute;left:12px;bottom:12px;display:grid;gap:6px;'
      + 'font:12px ui-monospace,monospace;color:#e8e2d4;background:rgba(20,22,26,.82);'
      + 'padding:10px 12px;border-radius:8px;min-width:210px';
    const add = (label: string, min: number, max: number, value: number,
      set: (v: number) => void) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:grid;grid-template-columns:64px 1fr 34px;gap:8px;align-items:center';
      const name = document.createElement('span');
      name.textContent = label;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = '0.05';
      slider.value = String(value);
      const shown = document.createElement('span');
      shown.textContent = value.toFixed(2);
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        set(v);
        shown.textContent = v.toFixed(2);
      });
      row.append(name, slider, shown);
      panel.appendChild(row);
    };
    add('speed', 0, 6, this.speed, (v) => { this.speed = v; });
    add('turn', -2, 2, this.turn, (v) => { this.turn = v; });
    add('dig', 0, 1, this.digging, (v) => { this.digging = v; });
    add('carry', 0, 1, this.carrying, (v) => { this.carrying = v; });
    add('zoom', 1, 12, this.distance, (v) => { this.distance = v; });
    host.appendChild(panel);
    this.cleanups.push(() => panel.remove());
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement;
    const down = (e: PointerEvent) => { this.orbitting = true; this.lastX = e.clientX; };
    const move = (e: PointerEvent) => {
      if (!this.orbitting) return;
      this.orbit += (e.clientX - this.lastX) * 0.008;
      this.lastX = e.clientX;
    };
    const up = () => { this.orbitting = false; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    this.cleanups.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    });
  }

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    /*
     * updateStyle must stay ON, and the size must come from the HOST.
     *
     * Passing `false` sets the draw buffer but leaves the canvas element with
     * no CSS size, so it lays out at its attribute size in CSS pixels — which
     * at a device pixel ratio of 2 is TWICE the viewport. You then see the
     * top-left quarter of the render and the subject sits off in the corner.
     * Invisible on a desktop at ratio 1, which is exactly why the headless
     * check now runs at 3.
     */
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (time: number): void => {
    if (this.disposed) return;
    const dt = this.lastTime ? Math.min(0.05, (time - this.lastTime) / 1000) : 0;
    this.lastTime = time;

    // She walks on the spot: the turntable moves, not her, so the gait can be
    // watched from every angle without chasing her across the grid.
    this.queen.update(dt, {
      speed: this.speed,
      turn: this.turn,
      digging: this.digging,
      carrying: this.carrying,
    });
    if (!this.orbitting) this.orbit += dt * 0.25;

    /*
     * Framed from her own bounding box, so "zoom" is a multiple of however big
     * she happens to be. Hard-coding a distance meant every change to
     * QUEEN_LENGTH_MM silently re-framed the shot.
     */
    const reach = Math.max(0.4, this.queen.lengthVoxels) * this.distance * 0.75;
    const centre = this.queen.lengthVoxels * 0.18;
    this.camera.position.set(
      Math.sin(this.orbit) * reach,
      centre + reach * 0.38,
      Math.cos(this.orbit) * reach,
    );
    this.camera.lookAt(0, centre, 0);

    if (++this.frames % 12 === 0) {
      const mm = (this.queen.lengthVoxels * VOXEL_MM).toFixed(1);
      this.readout.innerHTML = `
        <b>Queen</b> &nbsp; ${this.queen.ready ? 'loaded' : 'loading…'} &nbsp;
        <b>${this.queen.lengthVoxels.toFixed(2)}</b> voxels (${mm} mm)<br>
        <span class="dim">v${__APP_VERSION__} · ${__BUILD_TIME__} · drag to orbit ·
        1 grid square = 1 voxel = ${VOXEL_MM} mm</span>
      `;
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.cleanups.forEach((fn) => fn());
    this.queen.dispose();
    this.readout.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
