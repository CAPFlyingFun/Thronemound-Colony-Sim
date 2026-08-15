/*
 * WHAT STRAIGHTENS THE WORM — computed off its own skeleton, not guessed.
 *
 * The earthworm's bind pose is an S. That is a perfectly good pose to
 * author and rig in, and a useless one to animate FROM: everything the
 * game asks it to do — lie in a tunnel, be dragged, be eaten — starts by
 * knowing what "straight" is, and every angle is measured against it.
 *
 * Eyeballing seventeen bones until an S looks like a line is a bad hour.
 * The rig already knows: each bone's child sits at a fixed offset in that
 * bone's own space, so "straight" is the one set of local rotations that
 * lays every one of those offsets along a single axis. That is a solve,
 * and it is this file.
 *
 * THE SOLVE. Walk the chain from the root. For a bone whose child hangs at
 * unit direction `v` in its own space, with the corrected parent frame `R`
 * already known, we want the world direction of that offset to be the
 * chosen axis `u`:
 *
 *     R * q * v = u        so        q * v = R⁻¹ * u
 *
 * `q` is then the minimal rotation taking `v` to `R⁻¹u`, which three.js
 * writes as `setFromUnitVectors`. Solved root-first, so each bone's answer
 * is expressed in a parent that is already straight.
 *
 * It reports the angles AND checks its own work: it applies them and
 * measures how far the chain deviates from the axis afterwards. A solve
 * that prints numbers without doing that is a solve you have to trust.
 *
 *   node scripts/probe-worm.mjs [model] [--write]
 *
 * `--write` saves the pose to src/scenes/wormPose.ts.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const MODEL = process.argv.find((a) => a.endsWith('.glb')) ?? 'earthworm.glb';
const WRITE = process.argv.includes('--write');
const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async (model) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { GLTFLoader } = await import(
    '/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
  );
  const gltf = await new GLTFLoader().loadAsync(`/models/${model}`);
  gltf.scene.updateMatrixWorld(true);

  /* THE LONGEST CHAIN IS THE WORM. A rig may carry stray bones — an
   * armature root, a control — and the body is simply the deepest
   * single-child run in it. */
  const roots = [];
  gltf.scene.traverse((n) => { if (n.isBone && !n.parent?.isBone) roots.push(n); });
  const runFrom = (bone) => {
    const run = [bone];
    let at = bone;
    while (at.children.filter((c) => c.isBone).length === 1) {
      at = at.children.find((c) => c.isBone);
      run.push(at);
    }
    return run;
  };
  let chain = [];
  for (const r of roots) {
    /* Descend to wherever the branching stops, then take the long run. */
    const stack = [r];
    while (stack.length) {
      const b = stack.pop();
      const kids = b.children.filter((c) => c.isBone);
      if (kids.length === 1) {
        const run = runFrom(b);
        if (run.length > chain.length) chain = run;
      }
      for (const k of kids) stack.push(k);
    }
  }
  if (chain.length < 3) return { error: `no chain found (${chain.length} bones)` };

  /* HOW BENT IT IS NOW, so the fix has something to be measured against.
   * The turn at each joint, in degrees, between one segment and the next. */
  const worldOf = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const bendBefore = [];
  for (let i = 1; i + 1 < chain.length; i += 1) {
    const a = worldOf(chain[i]).sub(worldOf(chain[i - 1])).normalize();
    const b = worldOf(chain[i + 1]).sub(worldOf(chain[i])).normalize();
    bendBefore.push((Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI);
  }

  /*
   * THE AXIS IS THE ROOT'S OWN FIRST SEGMENT, not the line from head to
   * tail. On an S those are wildly different — the ends can even point
   * back at each other — and straightening onto the head-to-tail line
   * would swing the whole animal rather than unbending it. Taking the
   * first segment means the head stays where it is and the body comes
   * into line behind it.
   */
  const axis = worldOf(chain[1]).sub(worldOf(chain[0])).normalize();

  const pose = [];
  const parentWorld = new THREE.Quaternion();
  const rest = [];
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const bone = chain[i];
    const child = chain[i + 1];
    rest.push(bone.quaternion.clone());
    /* Where the child hangs, in this bone's OWN space — a constant of the
     * rig, untouched by any rotation we choose. */
    const v = child.position.clone().normalize();
    /* The axis, brought into the parent's corrected frame. */
    const want = axis.clone().applyQuaternion(parentWorld.clone().invert());
    const q = new THREE.Quaternion().setFromUnitVectors(v, want);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const deg = (r) => +((r * 180) / Math.PI).toFixed(3);
    pose.push({
      bone: bone.name,
      child: child.name,
      euler: [deg(e.x), deg(e.y), deg(e.z)],
      quat: [+q.x.toFixed(6), +q.y.toFixed(6), +q.z.toFixed(6), +q.w.toFixed(6)],
      /* How far this joint had to move — the number that says which joints
       * carry the S and which were already straight. */
      fromRest: deg(bone.quaternion.angleTo(q)),
    });
    bone.quaternion.copy(q);
    parentWorld.multiply(q);
  }

  /* AND CHECK IT. Re-solve the world matrices with the pose applied and
   * measure what is left of the bend. */
  gltf.scene.updateMatrixWorld(true);
  const bendAfter = [];
  for (let i = 1; i + 1 < chain.length; i += 1) {
    const a = worldOf(chain[i]).sub(worldOf(chain[i - 1])).normalize();
    const b = worldOf(chain[i + 1]).sub(worldOf(chain[i])).normalize();
    bendAfter.push((Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI);
  }
  const span = worldOf(chain[chain.length - 1]).distanceTo(worldOf(chain[0]));
  let along = 0;
  for (let i = 1; i < chain.length; i += 1) {
    along += worldOf(chain[i]).distanceTo(worldOf(chain[i - 1]));
  }

  const worst = (xs) => Math.max(...xs);
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  return {
    model,
    bones: chain.map((b) => b.name),
    pose,
    bendBefore: { worst: +worst(bendBefore).toFixed(2), mean: +mean(bendBefore).toFixed(2) },
    bendAfter: { worst: +worst(bendAfter).toFixed(3), mean: +mean(bendAfter).toFixed(3) },
    /* End-to-end distance over path length: 1 is a straight line. */
    straightness: +(span / along).toFixed(5),
  };
}, MODEL);

