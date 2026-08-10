import './style.css';
import { markLoaded, registerServiceWorker } from './pwa';

/*
 * Offline play and the update prompt. First, so a scene that throws while
 * loading still leaves an installable, updatable app behind it.
 */
registerServiceWorker();

/*
 * Routing.
 *
 * THE ISLAND IS THE GAME MAP NOW. Opening the app with no query string drops
 * straight into Kauai-for-ants; the old rooms stay one query string away as
 * permanent development rigs instead of being deleted.
 *
 * The colony sim keeps every URL it ever had — `?map=densityterrainlab`,
 * `?scene=density`, `?scene=block`, and the rest — so focused testing still
 * has small deterministic rooms when the full island would be noise.
 *
 * Everything is imported lazily so a route only pays for its own scene.
 */
const params = new URLSearchParams(window.location.search);
// Case-blind on purpose: "?scene=Sandbox" typed on a phone should work.
const scene = params.get('scene')?.toLowerCase() ?? null;
const map = params.get('map');
const colonySim = scene === 'density'
  || map === 'densityterrainlab'
  || params.has('densityterrainlab');

const host = document.getElementById('app');

/*
 * WHO SAYS THE APP HAS FINISHED LOADING.
 *
 * A waiting update is not allowed to reload the app out from under a load in
 * progress — see `pwaPolicy.ts` for the bug that rule exists for — so
 * something has to say when the load is over. The island says it itself, from
 * the far side of a height field, a set of biome textures and a megabyte of
 * ant. Every other route here is a development rig: a small deterministic
 * room that is up as soon as its module is, with no curtain to lift and
 * nothing worth protecting from a reload. They are marked loaded at once, so
 * a rig can still take an update immediately and none of them can strand one.
 */
const island = !colonySim && ![
  'queen', 'block', 'terrainbug', 'world', 'hex', 'dig',
  'ant-sandbox', 'rail', 'pipes', 'sandbox', 'carry',
].includes(scene ?? '');
if (!island) markLoaded();

if (host) {
  host.classList.add('dig-host');
  if (colonySim) {
    void import('./scenes/DensityTerrainLabScene').then(
      ({ DensityTerrainLabScene }) => new DensityTerrainLabScene(host),
    );
  } else if (scene === 'queen') {
    // Model and gait preview. Nothing in the game imports it — see QueenScene.
    void import('./scenes/QueenScene').then(({ QueenScene }) => new QueenScene(host));
  } else if (scene === 'block' || scene === 'terrainbug') {
    /*
     * The compact dirt-block laboratory: six-face walk, digging, shafts,
     * cliff and nest designer rigs. Kept because bugs are easier to pin down
     * here than halfway across a fifty-six-metre island.
     */
    void import('./scenes/BlockScene').then(({ BlockScene }) => new BlockScene(host));
  } else if (scene === 'world') {
    /*
     * The hybrid streamed-world prototype: a macro surface everywhere, a
     * fine diggable window under the ant, a nest plan carved into the world
     * function. See docs/HYBRID_WORLD_PLAN.md.
     */
    void import('./scenes/WorldScene').then(({ WorldScene }) => new WorldScene(host));
  } else if (scene === 'hex') {
    // The hex-grid experiment, kept only as the reference the rounded sockets
    // were taken from. See src/voxel/HexGrid.ts for why it could never be the
    // real grid.
    void import('./scenes/HexScene').then(({ HexScene }) => new HexScene(host));
  } else if (scene === 'dig') {
    // The original dig room remains available explicitly as a reference rig.
    void import('./scenes/DigScene').then(({ DigScene }) => new DigScene(host));
  } else if (scene === 'ant-sandbox') {
  void import('./scenes/sandbox/AntMechanicsSandbox').then(
    ({ AntMechanicsSandbox }) => new AntMechanicsSandbox(host),
  );
  } else if (scene === 'rail') {
    /*
     * The monorail room: the coaster-style tunnel builder on its own, with a
     * cart riding the track. Pieces compile to a NestPlan, so what this room
     * proves carries into the carved, jaws-executed version unchanged.
     */
    void import('./scenes/RailScene').then(({ RailScene }) => new RailScene(host));
  } else if (scene === 'pipes') {
    /*
     * The pipes room: tunnels as plumbing. Arm a pipe piece, rotate it in
     * 45° racks, tap again to place — it snaps to the open end, carves
     * instantly, and the network's centerlines are where ants can travel.
     */
    void import('./scenes/PipesScene').then(({ PipesScene }) => new PipesScene(host));
  } else if (scene === 'sandbox') {
    /*
     * The ant mechanics sandbox: worker and major, and the head-and-jaws
     * interaction grammar — approach, aim, clamp, carry or drag or bite —
     * proved on a bare field before it meets the island.
     */
    void import('./scenes/SandboxScene').then(({ SandboxScene }) => new SandboxScene(host));
  } else if (scene === 'carry') {
    /*
     * The carry room: soil as a lattice of 2 mm blocks, and digging as
     * picking one up. Crosshair on a block, CARRY takes it, DROP places it —
     * a tunnel is exactly the blocks somebody carried out of it.
     */
    void import('./scenes/CarryScene').then(({ CarryScene }) => new CarryScene(host));
  } else {
    /*
     * Default and `?scene=island`: Beyond Extinction's Kauai at 1:1000,
     * carrying the streamed fine soil, nest plan, rail traversal and designer.
     */
    void import('./scenes/IslandScene').then(({ IslandScene }) => new IslandScene(host));
  }
}