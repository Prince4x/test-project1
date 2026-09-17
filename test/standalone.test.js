/**
 * Verifies the single-file build (the file you double-click) actually works:
 * it is generated here, then loaded in jsdom with scripts enabled — the closest
 * thing to opening it in a real browser without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let JSDOM = null;
let VirtualConsole = null;
let build = null;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
  ({ build } = await import('../tools/build-standalone.mjs'));
} catch {
  JSDOM = null;
  VirtualConsole = null;
  build = null;
}

test('the standalone build is self-contained (no server URLs left behind)', () => {
  if (!build) return; // jsdom not installed: nothing to check here
  const result = build();
  assert.ok(result.bytes > 100_000, 'the bundle is inlined into the file');
  assert.ok(fs.existsSync(result.path), 'the build wrote a file');

  const html = fs.readFileSync(result.path, 'utf8');
  assert.ok(html.includes('<style>'), 'CSS is inlined');
  assert.ok(!html.includes('src="/js/app.js"'), 'the module entry point is gone');
  assert.ok(!html.includes('href="/styles.css"'), 'the stylesheet link is gone');
  assert.ok(!html.includes("from '/engine/"), 'engine imports were rewritten');
  assert.ok(html.includes('__TEEN_PATTI_STANDALONE__ = true'), 'the standalone flag is set');
  assert.ok(html.includes('__require("public/js/app.js")'), 'the entry module is required at the end');
  assert.ok(html.includes('const $$ ='), 'dollar signs survive bundling (no replace() escaping bugs)');
  fs.rmSync(result.path, { force: true });
});

test('the single file boots, deals and plays a hand with scripts enabled', { skip: !JSDOM, timeout: 120000 }, async (t) => {
  const result = build();
  t.after(() => fs.rmSync(result.path, { force: true }));

  const problems = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => problems.push(`jsdom: ${error.message}`));
  virtualConsole.on('error', (...args) => problems.push(`console.error: ${args.join(' ')}`));

  const dom = new JSDOM(fs.readFileSync(result.path, 'utf8'), {
    url: 'http://localhost/teen-patti-standalone.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  t.after(() => window.close());

  const waitFor = async (predicate, timeout = 30000, label = 'condition') => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${problems.join(' | ')}`);
  };

  await waitFor(() => window.app, 20000, 'the app shell to boot from the single file');

  // Lobby is rendered and multiplayer is politely disabled.
  assert.ok(window.document.querySelector('#rank-chart').children.length >= 6, 'hand rankings render');
  assert.equal(window.document.querySelector('#btn-online').disabled, true, 'online mode is disabled offline');
  assert.match(window.document.querySelector('#table-list').textContent, /single-file build/i);

  // Press "Practice vs AI" exactly like a player would.
  window.document.querySelector('#btn-practice').click();
  await waitFor(() => window.app.view.snapshot?.phase, 20000, 'the first dealt snapshot');
  assert.equal(window.document.querySelector('#game').classList.contains('active'), true, 'the table screen is shown');
  assert.ok(window.document.querySelectorAll('#seats .seat').length >= 4, 'seats render from the single file');

  // Play until a hand finishes.
  const started = Date.now();
  let acted = 0;
  while (Date.now() - started < 60000 && !(window.app.view.snapshot?.history?.length >= 1)) {
    const snapshot = window.app.view.snapshot;
    if (snapshot?.phase === 'betting') {
      const you = snapshot.you;
      if (you?.inHand && !you.packed && you.options?.see && acted % 2 === 0) {
        window.app.view.act('see');
        acted += 1;
      } else if (you?.canAct) {
        window.app.view.act(you.options.call ? 'chaal' : 'allin');
        acted += 1;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  assert.ok(acted > 0, 'actions were dispatched from the single file');
  assert.ok(window.app.view.snapshot.history.length >= 1, `a hand completed offline (${problems.join(' | ')})`);
  assert.ok(window.document.querySelector('#pot-value').textContent.length > 0, 'the pot is rendered');
  assert.equal(problems.filter((message) => !/Could not parse CSS|Not implemented/.test(message)).length, 0,
    `no script errors: ${problems.join(' | ')}`);
});
