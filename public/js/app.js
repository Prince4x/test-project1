/**
 * App shell — lobby, screen switching, settings, tutorial and the glue between
 * the controllers (practice / online) and the table view.
 */

import { Store, AVATARS } from '/js/store.js';
import { SoundBoard } from '/js/sound.js';
import { PracticeController } from '/js/practice.js';
import { OnlineController } from '/js/net.js';
import { GameView } from '/js/game-view.js';
import { RANKING_CHART, CATEGORY_LABEL } from '/engine/evaluator.js';
import { PERSONALITIES } from '/engine/ai.js';
import {
  el, $, $$, toast, openModal, closeModal, cardRow, formatChips, formatSigned, inviteLink, copyToClipboard
} from '/js/ui.js';

/**
 * The single-file build (`tools/build-standalone.mjs`) runs from a plain file://
 * URL with no server behind it: practice mode works fully, multiplayer is
 * switched off with a friendly explanation instead of a broken fetch.
 */
const STANDALONE = Boolean(window.__TEEN_PATTI_STANDALONE__);

const SPEED = { slow: 1.6, normal: 1, fast: 0.55 };

class App {
  constructor() {
    this.store = new Store();
    this.sound = new SoundBoard({
      enabled: this.store.settings.sound,
      speed: SPEED[this.store.settings.animations] || 1
    });
    this.mode = null;                 // 'practice' | 'online'
    this.controller = null;
    this.view = new GameView({
      store: this.store,
      sound: this.sound,
      callbacks: {
        onLeave: () => this.leaveTable(),
        onOpenSettings: () => this.openSettings(),
        onAddBot: () => this.controller?.addBot?.(),
        onRebuy: (amount) => this.rebuy(amount),
        onChat: (text) => this.sendChat(text),
        onReaction: (emoji) => this.sendReaction(emoji),
        onInvite: () => this.showInvite(),
        onHandResult: (info) => this.recordOnlineHand(info)
      }
    });
    this.online = null;
    this.tablesRefresh = null;
  }

  // ───────────────────────────────────────────────────────────── bootstrap ──

  init() {
    this.applyTheme(this.store.settings.theme, { silent: true });
    this.applySpeed(this.store.settings.animations);
    this.view.mount();
    this.renderProfileChip();
    this.renderStats();
    this.renderRankChart();
    this.bindLobby();
    this.bindGlobal();
    this.renderLeaderboard([]);

    const url = new URL(window.location.href);
    const wanted = url.searchParams.get('table');
    if (wanted) {
      url.searchParams.delete('table');
      window.history.replaceState({}, '', url.pathname + (url.search || ''));
      this.startOnline({ tableId: wanted });
    }
    return this;
  }

  bindGlobal() {
    document.addEventListener('keydown', (event) => {
      if (event.target.matches('input, textarea, select')) return;
      if (event.key === 'Escape') {
        this.view.closeDrawers();
        return;
      }
      if (!$('#game').classList.contains('active') || event.metaKey || event.ctrlKey) return;
      const map = { s: 'see', f: 'pack', c: 'call', a: 'allin', r: 'raise' };
      const intent = map[event.key.toLowerCase()];
      if (!intent) return;
      const you = this.view.snapshot?.you;
      if (!you?.canAct) return;
      if (intent === 'see' && you.options?.see) this.view.act('see');
      else if (intent === 'pack') this.view.act('pack');
      else if (intent === 'call' && you.options?.call) this.view.act(you.options.callLabel === 'Blind' ? 'blind' : 'chaal');
      else if (intent === 'allin' && you.options?.allIn) this.view.act('allin');
      else if (intent === 'raise' && you.options?.raise) this.view.act('raise', { stake: this.view.raiseValue });
    });
    window.addEventListener('beforeunload', () => {
      this.controller?.stop?.();
      this.online?.disconnect?.();
    });
  }