await browser.close();

if (out.error) { console.log(out.error); process.exit(1); }

console.log(`\nSTRAIGHTENING ${out.model.toUpperCase()} — ${out.bones.length} bones in the body chain\n`);
console.log('  bone                       X       Y       Z    moved');
for (const p of out.pose) {
  const pad = (v, n) => String(v).padStart(n);
  console.log(`  ${p.bone.padEnd(22)} ${pad(p.euler[0], 7)} ${pad(p.euler[1], 7)}`
    + ` ${pad(p.euler[2], 7)} ${pad(p.fromRest, 8)}   (degrees)`);
}
console.log(`\n  bend at the joints   before  worst ${out.bendBefore.worst}  mean ${out.bendBefore.mean}`);
console.log(`                       after   worst ${out.bendAfter.worst}  mean ${out.bendAfter.mean}`);
console.log(`  straightness (1 = a line): ${out.straightness}`);

/*
 * AND THE ANSWER IS SIMPLER THAN THE SOLVE. If every bone below the root
 * comes out at identity, the S lives entirely in the bones' REST
 * rotations — so "straight" is not a pose to store, it is the absence of
 * one: zero the body bones and the animal lays out on its own.
 */
const BENT = 0.05;
const moved = out.pose.filter((p, i) => i > 0 && Math.abs(1 - Math.abs(p.quat[3])) > BENT);
if (moved.length === 0) {
  console.log('\n  EVERY body bone straightens to IDENTITY. The S is entirely in the'
    + '\n  rest rotations, so straight is ZERO on all of them — only the root'
    + '\n  carries a rotation, and that only decides which way she points.');
} else {
  console.log(`\n  ${moved.length} bone(s) need a real rotation: `
    + moved.map((m) => m.bone).join(', '));
}
if (errs.length) console.log('\npage errors:', errs.slice(0, 2).join(' | '));

if (WRITE) {
  const body = `/**
 * THE POSE THAT STRAIGHTENS THE WORM — solved, not authored.
 *
 * The earthworm's bind pose is an S, which is fine to rig in and useless
 * to animate from: every motion the game gives it is measured against
 * straight, so straight has to exist first. These are the local rotations
 * that lay every bone's child-offset along the chain's own first segment.
 *
 * Generated by \`npm run probe:worm -- --write\`. Solved rather than typed,
 * so a re-export of the model regenerates rather than being hand-nudged:
 * it took the joints from a mean bend of ${out.bendBefore.mean}° to
 * ${out.bendAfter.mean}°, and the chain to a straightness of
 * ${out.straightness} where 1 is a line.
 *
 * The axis is the ROOT'S FIRST SEGMENT, not head-to-tail. On an S those
 * are wildly different — the ends can point back at each other — so
 * straightening onto head-to-tail would swing the whole animal instead of
 * unbending it. This way the head stays put and the body lines up behind.
 */
export interface BonePose {
  readonly bone: string;
  /** Local rotation, as a quaternion: x, y, z, w. */
  readonly quat: readonly [number, number, number, number];
}

export const WORM_STRAIGHT: readonly BonePose[] = [
${out.pose.map((p) => `  { bone: '${p.bone}', quat: [${p.quat.join(', ')}] },`).join('\n')}
];
`;
  writeFileSync('src/scenes/wormPose.ts', body);
  console.log('\nwritten to src/scenes/wormPose.ts');
}

if (out.bendAfter.worst > 1) {
  console.log(`\nFAILED: ${out.bendAfter.worst}° of bend left — the solve did not straighten it`);
  process.exit(1);
}
console.log('\nall green — the chain lies on one axis');
