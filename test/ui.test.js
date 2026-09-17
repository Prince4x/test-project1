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

test('each browser tab gets its own seat (two tabs = two players)', { skip: !JSDOM }, async () => {
  const sharedLocal = new Map();
  const sharedLocalStorage = {
    getItem: (key) => (sharedLocal.has(key) ? sharedLocal.get(key) : null),
    setItem: (key, value) => sharedLocal.set(key, String(value)),
    removeItem: (key) => sharedLocal.delete(key)
  };

  const sessionFor = (suffix) => {
    const values = new Map();
    if (suffix) values.set('teen-patti-arena/tab', suffix);
    return {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      values
    };
  };

  const previous = new Map();
  const expose = (key, value) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  expose('localStorage', sharedLocalStorage);

  try {
    const { Store } = await import('../public/js/store.js');

    // Same browser profile (shared localStorage), two different tabs.
    expose('sessionStorage', sessionFor(null));
    const tabA = new Store();
    expose('sessionStorage', sessionFor(null));
    const tabB = new Store();

    assert.equal(tabA.profile.id, tabB.profile.id, 'both tabs share the same identity');
    assert.notEqual(tabA.playerId, tabB.playerId, 'but they get different seats');
    assert.ok(tabA.playerId.startsWith(tabA.profile.id), 'the seat id derives from the identity');

    // A reload in the same tab keeps its seat (sessionStorage survives).
    const firstSeat = tabA.playerId;
    expose('sessionStorage', sessionFor(tabA.playerId.split('-').pop()));
    const reloaded = new Store();
    assert.equal(reloaded.playerId, firstSeat, 'reloading a tab keeps its seat — reconnects work');

    // The socket connects as the seat, not as the bare identity.
    if (typeof window !== 'undefined') {
      const { OnlineController } = await import('../public/js/net.js');
      const controller = new OnlineController({ profile: { id: 'identity-1', seatId: 'identity-1-abcd', name: 'T', avatar: '🙂' } });
      assert.match(controller.url, /profile=identity-1-abcd/, 'the socket claims the tab seat');
      assert.equal(controller.seatId, 'identity-1-abcd');
    }
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
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
      settings: { hints: true, sound: false, ambience: false, volume: 0.8, animations: 'fast', practiceRounds: 2, practiceBoot: 5, practiceTimer: 5, autoRebuy: true },
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

    // The app shell boots against the casino lobby markup and fills it in.
    const { default: AppModule } = await import('../public/js/app.js');
    assert.ok(AppModule || window.app, 'app shell module runs');
    const appInstance = window.app;
    assert.ok(appInstance, 'the app exposes a debug handle');

    // ── casino home page ──
    assert.ok(document.querySelector('.marquee-sign h2').textContent.includes('TEEN PATTI'), 'hero marquee sign renders');
    assert.equal(document.querySelectorAll('.hero-actions .cta').length, 3, 'three hero play buttons');
    assert.ok(document.querySelector('#rank-chart').children.length >= 6, 'hand-rankings chart is rendered');
    assert.ok(document.querySelectorAll('#rank-chart .rank-row .cards-mini').length >= 6, 'rankings show example cards');
    assert.ok(document.querySelector('#stat-grid').children.length >= 4, 'statistics render as chip tiles');
    assert.ok(document.querySelector('#ticker-track').childElementCount >= 14, 'the ticker is filled and duplicated for a seamless loop');
    assert.ok(document.querySelectorAll('.casino-bg .bokeh').length >= 4, 'stage dressing (bokeh) exists');
    assert.ok(document.querySelector('.player-card .pc-name').textContent.length > 0, 'profile card renders');
    assert.ok(document.querySelector('#sound-unlock'), 'a sound-unlock prompt exists');

    // leaderboard podium
    appInstance.renderLeaderboard([
      { name: 'Ravi', avatar: '🐯', hands: 12, wins: 5, net: 900, biggestPot: 400 },
      { name: 'Priya', avatar: '🦋', hands: 9, wins: 3, net: -120, biggestPot: 150 }
    ]);
    assert.ok(document.querySelector('#leaderboard .board-row.first'), 'the leader gets a podium row');
    assert.match(document.querySelector('#leaderboard .net.down').textContent, /-/);

    // house tables render as felt table cards with seat dots
    appInstance.renderTables([
      { id: 't1', name: 'Friendly Table', players: 3, humans: 1, maxPlayers: 6, boot: 10, pot: 140, handNo: 4, phase: 'betting' }
    ]);
    assert.equal(document.querySelectorAll('#table-list .table-card').length, 1, 'table card renders');
    assert.equal(document.querySelectorAll('#table-list .seat-dot').length, 6, 'seat dots show occupancy');
    assert.equal(document.querySelectorAll('#table-list .seat-dot.taken').length, 3, 'taken seats are marked');

    // ── sound board ──
    const { SoundBoard } = await import('../public/js/sound.js');
    const board = new SoundBoard({ enabled: true, ambience: true, volume: 0.6 });
    assert.equal(typeof board.unlock, 'function');
    assert.equal(typeof board.tick, 'function');
    for (const cue of ['shuffle', 'deal', 'flip', 'chip', 'chipStack', 'call', 'raise', 'check', 'fold', 'allIn',
      'turn', 'show', 'win', 'lose', 'join', 'warning', 'tick', 'message', 'error', 'reaction', 'click', 'hover']) {
      assert.equal(typeof board[cue], 'function', `sound cue "${cue}" exists`);
    }
    // With no Web Audio available (jsdom), every cue must be a silent no-op.
    board.unlock();
    board.win(true);
    board.setVolume(0.3);
    board.setEnabled(false);
    board.startAmbience();
    board.stopAmbience();
    assert.equal(board.state.volume, 0.3);

    appInstance.openSettings();
    assert.ok(document.querySelector('.modal'), 'settings modal opens');
    assert.ok(document.querySelectorAll('.modal .setting-row').length >= 4, 'settings rows render');
    appInstance.openTutorial();
    assert.ok(document.querySelector('.modal'), 'tutorial modal opens');
    appInstance.view.closeDrawers();

    // ── sharing / multiplayer plumbing ──
    const { inviteLink, isLocalHost } = await import('../public/js/ui.js');
    assert.equal(isLocalHost(), true, 'jsdom runs on localhost');
    assert.equal(
      inviteLink('t123', 'http://192.168.1.24:4000'),
      'http://192.168.1.24:4000/?table=t123',
      'the invite link is built on the LAN address, not localhost'
    );
    assert.equal(
      new URL(inviteLink('t123', 'https://cards.example.com/abc')).searchParams.get('table'),
      't123',
      'the invite link keeps the table id on any base'
    );

    // The lobby advertises a shareable address (server-reported LAN IP here).
    appInstance.network = {
      port: 4000,
      local: 'http://localhost:4000',
      addresses: [{ label: 'Wi-Fi', ip: '192.168.1.24', url: 'http://192.168.1.24:4000' }],
      primary: 'http://192.168.1.24:4000',
      publicUrl: null
    };
    appInstance.renderShareBar();
    const shareBar = document.querySelector('#share-bar');
    assert.equal(shareBar.hidden, false, 'the share bar is visible on the host machine');
    assert.match(shareBar.textContent, /192\.168\.1\.24:4000/, 'it shows the LAN address a friend can use');
    assert.equal(appInstance.inviteBase(), 'http://192.168.1.24:4000', 'invite base prefers the LAN address');

    // Deployed (PUBLIC_URL) wins over the LAN address.
    appInstance.network.publicUrl = 'https://cards.example.com';
    assert.equal(appInstance.inviteBase(), 'https://cards.example.com', 'a deployed public URL wins');

    appInstance.teardown();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