  bindLobby() {
    $('#btn-sound').onclick = () => {
      this.sound.resume();
      this.store.setSetting('sound', !this.store.settings.sound);
      this.sound.setEnabled(this.store.settings.sound);
      this.syncTopButtons();
    };
    $('#btn-theme').onclick = () => {
      const next = this.store.settings.theme === 'dark' ? 'light' : 'dark';
      this.store.setSetting('theme', next);
      this.applyTheme(next);
    };
    $('#btn-settings').onclick = () => this.openSettings();
    $('#btn-help').onclick = () => this.openTutorial();
    $('#btn-practice').onclick = () => {
      this.sound.resume();
      this.startPractice();
    };
    $('#btn-online').onclick = () => this.startOnline({});
    $('#btn-tutorial').onclick = () => this.openTutorial();
    $('#btn-create').onclick = () => this.openCreateTable();
    $('#btn-refresh').onclick = () => this.refreshTables();
    $('#btn-reset-stats').onclick = () => {
      openModal({
        title: 'Reset statistics?',
        icon: '🧹',
        body: [el('p', { class: 'muted', text: 'Your win rate, hand count and best hand will be cleared. Your profile and chips stay.' })],
        actions: [
          { label: 'Cancel' },
          { label: 'Reset', kind: 'danger', onClick: () => { this.store.resetStats(); this.renderStats(); toast('Statistics cleared', { kind: 'good' }); } }
        ]
      });
    };
    $('#profile-chip').onclick = () => this.openProfileEditor();
    this.syncTopButtons();
    if (STANDALONE) {
      $('#hero-title').textContent = 'Your offline Teen Patti table';
      $('#hero-copy').textContent = 'This single-file build runs straight from your disk — no server, no internet. Press “Practice vs AI” to deal. Everything else (rules, AI, stats, sounds) is identical to the online game.';
      $('#btn-online').querySelector('span span').textContent = 'Needs the full project — run "npm start" for live tables.';
      $('#btn-online').disabled = true;
      $('#btn-online').title = 'Multiplayer needs the Node server from the full project';
    }
  }

  syncTopButtons() {
    $('#btn-sound').textContent = this.store.settings.sound ? '🔊' : '🔇';
    $('#btn-theme').textContent = this.store.settings.theme === 'dark' ? '🌙' : '☀️';
  }

  applyTheme(theme, { silent } = {}) {
    document.body.dataset.theme = theme;
    this.syncTopButtons();
    if (!silent) toast(`${theme === 'dark' ? 'Night felt' : 'Daylight felt'} theme on`, { timeout: 1400 });
  }

  applySpeed(speed) {
    document.documentElement.style.setProperty('--anim-speed', String(SPEED[speed] || 1));
    this.sound.setSpeed(SPEED[speed] || 1);
  }

  renderProfileChip() {
    const { name, avatar } = this.store.profile;
    $('#profile-chip').replaceChildren(
      el('span', { class: 'pill', style: { cursor: 'pointer' } }, [
        el('span', { text: avatar, style: { fontSize: '16px' } }),
        el('span', { text: name })
      ])
    );
  }

  renderStats() {
    const stats = this.store.stats;
    const net = stats.net;
    $('#stat-grid').replaceChildren(
      el('div', { class: 'stat' }, [el('b', { text: String(stats.hands) }), el('span', { text: 'hands played' })]),
      el('div', { class: 'stat' }, [el('b', { text: `${this.store.winRate}%` }), el('span', { text: 'win rate' })]),
      el('div', { class: `stat ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}` }, [el('b', { text: formatSigned(net) }), el('span', { text: 'net chips' })]),
      el('div', { class: 'stat' }, [el('b', { text: formatChips(stats.biggestPot) }), el('span', { text: 'biggest pot' })])
    );
    $('#pill-best-hand').textContent = stats.bestHand
      ? `Best hand: ${stats.bestHand.name}`
      : 'Best hand: —';
  }

  renderRankChart(highlightCategory = null) {
    // keyed by the engine's category value (see evaluator.js)
    const examples = {
      5: ['AS', 'AH', 'AD'],   // trail
      4: ['AS', 'KS', 'QS'],   // pure sequence
      3: ['AS', 'KH', 'QD'],   // sequence
      2: ['AS', 'JS', '4S'],   // colour
      1: ['KS', 'KH', '7D'],   // pair
      0: ['AS', 'JH', '9D']    // high card
    };
    $('#rank-chart').replaceChildren(...RANKING_CHART.map((entry, index) => el('div', {
      class: `rank-row ${highlightCategory === entry.category ? 'highlight' : ''}`
    }, [
      el('span', { class: 'idx', text: String(index + 1) }),
      el('div', {}, [
        el('b', { text: entry.name }),
        el('div', { class: 'tiny muted', text: CATEGORY_LABEL[entry.category] })
      ]),
      cardRow(examples[entry.category] || [], { size: 'sm' })
    ])));
  }

