/**
 * Which bone should the head PIVOT on?
 *
 * Reported after testing: the joint currently being rotated sits at the
 * antenna sockets, and the turn should happen about two bones further back.
 * So this walks the real parent chain up from her mouth — the hierarchy the
 * GLB actually has, not the order a table lists — and reports where each
 * joint sits in her own frame, how far back along her body it is, and how
 * far it is from the antenna sockets.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage();
await p.goto(process.env.SMOKE_URL ?? 'http://localhost:4460/Thronemound-Colony-Sim/?scene=block', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await p.waitForTimeout(1500);
const out = await p.evaluate(() => {
  const lab = window.blockScene, MM = 5;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rig = lab.queen.rig;
  lab.queen.update(1/60, { speed: 0, turn: 0, digging: 0, carrying: 0 });
  lab.queen.root.updateMatrixWorld(true);
  const pos = (n) => { const bo = lab.queen.bones.get(n); if (!bo) return null; const v = new V(); bo.getWorldPosition(v); return v; };
  const socket = pos(rig.antennaLeft[0]);
  const jaw = pos(rig.mouth[rig.mouth.length - 1]);
  const fwd = lab.forward, up = lab.up;
  const right = new V().crossVectors(up, fwd).normalize();
  const rel = (v) => v ? {
    fwd: +(v.clone().sub(jaw).dot(fwd) * MM).toFixed(2),
    up: +(v.clone().sub(jaw).dot(up) * MM).toFixed(2),
    fromSocket: +(v.distanceTo(socket) * MM).toFixed(2),
    fromJaw: +(v.distanceTo(jaw) * MM).toFixed(2),
  } : null;
  // Walk the REAL parent chain from the mouth tip upward.
  const chain = [];
  let node = lab.queen.bones.get(rig.mouth[rig.mouth.length - 1]);
  const named = new Map();
  for (const [n] of lab.queen.bones) named.set(lab.queen.bones.get(n), n);
  while (node && chain.length < 10) {
    const n = named.get(node);
    if (!n) break;
    chain.push({ bone: n, ...rel(pos(n)) });
    node = node.parent;
  }
  return {
    chain,
    tableThorax: rig.thorax,
    tableBody: rig.body,
    tableMouth: rig.mouth,
    socketBone: rig.antennaLeft[0],
    socketRel: rel(socket),
    usingNow: rig.thorax[0],
  };
});
console.log(`table: body ${JSON.stringify(out.tableBody)}  thorax ${JSON.stringify(out.tableThorax)}  mouth ${JSON.stringify(out.tableMouth)}`);
console.log(`antenna socket bone ${out.socketBone} — ${out.socketRel.fwd} mm fwd of the jaw, ${out.socketRel.up} mm up`);
console.log(`\nREAL parent chain up from the mouth tip (all offsets relative to the jaw):`);
console.log('  bone         fwd of jaw    up from jaw   from socket   from jaw');
for (const c of out.chain) {
  const mark = c.bone === out.usingNow ? '  <-- pivoting here now' : '';
  console.log(`  ${c.bone.padEnd(11)} ${String(c.fwd).padStart(8)} mm ${String(c.up).padStart(11)} mm ${String(c.fromSocket).padStart(11)} mm ${String(c.fromJaw).padStart(9)} mm${mark}`);
}
await b.close();
