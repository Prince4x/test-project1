/**
 * Room manager — owns every online table, the server-side AI bots and the
 * WebSocket protocol spoken with browsers.
 *
 * The engine itself is host-agnostic; this file supplies the clock (bot pacing,
 * turn timeouts, auto-dealing) and the multiplayer plumbing (join/leave,
 * reconnects, chat, per-viewer state broadcasts).
 */

import { TeenPattiTable, PHASE, ACTION } from '../src/engine/table.js';
import { decideAction, PERSONALITIES } from '../src/engine/ai.js';
import { handStrength, evaluate } from '../src/engine/evaluator.js';

// TEEN_PATTI_FAST=1 compresses every delay — used by the end-to-end test and
// handy when demoing the bots.
const FAST = process.env.TEEN_PATTI_FAST === '1';

const HAND_SETTLE_DELAY = FAST ? 400 : 3200;   // ms between hands
const BOT_MIN_DELAY = FAST ? 120 : 900;
const BOT_MAX_DELAY = FAST ? 260 : 2000;
const DISCONNECT_GRACE = 45000;   // ms before a dropped player gives up their seat
const EMPTY_ROOM_TTL = 5 * 60 * 1000;
const SEED_REFRESH = 3 * 60 * 1000; // public house tables recycle their bots when idle
const MAX_CHAT = 180;

const BOT_LINES = {
  join: ['Namaste!', 'Good luck, all.', 'Deal me in.', 'Table looks good.'],
  raise: ['Full chaal!', 'Feeling lucky…', 'Pay to play.', 'Your turn to sweat.'],
  pack: ['Too rich for me.', 'I fold.', 'Not my hand.', 'Take it.'],
  win: ['Thank you kindly!', 'That is how it is done.', 'Ship it.'],
  blind: ['Playing blind!', 'No peeking.', 'Blind chaal.'],
  sideshow: ['Let us compare.', 'Show me one card worth of courage.']
};

function pick(list, rng = Math.random) {
  return list[Math.floor(rng() * list.length)];
}

export class RoomManager {
  constructor({ now = () => Date.now() } = {}) {
    this.rooms = new Map();
    this.clients = new Set();
    this.leaderboard = new Map(); // profileId -> career stats
    this.now = now;
    this.started = now();
  }

  // ────────────────────────────────────────────────────────────── tables ──

  listTables() {
    return [...this.rooms.values()].map((room) => ({
      id: room.table.id,
      name: room.table.name,
      players: room.table.seatedCount,
      humans: room.humans.size,
      maxPlayers: room.table.config.maxPlayers,
      boot: room.table.config.boot,
      phase: room.table.phase,
      handNo: room.table.handNo,
      pot: room.table.potTotal,
      createdAt: room.createdAt
    })).sort((a, b) => b.humans - a.humans || a.createdAt - b.createdAt);
  }

  getTableInfo(room) {
    const table = room.table;
    return {
      id: table.id,
      name: table.name,
      players: table.seatedCount,
      humans: room.humans.size,
      bots: table.players.filter((player) => player.isBot).length,
      maxPlayers: table.config.maxPlayers,
      boot: table.config.boot,
      phase: table.phase,
      pot: table.potTotal,
      handNo: table.handNo,
      seats: table.seats.map((player) => (player
        ? { name: player.name, avatar: player.avatar, chips: player.chips, isBot: player.isBot, inHand: player.inHand, connected: player.connected }
        : null))
    };
  }

  createRoom({ name, hostId, config = {}, bots = 0, isPublic = true, keepAlive = false } = {}) {
    const table = new TeenPattiTable({
      name: name || 'Teen Patti Table',
      ...config
    });
    const room = {
      table,
      clients: new Map(),   // profileId -> connection
      humans: new Map(),    // profileId -> { name, avatar, disconnectedAt }
      createdAt: this.now(),
      lastActivity: this.now(),
      nextBotActionAt: 0,
      nextHandAt: this.now() + 1200,
      lastSettledHand: 0,
      lastHumanLeftAt: this.now(),
      isPublic,
      keepAlive,
      seedBots: keepAlive ? bots : 0
    };
    this.rooms.set(table.id, room);

    if (bots > 0) this.fillWithBots(room, bots);
    return room;
  }

