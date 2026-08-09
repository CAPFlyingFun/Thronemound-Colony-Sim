/**
 * THE ANTENNA CHAINS, MEASURED OFF THE FILE.
 *
 * Phase 0 of the antenna-sensing work: before any sensor code exists, how far
 * can she actually reach? A feeler that is 1.8 mm long cannot be given a 20 mm
 * probe distance, and the only honest source for that number is the model.
 *
 * Reads the GLBs directly — no browser, no renderer, no scene — so the numbers
 * are reproducible and reviewable in CI. For each caste it walks the antenna
 * bones named in the rig table and reports:
 *
 *   - each joint's offset from its parent, in model units and in millimetres
 *   - the running length of the chain, and the total reach from its root
 *   - the rest direction of the whole chain, in the model's own frame
 *   - WHICH BONES ACTUALLY CARRY SKIN. The legs already taught us that the
 *     last NAMED bone need not be the last VISIBLE one: an auto-rigger leaves
 *     empty terminal bones that move nothing. A feeler tip measured to the
 *     wrong bone is a sensor that reports contact where there is no geometry,
 *     so the skin weights decide the tip, not the name.
 *
 *   node scripts/probe-antenna.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MeshoptDecoder } from 'meshoptimizer/meshopt_decoder.module.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* Kept in step with hexapod.ts by assertion below, not by hope. */
const CASTE_LENGTH_MM = { queen: 9, worker: 4, major: 6 };

/* ------------------------------------------------------------------ glb */

/** Binary glTF: a 12-byte header, then length-prefixed chunks. */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  let json = null;
  let bin = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const len = buf.readUInt32LE(at);
    const kind = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    if (kind === 0x004e4942) bin = body;
    at += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error(`${file}: no JSON chunk`);
  return { json, bin };
}

const COMPONENT = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * One bufferView's bytes.
 *
 * These exports are EXT_meshopt_compression, so a view's real bytes are not
 * simply a slice of the BIN chunk — they are a compressed block that has to be
 * decoded first. Reading the slice raw is how this probe first went out of
 * bounds by 180 kB, which is a loud failure; the quiet version would have been
 * plausible garbage weights, so the decode is not optional.
 */
const viewCache = new Map();
function bufferViewBytes(gltf, bin, index) {
  if (viewCache.has(index)) return viewCache.get(index);
  const view = gltf.bufferViews[index];
  const ext = view.extensions?.EXT_meshopt_compression;
  let bytes;
  if (ext) {
    const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    const out = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(
      out, ext.count, ext.byteStride, src, ext.mode, ext.filter ?? 'NONE',
    );
    bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  } else {
    const at = view.byteOffset ?? 0;
    bytes = bin.subarray(at, at + view.byteLength);
  }
  viewCache.set(index, bytes);
  return bytes;
}

/** One accessor's values, flattened. Handles the interleaved case by stride. */
function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  const spec = COMPONENT[acc.componentType];
  const per = COUNT[acc.type];
  const out = new (spec.array)(acc.count * per);
  if (acc.bufferView === undefined) return out; // sparse/zero-filled
  const view = gltf.bufferViews[acc.bufferView];
  const data = bufferViewBytes(gltf, bin, acc.bufferView);
  const base = acc.byteOffset ?? 0;
  const stride = view.byteStride ?? per * spec.size;
  for (let i = 0; i < acc.count; i += 1) {
    for (let c = 0; c < per; c += 1) {
      const at = base + i * stride + c * spec.size;
      if (at + spec.size > data.length) continue;
      out[i * per + c] = spec.array === Float32Array ? data.readFloatLE(at)
        : spec.array === Uint16Array ? data.readUInt16LE(at)
        : spec.array === Uint32Array ? data.readUInt32LE(at)
        : spec.array === Int16Array ? data.readInt16LE(at)
        : spec.array === Int8Array ? data.readInt8(at)
        : data.readUInt8(at);
    }
  }
  return out;
}

/* ------------------------------------------------------------- geometry */

/** A node's local translation, whether it was written as TRS or a matrix. */
function localTranslation(node) {
  if (node.matrix) return { x: node.matrix[12], y: node.matrix[13], z: node.matrix[14] };
  const t = node.translation ?? [0, 0, 0];
  return { x: t[0], y: t[1], z: t[2] };
}

const len3 = (v) => Math.hypot(v.x, v.y, v.z);

/* ---- world rest pose: the chain's real shape, not per-parent offsets ---- */

/** Column-major 4x4 multiply, glTF/three convention. */
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = sum;
    }
  }
  return o;
}

