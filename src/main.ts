import './style.css';

const params = new URLSearchParams(window.location.search);

const scene = params.get('scene');

if (scene === 'queen') {
  // Model + gait preview. Nothing in the game imports it — see QueenScene.
  const host = document.getElementById('app');
  if (host) {
    host.classList.add('dig-host');
    void import('./scenes/QueenScene').then(({ QueenScene }) => {
      new QueenScene(host);
    });
  }
} else if (scene === 'hex') {
  // Hex-grid experiment. Entirely separate from the cube world — see
  // src/voxel/HexGrid.ts for why it cannot simply reuse DigScene.
  const host = document.getElementById('app');
  if (host) {
    host.classList.add('dig-host');
    void import('./scenes/HexScene').then(({ HexScene }) => {
      new HexScene(host);
    });
  }
} else if (scene === 'dig') {
  // 3D dig prototype. Both scenes are imported lazily so the three.js bundle
  // and the Phaser bundle never ship together — each route loads only its own.
  const host = document.getElementById('app');
  if (host) {
    host.classList.add('dig-host');
    void import('./scenes/DigScene').then(({ DigScene }) => {
      new DigScene(host);
    });
  }
} else {
  void import('./bootPhaser');
}
