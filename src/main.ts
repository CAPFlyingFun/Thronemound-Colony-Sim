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
 * The density colony sim IS the game now, so it is the default — the bare
 * URL, and therefore the installed app's `start_url`, opens the room with
 * the menu, the save and the streaming world in it. It used to be the dig
 * prototype, and the dig room is not deleted for the same reason the hex
 * grid was not: it is the reference the first-person camera and the feel of
 * digging were ported FROM, and when a port is questioned the original is
 * the arbiter. It has simply retired from being the front page to living at
 * `?scene=dig`.
 *
 * Everything is imported lazily so a route only pays for its own scene.
 */
const params = new URLSearchParams(window.location.search);
const scene = params.get('scene');

const host = document.getElementById('app');
if (host) {
  host.classList.add('dig-host');
  if (scene === 'queen') {
    // Model and gait preview. Nothing in the game imports it — see QueenScene.
    void import('./scenes/QueenScene').then(({ QueenScene }) => new QueenScene(host));
  } else if (scene === 'hex') {
    // The hex-grid experiment, kept only as the reference the rounded sockets
    // were taken from. See src/voxel/HexGrid.ts for why it could never be the
    // real grid.
    void import('./scenes/HexScene').then(({ HexScene }) => new HexScene(host));
  } else if (scene === 'dig') {
    // The retired voxel dig room, kept as the reference room.
    void import('./scenes/DigScene').then(({ DigScene }) => new DigScene(host));
  } else {
    // The game. `?map=densityterrainlab` and `?scene=density` still land
    // here so every link and test URL written before the flip keeps working.
    void import('./scenes/DensityTerrainLabScene').then(
      ({ DensityTerrainLabScene }) => new DensityTerrainLabScene(host),
    );
  }
}
