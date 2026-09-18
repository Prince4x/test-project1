/**
 * Table-view life cycle: two glitches that made the game look broken.
 *
 *  1. Chips, sparkles and emoji are positioned in viewport coordinates, so they
 *     are appended to <body> rather than to the table screen. Tearing the table
 *     down cancelled their removal timers but never took the nodes off the
 *     screen — leaving frozen chip graphics floating over the lobby for ever,
 *     and over the table after the second game started.
 *
 *  2. Card animation state lived on the seat's DOM node, and the seat ring is
 *     rebuilt from scratch whenever somebody joins or leaves. A fresh node has
 *     no memory of the hand it replaced, so every visible hand re-dealt and
 *     re-flipped itself in the middle of play.
 *
 * There is a third, quieter one covered here too: the view set `destroyed = true`
 * on teardown and never cleared it, so after leaving a table every later game
 * rendered no seats (the old layout signature still matched) and animated
 * nothing (frame()/later() were permanently disabled).
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

/** Boot the real app shell in a jsdom document. */
function boot() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8'), {
    url: 'http://localhost:4000/',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.localStorage.clear();

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
  expose('fetch', async () => ({ ok: true, json: async () => ({ tables: [], leaderboard: [] }) }));

  return {
    dom,
    window,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      window.close();
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('animations do not outlive the table, and a second game still animates', { skip: !JSDOM, timeout: 180000 }, async (t) => {
  const { window, restore } = boot();
  const document = window.document;
  const floaters = () => document.querySelectorAll('body > .fly-chip, body > .sparkle, body > .reaction-float').length;

  try {
    await import('../public/js/app.js');
    const app = window.app;
    const view = app.view;

    // A short, fast table: this test is about animations and the seat ring, and
    // it only needs cards on screen quickly. Default pacing takes tens of real
    // seconds per hand, which made it flaky when the suite ran in parallel.
    window.document.querySelector('#practice-players').value = '2';
    window.document.querySelector('#practice-rounds').value = '3';
    app.store.settings.practicePace = 'fast';

    app.startPractice();
    await sleep(400);
    assert.ok(document.querySelectorAll('#seats .seat').length > 0, 'the table draws its seats');
    assert.equal(view.destroyed, false, 'a running table is not marked destroyed');

    // ── 1. flight animations are cleaned up when the table closes ────────────
    const seatEl = document.querySelector('#seats .seat');
    view.flyChips(seatEl, 4);
    view.sparkle(3);
    assert.ok(floaters() > 0, 'chips and sparkles are on screen while flying');

    // Close the table with them mid-flight: their timers are cancelled, so the
    // nodes must be removed by the teardown itself.
    view.destroy();
    assert.equal(floaters(), 0, 'closing the table takes the flying chips and sparkles with it');

    // ── 2. a second game starts clean ───────────────────────────────────────
    app.startPractice();
    await sleep(600);
    const seats = document.querySelectorAll('#seats .seat').length;
    assert.ok(seats > 0, `the next table draws its seats too (${seats} seats)`);
    assert.equal(view.destroyed, false, 'and is not stuck in the destroyed state');

    view.flyChips(document.querySelector('#seats .seat') || document.body, 3);
    const flying = floaters();
    assert.ok(flying > 0, 'animations work again in the second game, not just the first');
    await sleep(1400);
    assert.equal(floaters(), 0, 'and they still clean themselves up');

    // ── 3. an already-visible hand is not re-flipped by a ring rebuild ──────
    let seatId = null;
    let sawVisibleHand = false;
    for (let i = 0; i < 2500; i += 1) {
      const snapshot = view.snapshot;
      if (snapshot?.you) {
        seatId = snapshot.seats[snapshot.you.seat]?.id ?? seatId;
        if (snapshot.you.canAct) {
          if (snapshot.you.options?.see && !snapshot.you.seen) app.controller.dispatch('see');
          else if (snapshot.you.options?.call) app.controller.dispatch('chaal');
          else if (snapshot.you.options?.check) app.controller.dispatch('check');
        }
      }
      const node = seatId ? view.seats.get(seatId) : null;
      if (node && node.refs.hand.querySelectorAll('.pcard:not(.back)').length === 3) { sawVisibleHand = true; break; }
      await sleep(20);
    }
    assert.ok(sawVisibleHand, 'practice dealt a hand and the cards were shown');

    const beforeNode = view.seats.get(seatId);
    await sleep(700); // let the flip animation finish
    assert.equal(beforeNode.refs.hand.querySelectorAll('.pcard.flip').length, 3, 'the reveal animation did run');

    // Somebody sits down: the whole ring is rebuilt from scratch.
    app.controller.addBot?.();
    await sleep(300);
    const afterNode = view.seats.get(seatId);
    assert.notEqual(afterNode, beforeNode, 'the ring really was rebuilt');
    assert.equal(
      afterNode.refs.hand.querySelectorAll('.pcard.flip').length, 0,
      'cards the player can already see must NOT flip again'
    );
    assert.equal(
      afterNode.refs.hand.querySelectorAll('.pcard.dealt').length, 0,
      'and must not re-deal either'
    );
    assert.equal(
      afterNode.refs.hand.querySelectorAll('.pcard:not(.back)').length, 3,
      'the hand is still shown face-up after the rebuild'
    );

    // ── 4. leaving the table leaves nothing behind ──────────────────────────
    app.leaveTable();
    await sleep(300);
    assert.equal(floaters(), 0, 'no chips or sparkles left floating over the lobby');
    assert.equal(view.destroyed, true, 'the closed table is marked destroyed');
  } finally {
    restore();
  }
});
