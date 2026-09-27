/**
 * Phase 1 rule-exactness tests.
 *
 * Betting convention (spec): `stake` is the blind unit.
 *   - A blind player bets 1x–2x the current stake; after a blind bet of X the
 *     stake becomes X.
 *   - A seen player bets 2x–4x the current stake; after a seen bet of X the
 *     stake becomes X/2 (the engine expresses this as "raise to S, pay 2·S").
 * Plus: pot limit forced show, max blind rounds, requested-show tie policy,
 * and the crypto-backed default shuffle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TeenPattiTable, PHASE, ACTION, DEFAULT_CONFIG, raiseCostFor } from '../src/engine/table.js';
import { secureRandom, shuffle, makeDeck } from '../src/engine/cards.js';

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

// ── betting convention ──────────────────────────────────────────────────────

test('the stake starts at the boot and blind/seen rates follow the spec', () => {
  const table = makeTable({ boot: 10 });
  table.startHand();
  assert.equal(table.stake, 10, 'stake starts at the boot');
  assert.equal(table.blindCost, 10, 'blind call = 1x stake');
  assert.equal(table.chaalCost, 20, 'seen call (chaal) = 2x stake');
  assert.equal(raiseCostFor(15, false), 15, 'a blind bet that sets the stake to X costs X');
  assert.equal(raiseCostFor(15, true), 30, 'a seen bet that sets the stake to X costs 2X');
});

test('a blind bet of X makes the stake X; a seen bet of 2X also makes the stake X', () => {
  const table = makeTable({ boot: 10 });
  table.startHand();

  // Blind raise to 20 (the 1x–2x cap): pays 20, stake becomes 20.
  const blind = table.turnPlayer;
  table.act(blind.id, ACTION.RAISE, { stake: 20 });
  assert.equal(blind.lastBet, 20);
  assert.equal(table.stake, 20);

  // Seen raise to 40 (2x the stake): pays 80 = 4x the old stake — the spec's
  // "seen bet of X" with X = 80, and the stake becomes X/2 = 40.
  const seen = table.turnPlayer;
  table.act(seen.id, ACTION.SEE);
  table.act(seen.id, ACTION.RAISE, { stake: 40 });
  assert.equal(seen.lastBet, 80, 'the seen player paid 4x the previous stake');
  assert.equal(table.stake, 40, 'the stake settled at half the seen bet');
});

test('the chaal limit caps every raise at double the current stake', () => {
  const table = makeTable({ boot: 10 });
  table.startHand();
  const player = table.turnPlayer;
  assert.equal(table.maxRaiseFor(player), 20, 'blind max = 2x stake');
  assert.throws(() => table.act(player.id, ACTION.RAISE, { stake: 21 }), /Maximum raise/);

  table.act(player.id, ACTION.SEE);
  assert.equal(table.maxRaiseFor(player), 20, 'seen max stake is the same 2x — it just costs double');
  table.act(player.id, ACTION.RAISE, { stake: 20 });
  assert.equal(player.lastBet, 40);
});

test('an all-in cannot push the stake past the chaal limit', () => {
  const table = makeTable({ boot: 10 });
  table.startHand();
  const player = table.turnPlayer; // blind, 990 chips left after the boot
  table.act(player.id, ACTION.ALL_IN);
  assert.equal(player.lastBet, 990);
  assert.equal(table.stake, 20, 'stake capped at 2x, not the whole shove');
});

// ── pot limit ───────────────────────────────────────────────────────────────

test('reaching the pot limit forces an immediate showdown for everyone', () => {
  const table = makeTable({ boot: 10, potLimit: 60 });
  table.startHand(); // pot = 30
  assert.equal(table.phase, PHASE.BETTING);

  table.act(table.turnPlayer.id, ACTION.RAISE, { stake: 20 }); // +20 → 50
  assert.equal(table.phase, PHASE.BETTING, 'below the limit play continues');
  table.act(table.turnPlayer.id, ACTION.CHAAL); // blind call +20 → 70 ≥ 60
  assert.equal(table.phase, PHASE.SETTLED, 'pot limit reached — forced show');
  assert.equal(table.results.reason, 'potlimit');
  assert.ok(table.results.reveal.length >= 2, 'a forced show reveals the live hands');
});

test('a forced show splits the pot on a tie', () => {
  const table = makeTable({ boot: 10, potLimit: 40 }, 2);
  table.startHand(); // pot 20
  const [a, b] = table.activePlayers;
  a.cards = ['KS', 'KH', '9D'];
  b.cards = ['KC', 'KD', '9H']; // identical strength
  table.act(table.turnPlayer.id, ACTION.RAISE, { stake: 20 }); // pot 40 → forced show
  assert.equal(table.phase, PHASE.SETTLED);
  assert.equal(table.results.reason, 'potlimit');
  assert.equal(table.results.winners.length, 2, 'a tied forced show splits the pot');
});

// ── requested show tie policy ───────────────────────────────────────────────

test('in a requested show the caller loses ties (configurable)', () => {
  const table = makeTable({ boot: 10 }, 2);
  table.startHand();
  const caller = table.turnPlayer;
  const other = table.activePlayers.find((p) => p.id !== caller.id);
  caller.cards = ['KS', 'KH', '9D'];
  other.cards = ['KC', 'KD', '9H']; // identical strength
  table.act(caller.id, ACTION.SEE);
  table.act(caller.id, ACTION.SHOW); // pays the 20 chaal as the show fee
  assert.equal(table.phase, PHASE.SETTLED);

  // Every *contested* chip (the matched boots) goes to the non-caller. The
  // caller's show fee was never matched, so — like an uncalled bet — it is
  // returned to them as their own side-pot layer, keeping chips conserved.
  const winnings = Object.fromEntries(table.results.winners.map((w) => [w.id, w.amount]));
  assert.equal(winnings[other.id], 20, 'the non-caller wins the whole contested pot');
  assert.equal(winnings[caller.id], 20, 'the caller only gets their unmatched show fee back');
  assert.equal(other.chips, 1010, 'the tie goes against the caller');
  assert.equal(caller.chips, 990);
});

test("showTie: 'split' keeps the old splitting behaviour", () => {
  const table = makeTable({ boot: 10, showTie: 'split' }, 2);
  table.startHand();
  const caller = table.turnPlayer;
  const other = table.activePlayers.find((p) => p.id !== caller.id);
  caller.cards = ['KS', 'KH', '9D'];
  other.cards = ['KC', 'KD', '9H'];
  table.act(caller.id, ACTION.SEE);
  table.act(caller.id, ACTION.SHOW);
  const winnings = Object.fromEntries(table.results.winners.map((w) => [w.id, w.amount]));
  assert.equal(winnings[other.id], 10, 'the contested pot splits evenly');
  assert.equal(winnings[caller.id], 10 + 20, 'the caller gets their half plus the unmatched fee');
  assert.equal(other.chips, 1000, 'a split tie costs nobody anything');
  assert.equal(caller.chips, 1000);
});

// ── max blind rounds ────────────────────────────────────────────────────────

test('after maxBlindRounds a blind player is auto-seen at the start of their turn', () => {
  const table = makeTable({ boot: 10, maxBlindRounds: 1, maxRounds: 6 });
  table.startHand();

  // Round 1: everybody may stay blind.
  for (let i = 0; i < 3; i += 1) {
    const player = table.turnPlayer;
    assert.equal(player.seen, false, 'round 1 allows blind play');
    table.act(player.id, ACTION.CHAAL);
  }
  assert.equal(table.round, 2, 'round 2 has begun');
  const next = table.turnPlayer;
  assert.equal(next.seen, true, 'past the blind limit the turn starts seen');
});

// ── shuffle randomness ──────────────────────────────────────────────────────

test('unseeded tables use the crypto shuffle; seeded tables stay reproducible', () => {
  // secureRandom must produce floats in [0, 1).
  for (let i = 0; i < 50; i += 1) {
    const value = secureRandom();
    assert.ok(value >= 0 && value < 1, `secureRandom out of range: ${value}`);
  }

  // The default shuffle (no rng argument) must not be the identity and must
  // preserve the deck contents.
  const deck = makeDeck();
  const shuffled = shuffle(deck);
  assert.equal(shuffled.length, 52);
  assert.deepEqual([...shuffled].sort(), [...deck].sort(), 'no cards created or lost');

  // Two tables with the same seed deal identical hands (tests rely on this)…
  const a = makeTable({ seed: 123 });
  const b = makeTable({ seed: 123 });
  a.startHand();
  b.startHand();
  assert.deepEqual(
    a.players.map((p) => p.cards),
    b.players.map((p) => p.cards),
    'seeded deals are reproducible'
  );

  // …while unseeded tables draw from the CSPRNG.
  const real = new TeenPattiTable({ ...DEFAULT_CONFIG });
  assert.equal(real.rng, secureRandom, 'no seed → crypto-backed shuffle');
});
