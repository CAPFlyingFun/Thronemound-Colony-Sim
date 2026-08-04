import './style.css';
import { registerServiceWorker } from './pwa';

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
const scene = params.get('scene');
const map = params.get('map');
const colonySim = scene === 'density'
  || map === 'densityterrainlab'
  || params.has('densityterrainlab');

const host = document.getElementById('app');
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
  } else {
    /*
     * Default and `?scene=island`: Beyond Extinction's Kauai at 1:1000,
     * carrying the streamed fine soil, nest plan, rail traversal and designer.
     */
    void import('./scenes/IslandScene').then(({ IslandScene }) => new IslandScene(host));
  }
}