  fillWithBots(room, count = room.table.config.maxPlayers - 1) {
    const used = new Set(room.table.players.map((player) => player.name));
    for (let i = 0; i < count; i += 1) {
      if (room.table.seatedCount >= room.table.config.maxPlayers) break;
      const bot = this.spawnBot(room, used);
      if (bot) used.add(bot.name);
    }
    return room;
  }

  spawnBot(room, used = new Set(room.table.players.map((player) => player.name))) {
    const candidates = [
      ['Ravi', '🐯'], ['Priya', '🦋'], ['Arjun', '🦅'], ['Meera', '🌸'], ['Vikram', '🐘'],
      ['Anjali', '🪔'], ['Dev', '🐉'], ['Kavya', '🦚'], ['Rohan', '🦁'], ['Sana', '🌙'],
      ['Kabir', '⚡'], ['Nisha', '💎'], ['Zara', '🔥'], ['Imran', '🎲']
    ].filter(([name]) => !used.has(name));
    if (!candidates.length) return null;
    const [name, avatar] = pick(candidates);
    const personalities = Object.keys(PERSONALITIES);
    const player = room.table.addPlayer({
      name,
      avatar,
      isBot: true,
      personality: pick(personalities),
      chips: room.table.config.startChips
    });
    return player;
  }

  joinTable(connection, tableId, { profile, buyIn } = {}) {
    const room = this.rooms.get(tableId);
    if (!room) throw new Error('That table is no longer available');
    const id = profile.id;
    const existing = room.table.getPlayer(id);

    if (existing) {
      // Reconnecting player: just re-attach the socket.
      room.clients.set(id, connection);
      room.humans.set(id, { name: existing.name, avatar: existing.avatar, disconnectedAt: null });
      existing.connected = true;
      room.lastHumanLeftAt = null;
    } else {
      const seatCount = room.table.seatedCount;
      if (seatCount >= room.table.config.maxPlayers) throw new Error('That table is full');
      const amount = Number(buyIn) || room.table.config.startChips;
      const clamped = Math.min(Math.max(amount, room.table.config.minBuyIn), room.table.config.maxBuyIn);
      // Make room for a human: retire a bot if the table is bots-only-full.
      if (seatCount >= room.table.config.maxPlayers - 1) {
        const bot = room.table.players.find((player) => player.isBot);
        if (bot && room.humans.size < room.table.config.maxPlayers - 1) room.table.removePlayer(bot.id);
      }
      room.table.addPlayer({ id, name: profile.name, avatar: profile.avatar, chips: clamped });
      room.clients.set(id, connection);
      room.humans.set(id, { name: profile.name, avatar: profile.avatar, disconnectedAt: null });
      room.lastHumanLeftAt = null;
      this.broadcastChat(room, {
        from: 'Table',
        avatar: '🎴',
        system: true,
        text: `${profile.avatar} ${profile.name} joined with ${clamped} chips`
      });
    }

    connection.data.profileId = id;
    connection.data.tableId = tableId;
    connection.send({ type: 'joined', tableId, table: this.getTableInfo(room) });
    this.broadcastState(room);
    return room;
  }

  leaveTable(connection, { keepSeat = false } = {}) {
    const tableId = connection.data.tableId;
    if (!tableId) return;
    const room = this.rooms.get(tableId);
    const id = connection.data.profileId;
    connection.data.tableId = null;
    if (!room) return;

    if (keepSeat) {
      const player = room.table.getPlayer(id);
      room.clients.delete(id);
      if (player) {
        player.connected = false;
        room.humans.set(id, { name: player.name, avatar: player.avatar, disconnectedAt: this.now() });
      }
    } else {
      const player = room.table.getPlayer(id);
      room.clients.delete(id);
      room.humans.delete(id);
      room.table.removePlayer(id);
      this.broadcastChat(room, {
        from: 'Table',
        avatar: '🎴',
        system: true,
        text: `${player ? `${player.avatar} ${player.name}` : 'A player'} left the table`
      });
    }
    room.lastHumanLeftAt = room.humans.size === 0 ? this.now() : null;
    this.broadcastState(room);
  }

