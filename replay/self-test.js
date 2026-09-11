#!/usr/bin/env node
/**
 * Ensure / replay / self-test.js
 *
 * Proves Ensure's own logic against its own demo, with no external server
 * to start, wait on, or leak:
 *
 *   checks/demo.json              -> every check expects 'pass'
 *   checks/negative-controls.json -> every check expects 'fail', for a
 *                                    stated reason (expectDetail)
 *
 * Both files must exit 0. Zero surprises in either is the pass condition;
 * negative controls going green would mean grading got too permissive.
 *
 * Runs each checks file as a child process on purpose, so `npm run
 * self-test` exercises exactly the same entry point, argv and exit codes as
 * running `node replay/ensure-run.js checks/demo.json` by hand.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from './demo-server.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNNER = path.join(ROOT, 'replay', 'ensure-run.js');
const FILES = [
  { file: 'checks/demo.json', label: 'positive checks (all should pass)' },
  { file: 'checks/negative-controls.json', label: 'negative controls (all should fail on purpose)' },
];

// Must be spawned asynchronously: the demo server runs in *this* process, so
// a synchronous spawnSync here would block the event loop and the page under
// test would never get a response.
function runChecks(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, path.join(ROOT, file)], {
      stdio: 'inherit',
      cwd: ROOT,
      env,
    });
    child.on('error', (err) => {
      console.error(`failed to start runner: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

const server = await startDemoServer(Number(process.env.PORT || 0));
console.log(`self-test: demo served at ${server.url}\n`);

let failed = 0;
try {
  for (const { file, label } of FILES) {
    console.log(`--- ${file}: ${label}`);
    const code = await runChecks(file, { ...process.env, APP_URL: server.url, REPO_CHECKOUT_DIR: ROOT });
    if (code !== 0) failed++;
    console.log(`--- ${file} exited ${code}\n`);
  }
} finally {
  await server.close();
}

if (failed) {
  console.error(`self-test FAILED: ${failed} of ${FILES.length} checks files reported a surprise.`);
  process.exit(1);
}
console.log(`self-test OK: ${FILES.length}/${FILES.length} checks files matched their declared expectations.`);