  renderLeaderboard(entries) {
    const host = $('#leaderboard');
    if (!entries?.length) {
      host.replaceChildren(el('p', { class: 'muted tiny', text: this.mode === 'online' ? 'No hands played on the server yet.' : 'Connect to a live table to build the leaderboard.' }));
      return;
    }
    host.replaceChildren(...entries.map((entry, index) => el('div', { class: 'board-row' }, [
      el('span', { class: 'place', text: `#${index + 1}` }),
      el('span', {}, [
        el('b', { text: `${entry.avatar || '🙂'} ${entry.name}` }),
        el('span', { class: 'tiny muted', text: ` · ${entry.hands} hands · ${entry.wins} wins` })
      ]),
      el('span', { class: entry.net >= 0 ? 'pill green' : 'pill red', text: formatSigned(entry.net) })
    ])));
  }

  renderTables(tables = []) {
    const host = $('#table-list');
    $('#pill-tables').textContent = `${tables.length} table${tables.length === 1 ? '' : 's'}`;
    if (!tables.length) {
      host.replaceChildren(el('p', { class: 'muted tiny', text: 'No live tables right now — create one and invite a friend.' }));
      return;
    }
    host.replaceChildren(...tables.map((table) => {
      const row = el('div', { class: 'table-row' }, [
        el('div', { class: 'name' }, [
          el('span', { text: '🎴' }),
          el('span', { text: table.name }),
          table.phase === 'betting' ? el('span', { class: 'pill green', text: 'in play' }) : el('span', { class: 'pill', text: 'waiting' })
        ]),
        el('button', {
          class: 'btn small primary',
          text: 'Sit down',
          onclick: () => this.startOnline({ tableId: table.id, buyIn: table.boot * 50 })
        }),
        el('div', { class: 'meta' }, [
          el('span', { class: 'pill', text: `👤 ${table.players}/${table.maxPlayers}` }),
          el('span', { class: 'pill gold', text: `boot ${formatChips(table.boot)}` }),
          el('span', { class: 'pill', text: `pot ${formatChips(table.pot)}` }),
          el('span', { class: 'pill blue', text: `hand #${table.handNo}` })
        ])
      ]);
      return row;
    }));
  }

  // ─────────────────────────────────────────────────────────────── practice ──

  startPractice() {
    this.teardown();
    this.mode = 'practice';
    $('#pill-connection').textContent = '● Offline practice';
    const settings = {
      ...this.store.settings,
      practicePlayers: Number($('#practice-players').value),
      practiceBoot: Number($('#practice-boot').value),
      practiceRounds: Number($('#practice-rounds').value),
      practiceTimer: Number($('#practice-timer').value)
    };

    this.controller = new PracticeController({
      profile: this.store.profile,
      settings,
      onState: (snapshot) => {
        this.view.render(snapshot, { id: snapshot.tableId, name: snapshot.name, bots: snapshot.seats.filter((seat) => seat?.isBot).length });
      },
      onEvent: (events) => this.view.handleEvents(events),
      onError: (message) => { this.sound.error(); toast(message, { kind: 'warn' }); },
      onHandEnd: (info) => this.recordPracticeHand(info),
      onChat: (message) => this.view.pushChat(message)
    });
    this.view.setController(this.controller);
    this.showScreen('game');
    this.controller.start();
    this.view.pushChat({ system: true, from: 'Table', text: 'Practice table ready — blinds are fixed at the boot, no blinds rotation. Good luck!' });
    toast('Practice mode — play blind or see your cards to bet at full rate', { timeout: 4200 });
  }

  recordPracticeHand(info) {
    this.store.recordHand({
      won: info.won,
      amount: info.amount,
      net: info.net,
      folded: info.packed,
      bestHand: info.bestHand ? { name: info.bestHand.name, rank: info.bestHand.rank } : null
    });
    this.renderStats();
    if (info.won) {
      toast(`You won ${formatChips(info.amount)} (${formatSigned(info.net)} this hand)`, { kind: 'good' });
    }
  }

