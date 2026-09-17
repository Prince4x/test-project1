/**
 * Practice controller — runs the shared engine locally with AI opponents.
 *
 * It mirrors the server room loop (bot pacing, turn clocks, auto-dealing) but
 * entirely in the browser, so it works offline and starts instantly. The UI
 * receives exactly the same snapshot/event shape as the online controller.
 */

import { TeenPattiTable, PHASE, ACTION } from '/engine/table.js';
import { decideAction, PERSONALITIES } from '/engine/ai.js';
import { evaluate, handStrength } from '/engine/evaluator.js';
import { AVATARS } from '/js/store.js';

const TICK = 200;
const NEXT_HAND_DELAY = 3600;

/** Bot pacing: 'normal' feels human, 'fast' is for tests and demos. */
const PACE = {
  normal: { min: 700, max: 1600 },
  fast: { min: 90, max: 220 }
};

export class PracticeController {
  constructor({ profile, settings = {}, pace = 'normal', onState, onEvent, onError, onHandEnd, onChat } = {}) {
    this.pace = PACE[pace] || PACE.normal;
    this.profile = profile;
    this.settings = settings;
    this.onState = onState || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onError = onError || (() => {});
    this.onHandEnd = onHandEnd || (() => {});
    this.onChat = onChat || (() => {});
    this.timer = null;
    this.nextBotAt = 0;
    this.nextHandAt = 0;
    this.lastRecorded = 0;
    this.humanId = profile.id || 'you';
    this.botSeats = new Map();
    this.running = false;
  }

  build() {
    const players = Math.max(2, Math.min(6, Number(this.settings.practicePlayers) || 4));
    const boot = Number(this.settings.practiceBoot) || 10;
    const turnSeconds = Number(this.settings.practiceTimer);
    this.table = new TeenPattiTable({
      id: `practice-${Math.random().toString(36).slice(2, 7)}`,
      name: 'Practice table',
      clock: () => Date.now(),
      boot,
      startChips: Math.max(1000, boot * 100),
      maxBuyIn: Math.max(1000, boot * 100),
      minRaise: Math.max(2, Math.ceil(boot / 2)),
      maxRounds: Number(this.settings.practiceRounds) || 4,
      turnSeconds: turnSeconds > 0 ? turnSeconds : 9999,
      sideshow: true,
      autoRebuy: this.settings.autoRebuy !== false,
      maxPlayers: 6
    });

    // Sit the human in the middle of the table so the ring looks balanced.
    this.table.addPlayer({
      id: this.humanId,
      name: this.profile.name,
      avatar: this.profile.avatar,
      chips: Math.max(1000, boot * 100)
    });

    const names = [
      ['Ravi', '🐯'], ['Priya', '🦋'], ['Arjun', '🦅'], ['Meera', '🌸'], ['Vikram', '🐘'], ['Kavya', '🦚']
    ];
    const personalities = Object.keys(PERSONALITIES);
    for (let i = 1; i < players; i += 1) {
      const [name, avatar] = names[i - 1];
      const bot = this.table.addPlayer({
        id: `bot-${i}`,
        name,
        avatar,
        isBot: true,
        personality: personalities[(i - 1) % personalities.length],
        chips: Math.max(1000, boot * 100)
      });
      this.botSeats.set(bot.id, bot.personality);
    }

    // Park the human's seat at the bottom of the ring.
    const order = [this.humanId, ...[...this.botSeats.keys()]];
    while (order.length < 6) order.push(null);
    this.seatOrder = order;
    return this.table;
  }

