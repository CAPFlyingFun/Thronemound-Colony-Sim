/**
 * The first-person dig HUD, per the approved mock: an aviator's layout worn
 * by a digging ant.
 *
 * The mapping, instrument for instrument, as it was specified: the airspeed
 * tape carries DIG — millimetres of tunnel driven this bore; the altimeter
 * carries DEPTH below the undug land; the VSI beside it carries the PITCH of
 * the aim, needle below level when she is set to descend; the heading sits in
 * a fan at the top; and the middle is a pitch ladder behind a fixed
 * circle-and-wings marker that is exactly where the jaws will land, because
 * in first person the look IS the aim.
 *
 * One symbology, two looks, no code for the second one: over the sky it
 * reads as a combiner HUD, and in a tunnel the dark soil behind it is the
 * black of a panel display.
 *
 * Everything here is a number the scene already computes — depth is the
 * wedged measure, soil is the carve's own tally — so the HUD is
 * instrumentation, not decoration: if it disagrees with the game, one of
 * them is wrong and it matters which.
 */

const NS = 'http://www.w3.org/2000/svg';
const GREEN = '#86ffb0';

/** Everything the HUD shows, handed in once a frame. */
export interface DigHudState {
  headingDeg: number;
  pitchDeg: number;
  /** Millimetres of tunnel driven since the dig was last pressed. */
  digMm: number;
  /** Millimetres below the undug land; zero and clamped on the surface. */
  depthMm: number;
  /** Ground speed in millimetres per second. */
  gsMmS: number;
  /** Total soil removed, cubic millimetres. */
  soilMm3: number;
  cutting: boolean;
}

/** Pixels per degree on the pitch ladder. */
const LADDER_SCALE = 9;
/** Pixels per millimetre on the two tapes. */
const TAPE_SCALE = 22;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string>, parent: SVGElement | null,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent?.appendChild(node);
  return node;
}

function text(
  x: number, y: number, content: string, parent: SVGElement, anchor = 'start', small = false,
): SVGTextElement {
  const node = el('text', {
    x: String(x), y: String(y), 'text-anchor': anchor,
    ...(small ? { class: 'small' } : {}),
  }, parent);
  node.textContent = content;
  return node;
}

/** One tape slot: a tick and its label, repositioned as the value scrolls. */
interface TapeSlot { tick: SVGLineElement; label: SVGTextElement; }

export class DigHud {
  readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly ladder: SVGGElement;
  private readonly headingText: SVGTextElement;
  private readonly digText: SVGTextElement;
  private readonly depthText: SVGTextElement;
  private readonly pitchNeedle: SVGLineElement;
  private readonly pitchText: SVGTextElement;
  private readonly gsText: SVGTextElement;
  private readonly stateText: SVGTextElement;
  private readonly soilText: SVGTextElement;
  private readonly digSlots: TapeSlot[] = [];
  private readonly depthSlots: TapeSlot[] = [];
  private shown = true;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'density-lab-fphud';
    this.svg = el('svg', {
      viewBox: '0 0 932 430', preserveAspectRatio: 'xMidYMid meet',
    }, null);
    this.root.appendChild(this.svg);

    // Heading fan, top centre.
    for (const d of [-30, -20, -10, 0, 10, 20, 30]) {
      const x = 466 + d * 3.4;
      el('line', {
        x1: String(x), y1: '52', x2: String(x), y2: d === 0 ? '38' : '44',
      }, this.svg);
    }
    el('polygon', { points: '466,60 459,74 473,74' }, this.svg);
    this.headingText = text(466, 96, 'H 000', this.svg, 'middle');

    /*
     * The pitch ladder, clipped to the middle of the frame and translated as
     * one group — the lines were placed once at their zero-pitch heights, so
     * moving the group by pitch times the scale IS the attitude indicator.
     */
    const clip = el('clipPath', { id: 'fphud-ladder-clip' }, this.svg);
    el('rect', { x: '250', y: '95', width: '432', height: '280' }, clip);
    const clipped = el('g', { 'clip-path': 'url(#fphud-ladder-clip)' }, this.svg);
    this.ladder = el('g', {}, clipped);
    for (let line = -80; line <= 40; line += 10) {
      const y = 235 - line * LADDER_SCALE;
      const dash: Record<string, string> = line < 0 ? { 'stroke-dasharray': '14 10' } : {};
      const bar = line === 0 ? 140 : 90;
      const g = el('g', dash, this.ladder);
      el('line', { x1: String(466 - 46 - bar), y1: String(y), x2: String(466 - 46), y2: String(y) }, g);
      el('line', { x1: String(466 + 46), y1: String(y), x2: String(466 + 46 + bar), y2: String(y) }, g);
      if (line !== 0) {
        const lip = line > 0 ? 10 : -10;
        el('line', { x1: String(466 - 46 - bar), y1: String(y), x2: String(466 - 46 - bar), y2: String(y + lip) }, g);
        el('line', { x1: String(466 + 46 + bar), y1: String(y), x2: String(466 + 46 + bar), y2: String(y + lip) }, g);
        text(466 - 46 - bar - 14, y + 5, String(line), g, 'end');
        text(466 + 46 + bar + 14, y + 5, String(line), g);
      }
    }