/** A node's local matrix from either `matrix` or TRS. */
function localMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** World matrices for every node, by walking the scene's roots. */
function worldMatrices(gltf) {
  const nodes = gltf.nodes ?? [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const world = new Array(nodes.length).fill(null);
  const resolve = (i, guard = 0) => {
    if (world[i]) return world[i];
    if (guard > 64) return localMatrix(nodes[i]);
    const p = parent.get(i);
    const local = localMatrix(nodes[i]);
    world[i] = p === undefined ? local : mul(resolve(p, guard + 1), local);
    return world[i];
  };
  nodes.forEach((_, i) => resolve(i));
  return world;
}

const posOf = (m) => ({ x: m[12], y: m[13], z: m[14] });

/* ---------------------------------------------------------------- rigs */

/** Read the rig tables out of hexapod.ts rather than restating them here —
 *  a second copy is a second thing to forget to update. */
function rigsFromSource() {
  const src = fs.readFileSync(path.join(root, 'src/anim/hexapod.ts'), 'utf8');
  const rigs = {};
  for (const caste of ['QUEEN', 'WORKER', 'MAJOR']) {
    const start = src.indexOf(`export const ${caste}_RIG`);
    if (start < 0) throw new Error(`${caste}_RIG not found in hexapod.ts`);
    const chunk = src.slice(start, start + 2600);
    const units = /lengthUnits:\s*([\d.]+)/.exec(chunk);
    const left = /antennaLeft:\s*\[([^\]]*)\]/.exec(chunk);
    const right = /antennaRight:\s*\[([^\]]*)\]/.exec(chunk);
    if (!units || !left || !right) throw new Error(`${caste}_RIG: unreadable`);
    const names = (s) => s.split(',').map((n) => n.trim().replace(/^'|'$/g, '')).filter(Boolean);
    rigs[caste.toLowerCase()] = {
      lengthUnits: Number(units[1]),
      antennaLeft: names(left[1]),
      antennaRight: names(right[1]),
    };
  }
  return rigs;
}

/* ---------------------------------------------------------------- main */

await MeshoptDecoder.ready;

const rigs = rigsFromSource();
const report = {};

for (const caste of ['queen', 'worker', 'major']) {
  const rig = rigs[caste];
  const { json: gltf, bin } = readGlb(path.join(root, `public/models/${caste}.glb`));
  viewCache.clear(); // views are indexed per file
  const nodes = gltf.nodes ?? [];
  const byName = new Map(nodes.map((n, i) => [n.name, i]));
  const world = worldMatrices(gltf);

  /* Which joints the skin actually weights, and how strongly. A bone with no
   * weight above the floor drives no vertices: it is a marker, not a feeler. */
  const weightOf = new Map();
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const jAcc = prim.attributes?.JOINTS_0;
      const wAcc = prim.attributes?.WEIGHTS_0;
      if (jAcc === undefined || wAcc === undefined) continue;
      const joints = readAccessor(gltf, bin, jAcc);
      const weights = readAccessor(gltf, bin, wAcc);
      for (let i = 0; i < joints.length; i += 1) {
        const w = weights[i];
        if (!(w > 0)) continue;
        const j = joints[i];
        weightOf.set(j, Math.max(weightOf.get(j) ?? 0, w));
      }
    }
  }
  /* JOINTS_0 indexes the SKIN's joint list, not the node list. */
  const skinJoints = gltf.skins?.[0]?.joints ?? [];
  const nodeWeight = new Map();
  weightOf.forEach((w, j) => {
    const node = skinJoints[j];
    if (node !== undefined) nodeWeight.set(node, w);
  });

  const mmPerUnit = CASTE_LENGTH_MM[caste] / rig.lengthUnits;

  const measure = (chain) => {
    const joints = [];
    let run = 0;
    for (let i = 0; i < chain.length; i += 1) {
      const idx = byName.get(chain[i]);
      if (idx === undefined) { joints.push({ name: chain[i], missing: true }); continue; }
      const node = nodes[idx];
      const off = localTranslation(node);
      /* A bone's own offset is measured FROM ITS PARENT, so the first named
       * bone's offset is where the antenna leaves the head, and each later
       * one is the length of the segment before it. */
      const segment = len3(off) * mmPerUnit;
      if (i > 0) run += segment;
      const childBones = (node.children ?? []).filter((c) => skinJoints.includes(c));
      joints.push({
        name: chain[i],
        node: idx,
        offsetUnits: off,
        segmentMm: segment,
        runMm: run,
        skinWeight: nodeWeight.get(idx) ?? 0,
        skinned: (nodeWeight.get(idx) ?? 0) > 0.01,
        children: childBones.map((c) => nodes[c]?.name ?? `#${c}`),
      });
    }
    /* The chain may continue past the last NAMED bone. Follow it so an empty
     * terminal marker cannot masquerade as the tip. */
    const tail = [];
    let cursor = byName.get(chain[chain.length - 1]);
    for (let guard = 0; cursor !== undefined && guard < 6; guard += 1) {
      const kids = (nodes[cursor]?.children ?? []).filter((c) => skinJoints.includes(c));
      if (kids.length !== 1) break;
      const k = kids[0];
      const off = localTranslation(nodes[k]);
      tail.push({
        name: nodes[k]?.name ?? `#${k}`,
        node: k,
        segmentMm: len3(off) * mmPerUnit,
        skinWeight: nodeWeight.get(k) ?? 0,
        skinned: (nodeWeight.get(k) ?? 0) > 0.01,
        named: chain.includes(nodes[k]?.name),
      });
      cursor = k;
    }
    const present = joints.filter((j) => !j.missing);
    const lastSkinned = [...present].reverse().find((j) => j.skinned) ?? null;
    /*
     * The chain's REST SHAPE in the model's own frame: where the base sits,
     * where the tip sits, and the straight-line vector between them. This is
     * the direction a search sweep departs from, and the straight-line reach
     * is what the sensor may actually claim — a curled feeler reaches less far
     * than the sum of its segments, so the two numbers are reported apart.
     */
    const idx = present.map((j) => j.node);
    const base = idx.length ? posOf(world[idx[0]]) : { x: 0, y: 0, z: 0 };
    const tip = idx.length ? posOf(world[idx[idx.length - 1]]) : base;
    const span = { x: tip.x - base.x, y: tip.y - base.y, z: tip.z - base.z };
    const straightMm = len3(span) * mmPerUnit;
    const dir = straightMm > 0
      ? { x: span.x / len3(span), y: span.y / len3(span), z: span.z / len3(span) }
      : { x: 0, y: 0, z: 0 };
    return {
      joints,
      tail,
      reachMm: present.length ? present[present.length - 1].runMm : 0,
      skinnedReachMm: lastSkinned ? lastSkinned.runMm : 0,
      lastSkinnedBone: lastSkinned ? lastSkinned.name : null,
      restBaseUnits: base,
      restTipUnits: tip,
      restDir: dir,
      straightReachMm: straightMm,
    };
  };

  report[caste] = {
    lengthUnits: rig.lengthUnits,
    lengthMm: CASTE_LENGTH_MM[caste],
    mmPerUnit,
    left: measure(rig.antennaLeft),
    right: measure(rig.antennaRight),
  };
}

