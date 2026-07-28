import './style.css';

const params = new URLSearchParams(window.location.search);

if (params.get('scene') === 'dig') {
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
