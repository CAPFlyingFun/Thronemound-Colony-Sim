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
 * The DIG ROOM is the default again, and that is a deliberate step back: the
 * colony sim grew a streamed world, a model with a full IK stance, a climb,
 * a menu and a save, and something in that pile broke the feel of digging.
 * The way back to a known-good is to start from the room that still works
 * and re-add one thing at a time, so the room that still works is the one
 * that opens.
 *
 * The colony sim keeps every URL it ever had — `?map=densityterrainlab`,
 * `?scene=density` — and nothing about it is deleted or disowned. It is one
 * query string away.
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
     * The restart: one block of dirt, an ant who can walk all the way round
     * it, and digging at the mandible. Everything else is being re-added one
     * piece at a time. `terrainbug` is the name it was asked for by.
     */
    void import('./scenes/BlockScene').then(({ BlockScene }) => new BlockScene(host));
  } else if (scene === 'hex') {
    // The hex-grid experiment, kept only as the reference the rounded sockets
    // were taken from. See src/voxel/HexGrid.ts for why it could never be the
    // real grid.
    void import('./scenes/HexScene').then(({ HexScene }) => new HexScene(host));
  } else {
    // The dig room: the reference the rest is measured against.
    void import('./scenes/DigScene').then(({ DigScene }) => new DigScene(host));
  }
}
