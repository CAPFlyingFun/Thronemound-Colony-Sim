/**
 * SERVE `dist` THE WAY GITHUB PAGES DOES — under the build's own base path.
 *
 * `vite preview` cannot do this, and the reason is worth writing down because
 * it looks like a bug in the app rather than in the tooling. `vite.config.ts`
 * picks the base off `command`:
 *
 *     base: command === 'serve' ? '/' : '/Thronemound-Colony-Sim/'
 *
 * and `vite preview` runs as `serve`. So a production build whose HTML points
 * at `/Thronemound-Colony-Sim/assets/…` gets served from `/`, every one of
 * those paths misses, and the SPA fallback answers each of them with
 * `index.html` — status 200, content-type text/html, for the manifest, the
 * service worker and every chunk alike. Nothing 404s, so nothing looks wrong;
 * `smoke-pwa` simply reported that the manifest was not JSON.
 *
 * Changing that base is not the fix: preview serving at `/` is exactly what
 * the forty probes navigating to `http://127.0.0.1:4173/?scene=island` rely
 * on. So the PWA smoke gets its own server instead, and stops depending on
 * anyone having started the right one.
 *
 * Deliberately tiny and dependency-free: static files, correct types, no
 * fallback. NO SPA FALLBACK is the point — a missing file must 404 here, or
 * this reintroduces the exact failure it exists to avoid.
 *
 *     node scripts/serveDist.mjs [port]      # or import startDistServer()
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  /* The one that started this. A manifest served as text/html is ignored by
   * the browser and the app is quietly not installable. */
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** The base the build actually used, read from its own HTML. */
export function baseOfDist() {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const hit = /(?:src|href)="(\/[^"]*?\/)assets\//.exec(html);
  return hit ? hit[1] : '/';
}

/**
 * Start the server. Resolves with the URL the app lives at and a stop().
 *
 * Port 0 asks the OS for a free one, which is what a smoke test wants: two
 * runs at once must not fight, and a stale server from an earlier session
 * must not be able to answer in this one's place. That has happened here —
 * a forgotten `python3 -m http.server` held a port for a whole session and
 * every measurement taken against it was of an older build.
 */
export function startDistServer(port = 0) {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/index.html is missing — run `npx vite build` first');
  }
  const base = baseOfDist();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (!path.startsWith(base)) { res.writeHead(404).end('not found'); return; }
    path = path.slice(base.length) || 'index.html';
    if (path.endsWith('/')) path += 'index.html';
    /* Nothing outside dist, whatever the request says. */
    const full = normalize(join(DIST, path));
    if (!full.startsWith(DIST.replace(new RegExp(`${sep}$`), '') + sep)) {
      res.writeHead(403).end('no');
      return;
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
      /* 404, NOT index.html. A fallback here would hide exactly the failure
       * this server was written to stop hiding. */
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
      /*
       * `no-cache`, NOT `no-store`, and the difference matters here.
       *
       * The service-worker tests rewrite a file and read it back, so the
       * browser must revalidate rather than answer from its own cache —
       * that is what `no-cache` buys. `no-store` goes further and forbids
       * storing at all, which is not what any real host does and changes
       * how the worker sees its own scripts: measured, the mid-load update
       * check behaved differently under it and the smoke reported an update
       * taken during the load that a normal host never produces. A test
       * server that is stricter than production tests something else.
       */
      'Cache-Control': 'no-cache',
    });
    createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: got } = server.address();
      resolve({
        url: `http://localhost:${got}${base}`,
        port: got,
        base,
        stop: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/* CLI: `node scripts/serveDist.mjs 4300` */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await startDistServer(Number(process.argv[2] ?? 4300));
  console.log(`serving dist at ${url}`);
}