  recordOnlineHand(info) {
    if (!info.results) return;
    const ranking = info.results.rankings?.find((entry) => entry.id === this.store.profile.id);
    const me = this.view.snapshot?.seats?.find((seat) => seat?.id === this.store.profile.id);
    this.store.recordHand({
      won: info.won,
      amount: info.amount,
      net: info.amount - (ranking?.committed || 0),
      folded: Boolean(me?.packed),
      bestHand: ranking ? { name: ranking.hand.text, rank: ranking.strength } : null
    });
    this.renderStats();
  }

  // ───────────────────────────────────────────────────────────────── online ──

  startOnline({ tableId = null, buyIn = null } = {}) {
    if (STANDALONE) {
      this.sound.error();
      toast('Multiplayer needs the full project — run "npm start" and open localhost:4000', { kind: 'warn', timeout: 5200 });
      return;
    }
    this.teardown();
    this.mode = 'online';
    this.sound.resume();
    let joinRequested = false;

    this.online = new OnlineController({
      profile: this.store.profile,
      onStatus: ({ state, retryIn }) => {
        const labels = {
          connecting: '● Connecting…',
          connected: '● Live server',
          disconnected: '● Disconnected',
          reconnecting: `● Reconnecting in ${retryIn ?? 1}s`,
          error: '● Connection error'
        };
        $('#pill-connection').textContent = labels[state] || '● Offline';
        if (state === 'reconnecting') toast('Connection lost — retrying…', { kind: 'warn' });
      },
      onWelcome: (message) => {
        if (message.leaderboard?.length) this.renderLeaderboard(message.leaderboard);
        if (message.tables) this.renderTables(message.tables);
        if (tableId && !joinRequested) {
          joinRequested = true;
          this.online.joinTable(tableId, buyIn || 1000);
          this.showScreen('game');
          this.view.pushChat({ system: true, from: 'Table', text: 'Connecting to the table…' });
        }
      },
      onTables: (tables) => {
        this.renderTables(tables);
        const stats = tables.find((table) => table.id === this.view.snapshot?.tableId);
        if (stats) this.view.tableInfo = stats;
      },
      onState: (snapshot, events, table) => this.view.render(snapshot, table),
      onEvent: (events) => this.view.handleEvents(events),
      onJoined: (message) => {
        if (!tableId) return;
        const info = message.table;
        this.view.pushChat({
          system: true,
          from: 'Table',
          text: `Welcome to ${info?.name || 'the table'} — boot ${formatChips(info?.boot ?? 0)}, ${info?.players ?? 0}/${info?.maxPlayers ?? 6} seated.`
        });
        if (info?.humans <= 1) {
          toast('You are the only human — use 💬 → Add AI player, or share an invite link', { timeout: 5000 });
        }
      },
      onLeft: () => {
        this.showScreen('lobby');
        this.mode = null;
      },
      onChat: (message) => this.view.pushChat(message),
      onError: (message) => {
        this.sound.error();
        toast(message, { kind: 'warn' });
        if (/full|no longer/.test(message)) this.showScreen('lobby');
      }
    });

    this.view.setController(this.online);
    this.controller = null;
    this.online.connect();
    this.refreshTables();
    if (!tableId) {
      this.showScreen('lobby');
      toast('Connected — pick a live table or create your own', { kind: 'good', timeout: 3600 });
    }
    clearInterval(this.tablesRefresh);
    this.tablesRefresh = setInterval(() => this.mode === 'online' && this.online?.requestTables?.(), 6000);
  }

  joinOnline(tableId, buyIn) {
    this.online?.joinTable(tableId, buyIn);
    this.view.pushChat({ system: true, from: 'Table', text: 'Taking your seat…' });
    this.showScreen('game');
  }

  sendChat(text) {
    if (this.mode === 'online') {
      // The server broadcasts to everybody, including us — no local echo needed.
      this.online.chat(text);
      return;
    }
    this.controller?.chat(text);
  }

  sendReaction(emoji) {
    this.sendChat(emoji);
    this.view.floatEmote(emoji, this.store.profile.name);
    this.sound.reaction();
  }

  rebuy(amount) {
    if (this.mode === 'online') this.online.rebuy(amount);
    else toast('Practice mode tops you up automatically between hands', { timeout: 2200 });
  }

