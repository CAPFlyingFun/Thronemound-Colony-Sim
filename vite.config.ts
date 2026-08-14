import { defineConfig } from 'vite';
import pkg from './package.json';

// Surfaced in the HUD. Without it there is no way to tell from a phone whether
// you are looking at the newest build or a cached one, which has already caused
// a "this is still broken" report against code that was two versions old.
const buildTime = new Date().toISOString().slice(5, 16).replace('T', ' ');

export default defineConfig(({ command }) => ({
  // GitHub Pages needs the repo name as the base. Local dev (Replit or
  // localhost) serves from root, so assets resolve without the prefix.
  base: command === 'serve' ? '/' : '/Thronemound-Colony-Sim/',
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
    host: true,
    // Replit proxies the preview through its own domain — allow all hosts so
    // the iframe doesn't get a 403.
    allowedHosts: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: {
    sourcemap: true,
  },
  /*
   * THIRTY SECONDS, because five is not a timeout here — it is a coin toss.
   *
   * Vitest defaults to 5 s, and this project's tests are not unit tests in
   * the millisecond sense: they build a real voxel island, dig spheres out
   * of it and compare whole float fields. `islandSave`'s round-trip takes
   * 3,996 ms on this machine, which is a one-second margin, and a loaded
   * GitHub runner ate it — the v0.1.42 deploy failed with 966 tests passing
   * and that one timing out, on a commit that touched the pose editor and
   * nothing else. A test that fails on how busy the runner is tells you
   * about the runner.
   *
   * Raised rather than tuned per-file: several of these sit in the same
   * seconds-long band and picking them off one at a time just moves the
   * coin toss to whichever is next-slowest. A genuinely hung test still
   * fails, thirty seconds later.
   */
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
}));
