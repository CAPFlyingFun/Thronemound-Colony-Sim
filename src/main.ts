import './style.css';

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
const scene = new URLSearchParams(window.location.search).get('scene');

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
  } else {
    void import('./scenes/DigScene').then(({ DigScene }) => new DigScene(host));
  }
}