  showInvite() {
    const tableId = this.view.snapshot?.tableId;
    if (!tableId) return;
    const link = inviteLink(tableId);
    openModal({
      title: 'Invite players',
      icon: '🔗',
      body: [
        el('p', { class: 'muted', text: 'Anyone opening this link sits at your table with their own chips.' }),
        el('input', { value: link, readOnly: true, style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' } })
      ],
      actions: [
        { label: 'Add AI player', onClick: () => { this.online?.fillWithBots(1); } },
        { label: 'Copy link', kind: 'primary', onClick: () => { copyToClipboard(link); toast('Invite link copied', { kind: 'good' }); } }
      ]
    });
  }

  refreshTables() {
    if (STANDALONE) {
      $('#pill-connection').textContent = '● Offline build';
      $('#pill-tables').textContent = 'single file';
      const list = $('#table-list');
      if (list) {
        list.replaceChildren(el('p', { class: 'muted tiny' }, [
          el('b', { text: 'This is the single-file build. ' }),
          el('span', {
            text: 'Practice vs AI works completely offline. For live multiplayer tables, run the full project (npm start) — every other feature is identical.'
          })
        ]));
      }
      return;
    }
    if (!this.online) {
      fetch('/api/tables').then((res) => res.json()).then((data) => this.renderTables(data.tables || [])).catch(() => {});
      fetch('/api/leaderboard').then((res) => res.json()).then((data) => this.renderLeaderboard(data.leaderboard || [])).catch(() => {});
      return;
    }
    this.online.requestTables();
  }

  // ────────────────────────────────────────────────────────────── screen flow ──

  showScreen(name) {
    $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === name));
    if (name === 'lobby') this.refreshTables();
  }

  leaveTable() {
    if (this.mode === 'online') {
      this.online?.leaveTable();
      clearInterval(this.tablesRefresh);
      this.online?.disconnect();
      this.online = null;
      this.controller = null;
    }
    this.view.destroy();
    this.mode = null;
    $('#pill-connection').textContent = '● Offline';
    this.showScreen('lobby');
    this.renderStats();
  }

  teardown() {
    this.controller?.stop?.();
    this.controller = null;
    if (this.online) {
      this.online.disconnect();
      this.online = null;
    }
    clearInterval(this.tablesRefresh);
    this.view.destroy();
  }

  // ────────────────────────────────────────────────────────────── modals ──

