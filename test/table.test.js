import test from 'node:test';
import assert from 'node:assert/strict';
import { TeenPattiTable, PHASE, ACTION, DEFAULT_CONFIG } from '../src/engine/table.js';
import { evaluate } from '../src/engine/evaluator.js';

function makeTable(options = {}, playerCount = 3) {
  const table = new TeenPattiTable({
    ...DEFAULT_CONFIG,
    seed: 42,
    turnSeconds: 30,
    ...options
  });
  for (let i = 0; i < playerCount; i += 1) {
    table.addPlayer({ id: `p${i + 1}`, name: `P${i + 1}`, chips: options.startChips ?? 1000 });
  }
  return table;
}

/** Every chip on the table: stacks plus what has been committed to the pot. */
function totalChips(table) {
  return table.players.reduce((sum, player) => sum + player.chips + player.committed, 0);
}

test('dealing posts the boot, deals three cards and sets the first turn', () => {
  const table = makeTable();
  const before = totalChips(table);
  table.startHand();

  assert.equal(table.phase, PHASE.BETTING);
  assert.equal(table.handNo, 1);
  assert.equal(table.round, 1);
  assert.equal(table.stake, table.config.boot);
  for (const player of table.players) {
    assert.equal(player.cards.length, 3);
    assert.equal(player.committed, table.config.boot);
    assert.equal(player.seen, false, 'players start blind');
  }
  assert.equal(table.potTotal, 30, 'three boots in the pot');
  assert.equal(totalChips(table), before);
  assert.equal(table.turnSeat, (table.dealerSeat + 1) % 6, 'action starts left of the dealer');
  assert.ok(table.players.every((player) => table.pending.has(player.id)));
});

test('dealer button rotates each hand', () => {
  const table = makeTable();
  table.startHand();
  const first = table.dealerSeat;
  table.showdown('fold');
  table.startHand();
  assert.notEqual(table.dealerSeat, first);
});

test('packing around leaves one player who takes the pot', () => {
  const table = makeTable();
  table.startHand();
  const before = totalChips(table);
  const firstToAct = table.playerAt(table.turnSeat);
  table.act(firstToAct.id, ACTION.PACK);
  table.act(table.playerAt(table.turnSeat).id, ACTION.PACK);
  const winner = table.players.find((player) => !player.packed);

  assert.equal(table.phase, PHASE.SETTLED);
  assert.equal(table.results.winners.length, 1);
  assert.equal(table.results.winners[0].id, winner.id);
  assert.equal(table.results.pot, 30);
  assert.equal(totalChips(table), before, 'chips are conserved');
  assert.equal(table.players.find((player) => player.id === winner.id).chips, 1020);
});

test('blind players pay half the stake, seen players pay full', () => {
  const table = makeTable();
  table.startHand();
  const first = table.playerAt(table.turnSeat);
  table.act(first.id, ACTION.CHAAL); // blind -> pays ceil(10/2) = 5
  assert.equal(first.lastBet, 5);

  const second = table.playerAt(table.turnSeat);
  table.act(second.id, ACTION.SEE);
  table.act(second.id, ACTION.CHAAL); // seen -> pays 10
  assert.equal(second.lastBet, 10);
});

test('a raise resets the round so everybody must respond', () => {
  const table = makeTable();
  table.startHand();
  const raiser = table.playerAt(table.turnSeat);
  table.act(raiser.id, ACTION.RAISE, { stake: 20 });
  assert.equal(table.stake, 20);
  assert.equal(raiser.lastBet, 10, 'a blind raiser pays half of the new stake');
  assert.equal(table.pending.size, 2);
  assert.ok(!table.pending.has(raiser.id));

  const next = table.playerAt(table.turnSeat);
  assert.ok(next.id !== raiser.id, 'the turn moves on to a player who still owes a response');
  table.act(next.id, ACTION.CHAAL);
  table.act(table.playerAt(table.turnSeat).id, ACTION.CHAAL);
  assert.equal(table.round, 2, 'once everyone responds the round advances');
});

test('raises are validated against the minimum and the stack', () => {
  const table = makeTable({ boot: 10, minRaise: 2 });
  table.startHand();
  const player = table.playerAt(table.turnSeat);
  assert.throws(() => table.act(player.id, ACTION.RAISE, { stake: 11 }), /Minimum raise/);
  assert.throws(() => table.act(player.id, ACTION.RAISE, { stake: 5000 }), /Maximum raise/);
});

test('you cannot act out of turn or twice in a round', () => {
  const table = makeTable();
  table.startHand();
  const idle = table.players.find((player) => player.seat !== table.turnSeat);
  assert.throws(() => table.act(idle.id, ACTION.CHAAL), /not your turn/);
  const actor = table.playerAt(table.turnSeat);
  table.act(actor.id, ACTION.CHAAL);
  assert.throws(() => table.act(actor.id, ACTION.CHAAL), /not your turn|already acted/);
});

