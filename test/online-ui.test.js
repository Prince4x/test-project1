/**
 * Online UI integration: boots the real client app in a DOM, connects it to the
 * real server over a real WebSocket, sits down at a table and plays.
 *
 * This is the closest thing to clicking through the multiplayer game that can
 * run without a graphical browser. Skipped when jsdom is not installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await freePort();   // a port nothing else is using (see free-port.mjs)

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
  const { register } = await import('node:module');
  register('./browser-loader.mjs', import.meta.url);
} catch {
  JSDOM = null;
}

async function startServer() {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TEEN_PATTI_FAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return { server, logs: () => logs };
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  server.kill('SIGTERM');
  throw new Error(`server never came up: ${logs}`);
}

test('a player can sit at a live table from the real UI', { skip: !JSDOM, timeout: 90000 }, async (t) => {
  const { server, logs } = await startServer();
  t.after(() => {
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 1500);
    force.unref?.();
    server.unref();
  });

  const created = await (await fetch(`http://127.0.0.1:${PORT}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'UI table',
      bots: 3,
      config: { boot: 5, startChips: 500, minBuyIn: 100, maxBuyIn: 1000, maxRounds: 2, turnSeconds: 8, disconnectedTurnSeconds: 2 }
    })
  })).json();

  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8'), {
    url: `http://127.0.0.1:${PORT}/`,
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  const previous = new Map();
  const expose = (key, value) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  expose('window', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('requestAnimationFrame', window.requestAnimationFrame);
  expose('cancelAnimationFrame', window.cancelAnimationFrame);
  expose('WebSocket', window.WebSocket);
  expose('HTMLElement', window.HTMLElement);
  expose('Node', window.Node);
  expose('SVGElement', window.SVGElement);

  try {
    await import('../public/js/app.js');
    const app = window.app;
    assert.ok(app, 'the app shell booted');

    app.startOnline({ tableId: created.table.id, buyIn: 500 });

    // Wait for the first server snapshot to reach the table view.
    const waitUntil = async (predicate, timeout = 30000, label = 'condition') => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${label}\n${logs()}`);
    };

    await waitUntil(() => app.view.snapshot?.phase, 30000, 'the first table snapshot');
    assert.equal(window.document.querySelector('#game').classList.contains('active'), true, 'the table screen is shown');
    await waitUntil(() => window.document.querySelectorAll('#seats .seat').length >= 4, 10000, 'seats to render');

    // Play until a hand completes, acting through the controller exactly like
    // the buttons do.
    let acted = 0;
    let handsDone = 0;
    const started = Date.now();
    while (Date.now() - started < 45000 && handsDone < 1) {
      const snapshot = app.view.snapshot;
      if (snapshot?.phase === 'betting') {
        const you = snapshot.you;
        if (you?.inHand && !you.packed && you.options?.see) {
          app.view.act('see');
          acted += 1;
        } else if (you?.canAct) {
          app.view.act(you.options.call ? 'chaal' : 'allin');
          acted += 1;
          const button = window.document.querySelector('#action-bar button');
          assert.ok(button, 'the action bar offers buttons on my turn');
        }
      }
      handsDone = snapshot?.history?.length || 0;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    assert.ok(acted > 0, `the UI layer sent actions to the server (${acted})`);
    assert.ok(handsDone >= 1, `a hand completed at the live table\n${logs()}`);
    assert.ok(app.view.snapshot.you.seen, 'we saw our cards through the UI');
    assert.ok(window.document.querySelector('#pot-value').textContent.length > 0, 'the pot is rendered');
    assert.ok(window.document.querySelector('#history-body').textContent.includes('Hand #'), 'hand history is populated');

    // Chat round-trips through the server and comes back to the view.
    app.sendChat('hello from the ui test');
    await waitUntil(
      () => app.view.chatLog.some((message) => message.text === 'hello from the ui test'),
      8000,
      'our chat message to come back from the server'
    );

    app.leaveTable();
    assert.equal(window.document.querySelector('#lobby').classList.contains('active'), true, 'leaving returns to the lobby');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
