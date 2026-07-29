import { defineConfig } from 'vite';
import pkg from './package.json';

// Surfaced in the HUD. Without it there is no way to tell from a phone whether
// you are looking at the newest build or a cached one, which has already caused
// a "this is still broken" report against code that was two versions old.
const buildTime = new Date().toISOString().slice(5, 16).replace('T', ' ');

export default defineConfig({
  base: '/Thronemound-Colony-Sim/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: {
    sourcemap: true,
  },
});
