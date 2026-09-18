#!/usr/bin/env node
/**
 * Waits for the game server to answer, then prints the links to use.
 *
 * The launchers call this instead of polling with PowerShell or curl, because
 * the runtime is already known to be present (it is what runs the server) and it
 * cannot be confused by the host machine's proxy settings or by `localhost`
 * resolving to an address the server is not listening on.
 *
 * Deliberately built on node:http rather than fetch/AbortSignal: the server
 * itself only needs core modules, so a working server must never be reported as
 * broken just because the installed Node predates fetch (18+) or
 * AbortSignal.timeout (17.3+). If this check fails, the launcher tells the user
 * the server is down — so it has to be right.
 *
 * Always talks to 127.0.0.1: that is the address the server is guaranteed to
 * answer on. `localhost` is deliberately not used here — on Windows it resolves
 * to IPv6 `::1` first, and clients that do not fall back to IPv4 then wait for a
 * server that is running perfectly well.
 *
 * Usage: node tools/wait-for-server.mjs [port] [timeoutSeconds]
 * Exit code 0 = the server answered, 1 = it never did.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 4000);
const timeoutSeconds = Number(process.argv[3] || 25);
const started = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One GET against the local server, with a hard timeout. Resolves the JSON body. */
function get(pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

let up = false;
while (Date.now() - started < timeoutSeconds * 1000) {
  try {
    const health = await get('/api/health', 900);
    if (health && health.ok) { up = true; break; }
  } catch {
    // not listening yet — keep waiting
  }
  await sleep(250);
}

if (!up) {
  console.error('');
  console.error(`  ✖ The server did not answer at http://127.0.0.1:${port} within ${timeoutSeconds} seconds.`);
  console.error('');

  // The server prints why it stopped; show it instead of leaving the user guessing.
  let log = '';
  try {
    log = fs.readFileSync(path.join(root, 'server-log.txt'), 'utf8').trim();
  } catch {
    /* no log written */
  }
  if (log) {
    console.error('  The server said:');
    console.error('');
    for (const line of log.split('\n').slice(-14)) console.error(`    ${line}`);
    console.error('');
  } else {
    console.error('  The server did not print anything, which usually means it never');
    console.error('  started at all.');
    console.error('');
  }
  console.error(`  (Node ${process.version} is what is running this check.)`);
  console.error('');
  console.error('  Things to check:');
  console.error('    * Is a "Teen Patti Arena server" window open behind this one?');
  console.error('      If it closed, the reason is printed above.');
  console.error(`    * Is port ${port} already used by something else? Then run:`);
  console.error(`        set PORT=${port === 4100 ? 4200 : port + 100}`);
  console.error('        node server\\index.js');
  console.error('    * Meanwhile the offline single-file game works with no server');
  console.error('      at all — open PLAY-ME-first.html.');
  console.error('');
  process.exit(1);
}

console.log(`   Server is up (answered in ${((Date.now() - started) / 1000).toFixed(1)}s).`);
console.log('');
console.log(`   On this PC:            http://localhost:${port}`);

try {
  const network = await get('/api/network', 2000);
  if (network.primary && network.primary.indexOf('localhost') === -1) {
    console.log('');
    console.log(`   Friends on the same Wi-Fi open:   ${network.primary}`);
    console.log('   (send them that link — it works on their device, "localhost" does not)');
  } else {
    console.log('');
    console.log('   No Wi-Fi address found — this PC may be on data or a link-local only');
    console.log('   network, so friends cannot join yet. See README.md, "Play with friends".');
  }
} catch {
  /* the health check already passed; this is a nicety */
}

console.log('');
process.exit(0);
