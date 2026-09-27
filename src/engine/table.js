/**
 * Teen Patti table engine — a pure, host-agnostic state machine.
 *
 * The same file runs on the Node server (authoritative multiplayer) and in the
 * browser (single-player practice mode against the AI), so gameplay can never
 * diverge between the two modes.
 *
 * Rules implemented (standard / "open" Teen Patti):
 *   • 52 card deck, 3 cards per player, 2–6 players per table.
 *   • Every player posts a Boot (ante) to be dealt in. The current stake
 *     starts at the boot.
 *   • Play is either Blind (cards unseen) or Seen.
 *     `stake` is the BLIND unit: a blind player bets 1x–2x the current stake
 *     (after a blind bet of X the stake becomes X); a seen player bets 2x–4x
 *     the current stake (after a seen bet of X the stake becomes X/2).
 *     The engine expresses every bet as the stake it sets: a raise "to S"
 *     costs a blind player S and a seen player 2·S, with S capped at
 *     `chaalLimit`× the current stake (the max-bet-per-turn house rule).
 *   • On your turn: Pack (fold), Chaal/Call, Raise, All-in, Show, Side Show.
 *     A side show costs the requester their normal chaal and consumes the
 *     turn; the target accepts or declines. Ties pack the requester.
 *   • `potLimit` (optional): when the pot reaches it, everybody still live is
 *     forced to show and ties split the pot. In a *requested* show, ties go
 *     against the caller (`showTie: 'caller-loses'`, configurable).
 *   • `maxBlindRounds` (optional): after that many rounds, blind players are
 *     automatically seen at the start of their turn.
 *   • Everyone at the table gets the chance to respond to a raise; a betting
 *     round ends when all live players have responded. After `maxRounds`
 *     rounds a compulsory Showdown happens (house rule that guarantees the
 *     hand terminates) — otherwise the hand ends when all but one pack, when
 *     somebody Shows, or when only one player still has chips to bet.
 *   • Showdown compares hands, folds are paid into the pot and all-in players
 *     are protected by side pots.
 *
 * The engine never uses timers itself: the host (server or browser) owns the
 * clock and calls `checkTimeout(now)`. Every mutation appends to `events`,
 * which hosts drain and broadcast — they drive the animations and sounds.
 */

import { makeDeck, shuffle, createRng, secureRandom, parseCard, cardLabel, RANK_NAME } from './cards.js';
import {
  evaluate,
  compareKeys,
  CATEGORY_NAME,
  RANKING_CHART,
  handStrength,
  DEFAULT_RULES
} from './evaluator.js';

export const PHASE = {
  WAITING: 'waiting',
  BETTING: 'betting',
  SHOWDOWN: 'showdown',
  SETTLED: 'settled'
};

export const ACTION = {
  PACK: 'pack',
  CHECK: 'check',
  CHAAL: 'chaal',
  BLIND: 'blind',
  RAISE: 'raise',
  ALL_IN: 'allin',
  SHOW: 'show',
  SIDE_SHOW: 'sideshow',
  SEE: 'see'
};

export const DEFAULT_CONFIG = {
  /** Ante every player posts to be dealt in. */
  boot: 10,
  /** Chips handed to a player on buy-in. */
  startChips: 1000,
  minBuyIn: 500,
  maxBuyIn: 5000,
  /** Betting rounds (orbits) before a compulsory showdown. */
  maxRounds: 4,
  /** Seconds a player has to act before the timeout action fires. */
  turnSeconds: 25,
  /** Shorter clock for players who dropped out, so the table never stalls. */
  disconnectedTurnSeconds: 4,
  /** Seconds the target of a side show has to accept or decline. */
  sideShowSeconds: 12,
  /** Allow side shows. */
  sideshow: true,
  /** Time source: () => ms. Hosts may inject their own (tests, replay). */
  clock: null,
  /** Minimum raise step over the current stake (in blind units). */
  minRaise: 1,
  /** House cap on the stake (0 = uncapped, chips are the only limit). */
  maxStake: 0,
  /**
   * Max-bet-per-turn multiple: a raise may set the stake to at most
   * `chaalLimit`× the current stake (blind 1x–2x, seen 2x–4x when 2).
   */
  chaalLimit: 2,
  /** Pot cap: when the pot reaches this, everyone left is forced to show (0 = off). */
  potLimit: 0,
  /** After this many betting rounds blind players are auto-seen (0 = never). */
  maxBlindRounds: 0,
  /** Requested-show ties: 'caller-loses' (the asker loses ties) or 'split'. */
  showTie: 'caller-loses',
  /** House rule for where the A-2-3 run ranks: 'a23-second' | 'a23-lowest'. */
  sequenceOrder: DEFAULT_RULES.sequenceOrder,
  /** Game mode id — informational; the rules below are what the engine reads. */
  mode: 'classic',
  /** Muflis / lowball: the lowest classic hand wins. */
  reversed: false,
  /** Ranks that always play wild (AK47: [14,13,4,7], 1942: [14,9,4,2]). */
  wildRanks: [],
  /** Joker mode: reveal one card per hand — its rank plays wild everywhere. */
  jokerReveal: false,
  /** What happens when the clock runs out. */
  timeoutAction: 'pack',
  /** Cost of calling a show: 'call' (the usual chaal amount) or 'double'. */
  showCost: 'call',
  minPlayers: 2,
  maxPlayers: 6,
  /** Chips a player is topped up with when broke in practice mode. */
  autoRebuy: false
};

const SEAT_ORDER = ['S', 'H', 'D', 'C'];

let playerCounter = 0;