    // The aim: where the jaws are pointed. Fixed centre, circle and wings.
    el('circle', { cx: '466', cy: '235', r: '9' }, this.svg);
    el('line', { x1: '440', y1: '235', x2: '457', y2: '235' }, this.svg);
    el('line', { x1: '475', y1: '235', x2: '492', y2: '235' }, this.svg);
    el('line', { x1: '466', y1: '219', x2: '466', y2: '226' }, this.svg);

    // Left: tunnel driven this bore.
    text(150, 118, 'DIG mm', this.svg, 'start', true);
    el('line', { x1: '190', y1: '130', x2: '190', y2: '340' }, this.svg);
    for (let k = 0; k < 9; k += 1) {
      this.digSlots.push({
        tick: el('line', {}, this.svg),
        label: text(166, 0, '', this.svg, 'end'),
      });
      this.depthSlots.push({
        tick: el('line', {}, this.svg),
        label: text(730, 0, '', this.svg),
      });
    }
    el('polyline', { points: '196,222 146,222 146,248 196,248 208,235 196,222', fill: 'rgba(0,20,6,0.55)' }, this.svg);
    this.digText = text(152, 242, '0.0', this.svg);

    /*
     * Right: depth below the undug land. Everything on this side ends by
     * x = 756, because the action buttons are wider ON THE DEVICE than in a
     * headless run — measured from a play screenshot with the DIG button's
     * left edge at 771, sitting over the old readout, the pitch dial and
     * the soil line all at once. The headless check renders the same
     * viewBox with narrower buttons, which is exactly how the collision
     * shipped unseen.
     */
    text(640, 118, 'DEPTH mm', this.svg, 'start', true);
    el('line', { x1: '706', y1: '130', x2: '706', y2: '340' }, this.svg);
    el('polyline', { points: '700,222 756,222 756,248 700,248 688,235 700,222', fill: 'rgba(0,20,6,0.55)' }, this.svg);
    this.depthText = text(708, 242, '0.0', this.svg);

    // The pitch, worn like a VSI: in the top-right corner, above the reach
    // of the button column, needle below level when the aim is set to
    // descend.
    text(838, 32, 'PITCH', this.svg, 'middle', true);
    el('path', { d: 'M 838 48 A 36 36 0 0 1 838 120', 'stroke-dasharray': '3 9' }, this.svg);
    this.pitchNeedle = el('line', { x1: '838', y1: '84', x2: '808', y2: '84', 'stroke-width': '2.4' }, this.svg);
    this.pitchText = text(838, 146, '+0°', this.svg, 'middle');

    // Corners.
    this.gsText = text(140, 392, 'GS 0', this.svg);
    this.stateText = text(466, 392, 'DIG READY', this.svg, 'middle');
    this.soilText = text(756, 392, 'SOIL 0 mm³', this.svg, 'end');
    text(756, 412, 'BITE 0.5 mm', this.svg, 'end', true);
  }

  set visible(show: boolean) {
    if (show === this.shown) return;
    this.shown = show;
    this.root.style.display = show ? '' : 'none';
  }

  private tape(slots: TapeSlot[], value: number, x: number, flip: boolean): void {
    for (let k = 0; k < slots.length; k += 1) {
      const v = Math.round(value) + k - 4;
      const y = 235 - (v - value) * TAPE_SCALE;
      const slot = slots[k]!;
      // The value box owns the middle of the tape; ticks under it are noise.
      if (v < 0 || y < 132 || y > 338 || Math.abs(y - 235) < 18) {
        slot.tick.setAttribute('visibility', 'hidden');
        slot.label.setAttribute('visibility', 'hidden');
        continue;
      }
      const major = v % 5 === 0;
      slot.tick.setAttribute('visibility', 'visible');
      slot.tick.setAttribute('x1', String(x));
      slot.tick.setAttribute('y1', y.toFixed(1));
      slot.tick.setAttribute('x2', String(x + (flip ? 16 : -16) * (major ? 1 : 0.55)));
      slot.tick.setAttribute('y2', y.toFixed(1));
      if (major) {
        slot.label.setAttribute('visibility', 'visible');
        slot.label.setAttribute('y', (y + 5).toFixed(1));
        slot.label.textContent = String(v);
      } else {
        slot.label.setAttribute('visibility', 'hidden');
      }
    }
  }

  update(state: DigHudState): void {
    if (!this.shown) return;
    const heading = ((Math.round(state.headingDeg) % 360) + 360) % 360;
    this.headingText.textContent = `H ${String(heading).padStart(3, '0')}`;

    this.ladder.setAttribute('transform', `translate(0 ${(state.pitchDeg * LADDER_SCALE).toFixed(1)})`);

    this.digText.textContent = state.digMm.toFixed(1);
    this.depthText.textContent = state.depthMm.toFixed(1);
    this.tape(this.digSlots, state.digMm, 190, false);
    this.tape(this.depthSlots, state.depthMm, 706, true);

    const rad = state.pitchDeg * Math.PI / 180;
    this.pitchNeedle.setAttribute('x2', (838 - 30 * Math.cos(rad)).toFixed(1));
    this.pitchNeedle.setAttribute('y2', (84 - 30 * Math.sin(rad)).toFixed(1));
    const rounded = Math.round(state.pitchDeg);
    this.pitchText.textContent = `${rounded >= 0 ? '+' : ''}${rounded}°`;

    this.gsText.textContent = `GS ${Math.round(state.gsMmS)}`;
    this.stateText.textContent = state.cutting ? '● CUTTING' : 'DIG READY';
    this.soilText.textContent = `SOIL ${Math.round(state.soilMm3)} mm³`;
  }
}