  broadcastState(room) {
    const events = room.table.drainEvents();
    for (const [profileId, connection] of room.clients) {
      if (!connection || connection.closed) continue;
      connection.send({
        type: 'state',
        snapshot: room.table.serialize(profileId),
        events,
        table: this.getTableInfo(room),
        serverTime: this.now()
      });
    }
  }

  broadcastChat(room, message) {
    const payload = { type: 'chat', at: this.now(), ...message };
    for (const connection of room.clients.values()) {
      if (connection && !connection.closed) connection.send(payload);
    }
  }

  // ─────────────────────────────────────────────────────────── messaging ──

  handleMessage(connection, message) {
    if (!message || typeof message !== 'object') return;
    const room = connection.data.tableId ? this.rooms.get(connection.data.tableId) : null;
    const profileId = connection.data.profileId;

    switch (message.type) {
      case 'hello': {
        const profile = message.profile || {};
        connection.data.name = String(profile.name || 'Player').slice(0, 18);
        connection.data.avatar = String(profile.avatar || '🙂').slice(0, 4);
        connection.send({
          type: 'hello',
          you: { id: profileId, name: connection.data.name, avatar: connection.data.avatar },
          tables: this.listTables(),
          leaderboard: this.leaderboardTop(),
          personalities: PERSONALITIES
        });
        break;
      }
      case 'tables': {
        connection.send({ type: 'tables', tables: this.listTables(), serverTime: this.now() });
        break;
      }
      case 'table:create': {
        this.leaveTable(connection);
        const room = this.createRoom({
          name: message.name,
          hostId: profileId,
          config: message.config || {},
          bots: message.bots ?? 3
        });
        this.joinTable(connection, room.table.id, { profile: message.profile || {}, buyIn: message.buyIn });
        break;
      }
      case 'table:join': {
        this.leaveTable(connection);
        this.joinTable(connection, message.tableId, {
          profile: message.profile || { id: profileId, name: connection.data.name, avatar: connection.data.avatar },
          buyIn: message.buyIn
        });
        break;
      }
      case 'table:leave': {
        this.leaveTable(connection);
        connection.send({ type: 'left' });
        break;
      }
      case 'table:fill': {
        if (!room) throw new Error('Join a table first');
        const missing = room.table.config.maxPlayers - room.table.seatedCount;
        const wanted = Math.min(missing, Math.max(0, Number(message.count) || 0));
        this.fillWithBots(room, wanted);
        room.nextHandAt = this.now() + 800;
        this.broadcastState(room);
        break;
      }
      case 'action': {
        if (!room) throw new Error('Join a table first');
        this.applyPlayerAction(room, profileId, message);
        break;
      }
      case 'sideshow': {
        if (!room) throw new Error('Join a table first');
        room.table.respondSideShow(profileId, Boolean(message.accept));
        this.broadcastState(room);
        break;
      }
      case 'rebuy': {
        if (!room) throw new Error('Join a table first');
        const player = room.table.getPlayer(profileId);
        if (!player) throw new Error('You are not seated');
        const amount = Math.min(Math.max(Number(message.amount) || 0, 0), room.table.config.maxBuyIn);
        room.table.topUp(profileId, amount);
        this.broadcastState(room);
        break;
      }
      case 'chat': {
        if (!room) throw new Error('Join a table first');
        const text = String(message.text || '').slice(0, MAX_CHAT).replace(/[\u0000-\u001f]/g, '');
        const player = room.table.getPlayer(profileId);
        if (!text || !player) return;
        this.broadcastChat(room, { from: player.name, avatar: player.avatar, text, profileId });
        break;
      }
      case 'ping':
        connection.send({ type: 'pong', serverTime: this.now() });
        break;
      default:
        break;
    }
  }

  applyPlayerAction(room, profileId, message) {
    const action = String(message.action || '').toLowerCase();
    const allowed = new Set(Object.values(ACTION));
    if (!allowed.has(action)) throw new Error(`Unknown action: ${action}`);
    room.table.act(profileId, action, { stake: message.stake });
    room.lastActivity = this.now();
    this.broadcastState(room);
  }

  // ──────────────────────────────────────────────────────────────── loop ──

