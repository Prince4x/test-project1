/**
 * Browser-side tests: boot the real client modules inside a jsdom document and
 * play hands through the UI layer (practice controller + table view + app shell).
 *
 * jsdom is a dev-only dependency; the suite skips itself when it is missing so
 * the runtime stays dependency-free.
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
  // Make Node resolve the browser's absolute module URLs (/engine/*, /js/*).
  const { register } = await import('node:module');
  register('./browser-loader.mjs', import.meta.url);
} catch {
  JSDOM = null;
}

/** Map a browser import specifier ("/engine/x.js") onto a file in the repo. */
function resolveSpecifier(specifier) {
  const clean = specifier.split('?')[0];
  if (clean.startsWith('/engine/')) return path.join(root, 'src', 'engine', clean.slice('/engine/'.length));
  if (clean.startsWith('/shared/')) return path.join(root, 'src', clean.slice('/shared/'.length));
  if (clean.startsWith('/js/')) return path.join(root, 'public', 'js', clean.slice('/js/'.length));
  return path.join(root, 'public', clean.slice(1));
}

function listClientModules(dir = path.join(root, 'public', 'js')) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(dir, name));
}

test('every browser import resolves to a file the server can serve', () => {
  const modules = [
    ...listClientModules(),
    path.join(root, 'src', 'engine', 'table.js'),
    path.join(root, 'src', 'engine', 'ai.js'),
    path.join(root, 'src', 'engine', 'evaluator.js'),
    path.join(root, 'src', 'engine', 'cards.js')
  ];
  const missing = [];
  for (const file of modules) {
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('/')) {
        // relative import: resolve against the file
        const target = path.resolve(path.dirname(file), specifier);
        if (!fs.existsSync(target)) missing.push(`${path.relative(root, file)} -> ${specifier}`);
        continue;
      }
      const target = resolveSpecifier(specifier);
      if (!fs.existsSync(target)) missing.push(`${path.relative(root, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(missing, [], `unresolvable browser imports: ${missing.join(', ')}`);
});

test('index.html only references assets that exist', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]);
  const missing = refs.filter((ref) => !fs.existsSync(resolveSpecifier(ref)));
  assert.deepEqual(missing, [], `missing assets: ${missing.join(', ')}`);
  assert.ok(html.includes('type="module"'), 'the client boots from an ES module');
});

test('the client modules and app shell load in a DOM', { skip: !JSDOM, timeout: 120000 }, async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8'), {
    url: 'http://localhost:4000/',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  // localStorage exists in jsdom, but make certain it is writable.
  window.localStorage.clear();

  // Import the client modules with the DOM globals in scope.
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
  expose('HTMLElement', window.HTMLElement);
  expose('Node', window.Node);
  expose('SVGElement', window.SVGElement);

  try {
    const { PracticeController } = await import('../public/js/practice.js');
    const { GameView } = await import('../public/js/game-view.js');

    const seatUpdates = [];
    const messages = [];
    const store = {
      settings: { hints: true, sound: false, animations: 'fast', practiceRounds: 2, practiceBoot: 5, practiceTimer: 5, autoRebuy: true },
      profile: { id: 'dom-player', name: 'Dom Tester', avatar: '🧪' },
      recordHand() {}
    };
    const sound = new Proxy({}, { get: () => () => {} });

    const controller = new PracticeController({
      profile: store.profile,
      settings: store.settings,
      pace: 'fast',
      onState: (snapshot) => {
        seatUpdates.push(snapshot);
        view.render(snapshot, { id: snapshot.tableId, name: snapshot.name });
      },
      onEvent: (events) => view.handleEvents(events),
      onError: (message) => messages.push(`error:${message}`),
      onHandEnd: (info) => messages.push(`hand:${info.handNo}:${info.net}`),
      onChat: (message) => view.pushChat(message)
    });

    const view = new GameView({
      store,
      sound,
      callbacks: {
        onLeave: () => {},
        onRebuy: () => {},
        onAddBot: () => controller.addBot(),
        onChat: (text) => controller.chat(text),
        onHandResult: () => {}
      }
    }).mount();
    view.setController(controller);
    controller.start();

    // Basic structure after the first render.
    assert.equal(seatUpdates.length, 1);
    assert.equal(document.querySelectorAll('#seats .seat').length >= 4, true, 'seats are drawn');
    assert.ok(document.querySelector('#pot-value').textContent.length > 0, 'the pot is rendered');
    assert.ok(document.querySelector('#action-bar').children.length > 0, 'the action bar is rendered');

    // Play several hands by always taking the safest legal action.
    const started = Date.now();
    let myTurns = 0;
    while (Date.now() - started < 60000 && Number(messages.filter((m) => m.startsWith('hand:')).length) < 1) {
      const snapshot = controller.table.serialize(controller.humanId);
      const you = snapshot.you;
      if (you?.canAct) {
        myTurns += 1;
        if (you.options.see && myTurns % 2 === 0) controller.dispatch('see');
        else if (you.options.call) controller.dispatch('chaal');
        else controller.dispatch('allin');
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    controller.stop();

    assert.ok(myTurns > 0, 'the player got a turn');
    assert.ok(messages.some((m) => m.startsWith('hand:')), `hands finished through the UI layer (${messages.join(', ')})`);
    assert.equal(messages.filter((m) => m.startsWith('error:')).length, 0, 'no UI errors');

    // Drawers and modals are wired up.
    document.querySelector('#btn-chat').click();
    assert.ok(document.querySelector('#chat-drawer').classList.contains('open'), 'chat drawer opens');
    document.querySelector('[data-close-drawer]').click();
    assert.equal(document.querySelector('#chat-drawer').classList.contains('open'), false, 'drawer closes');
    document.querySelector('#btn-rankings').click();
    assert.ok(document.querySelector('#rankings-body').textContent.includes('Trail'), 'rankings reference renders');
    view.destroy();

    // The app shell boots against the lobby markup and fills it in.
    const { default: AppModule } = await import('../public/js/app.js');
    assert.ok(AppModule || window.app, 'app shell module runs');
    const appInstance = window.app;
    assert.ok(appInstance, 'the app exposes a debug handle');
    assert.ok(document.querySelector('#rank-chart').children.length >= 6, 'lobby hand-rankings chart is rendered');
    assert.ok(document.querySelector('#stat-grid').children.length >= 4, 'lobby statistics render');
    assert.ok(document.querySelector('#profile-chip').textContent.trim().length > 0, 'profile chip renders');
    appInstance.openTutorial();
    assert.ok(document.querySelector('.modal'), 'tutorial modal opens');
    appInstance.view.closeDrawers();
    appInstance.teardown();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
