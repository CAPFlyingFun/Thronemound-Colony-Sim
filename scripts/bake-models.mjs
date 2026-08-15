/*
 * TURN A RELEASE OF MODELS INTO SOMETHING A PHONE CAN DOWNLOAD.
 *
 * Joshua authors these elsewhere and ships them as a GitHub release. They
 * arrive at AUTHORING quality, which is the right quality to author at and
 * about fifty times what a browser should ever fetch:
 *
 *   house_fly.glb   69.93 MB   three 4096x4096 PNG textures
 *   dirt clod       57.06 MB   the same
 *   twig            54.78 MB   the same
 *   rock            53.47 MB   the same
 *   aphid           50.49 MB   the same
 *   larva           37.37 MB   the same
 *   earthworm       36.81 MB   the same
 *
 * For scale, the ENTIRE game currently ships 2.9 MB of models — a queen at
 * 1.32, a worker at 0.62 and a major at 0.91. One housefly is twenty-three
 * times all of it.
 *
 * THE MESHES ARE NOT THE PROBLEM and must not be touched: the fly is 27k
 * vertices, which is ordinary. Sixty-seven of its seventy megabytes are
 * three 4096-square PNGs, and their real cost is worse than the download —
 * a 4096 RGBA texture is 89 MB of VRAM uncompressed, so one fly is 268 MB
 * of a phone's graphics memory. That is the whole problem, and resizing is
 * the whole fix.
 *
 * 512 IS NOT A COMPROMISE HERE. These are millimetre-scale animals seen on
 * a 932-point screen; a fly fills a few hundred pixels at its very largest,
 * and 512 is already more texel than it can show. The originals stay in the
 * release, which is where an original belongs.
 *
 *   node scripts/bake-models.mjs <folder-of-glbs>
 *
 * Writes public/models/<name>.glb and prints what each one cost.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node scripts/bake-models.mjs <folder-of-glbs>');
  process.exit(1);
}
const OUT = 'public/models';
mkdirSync(OUT, { recursive: true });

/**
 * What each release file is called in the game.
 *
 * The authoring names carry the tool that made them and the timestamp it
 * ran at — `Meshy_AI_Dirt_Clod_3D_0815193011_image-to-3d-texture.glb` — and
 * a URL in the game's source should say what the thing IS. Matched on a
 * fragment so a re-export with a new timestamp still lands.
 */
const NAMES = [
  [/house_?fly/i, 'housefly'],
  [/aphid/i, 'aphid'],
  [/earthworm/i, 'earthworm'],
  [/dirt.?clod/i, 'dirt-clod'],
  [/larva/i, 'larva'],
  [/rock/i, 'rock-model'],
  [/twig/i, 'twig-model'],
];

const nameFor = (file) => {
  for (const [pattern, name] of NAMES) if (pattern.test(file)) return name;
  /* Unknown: keep its own stem rather than inventing one, and say so. */
  return basename(file, '.glb').toLowerCase().replace(/[^a-z0-9]+/g, '-');
};

const mb = (bytes) => (bytes / 1048576).toFixed(2);

const files = readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.glb'));
if (files.length === 0) {
  console.error(`no .glb files in ${SRC}`);
  process.exit(1);
}

const rows = [];
for (const file of files) {
  const from = join(SRC, file);
  const name = nameFor(file);
  const to = join(OUT, `${name}.glb`);
  execFileSync('npx', [
    '--yes', '@gltf-transform/cli@4', 'optimize', from, to,
    /*
     * WEBP, and it needs no decoder wiring: three.js reads
     * `EXT_texture_webp` in GLTFLoader already, and every browser this game
     * supports decodes WebP — the HUD has been built on it since v0.1.22.
     */
    '--texture-compress', 'webp',
    '--texture-size', '512',
    /*
     * QUANTIZE rather than Draco or Meshopt. Both of those would shrink the
     * geometry further and both need a DECODER shipped and wired into the
     * loader; `KHR_mesh_quantization` is understood by three.js on its own.
     * The meshes are not what is heavy here, so buying a dependency to
     * shrink them would be paying for the wrong thing.
     */
    '--compress', 'quantize',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  rows.push({ name, was: statSync(from).size, now: statSync(to).size });
}

console.log('\nBAKED FOR THE WEB — authoring quality in, phone quality out\n');
console.log('  model            was        now       saved');
let was = 0; let now = 0;
for (const r of rows.sort((a, b) => b.was - a.was)) {
  was += r.was; now += r.now;
  console.log(
    `  ${r.name.padEnd(16)} ${`${mb(r.was)} MB`.padStart(9)}`
    + ` ${`${mb(r.now)} MB`.padStart(9)}   ${(r.was / r.now).toFixed(0)}x`,
  );
}
console.log(`  ${'TOTAL'.padEnd(16)} ${`${mb(was)} MB`.padStart(9)} ${`${mb(now)} MB`.padStart(9)}`
  + `   ${(was / now).toFixed(0)}x`);
