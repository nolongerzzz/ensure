#!/usr/bin/env node
/**
 * Ensure / replay / demo-server.js
 *
 * Serves demo/ as static files. Deliberately dependency-free and in-process:
 * the previous approach (`npx serve demo -l 5175 &` plus `npx wait-on`)
 * leaked a server process on every run, raced the port, and silently
 * no-oped when 5175 was already taken by an earlier leaked copy. The
 * self-test binds port 0 instead and hands the real URL to the runner, so
 * two runs can never collide.
 *
 *   node replay/demo-server.js          # port 5175
 *   PORT=0 node replay/demo-server.js   # any free port
 */

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_DIR = fileURLToPath(new URL('../demo/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function startDemoServer(port = 5175) {
  const server = http.createServer((req, res) => {
    // Strip the query string: the demo's own script tag is app.js?v=demo1,
    // and the assetHash check fetches app.js — both must serve the same file.
    const urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.join(DEMO_DIR, rel);

    // Never serve outside demo/, however creative the request path is.
    if (!filePath.startsWith(DEMO_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    // The demo has no icon; answering 204 keeps the browser console clean so
    // "no console errors" is a meaningful thing to check the demo against.
    if (rel === 'favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: actualPort } = server.address();
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Run directly (npm run demo) rather than imported by the self-test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT === undefined ? 5175 : Number(process.env.PORT);
  const { url } = await startDemoServer(port);
  console.log(`Ensure demo serving ${DEMO_DIR} at ${url}`);
  console.log('Ctrl-C to stop.');
}
