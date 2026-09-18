/**
 * Verifies the single-file build (the file you double-click) actually works:
 * it is generated here, then loaded in jsdom with scripts enabled — the closest
 * thing to opening it in a real browser without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** Always build into a temp file: the committed PLAY-ME-first.html stays put. */
function buildToTemp() {
  return build({ out: path.join(os.tmpdir(), `teen-patti-standalone-${process.pid}-${Date.now()}.html`) });
}

test('the standalone build is self-contained (no server URLs left behind)', () => {
  if (!build) return; // jsdom not installed: nothing to check here
  const result = buildToTemp();
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
  assert.ok(html.includes("box.id = 'boot-error'"), 'the boot-failure banner ships in the single file');
  assert.ok(html.includes('window.__teenPattiReady = true'), 'the boot flag the banner watches for ships too');
  fs.rmSync(result.path, { force: true });
});

test('the shipped PLAY-ME-first.html is present and identical to a fresh build', () => {
  if (!build) return;
  const shipped = path.join(root, 'PLAY-ME-first.html');
  assert.ok(fs.existsSync(shipped), 'PLAY-ME-first.html ships with the project (double-click to play)');
  const fresh = buildToTemp();
  assert.equal(
    fs.readFileSync(shipped, 'utf8'),
    fresh.html,
    'PLAY-ME-first.html is stale — run: npm run build:standalone'
  );
  fs.rmSync(fresh.path, { force: true });
});

test('the single file boots, deals and plays a hand with scripts enabled', { skip: !JSDOM, timeout: 120000 }, async (t) => {
  const result = buildToTemp();
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

    // Lobby is rendered. Multiplayer cannot work from a lone .html file, so the
    // button has to explain that rather than swallow the click.
    assert.ok(window.document.querySelector('#rank-chart').children.length >= 6, 'hand rankings render');
    const onlineButton = window.document.querySelector('#btn-online');
    assert.equal(onlineButton.disabled, false, 'the button stays clickable so it can explain itself');
    assert.match(onlineButton.querySelector('small').textContent, /server app/i, 'its label says what it needs');
    onlineButton.click();
    const dialog = window.document.querySelector('#modal-root').textContent.replace(/\s+/g, ' ');
    assert.match(dialog, /START-WINDOWS\.bat/, 'the help names the launcher to double-click');
    assert.match(dialog, /same Wi-Fi/i, 'and explains the network requirement');
    assert.match(dialog, /nodejs\.org/i, 'and where to get Node.js if it is missing');
    window.document.querySelector('#modal-root').replaceChildren();
    assert.match(window.document.querySelector('#table-list').textContent, /single-file build/i);
    assert.ok(window.document.querySelector('#table-list .link-btn'), 'the table list offers the same help');

  // One betting round instead of the default four, with fast bots: the hand is
  // over in a few seconds instead of most of a minute, so the assertions below
  // are about the game rather than about how loaded the machine is. A default-length hand runs at human pace and takes tens of
  // real seconds, so this test used to fail whenever the machine was busy with
  // other suites — it was measuring the scheduler, not the game. These are the
  // same controls a player picks in the practice panel.
  window.document.querySelector('#practice-players').value = '4';
  window.document.querySelector('#practice-rounds').value = '1';
  window.app.store.settings.practicePace = 'fast';

  // Press "Practice vs AI" exactly like a player would.
  window.document.querySelector('#btn-practice').click();
  await waitFor(() => window.app.view.snapshot?.phase, 20000, 'the first dealt snapshot');
  assert.equal(window.document.querySelector('#game').classList.contains('active'), true, 'the table screen is shown');
  assert.ok(window.document.querySelectorAll('#seats .seat').length >= 4, 'seats render from the single file');

  // Play until a hand finishes.
  const started = Date.now();
  let acted = 0;
  while (Date.now() - started < 90000 && !(window.app.view.snapshot?.history?.length >= 1)) {
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
