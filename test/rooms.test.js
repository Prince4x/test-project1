import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/rooms.js';
import { PHASE } from '../src/engine/table.js';

/** A stand-in for a WebSocket connection that records everything it is sent. */
function fakeConnection(profileId) {
  return {
    data: { profileId },
    query: new Map([['profile', profileId]]),
    closed: false,
    sent: [],
    handlers: {},
    send(message) {
      this.sent.push(message);
      return true;
    },
    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    },
    last(type) {
      return [...this.sent].reverse().find((message) => message.type === type);
    }
  };
}

function totalChips(table) {
  return table.players.reduce((sum, player) => sum + player.chips + player.committed, 0);
}

test('bots deal, bet and settle hands on their own until the clock stops', () => {
  let clock = 1_000_000;
  const rooms = new RoomManager({ now: () => clock });
  const room = rooms.createRoom({ name: 'Bot table', bots: 3, config: { turnSeconds: 5 } });
  const startingChips = totalChips(room.table);

  for (let step = 0; step < 900; step += 1) {
    clock += 400;
    rooms.tick();
    for (const player of room.table.players) {
      assert.ok(player.chips >= 0, 'no player ever goes negative');
      assert.ok(Number.isInteger(player.chips), 'chips stay integral');
    }
  }

  assert.ok(room.table.handNo >= 3, `bots played several hands (played ${room.table.handNo})`);
  assert.equal(totalChips(room.table), startingChips, 'chips are conserved by the bot loop');
  assert.ok(room.table.history.length > 0);
  assert.ok(rooms.leaderboard.size === 3);
  const leaderboard = rooms.leaderboardTop(3);
  const netSum = leaderboard.reduce((sum, entry) => sum + entry.net, 0);
  assert.equal(netSum, 0, 'the leaderboard is zero-sum');
});

test('a human can join, act and receive state updates', () => {
  let clock = 2_000_000;
  const rooms = new RoomManager({ now: () => clock });
  const room = rooms.createRoom({ name: 'Mixed table', bots: 3, config: { turnSeconds: 5 } });
  const human = fakeConnection('human-1');

  rooms.registerClient(human);
  assert.equal(human.last('welcome').tables.length, 1);

  rooms.onMessage(human, { type: 'hello', profile: { name: 'Arena Tester', avatar: '🎯' } });
  assert.equal(human.last('hello').you.name, 'Arena Tester');

  rooms.onMessage(human, { type: 'table:join', tableId: room.table.id, buyIn: 1000 });
  assert.equal(human.last('joined').tableId, room.table.id);
  assert.equal(room.table.getPlayer('human-1').chips, 1000);

  // Play out a hand: whenever it is the human's turn, chaal.
  let guard = 0;
  let view = null;
  while (guard < 400 && room.table.handNo < 2) {
    guard += 1;
    clock += 400;
    rooms.tick();
    view = room.table.serialize('human-1');
    if (view.sideShow?.iAmTarget) {
      rooms.onMessage(human, { type: 'sideshow', accept: false });
    } else if (view.you?.canAct) {
      rooms.onMessage(human, { type: 'action', action: 'chaal' });
    }
  }

  assert.ok(room.table.handNo >= 2, 'the table keeps dealing');
  const states = human.sent.filter((message) => message.type === 'state');
  assert.ok(states.length > 5, 'the client is kept up to date');
  assert.ok(!view.seats.some((seat) => seat && seat.id !== 'human-1' && seat.cards.length && room.table.phase === PHASE.BETTING),
    'other players hands stay hidden while betting');

  // Leaving the table frees the seat.
  rooms.onMessage(human, { type: 'table:leave' });
  assert.equal(room.table.getPlayer('human-1'), null);
});

test('invalid actions come back as friendly errors, never as crashes', () => {
  const clock = 3_000_000;
  const rooms = new RoomManager({ now: () => clock });
  const room = rooms.createRoom({ name: 'Errors', bots: 2 });
  const human = fakeConnection('human-2');
  rooms.registerClient(human);
  rooms.onMessage(human, { type: 'table:join', tableId: room.table.id, buyIn: 1000 });

  rooms.onMessage(human, { type: 'action', action: 'nonsense' });
  assert.match(human.last('error').message, /Unknown action/);

  rooms.onMessage(human, { type: 'action', action: 'chaal' });
  assert.ok(human.last('error'), 'acting out of turn is rejected politely');

  rooms.onMessage(human, { type: 'rebuy', amount: 500 });
  assert.equal(room.table.getPlayer('human-2').chips, 1500);
});

test('chat is broadcast and sanitised', () => {
  const rooms = new RoomManager();
  const room = rooms.createRoom({ name: 'Chat', bots: 1 });
  const human = fakeConnection('human-3');
  rooms.registerClient(human);
  rooms.onMessage(human, { type: 'hello', profile: { name: 'Talker', avatar: '💬' } });
  rooms.onMessage(human, { type: 'table:join', tableId: room.table.id, buyIn: 500 });
  rooms.onMessage(human, { type: 'chat', text: '  Namaste\u0000 everyone  ' });

  const chat = human.sent.filter((message) => message.type === 'chat' && !message.system);
  assert.ok(chat.length >= 1);
  assert.equal(chat.at(-1).from, 'Talker');
  assert.equal(chat.at(-1).text, '  Namaste everyone  ');
});

test('public house tables recycle their bots instead of disappearing', () => {
  let clock = 5_000_000;
  const rooms = new RoomManager({ now: () => clock });
  const room = rooms.createRoom({ name: 'House table', bots: 3, keepAlive: true });
  const veteran = room.table.players[0].name;

  clock += 5 * 60 * 1000;
  rooms.tick();
  assert.equal(rooms.rooms.has(room.table.id), true, 'the house table survives');
  assert.equal(room.table.seatedCount, 3, 'and is refilled with bots');
  assert.equal(room.table.players.every((player) => player.isBot), true);

  // A hand can be dealt again straight away.
  clock += 5000;
  for (let step = 0; step < 40; step += 1) {
    clock += 400;
    rooms.tick();
  }
  assert.ok(room.table.handNo >= 1, `the refreshed table deals (${room.table.handNo})`);
  assert.ok(veteran.length > 0);
});

test('tables are cleaned up once everybody has left', () => {
  let clock = 4_000_000;
  const rooms = new RoomManager({ now: () => clock });
  const room = rooms.createRoom({ name: 'Ghost town', bots: 0 });
  const human = fakeConnection('human-4');
  rooms.registerClient(human);
  rooms.onMessage(human, { type: 'table:join', tableId: room.table.id, buyIn: 500 });
  rooms.onMessage(human, { type: 'table:leave' });

  clock += 6 * 60 * 1000;
  rooms.tick();
  assert.equal(rooms.rooms.has(room.table.id), false, 'empty rooms are reaped');
});
