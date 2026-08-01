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
 * The dig prototype IS the game now, so it is the default rather than
 * something you have to know a query string to reach. The 2D Phaser prototype
 * that used to live here is gone along with the Phaser dependency — it shared
 * no code with the 3D game and was quietly the largest thing in the bundle.
 * It is in git history if it is ever wanted back.
 *
 * Everything is imported lazily so a route only pays for its own scene.
 */
const params = new URLSearchParams(window.location.search);
const scene = params.get('scene');
const map = params.get('map') ?? params.get('');
const densityTerrainLab =
  scene === 'density' ||
  map === 'densityterrainlab' ||
  params.has('densityterrainlab');

const host = document.getElementById('app');
if (host) {
  host.classList.add('dig-host');
  if (densityTerrainLab) {
    // Isolated signed-density terrain experiment. It intentionally shares no
    // production voxel terrain code, so the main map remains untouched.
    void import('./scenes/DensityTerrainLabScene').then(
      ({ DensityTerrainLabScene }) => new DensityTerrainLabScene(host),
    );
  } else if (scene === 'queen') {
    // Model and gait preview. Nothing in the game imports it — see QueenScene.
    void import('./scenes/QueenScene').then(({ QueenScene }) => new QueenScene(host));
  } else if (scene === 'hex') {
    // The hex-grid experiment, kept only as the reference the rounded sockets
    // were taken from. See src/voxel/HexGrid.ts for why it could never be the
    // real grid.
    void import('./scenes/HexScene').then(({ HexScene }) => new HexScene(host));
  } else {
    void import('./scenes/DigScene').then(({ DigScene }) => new DigScene(host));
  }
}