test('showdown reveals hands and awards the pot to the best hand', () => {
  const table = makeTable();
  table.startHand();
  const [a, b, c] = table.players;
  a.packed = true; a.status = 'packed';
  table.pending.delete(a.id);
  table.showdown('show');

  const ranked = table.results.rankings.map((entry) => entry.id);
  const strengths = table.results.rankings.map((entry) => evaluate(table.getPlayer(entry.id).cards).key.join('.'));
  assert.equal(ranked.length, 2);
  assert.deepEqual(strengths, [...strengths].sort((x, y) => {
    const left = x.split('.').map(Number);
    const right = y.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const l = left[i] ?? -1;
      const r = right[i] ?? -1;
      if (l !== r) return r - l;
    }
    return 0;
  }));
  const winner = table.getPlayer(table.results.winners[0].id);
  assert.ok([b.id, c.id].includes(winner.id));
  assert.equal(table.phase, PHASE.SETTLED);
});

test('all-in players are protected by side pots', () => {
  const fresh = new TeenPattiTable({ ...DEFAULT_CONFIG, seed: 7 });
  fresh.addPlayer({ id: 'short', name: 'Short', chips: 10 });
  fresh.addPlayer({ id: 'big1', name: 'Big1', chips: 2000 });
  fresh.addPlayer({ id: 'big2', name: 'Big2', chips: 2000 });
  const before = totalChips(fresh);
  fresh.startHand();

  // Deterministic cards: short has the nuts, big1 second best, big2 the worst.
  fresh.getPlayer('short').cards = ['AS', 'AH', 'AD'];
  fresh.getPlayer('big1').cards = ['KS', 'KH', 'KD'];
  fresh.getPlayer('big2').cards = ['QS', 'QH', 'QD'];

  // The short stack is all-in from the boot alone, so it can only win its own layer.
  const short = fresh.getPlayer('short');
  assert.equal(short.chips, 0);
  assert.equal(short.allIn, true);

  // The two big stacks play a big pot on top, at full (seen) stake.
  fresh.see('big1');
  fresh.see('big2');
  const order = [];
  const play = (id, action, payload) => {
    if (fresh.turnPlayer?.id !== id) throw new Error(`expected ${id} to act, got ${fresh.turnPlayer?.id}`);
    order.push(id);
    fresh.act(id, action, payload);
  };
  play('big1', ACTION.RAISE, { stake: 300 });
  play('big2', ACTION.CHAAL);
  fresh.showdown('allin');

  assert.equal(fresh.phase, PHASE.SETTLED);
  assert.equal(fresh.getPlayer('short').committed, 0, 'contributions reset after settlement');

  const winnings = Object.fromEntries(fresh.results.winners.map((winner) => [winner.id, winner.amount]));
  // Layer 1: everybody's first 10 chips (30) — short holds the nuts and takes it.
  assert.equal(winnings.short, 30);
  // Layer 2: the 300 chip layer, contested only by the players who covered it.
  assert.equal(winnings.big1, 600);
  assert.equal(winnings.big2, undefined, 'the worst hand wins nothing');
  assert.equal(fresh.getPlayer('short').chips, 30);
  assert.equal(fresh.getPlayer('big1').chips, 2290);
  assert.equal(fresh.getPlayer('big2').chips, 1690);
  assert.equal(totalChips(fresh), before, 'chips are conserved');
  assert.deepEqual(order, ['big1', 'big2']);
});

test('the hand ends after the configured number of betting rounds', () => {
  const table = makeTable({ maxRounds: 2 });
  table.startHand();
  let guard = 0;
  while (table.phase === PHASE.BETTING && guard < 50) {
    guard += 1;
    const player = table.turnPlayer;
    if (!player) break;
    table.act(player.id, ACTION.CHAAL);
  }
  assert.equal(table.phase, PHASE.SETTLED);
  assert.equal(table.results.reason, 'rounds');
  assert.equal(table.results.reason === 'rounds' && table.round, 2);
});

test('the turn timer packs the player who runs out of time', () => {
  const table = makeTable({ turnSeconds: 1 });
  table.startHand();
  const slow = table.turnPlayer;
  const result = table.checkTimeout(Date.now() + 3000);
  assert.equal(result.type, 'timeout');
  assert.equal(result.playerId, slow.id);
  assert.equal(slow.packed, true);
  assert.equal(table.turnPlayer.id !== slow.id, true);
});

test('a disconnected player is put on a short clock so the table keeps moving', () => {
  const table = makeTable({ turnSeconds: 30, disconnectedTurnSeconds: 4 });
  table.startHand();
  const slow = table.turnPlayer;
  assert.equal(table.serialize(slow.id).turnSeconds, 30, 'connected players get the full clock');

  table.setConnected(slow.id, false);
  table.startTurnClock();
  const view = table.serialize(slow.id);
  assert.equal(view.turnSeconds, 4, 'offline players get the short clock');
  assert.ok(view.turnDeadline - Date.now() <= 4000);

  // A minute later the engine packs them automatically instead of stalling.
  const result = table.checkTimeout(Date.now() + 5000);
  assert.equal(result.playerId, slow.id);
  assert.equal(slow.packed, true);
  assert.equal(table.serialize(slow.id).turnSeconds, 30, 'the next player is back on the normal clock');
});