  start() {
    this.build();
    this.running = true;
    this.table.startHand();
    this.publish();
    this.timer = setInterval(() => this.tick(), TICK);
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Human action coming from the action bar. */
  dispatch(action, payload = {}) {
    try {
      if (action === ACTION.SEE) {
        this.table.see(this.humanId);
      } else if (['sideshow-accept', 'sideshow-decline'].includes(action)) {
        this.table.respondSideShow(this.humanId, action === 'sideshow-accept');
      } else {
        this.table.act(this.humanId, action, payload);
      }
      this.publish();
      return true;
    } catch (error) {
      this.onError(error.message);
      return false;
    }
  }

  chat(text, emote) {
    this.onChat({
      from: this.profile.name,
      avatar: this.profile.avatar,
      text: text || emote,
      emote: Boolean(emote),
      self: true
    });
    // A bot may answer, for flavour.
    if (Math.random() < 0.35) {
      setTimeout(() => {
        const bots = this.table.players.filter((player) => player.isBot);
        const bot = bots[Math.floor(Math.random() * bots.length)];
        if (!bot) return;
        const lines = ['😄', 'Nice hand!', 'Chaal!', 'Ha, good luck.', '😎', 'Shabaash!', '🃏'];
        this.onChat({
          from: bot.name,
          avatar: bot.avatar,
          text: lines[Math.floor(Math.random() * lines.length)],
          bot: true
        });
      }, 900 + Math.random() * 1400);
    }
  }

  emptySeat() {
    for (let i = 0; i < 6; i += 1) if (!this.seatOrder[i]) return i;
    return 0;
  }

  /** Add another AI opponent mid-session ("+ bot"). */
  addBot() {
    if (this.table.seatedCount >= 6) return false;
    const used = new Set(this.table.players.map((player) => player.name));
    const pool = [
      ['Dev', '🐉'], ['Sana', '🌙'], ['Kabir', '⚡'], ['Nisha', '💎'], ['Rohan', '🦁'], ['Anjali', '🪔']
    ].filter(([name]) => !used.has(name));
    if (!pool.length) return false;
    const [name, avatar] = pool[0];
    const personalities = Object.keys(PERSONALITIES);
    const id = `bot-${Math.random().toString(36).slice(2, 6)}`;
    this.table.addPlayer({
      id,
      name,
      avatar,
      isBot: true,
      personality: personalities[Math.floor(Math.random() * personalities.length)],
      chips: Math.max(1000, this.table.config.boot * 100)
    });
    this.seatOrder[this.emptySeat()] = id;
    this.publish();
    return true;
  }

  removeBot() {
    const bot = [...this.table.players].reverse().find((player) => player.isBot);
    if (!bot || this.table.seatedCount <= 2) return false;
    this.table.removePlayer(bot.id);
    this.seatOrder = this.seatOrder.map((id) => (id === bot.id ? null : id));
    this.publish();
    return true;
  }

  tick() {
    if (!this.running) return;
    const now = Date.now();
    const table = this.table;

    const timeout = table.checkTimeout(now);
    if (timeout) {
      this.publish();
      return;
    }

    if (table.phase === PHASE.BETTING) {
      if (table.sideShow) {
        const target = table.getPlayer(table.sideShow.targetId);
        if (target?.isBot) {
          if (this.sideShowFor !== target.id) {
            this.sideShowFor = target.id;
            this.nextBotAt = now + this.pace.min;
          } else if (now >= this.nextBotAt) {
            this.sideShowFor = null;
            const profile = PERSONALITIES[target.personality] || PERSONALITIES.balanced;
            const strength = target.seen ? handStrength(evaluate(target.cards)) : 0.5;
            table.respondSideShow(target.id, strength > 0.62 - profile.aggression * 0.3);
            this.publish();
          }
        }
        return;
      }

      const player = table.turnPlayer;
      if (player?.isBot) {
        if (this.botFor !== player.id) {
          this.botFor = player.id;
          this.nextBotAt = now + this.pace.min + Math.random() * (this.pace.max - this.pace.min);
        } else if (now >= this.nextBotAt) {
          this.botFor = null;
          this.runBot(player);
          this.publish();
        }
      }
      return;
    }

    if ((table.phase === PHASE.WAITING || table.phase === PHASE.SETTLED) && table.canStartHand()) {
      if (!this.nextHandAt) this.nextHandAt = now + (this.pace === PACE.fast ? 500 : NEXT_HAND_DELAY);
      if (now >= this.nextHandAt) {
        this.nextHandAt = 0;
        this.topUpIfBroke();
        table.startHand();
        this.publish();
      }
    }
  }

  /** Practice mode keeps the player in chips so a session never dead-ends. */
  topUpIfBroke() {
    const me = this.table.getPlayer(this.humanId);
    if (!me) return;
    const floor = Math.max(this.table.config.startChips, this.table.config.boot * 20);
    if (me.chips < this.table.config.boot) {
      this.table.topUp(this.humanId, floor);
    }
  }

  runBot(player) {
    const table = this.table;
    const view = {
      cards: player.cards,
      seen: player.seen,
      chips: player.chips,
      costToCall: table.callCost(player),
      blindCost: table.blindCost,
      pot: table.potTotal,
      stake: table.stake,
      activePlayers: table.activePlayers.length,
      round: table.round,
      maxRounds: table.config.maxRounds,
      minRaise: table.minRaiseFor(player),
      maxRaise: table.maxRaiseFor(player),
      canShow: table.canShow(player),
      canSideShow: table.canSideShow(player),
      personality: player.personality,
      rng: Math.random
    };

    let decision;
    try {
      decision = decideAction(view);
    } catch {
      decision = { action: ACTION.CHAAL };
    }

    try {
      switch (decision.action) {
        case ACTION.SEE: table.act(player.id, ACTION.SEE); break;
        case ACTION.RAISE: table.act(player.id, ACTION.RAISE, { stake: decision.stake }); break;
        case ACTION.ALL_IN: table.act(player.id, ACTION.ALL_IN); break;
        case ACTION.SHOW: table.act(player.id, ACTION.SHOW); break;
        case ACTION.SIDE_SHOW: table.act(player.id, ACTION.SIDE_SHOW); break;
        case ACTION.PACK: table.act(player.id, ACTION.PACK); break;
        case ACTION.BLIND: table.act(player.id, ACTION.BLIND); break;
        default: table.act(player.id, ACTION.CHAAL);
      }
    } catch {
      try {
        if (player.chips >= table.callCost(player)) table.act(player.id, ACTION.CHAAL);
        else table.act(player.id, ACTION.ALL_IN);
      } catch {
        try { table.act(player.id, ACTION.PACK); } catch { /* clock handles it */ }
      }
    }
  }

  publish() {
    const events = this.table.drainEvents();
    const snapshot = this.table.serialize(this.humanId);
    this.onState(snapshot, events);
    if (events.length) this.onEvent(events, snapshot);
    if (this.table.phase === PHASE.SETTLED && this.table.results && this.lastRecorded !== this.table.results.handNo) {
      this.lastRecorded = this.table.results.handNo;
      this.reportHand(this.table.results);
    }
  }

  reportHand(results) {
    const ranking = results.rankings.find((entry) => entry.id === this.humanId);
    const packedEntry = results.packed.find((entry) => entry.id === this.humanId);
    const won = results.winners.find((winner) => winner.id === this.humanId);
    const committed = ranking?.committed ?? packedEntry?.committed ?? 0;
    this.onHandEnd({
      handNo: results.handNo,
      won: Boolean(won),
      amount: won ? won.amount : 0,
      net: (won ? won.amount : 0) - committed,
      packed: Boolean(packedEntry) || Boolean(ranking && this.table.getPlayer(this.humanId)?.packed),
      bestHand: ranking ? { name: ranking.hand.text, rank: ranking.strength } : null,
      results
    });
  }

  /** Everything the settings panel can tweak without leaving the table. */
  updateSettings(patch = {}) {
    Object.assign(this.settings, patch);
    const table = this.table;
    if (patch.practiceRounds) table.config.maxRounds = Number(patch.practiceRounds);
    if (patch.practiceTimer !== undefined) table.config.turnSeconds = Number(patch.practiceTimer) > 0 ? Number(patch.practiceTimer) : 9999;
    if (patch.autoRebuy !== undefined) table.config.autoRebuy = Boolean(patch.autoRebuy);
  }

  get isOnline() { return false; }
  get avatars() { return AVATARS; }
}

export default PracticeController;