  openProfileEditor() {
    const nameInput = el('input', { value: this.store.profile.name, maxLength: 18, style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' } });
    let chosen = this.store.profile.avatar;
    const grid = el('div', { class: 'row wrap' }, AVATARS.map((avatar) => {
      const button = el('button', {
        class: `btn small ${avatar === chosen ? 'primary' : ''}`,
        text: avatar,
        style: { fontSize: '20px' },
        onclick: (event) => {
          chosen = avatar;
          [...grid.children].forEach((child) => child.classList.remove('primary'));
          event.currentTarget.classList.add('primary');
        }
      });
      return button;
    }));
    const idField = el('input', { value: this.store.profile.id, readOnly: true, style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', fontSize: '12px' } });

    openModal({
      title: 'Your profile',
      icon: '🧑‍🚀',
      body: [
        el('div', { class: 'field' }, [el('label', { text: 'Display name' }), nameInput]),
        el('div', { class: 'field' }, [el('label', { text: 'Avatar' }), grid]),
        el('div', { class: 'field' }, [el('label', { text: 'Player id (used to rejoin a table)' }), idField]),
        el('p', { class: 'tiny muted', text: `Session stats: ${this.store.stats.hands} hands · ${this.store.winRate}% wins · ${formatSigned(this.store.stats.net)} net.` })
      ],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          kind: 'primary',
          onClick: () => {
            this.store.setProfile({ name: nameInput.value.trim().slice(0, 18) || 'Player', avatar: chosen });
            this.renderProfileChip();
            if (this.mode === 'online') toast('Rejoin tables to use your new name', { timeout: 2600 });
          }
        }
      ]
    });
  }

  openCreateTable() {
    const nameInput = el('input', { value: `${this.store.profile.name}'s table`, maxLength: 28, style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' } });
    const boot = el('select', { style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' } },
      [5, 10, 25, 100].map((value) => el('option', { value: String(value), text: `${value} chips`, selected: value === 10 })));
    const bots = el('select', { style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' } },
      [0, 1, 2, 3, 4, 5].map((value) => el('option', { value: String(value), text: value === 0 ? 'No AI (humans only)' : `${value} AI player${value > 1 ? 's' : ''}`, selected: value === 3 })));
    const rounds = el('select', { style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' } },
      [2, 3, 4, 6].map((value) => el('option', { value: String(value), text: `${value} rounds`, selected: value === 3 })));
    const buyIn = el('select', { style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' } },
      [500, 1000, 2500, 5000].map((value) => el('option', { value: String(value), text: `${value} chips`, selected: value === 1000 })));

    openModal({
      title: 'Create a live table',
      icon: '🃏',
      body: [
        el('div', { class: 'field' }, [el('label', { text: 'Table name' }), nameInput]),
        el('div', { class: 'split' }, [
          el('div', { class: 'field' }, [el('label', { text: 'Boot (ante)' }), boot]),
          el('div', { class: 'field' }, [el('label', { text: 'AI players' }), bots]),
          el('div', { class: 'field' }, [el('label', { text: 'Betting rounds' }), rounds]),
          el('div', { class: 'field' }, [el('label', { text: 'Your buy-in' }), buyIn])
        ]),
        el('p', { class: 'tiny muted', text: 'Two to six players per table. AI players keep the action going while your friends arrive; add more later from the invite panel.' })
      ],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create & sit down',
          kind: 'primary',
          onClick: () => {
            const config = {
              boot: Number(boot.value),
              startChips: Number(buyIn.value),
              minBuyIn: Math.max(100, Number(buyIn.value) / 2),
              maxBuyIn: Number(buyIn.value) * 4,
              maxRounds: Number(rounds.value),
              turnSeconds: 25,
              autoRebuy: false
            };
            if (!this.online) {
              this.mode = 'online';
              this.startOnline({});
              setTimeout(() => this.online?.createTable({ name: nameInput.value, config, bots: Number(bots.value), buyIn: Number(buyIn.value) }), 500);
            } else {
              this.online.createTable({ name: nameInput.value, config, bots: Number(bots.value), buyIn: Number(buyIn.value) });
            }
            setTimeout(() => this.showScreen('game'), 600);
          }
        }
      ]
    });
  }

  openSettings() {
    const s = this.store.settings;
    const toggleRow = (label, note, key, onChange) => el('div', { class: 'setting-row' }, [
      el('div', { class: 'label' }, [el('b', { text: label }), el('span', { text: note })]),
      el('label', { class: 'switch' }, [
        el('input', {
          type: 'checkbox',
          checked: Boolean(s[key]),
          onchange: (event) => {
            this.store.setSetting(key, event.target.checked);
            onChange?.(event.target.checked);
          }
        }),
        el('span', { class: 'track' })
      ])
    ]);

    const speedButtons = el('div', { class: 'row' }, ['slow', 'normal', 'fast'].map((speed) => el('button', {
      class: `btn small ${s.animations === speed ? 'primary' : ''}`,
      text: speed,
      onclick: (event) => {
        this.store.setSetting('animations', speed);
        this.applySpeed(speed);
        [...event.currentTarget.parentElement.children].forEach((child) => child.classList.remove('primary'));
        event.currentTarget.classList.add('primary');
      }
    })));

    const body = [
      toggleRow('Sound effects', 'Card deals, chips, wins and losses', 'sound', (value) => {
        this.sound.setEnabled(value);
        this.syncTopButtons();
      }),
      toggleRow('Strategy hints', 'Show hand strength advice under your cards', 'hints'),
      toggleRow('Auto top-up (practice)', 'Bots and you refill when a stack busts', 'autoRebuy'),
      el('div', { class: 'setting-row' }, [
        el('div', { class: 'label' }, [el('b', { text: 'Animation speed' }), el('span', { text: 'Faster play for quick sessions' })]),
        speedButtons
      ]),
      el('div', { class: 'setting-row' }, [
        el('div', { class: 'label' }, [el('b', { text: 'Table theme' }), el('span', { text: 'Night felt or daylight' })]),
        el('button', {
          class: 'btn small',
          text: s.theme === 'dark' ? '🌙 Night' : '☀️ Daylight',
          onclick: (event) => {
            const next = this.store.settings.theme === 'dark' ? 'light' : 'dark';
            this.store.setSetting('theme', next);
            this.applyTheme(next);
            event.currentTarget.textContent = next === 'dark' ? '🌙 Night' : '☀️ Daylight';
          }
        })
      ]),
      el('div', { class: 'setting-row' }, [
        el('div', { class: 'label' }, [el('b', { text: 'Achievements' }), el('span', { text: `${this.store.stats.hands} hands · ${this.store.stats.wins} wins · best ${this.store.stats.bestHand?.name || '—'}` })])
      ])
    ];

    if (this.mode === 'practice' && this.controller) {
      body.push(el('div', { class: 'setting-row' }, [
        el('div', { class: 'label' }, [el('b', { text: 'AI opponents' }), el('span', { text: `${this.view.snapshot?.seats?.filter(Boolean).filter((seat) => seat.isBot).length || 0} bots seated` })]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn small', text: '− Remove', onclick: () => this.controller.removeBot() }),
          el('button', { class: 'btn small primary', text: '+ Add AI', onclick: () => this.controller.addBot() })
        ])
      ]));
      body.push(el('div', { class: 'setting-row' }, [
        el('div', { class: 'label' }, [el('b', { text: 'Pacing' }), el('span', { text: 'Betting rounds and turn timer apply to new hands' })])
      ]));
    }

    if (this.mode === 'online') {
      body.push(el('div', { class: 'setting-row' }, [
        el('div', { class: 'label' }, [el('b', { text: 'Invite friends' }), el('span', { text: 'Copy a link to this table' })]),
        el('button', { class: 'btn small', text: '🔗 Invite', onclick: () => this.showInvite() })
      ]));
    }

    body.push(el('p', { class: 'tiny muted', text: 'Keyboard: S see · F pack · C chaal · R raise · A all-in · Esc close panels' }));

    openModal({
      title: 'Settings',
      icon: '⚙️',
      body,
      actions: [
        { label: 'How to play', onClick: () => this.openTutorial() },
        { label: 'Done', kind: 'primary' }
      ]
    });
  }

  openTutorial() {
    const steps = [
      {
        title: '1 · Post the boot and get three cards',
        text: 'Everyone pays the boot (ante) to be dealt three cards. Play is either blind or seen — blind bets cost half, so blind play is cheaper but you are betting in the dark.'
      },
      {
        title: '2 · See your cards when you are ready',
        text: 'Press S or the 👁 button to look. You keep the same turn and may then chaal (call the stake) at full rate, raise, or pack. Raising blind must at least double the stake.'
      },
      {
        title: '3 · Pack, chaal or raise on your turn',
        text: 'Every player who wants to stay must match the current stake. Pack (fold) to leave the hand. A raise resets the round so everyone must answer it.'
      },
      {
        title: '4 · Compare: side show and show',
        text: 'With three or more live players you may ask the player on your right for a side show: the weaker hand packs. Heads-up, a show compares immediately for the price of a chaal.'
      },
      {
        title: '5 · Showdown and pot',
        text: 'After the configured number of rounds a compulsory show happens: the best hand takes the pot, and all-in players are protected by side pots. Trail beats everything.'
      }
    ];

    openModal({
      title: 'How to play Teen Patti',
      icon: '🎓',
      body: [
        el('div', { class: 'row wrap' }, [
          el('span', { class: 'pill gold', text: 'Trail > Pure Sequence > Sequence > Colour > Pair > High Card' })
        ]),
        ...steps.map((step) => el('div', { class: 'tutorial-step' }, [
          el('div', { class: 'n', text: step.title.slice(0, 1) }),
          el('div', {}, [el('b', { text: step.title.slice(4) }), el('p', { class: 'tiny muted', style: { margin: '4px 0 0' }, text: step.text })])
        ])),
        el('h4', { text: 'AI personalities you will meet' }),
        el('div', { class: 'row wrap' }, Object.entries(PERSONALITIES).map(([key, profile]) => el('span', {
          class: 'pill',
          title: profile.blurb,
          text: `${profile.label}`
        }))),
        el('div', { class: 'tutorial-demo' }, [
          cardRow(['AS', 'AH', 'AD'], { size: 'sm' }),
          el('span', { class: 'muted tiny', text: '← the unbeatable hand: a trail of aces' })
        ])
      ],
      actions: [
        {
          label: this.mode ? 'Back to table' : 'Start practising',
          kind: 'primary',
          onClick: () => { if (!this.mode) this.startPractice(); }
        }
      ]
    });
  }
}

const app = new App().init();
app.refreshTables();
window.app = app;   // handy for debugging from the console