function uid(prefix = 'p') {
  playerCounter += 1;
  return `${prefix}${Date.now().toString(36)}${playerCounter.toString(36)}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * What a bet that sets the stake to `stake` costs: a blind player pays the
 * stake itself, a seen player pays double (chaal rate).
 */
export function raiseCostFor(stake, seen) {
  return seen ? Math.floor(stake) * 2 : Math.floor(stake);
}

export class TeenPattiTable {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    /**
     * Host clock. The engine never calls this.now() directly, so a host — the
     * server room loop or a test — can drive time itself and get deterministic
     * timers. Defaults to the real wall clock.
     */
    this.clock = this.config.clock || Date.now;
    this.id = config.id || uid('t');
    this.name = config.name || 'Teen Patti Table';
    this.createdAt = this.now();

    /** Fixed-length seat array; null = empty seat. */
    this.seats = new Array(this.config.maxPlayers).fill(null);
    this.phase = PHASE.WAITING;
    this.handNo = 0;
    this.round = 0;
    this.stake = 0;
    this.dealerSeat = -1;
    this.turnSeat = -1;
    this.pending = new Set();
    this.sideShow = null;
    this.results = null;
    this.history = [];
    this.log = [];
    this.events = [];
    this.turnStartedAt = 0;
    this.turnDeadline = 0;
    this.sideShowDeadline = 0;
    this.sessionStats = new Map();
    /**
     * Deal randomness: the CSPRNG for real play, a seeded xorshift only when
     * the host explicitly asks for reproducible deals (tests, replays).
     */
    this.rng = this.config.rng
      || (this.config.seed != null ? createRng(this.config.seed) : secureRandom);
    /** House rules forwarded to the hand evaluator (see DEFAULT_RULES). */
    this.rules = {
      sequenceOrder: this.config.sequenceOrder,
      reversed: Boolean(this.config.reversed),
      wildRanks: [...(this.config.wildRanks || [])]
    };
    /** Joker mode: the card revealed for the current hand (null otherwise). */
    this.jokerCard = null;
  }

  // ─────────────────────────────────────────────────────────────── players ──

  /** Current host time (injectable via config.clock). */
  now() {
    return this.clock();
  }

  get players() {
    return this.seats.filter(Boolean);
  }

  get seatedCount() {
    return this.players.length;
  }

  getPlayer(id) {
    return this.players.find((player) => player.id === id) || null;
  }

  playerAt(seat) {
    return this.seats[seat] || null;
  }

  addPlayer({ id = uid(), name, avatar = '🙂', chips, isBot = false, personality = 'balanced' } = {}) {
    if (this.getPlayer(id)) return this.getPlayer(id);
    if (this.seatedCount >= this.config.maxPlayers) throw new Error('Table is full');
    const seat = this.seats.findIndex((player) => !player);
    const startChips = chips ?? this.config.startChips;
    const player = {
      id,
      name: (name || 'Player').slice(0, 18),
      avatar,
      isBot,
      personality,
      seat,
      chips: startChips,
      inHand: false,
      seen: false,
      packed: false,
      allIn: false,
      sittingOut: false,
      cards: [],
      committed: 0,
      lastBet: 0,
      lastAction: null,
      status: 'waiting',
      connected: true,
      joinedAt: this.now()
    };
    this.seats[seat] = player;
    if (!this.sessionStats.has(id)) {
      this.sessionStats.set(id, { hands: 0, wins: 0, net: 0, biggestPot: 0, bestHand: null });
    }
    this.pushEvent({ type: 'player:join', playerId: id, seat, name: player.name, isBot });
    this.pushLog(`${player.avatar} ${player.name} took seat ${seat + 1}`);
    return player;
  }

  removePlayer(id) {
    const player = this.getPlayer(id);
    if (!player) return false;

    // Leaving mid-hand forfeits the hand; play carries on for everybody else.
    if (player.inHand && !player.packed) {
      const wasTurn = this.turnSeat === player.seat;
      player.packed = true;
      player.status = 'packed';
      player.lastAction = ACTION.PACK;
      player.cards = [];
      this.pending.delete(id);
      this.pushEvent({ type: 'action', action: ACTION.PACK, playerId: id, seat: player.seat, reason: 'left' });
      this.pushLog(`${player.avatar} ${player.name} left the table and packed`);
      if (this.phase === PHASE.BETTING) {
        // Either the leaver held the turn, or the hand may now be over.
        if (wasTurn) this.advanceTurn();
        else this.maybeShowdown();
      }
    }

    this.seats[player.seat] = null;
    this.pending.delete(id);
    this.pushEvent({ type: 'player:leave', playerId: id, name: player.name, seat: player.seat });
    this.pushLog(`${player.avatar} ${player.name} left the table`);
    return true;
  }

  setConnected(id, connected) {
    const player = this.getPlayer(id);
    if (!player) return;
    player.connected = connected;
    this.pushEvent({ type: 'player:connection', playerId: id, connected });
  }

  topUp(id, amount) {
    const player = this.getPlayer(id);
    if (!player) throw new Error('No such player');
    player.chips += amount;
    if (player.chips >= this.config.boot) player.sittingOut = false;
    this.pushEvent({ type: 'player:topup', playerId: id, amount, chips: player.chips });
    return player.chips;
  }

  // ──────────────────────────────────────────────────────────────── helpers ──

  get potTotal() {
    return this.players.reduce((total, player) => total + player.committed, 0);
  }

  /** What a blind player pays to call: 1x the current stake. */
  get blindCost() {
    return this.stake;
  }

  /** What a seen player pays to call (chaal): 2x the current stake. */
  get chaalCost() {
    return this.stake * 2;
  }

  callCost(player) {
    return player.seen ? this.chaalCost : this.blindCost;
  }

  get activePlayers() {
    return this.players.filter((player) => player.inHand && !player.packed);
  }

  get actionablePlayers() {
    return this.activePlayers.filter((player) => !player.allIn);
  }

  get turnPlayer() {
    return this.playerAt(this.turnSeat);
  }

  canStartHand() {
    if (this.phase === PHASE.BETTING || this.phase === PHASE.SHOWDOWN) return false;
    return this.players.filter((player) => player.chips >= this.config.boot).length >= this.config.minPlayers;
  }

  nextSeatFrom(seat, predicate) {
    for (let step = 1; step <= this.seats.length; step += 1) {
      const index = (seat + step) % this.seats.length;
      const player = this.seats[index];
      if (player && predicate(player)) return index;
    }
    return -1;
  }

  previousActiveSeat(fromSeat) {
    for (let step = 1; step <= this.seats.length; step += 1) {
      const index = (fromSeat - step + this.seats.length * 2) % this.seats.length;
      const player = this.seats[index];
      if (player && player.inHand && !player.packed) return index;
    }
    return -1;
  }

  pushEvent(event) {
    this.events.push({ ...event, at: this.now(), handNo: this.handNo });
  }

  pushLog(text) {
    this.log.push({ text, at: this.now(), handNo: this.handNo });
    if (this.log.length > 120) this.log.splice(0, this.log.length - 120);
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  // ─────────────────────────────────────────────────────────────── dealing ──

  startHand() {
    if (!this.canStartHand()) throw new Error('Not enough players to deal');
    this.events = [];
    this.results = null;
    this.sideShow = null;
    this.handNo += 1;
    this.round = 1;

    const deck = shuffle(makeDeck(), this.rng);
    let cursor = 0;

    // Reset everyone, mark broke players as sitting out.
    for (const player of this.players) {
      player.inHand = false;
      player.seen = false;
      player.packed = false;
      player.allIn = false;
      player.cards = [];
      player.committed = 0;
      player.lastBet = 0;
      player.lastAction = null;
      player.sittingOut = player.chips < this.config.boot;
      player.status = player.sittingOut ? 'out' : 'waiting';
    }

    // Rotate the dealer button to the next player who can afford the boot.
    this.dealerSeat = this.nextSeatFrom(this.dealerSeat < 0 ? this.seats.length - 1 : this.dealerSeat,
      (player) => player.chips >= this.config.boot);

    // Post the boot (ante) and deal three cards each.
    const entrants = [];
    for (let step = 0; step < this.seats.length; step += 1) {
      const seat = (this.dealerSeat + step) % this.seats.length;
      const player = this.seats[seat];
      if (!player || player.chips < this.config.boot) continue;
      const ante = Math.min(this.config.boot, player.chips);
      player.chips -= ante;
      player.committed = ante;
      player.inHand = true;
      player.status = 'playing';
      if (player.chips === 0) player.allIn = true;
      player.cards = [deck[cursor], deck[cursor + 1], deck[cursor + 2]];
      cursor += 3;
      entrants.push(player);
      this.pushEvent({ type: 'deal', playerId: player.id, seat, ante, allIn: player.allIn });
    }

    // Joker mode: turn the next deck card face up — its rank is wild for
    // everyone this hand. Static wilds (AK47/1942) always stay in force.
    if (this.config.jokerReveal) {
      this.jokerCard = deck[cursor];
      cursor += 1;
      const jokerRank = parseCard(this.jokerCard).rank;
      this.rules.wildRanks = [...new Set([...(this.config.wildRanks || []), jokerRank])];
      this.pushEvent({ type: 'joker', card: this.jokerCard, rank: jokerRank });
      this.pushLog(`Joker revealed: ${cardLabel(this.jokerCard)} — every ${RANK_NAME[jokerRank]} is wild`);
    } else {
      this.jokerCard = null;
    }

    this.stake = this.config.boot;
    this.pending = new Set(this.actionablePlayers.map((player) => player.id));
    this.phase = PHASE.BETTING;
    this.pushLog(`— Hand #${this.handNo} — boot ${this.config.boot}, dealer ${this.playerAt(this.dealerSeat)?.name}`);

    // First to act is the player after the dealer.
    this.turnSeat = this.nextSeatFrom(this.dealerSeat, (player) => player.inHand && !player.packed && !player.allIn);
    this.startTurnClock();

    this.pushEvent({
      type: 'hand:start',
      handNo: this.handNo,
      dealerSeat: this.dealerSeat,
      pot: this.potTotal,
      stake: this.stake,
      joker: this.jokerCard,
      players: entrants.map((player) => ({ id: player.id, seat: player.seat, committed: player.committed }))
    });

    this.maybeShowdown();
    return this.handNo;
  }

  startTurnClock() {
    this.turnStartedAt = this.now();
    const player = this.turnPlayer;
    // Blind-round limit: past it, a blind player is automatically seen at the
    // start of their turn (they keep the turn — just at chaal rates now).
    if (
      this.config.maxBlindRounds > 0
      && this.round > this.config.maxBlindRounds
      && player && player.inHand && !player.packed && !player.seen
    ) {
      this.pushLog(`${player.name} reached the ${this.config.maxBlindRounds} blind round limit — cards turned over`);
      this.see(player.id);
    }
    // A player who lost their connection gets a much shorter clock: their seat
    // still plays out the hand, but nobody waits around for them.
    const offline = player && player.connected === false;
    const seconds = offline
      ? Math.min(this.config.disconnectedTurnSeconds, this.config.turnSeconds)
      : this.config.turnSeconds;
    this.turnSeconds = seconds;
    this.turnDeadline = this.turnStartedAt + seconds * 1000;
    this.pushEvent({ type: 'turn', playerId: player?.id ?? null, deadline: this.turnDeadline, seconds });
  }

  // ─────────────────────────────────────────────────────────────── actions ──

  /** Free action: look at your own cards. Does not consume the turn. */
  see(id) {
    const player = this.getPlayer(id);
    if (!player || !player.inHand || player.packed) throw new Error('Cannot see cards right now');
    if (player.seen) return player;
    player.seen = true;
    player.lastAction = ACTION.SEE;
    this.pushEvent({ type: 'see', playerId: player.id, seat: player.seat });
    this.pushLog(`${player.name} saw their cards (${player.cards.join(' ')})`);
    return player;
  }

  act(id, action, payload = {}) {
    if (this.phase !== PHASE.BETTING) throw new Error('Betting is closed');
    if (action === ACTION.SEE) {
      const self = this.see(id);
      return true;
    }
    if (this.sideShow) throw new Error('Waiting for the side show response');
    const player = this.getPlayer(id);
    if (!player) throw new Error('You are not seated at this table');
    if (!player.inHand || player.packed) throw new Error('You are not in this hand');
    if (player.allIn) throw new Error('You are all-in');
    if (this.turnSeat !== player.seat) throw new Error('It is not your turn');
    if (!this.pending.has(id)) throw new Error('You have already acted this round');

    switch (action) {
      case ACTION.PACK:
        this.handlePack(player, payload);
        break;
      case ACTION.CHECK:
        this.handleCheck(player, payload);
        break;
      case ACTION.CHAAL:
      case ACTION.BLIND:
        this.handleCall(player, action, payload);
        break;
      case ACTION.RAISE:
        this.handleRaise(player, payload);
        break;
      case ACTION.ALL_IN:
        this.handleAllIn(player, payload);
        break;
      case ACTION.SHOW:
        this.handleShow(player, payload);
        break;
      case ACTION.SIDE_SHOW:
        this.handleSideShowRequest(player, payload);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    if (player.status === 'playing') player.status = 'playing';
    if (this.phase === PHASE.BETTING && !this.sideShow) this.advanceTurn();
    return true;
  }

  pay(player, amount) {
    const paid = Math.min(amount, player.chips);
    player.chips -= paid;
    player.committed += paid;
    player.lastBet = paid;
    if (player.chips === 0) {
      player.allIn = true;
      player.status = 'allin';
      this.pushEvent({ type: 'allin', playerId: player.id, seat: player.seat, amount: paid });
    }
    return paid;
  }

  handlePack(player, payload = {}) {
    player.packed = true;
    player.status = 'packed';
    player.lastAction = ACTION.PACK;
    this.pending.delete(player.id);
    this.pushEvent({
      type: 'action',
      action: ACTION.PACK,
      playerId: player.id,
      seat: player.seat,
      timeout: Boolean(payload.timeout),
      reason: payload.reason || null
    });
    this.pushLog(`${player.name} packed${payload.timeout ? ' (time out)' : ''}`);
  }

  /**
   * Check — a pass that costs nothing. Teen Patti has no free checking while a
   * chaal is owed, so the engine only allows it when the player has already
   * matched every live player's contribution (e.g. everyone else is all-in).
   */
  handleCheck(player, payload = {}) {
    const owed = this.activePlayers.some((other) => other.id !== player.id && other.committed > player.committed);
    if (owed) throw new Error('You must chaal (or pack) — a free check is not available');
    player.lastAction = ACTION.CHECK;
    this.pending.delete(player.id);
    this.pushEvent({
      type: 'action',
      action: ACTION.CHECK,
      playerId: player.id,
      seat: player.seat,
      amount: 0,
      pot: this.potTotal,
      timeout: Boolean(payload.timeout)
    });
    this.pushLog(`${player.name} checked`);
  }

  handleCall(player, action, payload = {}) {
    const cost = this.callCost(player);
    if (player.chips < cost) {
      throw new Error(`Not enough chips to ${player.seen ? 'chaal' : 'play blind'} (need ${cost}) — go all-in`);
    }
    const paid = this.pay(player, cost);
    player.lastAction = player.seen ? ACTION.CHAAL : ACTION.BLIND;
    this.pending.delete(player.id);
    this.pushEvent({
      type: 'action',
      action: player.lastAction,
      playerId: player.id,
      seat: player.seat,
      amount: paid,
      pot: this.potTotal,
      timeout: Boolean(payload.timeout)
    });
    this.pushLog(`${player.name} ${player.seen ? 'chaal' : 'blind'} ${paid}`);
  }

  /** Minimum stake a raise may be set to, given who is raising. */
  minRaiseFor(player) {
    return this.stake + Math.max(1, this.config.minRaise);
  }

  /**
   * Highest stake a raise may set. Three caps apply:
   *   • the chaal limit — at most `chaalLimit`× the current stake per turn
   *     (blind bets 1x–2x, seen bets 2x–4x when chaalLimit is 2);
   *   • what the player can actually pay (seen players pay 2× the stake);
   *   • the table's optional hard stake cap (`maxStake`).
   */
  maxRaiseFor(player) {
    const turnCap = Math.floor(this.stake * Math.max(1, this.config.chaalLimit));
    const affordable = player.seen ? Math.floor(player.chips / 2) : player.chips;
    let cap = Math.min(turnCap, affordable);
    if (this.config.maxStake > 0) cap = Math.min(cap, this.config.maxStake);
    return Math.max(0, cap);
  }

  handleRaise(player, payload = {}) {
    const requested = Math.floor(Number(payload.stake));
    const min = this.minRaiseFor(player);
    const max = this.maxRaiseFor(player);
    if (!Number.isFinite(requested)) throw new Error('Raise amount is required');
    if (max < min) throw new Error('Not enough chips to raise — go all-in instead');
    if (requested < min) throw new Error(`Minimum raise is ${min}`);
    if (requested > max) throw new Error(`Maximum raise is ${max}`);
    const newStake = requested;
    const cost = raiseCostFor(newStake, player.seen);
    const paid = this.pay(player, cost);
    this.stake = newStake;
    player.lastAction = ACTION.RAISE;
    // Everybody else must respond to the new stake.
    this.pending = new Set(
      this.actionablePlayers.filter((other) => other.id !== player.id && !other.allIn).map((other) => other.id)
    );
    this.pushEvent({
      type: 'action',
      action: ACTION.RAISE,
      playerId: player.id,
      seat: player.seat,
      amount: paid,
      stake: this.stake,
      pot: this.potTotal
    });
    this.pushLog(`${player.name} raised the stake to ${newStake} (paid ${paid})`);
  }

  handleAllIn(player, payload = {}) {
    const amount = player.chips;
    if (amount <= 0) throw new Error('Nothing left to bet');
    const stakeBefore = this.stake;
    const paid = this.pay(player, amount);
    // A seen bet of X is worth a blind stake of X/2. The all-in can bump the
    // stake, but never beyond the per-turn chaal limit.
    const equivalent = player.seen ? Math.floor(paid / 2) : paid;
    const turnCap = Math.floor(stakeBefore * Math.max(1, this.config.chaalLimit));
    const equivalentStake = Math.min(equivalent, turnCap);
    const raised = equivalentStake > this.stake;
    if (raised) this.stake = equivalentStake;
    player.lastAction = ACTION.ALL_IN;
    this.pending.delete(player.id);
    if (raised) {
      this.pending = new Set(
        this.actionablePlayers.filter((other) => other.id !== player.id && !other.allIn).map((other) => other.id)
      );
    }
    this.pushEvent({
      type: 'action',
      action: ACTION.ALL_IN,
      playerId: player.id,
      seat: player.seat,
      amount: paid,
      stake: this.stake,
      pot: this.potTotal
    });
    this.pushLog(`${player.name} went all-in for ${paid}`);
  }

  canShow(player) {
    return this.activePlayers.length === 2 && !player.allIn;
  }

  handleShow(player, payload = {}) {
    if (this.activePlayers.length !== 2) {
      throw new Error('You can only show when just two players are left — use chaal instead');
    }
    const multiplier = this.config.showCost === 'double' ? 2 : 1;
    const cost = Math.min(this.callCost(player) * multiplier, player.chips);
    const paid = this.pay(player, cost);
    player.lastAction = ACTION.SHOW;
    this.pending.delete(player.id);
    this.pushEvent({
      type: 'action',
      action: ACTION.SHOW,
      playerId: player.id,
      seat: player.seat,
      amount: paid,
      pot: this.potTotal
    });
    this.pushLog(`${player.name} called a show (paid ${paid})`);
    this.showdown('show', { callerId: player.id });
  }

  canSideShow(player) {
    if (!this.config.sideshow) return false;
    if (!player.seen || player.allIn) return false;
    if (player.chips < this.chaalCost) return false; // the request costs a chaal
    if (this.activePlayers.length < 3) return false;
    const target = this.playerAt(this.previousActiveSeat(player.seat));
    if (!target || target.id === player.id) return false;
    // Spec: only against another *seen* player who is still live.
    return target.inHand && !target.packed && !target.allIn && target.seen;
  }

  handleSideShowRequest(player, payload = {}) {
    if (!this.config.sideshow) throw new Error('Side shows are disabled at this table');
    if (!player.seen) throw new Error('See your cards before asking for a side show');
    if (this.activePlayers.length < 3) throw new Error('Side shows need at least three live players');
    const targetSeat = this.previousActiveSeat(player.seat);
    const target = this.playerAt(targetSeat);
    if (!target) throw new Error('No player to compare with');
    if (target.id === player.id) throw new Error('No player to compare with');
    if (target.allIn) throw new Error(`${target.name} is all-in — no side show possible`);
    if (!target.seen) throw new Error(`${target.name} is playing blind — you can only compare with a seen player`);
    const cost = this.chaalCost;
    if (player.chips < cost) throw new Error(`A side show costs your chaal (${cost}) — not enough chips`);
    // The request costs the normal chaal and consumes the turn: whatever the
    // outcome, the requester has acted this round.
    const paid = this.pay(player, cost);
    player.lastAction = ACTION.SIDE_SHOW;
    this.pending.delete(player.id);
    this.sideShow = {
      requesterId: player.id,
      requesterSeat: player.seat,
      targetId: target.id,
      targetSeat: target.seat,
      amount: paid,
      deadline: this.now() + this.config.sideShowSeconds * 1000
    };
    this.sideShowDeadline = this.sideShow.deadline;
    this.pushEvent({ type: 'sideshow:request', ...this.sideShow, pot: this.potTotal });
    this.pushLog(`${player.name} paid ${paid} and asked ${target.name} for a side show`);
    return this.sideShow;
  }

  respondSideShow(id, accept) {
    if (!this.sideShow) throw new Error('No side show is pending');
    if (this.sideShow.targetId !== id) throw new Error('This side show is not for you');
    const requester = this.getPlayer(this.sideShow.requesterId);
    const target = this.getPlayer(this.sideShow.targetId);
    const request = this.sideShow;
    this.sideShow = null;
    this.sideShowDeadline = 0;

    if (!accept) {
      this.pushEvent({ type: 'sideshow:declined', ...request });
      this.pushLog(`${target.name} declined the side show`);
      // The requester already paid their chaal — the turn moves on.
      if (this.phase === PHASE.BETTING) this.advanceTurn();
      return null;
    }

    const requesterHand = evaluate(requester.cards, this.rules);
    const targetHand = evaluate(target.cards, this.rules);
    // Ties pack the requester: winner only when strictly higher.
    const winner = compareKeys(requesterHand.key, targetHand.key) > 0 ? requester : target;
    const loser = winner === requester ? target : requester;
    loser.packed = true;
    loser.status = 'packed';
    loser.lastAction = ACTION.SIDE_SHOW;
    this.pending.delete(loser.id);
    this.pushEvent({
      type: 'sideshow:result',
      requesterId: requester.id,
      targetId: target.id,
      winnerId: winner.id,
      loserId: loser.id,
      requesterCards: requester.cards.slice(),
      targetCards: target.cards.slice()
    });
    this.pushLog(`${winner.name} won the side show — ${loser.name} packed`);
    // The requester's chaal was their action, so the turn always moves on.
    if (this.phase === PHASE.BETTING) this.advanceTurn();
    return { winnerId: winner.id, loserId: loser.id };
  }

  // ────────────────────────────────────────────────────────────── turn flow ──

  advanceTurn() {
    if (this.phase !== PHASE.BETTING) return;
    if (this.activePlayers.length <= 1) return this.showdown('fold');

    // No more betting possible: everybody else is all-in.
    if (this.actionablePlayers.length <= 1) return this.showdown('allin');

    // Pot limit reached: everyone still live is forced to show.
    if (this.config.potLimit > 0 && this.potTotal >= this.config.potLimit) {
      this.pushLog(`Pot limit of ${this.config.potLimit} reached — everyone shows`);
      return this.showdown('potlimit');
    }

    const currentSeat = this.turnSeat;
    this.pending = new Set([...this.pending].filter((id) => {
      const player = this.getPlayer(id);
      return player && player.inHand && !player.packed && !player.allIn;
    }));

    if (this.pending.size === 0) {
      if (this.round >= this.config.maxRounds) {
        this.pushLog(`Round limit of ${this.config.maxRounds} reached — compulsory show`);
        return this.showdown('rounds');
      }
      this.round += 1;
      this.pending = new Set(this.actionablePlayers.map((player) => player.id));
      this.pushEvent({ type: 'round', round: this.round, stake: this.stake, pot: this.potTotal });
      this.pushLog(`Betting round ${this.round} — stake ${this.stake}`);
    }

    if (this.pending.size === 0) return this.showdown('allin');

    for (let step = 1; step <= this.seats.length; step += 1) {
      const seat = (currentSeat + step) % this.seats.length;
      const player = this.seats[seat];
      if (player && this.pending.has(player.id) && !player.allIn && !player.packed) {
        this.turnSeat = seat;
        this.startTurnClock();
        return;
      }
    }
    this.showdown('allin');
  }

  maybeShowdown() {
    if (this.phase !== PHASE.BETTING) return;
    if (this.activePlayers.length <= 1) return this.showdown('fold');
    if (this.actionablePlayers.length <= 1) return this.showdown('allin');
    if (this.config.potLimit > 0 && this.potTotal >= this.config.potLimit) {
      this.pushLog(`Pot limit of ${this.config.potLimit} reached — everyone shows`);
      return this.showdown('potlimit');
    }
  }

  /** Timer hook — the host owns the clock. */
  checkTimeout(now = this.now()) {
    if (this.sideShow && now > this.sideShowDeadline) {
      this.respondSideShow(this.sideShow.targetId, false);
      return { type: 'sideshow:timeout' };
    }
    if (this.phase !== PHASE.BETTING || this.sideShow) return null;
    if (!this.turnPlayer || now <= this.turnDeadline) return null;
    const player = this.turnPlayer;
    if (this.config.timeoutAction === 'call') {
      const cost = this.callCost(player);
      const action = player.chips >= cost ? ACTION.CHAAL : ACTION.ALL_IN;
      try {
        this.act(player.id, action, { timeout: true });
        return { type: 'timeout', playerId: player.id, action };
      } catch (error) {
        this.act(player.id, ACTION.PACK, { timeout: true });
        return { type: 'timeout', playerId: player.id, action: ACTION.PACK };
      }
    }
    this.act(player.id, ACTION.PACK, { timeout: true });
    return { type: 'timeout', playerId: player.id, action: ACTION.PACK };
  }

  // ────────────────────────────────────────────────────────────── showdown ──

  /**
   * Resolve the hand.
   * @param {'fold'|'show'|'rounds'|'allin'|'potlimit'} reason
   * @param {{callerId?: string}} [opts] - who asked, for a requested show.
   */
  showdown(reason, opts = {}) {
    if (this.phase !== PHASE.BETTING) return;
    this.phase = PHASE.SHOWDOWN;
    this.turnSeat = -1;
    this.turnDeadline = 0;
    const live = this.activePlayers;
    /**
     * Tie policy: in a *requested* show the caller loses ties (configurable);
     * forced shows (pot limit / round limit / all-in) split the pot.
     */
    const showCallerId = reason === 'show' && this.config.showTie === 'caller-loses'
      ? opts.callerId || null
      : null;

    const evaluations = new Map();
    for (const player of live) evaluations.set(player.id, evaluate(player.cards, this.rules));

    const contributions = new Map();
    for (const player of this.players) if (player.committed > 0) contributions.set(player.id, player.committed);

    const revealAll = live.length > 1 && (reason !== 'fold' || this.config.showWinnerCards !== false);
    const winners = [];
    const potTotal = this.potTotal;

    // Single survivor: they take the whole pot, no comparison needed.
    if (live.length === 1) {
      const winner = live[0];
      winner.chips += potTotal;
      winners.push({ id: winner.id, name: winner.name, avatar: winner.avatar, amount: potTotal, hand: null });
      this.pushLog(`${winner.name} wins ${potTotal} — everyone else packed`);
    } else {
      // Side pots: layer the contributions so an all-in player can only win
      // the portion of the pot they actually covered.
      const levels = [...new Set([...contributions.values()])].sort((a, b) => a - b);
      let previous = 0;
      for (const level of levels) {
        let layerPot = 0;
        for (const [, amount] of contributions) {
          layerPot += Math.max(0, Math.min(amount - previous, level - previous));
        }
        previous = level;
        if (layerPot <= 0) continue;
        const eligible = live.filter((player) => (contributions.get(player.id) || 0) >= level);
        if (eligible.length === 0) continue;
        let best = eligible[0];
        for (const player of eligible.slice(1)) {
          if (compareKeys(evaluations.get(player.id).key, evaluations.get(best.id).key) > 0) best = player;
        }
        let tied = eligible.filter((player) => compareKeys(evaluations.get(player.id).key, evaluations.get(best.id).key) === 0);
        // Requested-show tie: the player who asked for the show loses it.
        if (showCallerId && tied.length > 1 && tied.some((player) => player.id === showCallerId)) {
          const withoutCaller = tied.filter((player) => player.id !== showCallerId);
          if (withoutCaller.length > 0) tied = withoutCaller;
        }
        const share = Math.floor(layerPot / tied.length);
        let remainder = layerPot - share * tied.length;
        for (const player of tied) {
          const amount = share + (remainder > 0 ? 1 : 0);
          if (remainder > 0) remainder -= 1;
          player.chips += amount;
          const entry = winners.find((winner) => winner.id === player.id);
          if (entry) entry.amount += amount;
          else {
            winners.push({
              id: player.id,
              name: player.name,
              avatar: player.avatar,
              amount,
              hand: evaluations.get(player.id)
            });
          }
        }
      }
    }

    const rankings = live
      .map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        allIn: player.allIn,
        committed: player.committed,
        cards: player.cards.slice(),
        hand: {
          category: evaluations.get(player.id).category,
          name: evaluations.get(player.id).name,
          text: evaluations.get(player.id).text
        },
        strength: handStrength(evaluations.get(player.id))
      }))
      .sort((a, b) => compareKeys(evaluations.get(b.id).key, evaluations.get(a.id).key));

    this.results = {
      handNo: this.handNo,
      reason,
      pot: potTotal,
      stake: this.stake,
      winners: winners.sort((a, b) => b.amount - a.amount),
      rankings,
      reveal: revealAll
        ? live.map((player) => ({
            id: player.id,
            name: player.name,
            cards: player.cards.slice(),
            hand: { category: evaluations.get(player.id).category, name: evaluations.get(player.id).name, text: evaluations.get(player.id).text }
          }))
        : [],
      packed: this.players
        .filter((player) => player.inHand && player.packed)
        .map((player) => ({ id: player.id, name: player.name, committed: player.committed })),
      at: this.now()
    };

    for (const player of this.players) {
      const stats = this.sessionStats.get(player.id);
      if (!stats) continue;
      if (player.inHand) stats.hands += 1;
      const won = winners.filter((winner) => winner.id === player.id).reduce((total, winner) => total + winner.amount, 0);
      if (won > 0) {
        stats.wins += 1;
        stats.biggestPot = Math.max(stats.biggestPot, won);
      }
      const evaluation = evaluations.get(player.id);
      if (evaluation && (!stats.bestHand || compareKeys(evaluation.key, stats.bestHand.key || []) > 0)) {
        stats.bestHand = { key: evaluation.key, name: evaluation.text, category: evaluation.category };
      }
      stats.net += won - player.committed;
    }

    this.history.unshift({
      handNo: this.handNo,
      pot: potTotal,
      reason,
      at: this.now(),
      winners: this.results.winners.map((winner) => ({ id: winner.id, name: winner.name, amount: winner.amount })),
      players: this.players
        .filter((player) => player.inHand)
        .map((player) => ({
          id: player.id,
          name: player.name,
          committed: player.committed,
          packed: player.packed,
          hand: evaluations.get(player.id) ? evaluations.get(player.id).name : null
        }))
    });
    if (this.history.length > 60) this.history.length = 60;

    for (const player of this.players) {
      if (player.inHand) player.status = player.allIn ? 'allin' : player.packed ? 'packed' : 'showdown';
    }

    this.pushEvent({ type: 'showdown', reason, pot: potTotal, winners: this.results.winners, rankings: this.results.rankings });
    this.pushLog(`Pot ${potTotal} → ${this.results.winners.map((winner) => `${winner.name} (${winner.amount})`).join(', ')}`);

    this.phase = PHASE.SETTLED;
    this.pushEvent({ type: 'hand:end', handNo: this.handNo, pot: potTotal, winners: this.results.winners });

    // Ready the table for the next hand.
    for (const player of this.players) {
      player.committed = 0;
      player.lastBet = 0;
      if (player.chips < this.config.boot) {
        player.sittingOut = true;
        player.status = 'out';
      }
    }
    if (this.config.autoRebuy) {
      for (const player of this.players) {
        if (player.isBot && player.chips < this.config.boot) {
          player.chips += this.config.startChips;
          player.sittingOut = false;
        }
      }
    }
    return this.results;
  }

  // ───────────────────────────────────────────────────────────── rendering ──

  /** Ranked strength of the viewer's own hand (used for the "your hand" widget). */
  handInfo(cards) {
    if (!cards || cards.length !== 3) return null;
    const evaluation = evaluate(cards, this.rules);
    return {
      category: evaluation.category,
      name: evaluation.name,
      label: evaluation.label,
      text: evaluation.text,
      strength: handStrength(evaluation),
      ranks: evaluation.ranks,
      suits: evaluation.suits
    };
  }

  /**
   * Viewer-specific snapshot. Cards of other players are only included at
   * showdown, and your own cards are withheld until you have "seen" them —
   * so a curious client cannot peek at hidden information.
   */
  serialize(viewerId = null) {
    const viewer = viewerId ? this.getPlayer(viewerId) : null;
    const revealOthers = this.phase === PHASE.SHOWDOWN || this.phase === PHASE.SETTLED;

    const seats = this.seats.map((player, seat) => {
      if (!player) return null;
      const isViewer = viewer && viewer.id === player.id;
      const cards = [];
      if (player.cards.length) {
        let visible = isViewer && player.seen;
        if (revealOthers && !player.packed) visible = true;
        if (this.results) {
          const revealed = this.results.reveal.find((entry) => entry.id === player.id);
          if (revealed) visible = true;
        }
        if (visible) cards.push(...player.cards);
      }
      return {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        isBot: player.isBot,
        seat,
        chips: player.chips,
        committed: player.committed,
        inHand: player.inHand,
        seen: player.seen,
        packed: player.packed,
        allIn: player.allIn,
        sittingOut: player.sittingOut,
        connected: player.connected,
        status: player.status,
        lastAction: player.lastAction,
        lastBet: player.lastBet,
        isDealer: seat === this.dealerSeat && this.phase !== PHASE.WAITING,
        isTurn: seat === this.turnSeat && this.phase === PHASE.BETTING,
        cardCount: player.inHand ? 3 : 0,
        cards,
        hand: cards.length === 3 ? this.handInfo(cards) : null,
        session: this.sessionStats.get(player.id) || null
      };
    });

    let you = null;
    if (viewer) {
      const isTurn = this.turnSeat === viewer.seat && this.phase === PHASE.BETTING && this.pending.has(viewer.id);
      const cost = this.callCost(viewer);
      const maxRaise = this.maxRaiseFor(viewer);
      const minRaise = this.minRaiseFor(viewer);
      you = {
        id: viewer.id,
        seat: viewer.seat,
        chips: viewer.chips,
        inHand: viewer.inHand,
        seen: viewer.seen,
        packed: viewer.packed,
        allIn: viewer.allIn,
        sittingOut: viewer.sittingOut,
        status: viewer.status,
        committed: viewer.committed,
        cards: viewer.seen || (revealOthers && !viewer.packed) ? viewer.cards.slice() : [],
        cardCount: viewer.inHand ? 3 : 0,
        hand: viewer.seen && viewer.cards.length === 3 ? this.handInfo(viewer.cards) : null,
        isTurn,
        costToCall: cost,
        canAct: isTurn,
        options: {
          pack: isTurn,
          check: isTurn && !this.activePlayers.some((other) => other.id !== viewer.id && other.committed > viewer.committed),
          call: isTurn && viewer.chips >= cost,
          callLabel: viewer.seen ? 'Chaal' : 'Blind',
          callCost: cost,
          raise: isTurn && maxRaise >= minRaise,
          minRaise,
          maxRaise,
          /** Chips paid per point of stake raised to: seen pays double. */
          raiseRate: viewer.seen ? 2 : 1,
          allIn: isTurn && viewer.chips > 0,
          allInAmount: viewer.chips,
          show: isTurn && this.canShow(viewer),
          sideShow: isTurn && this.canSideShow(viewer),
          sideShowCost: this.chaalCost,
          see: !viewer.seen && viewer.inHand && !viewer.packed,
          rebuy: viewer.chips < this.config.boot
        }
      };
    }

    return {
      tableId: this.id,
      name: this.name,
      phase: this.phase,
      handNo: this.handNo,
      round: this.round,
      maxRounds: this.config.maxRounds,
      pot: this.potTotal,
      stake: this.stake,
      blindCost: this.blindCost,
      chaalCost: this.chaalCost,
      dealerSeat: this.dealerSeat,
      turnSeat: this.turnSeat,
      turnDeadline: this.turnDeadline,
      turnSeconds: this.turnSeconds || this.config.turnSeconds,
      maxPlayers: this.config.maxPlayers,
      config: {
        boot: this.config.boot,
        maxRounds: this.config.maxRounds,
        turnSeconds: this.config.turnSeconds,
        minRaise: this.config.minRaise,
        maxStake: this.config.maxStake,
        chaalLimit: this.config.chaalLimit,
        potLimit: this.config.potLimit,
        maxBlindRounds: this.config.maxBlindRounds,
        showTie: this.config.showTie,
        sequenceOrder: this.config.sequenceOrder,
        sideshow: this.config.sideshow,
        startChips: this.config.startChips,
        minBuyIn: this.config.minBuyIn,
        maxBuyIn: this.config.maxBuyIn
      },
      mode: {
        id: this.config.mode,
        reversed: this.rules.reversed,
        wildRanks: this.rules.wildRanks.slice(),
        jokerCard: this.jokerCard,
        sequenceOrder: this.rules.sequenceOrder
      },
      seats,
      you,
      sideShow: this.sideShow
        ? {
            ...this.sideShow,
            iAmTarget: Boolean(viewer && this.sideShow.targetId === viewer.id),
            iAmRequester: Boolean(viewer && this.sideShow.requesterId === viewer.id),
            deadline: this.sideShowDeadline
          }
        : null,
      results: this.results,
      history: this.history.slice(0, 12),
      log: this.log.slice(-40),
      // Muflis flips the chart: strongest-first means weakest-classic-first.
      rankingsChart: (this.rules.reversed ? [...RANKING_CHART].reverse() : RANKING_CHART)
        .map((entry) => ({ ...entry, name: CATEGORY_NAME[entry.category] }))
    };
  }
}

export default TeenPattiTable;