  /** Called on an interval by the HTTP server. Drives bots, clocks and cleanup. */
  tick() {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      try {
        this.tickRoom(room, now);
      } catch (error) {
        console.error(`[room ${id}]`, error.message);
      }
      // Housekeeping. House ("keep alive") tables are never dropped: they
      // refresh themselves with a fresh set of bots so the lobby always has
      // somewhere to sit.
      const emptyFor = room.humans.size === 0 ? now - (room.lastHumanLeftAt ?? now) : 0;
      if (room.keepAlive) {
        if (room.humans.size === 0 && emptyFor > SEED_REFRESH) this.resetRoom(room);
      } else if (room.humans.size === 0 && emptyFor > EMPTY_ROOM_TTL) {
        this.rooms.delete(id);
        continue;
      }
      for (const [profileId, human] of room.humans) {
        if (human.disconnectedAt && now - human.disconnectedAt > DISCONNECT_GRACE) {
          room.humans.delete(profileId);
          room.clients.delete(profileId);
          room.table.removePlayer(profileId);
          room.lastHumanLeftAt = room.humans.size === 0 ? now : room.lastHumanLeftAt;
          this.broadcastState(room);
        }
      }
    }
  }

  tickRoom(room, now) {
    const table = room.table;

    // Bank the finished hand before the next one is dealt.
    if (table.phase === PHASE.SETTLED && table.results && room.lastSettledHand !== table.results.handNo) {
      this.recordHandResults(room);
    }

    // Turn clocks (bots get packed by the engine if they somehow stall).
    const timeout = table.checkTimeout(now);
    if (timeout) this.broadcastState(room);

    if (table.phase === PHASE.BETTING) {
      const pendingSideShow = table.sideShow;
      if (pendingSideShow) {
        const target = table.getPlayer(pendingSideShow.targetId);
        if (target?.isBot) {
          if (!room.nextBotActionAt || room.botSideShowFor !== pendingSideShow.targetId) {
            room.botSideShowFor = pendingSideShow.targetId;
            room.nextBotActionAt = now + BOT_MIN_DELAY;
          } else if (now >= room.nextBotActionAt) {
            room.botSideShowFor = null;
            room.nextBotActionAt = 0;
            const seen = target.seen;
            const strength = seen ? handStrength(evaluate(target.cards)) : 0.5;
            const profile = PERSONALITIES[target.personality] || PERSONALITIES.balanced;
            table.respondSideShow(target.id, seen && strength > 0.42 + (1 - profile.sideShow) * 0.2);
            this.maybeBotChat(room, target, 'sideshow', 0.25);
            this.broadcastState(room);
          }
        }
        return;
      }

      const player = table.turnPlayer;
      if (player?.isBot) {
        if (!room.nextBotActionAt || room.botFor !== player.id) {
          room.botFor = player.id;
          room.nextBotActionAt = now + BOT_MIN_DELAY + Math.random() * (BOT_MAX_DELAY - BOT_MIN_DELAY);
        } else if (now >= room.nextBotActionAt) {
          room.botFor = null;
          room.nextBotActionAt = 0;
          this.runBotTurn(room, player);
          this.broadcastState(room);
        }
      }
      return;
    }

    // Deal the next hand when the table is idle and still has players.
    if ((table.phase === PHASE.WAITING || table.phase === PHASE.SETTLED) && table.canStartHand()) {
      if (!room.nextHandAt || room.nextHandAt < now - 60000) room.nextHandAt = now + HAND_SETTLE_DELAY;
      if (now >= room.nextHandAt) {
        room.nextHandAt = 0;
        table.startHand();
        this.broadcastState(room);
      }
    }
  }

  runBotTurn(room, player) {
    const table = room.table;
    const activePlayers = table.activePlayers.length;
    const view = {
      cards: player.cards,
      seen: player.seen,
      chips: player.chips,
      costToCall: table.callCost(player),
      blindCost: table.blindCost,
      pot: table.potTotal,
      stake: table.stake,
      activePlayers,
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
    } catch (error) {
      decision = { action: ACTION.CHAAL };
    }

    const act = (action, payload) => table.act(player.id, action, payload);
    try {
      switch (decision.action) {
        case ACTION.PACK:
          act(ACTION.PACK);
          this.maybeBotChat(room, player, 'pack', 0.18);
          break;
        case ACTION.SHOW:
          act(ACTION.SHOW);
          break;
        case ACTION.SIDE_SHOW:
          act(ACTION.SIDE_SHOW);
          this.maybeBotChat(room, player, 'sideshow', 0.3);
          break;
        case ACTION.RAISE:
          act(ACTION.RAISE, { stake: decision.stake });
          this.maybeBotChat(room, player, 'raise', 0.12);
          break;
        case ACTION.ALL_IN:
          act(ACTION.ALL_IN);
          break;
        case ACTION.BLIND:
          act(ACTION.BLIND);
          this.maybeBotChat(room, player, 'blind', 0.1);
          break;
        case ACTION.SEE:
          act(ACTION.SEE);
          break;
        default:
          act(ACTION.CHAAL);
      }
    } catch (error) {
      // Never let a bot stall the table: fall back to the safest legal move.
      try {
        const cost = table.callCost(player);
        if (player.chips >= cost) table.act(player.id, ACTION.CHAAL);
        else table.act(player.id, ACTION.ALL_IN);
      } catch {
        try {
          table.act(player.id, ACTION.PACK);
        } catch { /* the clock will clean up */ }
      }
    }
  }

  maybeBotChat(room, player, kind, probability) {
    if (Math.random() > probability) return;
    if (room.humans.size === 0) return;
    this.broadcastChat(room, {
      from: player.name,
      avatar: player.avatar,
      bot: true,
      text: pick(BOT_LINES[kind] || BOT_LINES.raise)
    });
  }

  /** Aggregate career stats each time a hand finishes. */
  recordHandResults(room) {
    const table = room.table;
    const results = table.results;
    if (!results || room.lastSettledHand === results.handNo) return;
    room.lastSettledHand = results.handNo;

    const committed = new Map();
    for (const entry of results.rankings) committed.set(entry.id, entry.committed);
    for (const entry of results.packed) committed.set(entry.id, entry.committed);

    for (const player of table.players) {
      const entry = this.leaderboard.get(player.id) || {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        hands: 0,
        wins: 0,
        net: 0,
        biggestPot: 0
      };
      entry.name = player.name;
      entry.avatar = player.avatar;
      entry.hands += 1;
      const won = results.winners.filter((winner) => winner.id === player.id).reduce((sum, winner) => sum + winner.amount, 0);
      entry.net += won - (committed.get(player.id) || 0);
      if (won > 0) {
        entry.wins += 1;
        entry.biggestPot = Math.max(entry.biggestPot, won);
      }
      this.leaderboard.set(player.id, entry);
    }

    for (const winner of results.winners) {
      const player = table.getPlayer(winner.id);
      if (player?.isBot && winner.amount > table.config.startChips * 1.5) {
        this.maybeBotChat(room, player, 'win', 0.5);
      }
    }
  }

  leaderboardTop(limit = 12) {
    return [...this.leaderboard.values()]
      .filter((entry) => entry.hands > 0)
      .sort((a, b) => b.net - a.net || b.wins - a.wins)
      .slice(0, limit);
  }

  // ───────────────────────────────────────────────────────────- clients ──

  registerClient(connection) {
    const id = connection.query?.get('profile') || `guest-${Math.random().toString(36).slice(2, 10)}`;
    connection.data.profileId = id;
    this.clients.add(connection);
    connection.on('close', () => {
      this.clients.delete(connection);
      this.leaveTable(connection, { keepSeat: true });
    });
    connection.send({ type: 'welcome', profileId: id, tables: this.listTables(), serverTime: this.now() });
  }

  onMessage(connection, message) {
    try {
      this.handleMessage(connection, message);
    } catch (error) {
      connection.send({ type: 'error', message: error.message });
    }
  }

  /** Refill a public house table with fresh bots (called when it sits idle). */
  resetRoom(room) {
    for (const player of [...room.table.players]) {
      room.table.removePlayer(player.id);
    }
    room.table.results = null;
    room.table.history = [];
    room.lastSettledHand = 0;
    this.fillWithBots(room, room.seedBots || 3);
    room.nextHandAt = this.now() + 1500;
    room.lastHumanLeftAt = this.now();
  }

  stats() {
    return {
      tables: this.rooms.size,
      clients: this.clients.size,
      humans: [...this.rooms.values()].reduce((sum, room) => sum + room.humans.size, 0),
      uptime: this.now() - this.started
    };
  }
}

export default RoomManager;