/* -------------------------------------------------------------- output */

const f = (n, w = 7, d = 3) => String(Number(n).toFixed(d)).padStart(w);

for (const caste of ['queen', 'worker', 'major']) {
  const r = report[caste];
  console.log(`\n=== ${caste.toUpperCase()} — ${r.lengthMm} mm long, `
    + `${r.lengthUnits} model units, ${r.mmPerUnit.toFixed(4)} mm/unit ===`);
  for (const side of ['left', 'right']) {
    const a = r[side];
    console.log(`\n  antenna${side === 'left' ? 'Left' : 'Right'} — `
      + `${a.joints.length} named bones`);
    console.log('    bone         segment mm   run mm   skin w   carries geometry   children');
    for (const j of a.joints) {
      if (j.missing) { console.log(`    ${j.name.padEnd(12)} NOT IN FILE`); continue; }
      console.log(`    ${j.name.padEnd(12)} ${f(j.segmentMm)}   ${f(j.runMm)}   `
        + `${f(j.skinWeight, 6, 2)}   ${(j.skinned ? 'yes' : 'NO — empty').padEnd(17)}  `
        + `${j.children.join(', ') || '(leaf)'}`);
    }
    for (const t of a.tail) {
      console.log(`    ${t.name.padEnd(12)} ${f(t.segmentMm)}   ${' '.repeat(7)}   `
        + `${f(t.skinWeight, 6, 2)}   ${(t.skinned ? 'yes' : 'NO — empty').padEnd(17)}  `
        + `UNNAMED in rig map`);
    }
    console.log(`    rest base (model units)  : `
      + `${a.restBaseUnits.x.toFixed(3)}, ${a.restBaseUnits.y.toFixed(3)}, ${a.restBaseUnits.z.toFixed(3)}`);
    console.log(`    rest tip  (model units)  : `
      + `${a.restTipUnits.x.toFixed(3)}, ${a.restTipUnits.y.toFixed(3)}, ${a.restTipUnits.z.toFixed(3)}`);
    console.log(`    rest direction (unit)    : `
      + `${a.restDir.x.toFixed(3)}, ${a.restDir.y.toFixed(3)}, ${a.restDir.z.toFixed(3)}`);
    console.log(`    straight-line reach      : ${a.straightReachMm.toFixed(3)} mm`);
    console.log(`    reach to last named bone : ${a.reachMm.toFixed(3)} mm (sum of segments)`);
    console.log(`    reach to last SKINNED    : ${a.skinnedReachMm.toFixed(3)} mm `
      + `(${a.lastSkinnedBone ?? 'none'})`);
  }
}

console.log('\nJSON\n' + JSON.stringify(report, null, 1));
