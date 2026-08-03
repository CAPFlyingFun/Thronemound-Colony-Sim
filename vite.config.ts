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
    allowedHosts: 'all',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: {
    sourcemap: true,
  },
}));