test('side show: the weaker hand packs, the requester keeps the turn', () => {
  const table = makeTable({ sideshow: true });
  table.startHand();
  const requester = table.turnPlayer;
  requester.cards = ['AS', 'AH', 'AD'];
  const target = table.playerAt((requester.seat - 1 + 6) % 6);
  assert.ok(target, 'there is a neighbour to ask');
  target.cards = ['2S', '7H', '9D'];
  table.act(requester.id, ACTION.SEE);
  table.act(requester.id, ACTION.SIDE_SHOW);

  assert.ok(table.sideShow, 'a side show is pending');
  assert.equal(table.turnSeat, requester.seat, 'the requester keeps the turn');
  assert.throws(() => table.act(requester.id, ACTION.CHAAL), /side show/);

  table.respondSideShow(target.id, true);
  assert.equal(target.packed, true);
  assert.equal(table.turnSeat, requester.seat);
  assert.equal(table.sideShow, null);
});

test('declining a side show resumes normal play', () => {
  const table = makeTable({ sideshow: true });
  table.startHand();
  const requester = table.turnPlayer;
  const target = table.playerAt((requester.seat - 1 + 6) % 6);
  table.act(requester.id, ACTION.SEE);
  table.act(requester.id, ACTION.SIDE_SHOW);
  table.respondSideShow(target.id, false);
  assert.equal(target.packed, false);
  table.act(requester.id, ACTION.CHAAL);
  assert.notEqual(table.turnSeat, requester.seat);
});

test('a show can only be called heads-up and ends the hand immediately', () => {
  const table = makeTable({ sideshow: false });
  table.startHand();
  const first = table.turnPlayer;
  table.act(first.id, ACTION.SEE);
  assert.throws(() => table.act(first.id, ACTION.SHOW), /two players/);

  // Pack two players, then call for a show heads-up.
  let guard = 0;
  while (table.activePlayers.length > 2 && guard < 20) {
    guard += 1;
    table.act(table.turnPlayer.id, ACTION.PACK);
  }
  const heads = table.turnPlayer;
  table.act(heads.id, ACTION.SEE);
  table.act(heads.id, ACTION.SHOW);
  assert.equal(table.phase, PHASE.SETTLED);
  assert.equal(table.results.reason, 'show');
  assert.equal(table.results.winners.length, 1);
});

test('serialize hides other players hands and shows your own only after seeing', () => {
  const table = makeTable();
  table.startHand();
  const me = table.players[0];
  const other = table.players[1];

  let view = table.serialize(me.id);
  assert.equal(view.you.cards.length, 0, 'blind players do not receive their own cards');
  assert.equal(view.seats.find((seat) => seat.id === other.id).cards.length, 0);

  table.act(table.turnPlayer.id, ACTION.SEE);
  const seer = table.turnPlayer;
  view = table.serialize(seer.id);
  assert.equal(view.you.cards.length, 3, 'seen players receive their own cards');
  const otherSeat = view.seats.find((seat) => seat.id !== seer.id && seat.inHand);
  assert.equal(otherSeat.cards.length, 0, 'other hands stay hidden');

  table.showdown('show');
  view = table.serialize(seer.id);
  const live = view.seats.filter((seat) => seat && seat.inHand && !seat.packed);
  assert.ok(live.every((seat) => seat.cards.length === 3), 'showdown reveals live hands');
});

test('players who cannot afford the boot sit out', () => {
  const table = makeTable();
  table.players[0].chips = 5;
  table.startHand();
  assert.equal(table.players[0].inHand, false);
  assert.equal(table.players[0].sittingOut, true);
  assert.equal(table.players[0].chips, 5);
});

test('a player can rebuy and rejoin the action', () => {
  const table = makeTable();
  table.players[0].chips = 2;
  table.startHand();
  assert.equal(table.players[0].inHand, false);
  table.topUp(table.players[0].id, 500);
  table.showdown('fold');
  table.startHand();
  assert.equal(table.players[0].inHand, true);
});

test('session statistics track hands, wins and net chips', () => {
  const table = makeTable();
  table.startHand();
  const victimA = table.turnPlayer;
  table.act(victimA.id, ACTION.PACK);
  table.act(table.turnPlayer.id, ACTION.PACK);
  const winner = table.players.find((player) => !player.packed);
  const stats = table.sessionStats.get(winner.id);
  assert.equal(stats.hands, 1);
  assert.equal(stats.wins, 1);
  assert.ok(stats.net > 0);
  assert.equal(table.sessionStats.get(victimA.id).net, -10);
});
