/**
 * Boots the real app shell the way a real player's browser does.
 *
 * This file exists because two bugs survived every other test:
 *
 *   1. `animateJackpot()` called `this.frame(...)`, but App had no frame()
 *      helper. It only ran when the saved "biggest pot" was above zero — i.e.
 *      for anyone who had already played and won. The throw happened inside
 *      init(), so the whole shell died and the page looked frozen.
 *   2. `refreshTables()` gated its render on `this.alive`, which was never
 *      assigned, so the lobby never listed the tables the server returned.
 *
 * Both were invisible to the other suites because they called renderTables()
 * directly and started from an empty profile. Here the app is imported exactly
 * once, with a returning player's localStorage and a stubbed network, so the
 * real boot path is what gets tested.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
  const { register } = await import('node:module');
  register('./browser-loader.mjs', import.meta.url);
} catch {
  JSDOM = null;
}

const TABLES = [
  { id: 'friendly', name: 'Friendly Table', players: 2, humans: 1, maxPlayers: 6, boot: 10, pot: 240, handNo: 7, phase: 'betting' },
  { id: 'high-roller', name: 'High Roller', players: 1, humans: 1, maxPlayers: 6, boot: 100, pot: 100, handNo: 1, phase: 'waiting' }
];

test('a returning player with a saved biggest pot boots the shell and fills the lobby', { skip: !JSDOM, timeout: 120000 }, async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8'), {
    url: 'http://localhost:4000/',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  // Somebody who has already played and won something.
  window.localStorage.setItem('teen-patti-arena/v2', JSON.stringify({
    profile: { id: 'returning-player', name: 'Returning Player', avatar: '🎲' },
    settings: { sound: false, ambience: false, volume: 0.5, animations: 'fast', theme: 'dark', hints: true },
    stats: { handsPlayed: 12, handsWon: 5, biggestPot: 5000, chipsWon: 9000, bestHand: 'Trail' }
  }));

  const requests = [];
  const answers = {
    '/api/tables': { tables: TABLES },
    '/api/leaderboard': { leaderboard: [{ name: 'Ravi', avatar: '🐯', hands: 12, wins: 5, net: 900, biggestPot: 400 }] },
    '/api/network': {
      port: 4000,
      local: 'http://localhost:4000',
      primary: 'http://192.168.1.5:4000',
      publicUrl: null,
      addresses: [{ label: 'Wi-Fi', ip: '192.168.1.5', url: 'http://192.168.1.5:4000' }]
    }
  };

  const previous = new Map();
  const expose = (key, value) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };

  expose('window', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('sessionStorage', window.sessionStorage);
  expose('requestAnimationFrame', window.requestAnimationFrame);
  expose('cancelAnimationFrame', window.cancelAnimationFrame);
  expose('HTMLElement', window.HTMLElement);
  expose('Node', window.Node);
  expose('SVGElement', window.SVGElement);
  expose('fetch', async (url) => {
    const key = Object.keys(answers).find((route) => String(url).startsWith(route));
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => answers[key] ?? {} };
  });

  try {
    const { formatChips } = await import('../public/js/ui.js');

    // Importing the shell runs `new App().init()` — this is where the old code
    // threw "this.frame is not a function" and left the page dead.
    await import('../public/js/app.js');

    const app = window.app;
    assert.ok(app, 'the app shell booted and exposed its debug handle');
    assert.equal(app.alive, true, 'the shell reports itself alive after init');
    assert.equal(typeof app.frame, 'function', 'App has the frame() helper its animations call');
    assert.equal(typeof app.inviteBase, 'function', 'share helpers exist on the shell');

    // Let the jackpot counter finish: it must animate, not throw. Poll for the
    // value instead of sleeping a fixed 1.2s — the count-up runs for ~900ms, so
    // a fixed wait turns a busy machine into a false failure.
    const jackpot = window.document.querySelector('#jackpot-value');
    assert.ok(jackpot, 'the jackpot element is in the lobby');
    const expectedPot = formatChips(5000);
    let reachedValue = false;
    for (let i = 0; i < 120 && !reachedValue; i += 1) {
      reachedValue = jackpot.textContent.trim() === expectedPot;
      if (!reachedValue) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(jackpot.textContent.trim(), expectedPot, 'the saved biggest pot animates up to its value');

    // The lobby must show what the server reported (this used to be skipped
    // because every render sat behind an unset `alive` flag).
    assert.ok(requests.some((url) => url.includes('/api/tables')), 'the lobby asked the server for tables');
    const cards = window.document.querySelectorAll('#table-list .table-card');
    assert.equal(cards.length, TABLES.length, 'every live table gets a card in the lobby');
    assert.equal(window.document.querySelectorAll('#table-list .seat-dot').length, TABLES.length * 6, 'seat dots come from maxPlayers');
    assert.match(window.document.querySelector('#pill-tables').textContent, /2 tables/, 'the table count pill updates');
    assert.match(window.document.querySelector('#table-list').textContent, /High Roller/, 'table names render');

    // The share bar is filled from /api/network so the host knows what to send.
    const share = window.document.querySelector('#share-bar');
    assert.ok(share && !share.hidden, 'the Wi-Fi share bar is shown to the host');
    assert.match(share.textContent, /192\.168\.1\.5:4000/, 'the share bar shows the LAN address, never localhost');

    // Profiles, stats and rankings all render for a returning player.
    assert.match(window.document.querySelector('.player-card .pc-name').textContent, /Returning Player/);
    assert.ok(window.document.querySelector('#stat-grid').children.length >= 4, 'stat tiles render');
    assert.ok(window.document.querySelector('#leaderboard .board-row'), 'the leaderboard renders fetched rows');

    app.teardown();
    assert.equal(app.alive, false, 'teardown makes the shell not-alive so late frames stop');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  }
});
