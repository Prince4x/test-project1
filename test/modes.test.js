/**
 * Phase 2: game modes — one rules engine driven by mode configs.
 *
 *  - Wild cards (Joker / AK47 / 1942): every substitution is tried and the
 *    best hand under the current ranking is kept.
 *  - Muflis: the ranking is fully reversed via key negation, so showdown,
 *    side shows, side pots and the AI are mode-aware without extra branches.
 *  - The mode registry resolves to plain table-config overrides.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareHands, handStrength, CATEGORY } from '../src/engine/evaluator.js';
import { TeenPattiTable, PHASE, ACTION, DEFAULT_CONFIG } from '../src/engine/table.js';
import { MODES, MODE_IDS, modeInfo, applyMode } from '../src/engine/modes.js';
import { decideAction } from '../src/engine/ai.js';
import { parseCard } from '../src/engine/cards.js';

function makeTable(options = {}, playerCount = 3) {
  const table = new TeenPattiTable({
    ...DEFAULT_CONFIG,
    seed: 42,
    turnSeconds: 30,
    ...options
  });
  for (let i = 0; i < playerCount; i += 1) {
    table.addPlayer({ id: `p${i + 1}`, name: `P${i + 1}`, chips: 1000 });
  }
  return table;
}

// ── wild cards ──────────────────────────────────────────────────────────────

test('a wild card becomes whatever makes the hand strongest', () => {
  const rules = { wildRanks: [7] };

  // Pair + wild → trail
  let hand = evaluate(['KS', 'KH', '7D'], rules);
  assert.equal(hand.category, CATEGORY.TRAIL, 'pair plus wild upgrades to a trail');
  assert.equal(hand.wildCount, 1);
  assert.deepEqual(hand.cards, ['KS', 'KH', '7D'], 'the original cards are preserved');

  // Two suited connectors + wild → pure sequence
  hand = evaluate(['QS', 'JS', '7H'], rules);
  assert.equal(hand.category, CATEGORY.PURE_SEQUENCE, 'the wild completes the straight flush');

  // Wild alone with junk still makes at least a pair
  hand = evaluate(['AS', '9H', '7D'], rules);
  assert.ok(hand.category >= CATEGORY.PAIR, 'a wild always pairs the best card');

  // Text marks the wilds so players understand the upgrade
  assert.match(evaluate(['KS', 'KH', '7D'], rules).text, /wild/);
});

test('AK47 and 1942 wild ranks resolve from the registry', () => {
  assert.deepEqual(applyMode('ak47').wildRanks, [14, 13, 4, 7]);
  assert.deepEqual(applyMode('1942').wildRanks, [14, 9, 4, 2]);

  // In AK47 a hand of A-K-4 is three wilds → best possible trail.
  const hand = evaluate(['AS', 'KH', '4D'], { wildRanks: applyMode('ak47').wildRanks });
  assert.equal(hand.category, CATEGORY.TRAIL);
  assert.equal(hand.tiebreak[0], 14, 'three wilds become a trail of aces');
});

test('wild hands compare correctly against natural hands', () => {
  const rules = { wildRanks: [2] };
  const wildTrail = evaluate(['KS', 'KH', '2D'], rules);   // K-K-wild → trail of kings
  const naturalPair = evaluate(['AS', 'AH', '9D'], rules); // pair of aces
  assert.equal(compareHands(wildTrail, naturalPair), 1, 'the upgraded trail beats a natural pair of aces');
});

// ── muflis ──────────────────────────────────────────────────────────────────

test('muflis fully reverses the ranking', () => {
  const muflis = { reversed: true };
  const best = evaluate(['5H', '3S', '2C'], muflis);   // the nuts in muflis
  const trailAces = evaluate(['AS', 'AH', 'AD'], muflis); // the worst hand
  const pair = evaluate(['9S', '9H', '4D'], muflis);

  assert.equal(compareHands(best, trailAces), 1, '5-3-2 mixed beats a trail of aces');
  assert.equal(compareHands(best, pair), 1, 'high card beats a pair in muflis');
  assert.equal(compareHands(pair, trailAces), 1, 'even a pair beats a trail');

  // Lower high cards win among high cards.
  const low = evaluate(['7H', '4S', '2C'], muflis);
  const high = evaluate(['AH', 'KS', '9C'], muflis);
  assert.equal(compareHands(low, high), 1, 'the lower high card wins');

  // handStrength flips so the AI values muflis hands correctly.
  assert.ok(handStrength(best) > 0.8, `5-3-2 must look strong to the AI (${handStrength(best)})`);
  assert.ok(handStrength(trailAces) < 0.1, `A-A-A must look terrible (${handStrength(trailAces)})`);
});

test('in muflis a wild card MINIMIZES the hand', () => {
  const rules = { reversed: true, wildRanks: [9] };
  const hand = evaluate(['7H', '4S', '9C'], rules);
  assert.equal(hand.category, CATEGORY.HIGH_CARD, 'the wild avoids pairs and runs');
  const effectiveRanks = hand.effectiveCards.map((card) => parseCard(card).rank).sort((a, b) => a - b);
  assert.equal(effectiveRanks[0], 2, 'the wild turns into the lowest useful card');
});

test('a muflis showdown pays the lowest classic hand', () => {
  const table = makeTable({ ...applyMode('muflis'), maxRounds: 1 }, 2);
  table.startHand();
  const [a, b] = table.activePlayers;
  a.cards = ['5H', '3S', '2C'];   // muflis nuts
  b.cards = ['AS', 'AH', 'AD'];   // muflis disaster
  table.act(table.turnPlayer.id, ACTION.CHAAL);
  table.act(table.turnPlayer.id, ACTION.CHAAL);
  assert.equal(table.phase, PHASE.SETTLED);
  assert.equal(table.results.winners[0].id, a.id, 'the low hand takes the pot');
  assert.equal(table.results.rankings[0].id, a.id, 'rankings are mode-aware too');
});

// ── joker mode ──────────────────────────────────────────────────────────────

test('joker mode reveals one card per hand and makes its rank wild', () => {
  const table = makeTable({ ...applyMode('joker'), seed: 9 });
  table.startHand();

  assert.ok(table.jokerCard, 'a joker card is revealed');
  const rank = parseCard(table.jokerCard).rank;
  assert.deepEqual(table.rules.wildRanks, [rank], 'exactly that rank is wild');

  const events = table.events.filter((event) => event.type === 'joker');
  assert.equal(events.length, 1, 'the reveal is announced');
  assert.equal(events[0].card, table.jokerCard);
  const handStart = table.events.find((event) => event.type === 'hand:start');
  assert.equal(handStart.joker, table.jokerCard, 'hand:start carries the joker');

  const snapshot = table.serialize();
  assert.equal(snapshot.mode.jokerCard, table.jokerCard);
  assert.deepEqual(snapshot.mode.wildRanks, [rank]);

  // The joker changes from hand to hand (with enough hands it must differ).
  const seen = new Set([table.jokerCard]);
  for (let i = 0; i < 6; i += 1) {
    table.showdown('fold');
    table.startHand();
    seen.add(table.jokerCard);
  }
  assert.ok(seen.size > 1, `different hands reveal different jokers (${[...seen].join(' ')})`);
});

test('the joker card is never in anybody’s hand', () => {
  const table = makeTable({ ...applyMode('joker'), seed: 11 }, 6);
  for (let handNo = 0; handNo < 5; handNo += 1) {
    table.startHand();
    for (const player of table.players) {
      assert.ok(!player.cards.includes(table.jokerCard), 'the revealed card was dealt from the remaining deck');
    }
    table.showdown('fold');
  }
});

// ── mode registry ───────────────────────────────────────────────────────────

test('every registered mode resolves to a clean config', () => {
  for (const id of MODE_IDS) {
    const mode = modeInfo(id);
    assert.equal(mode.id, id);
    assert.ok(mode.name && mode.tagline && mode.howTo.length >= 3, `${id} documents itself`);
    const config = applyMode(id, { boot: 10 });
    assert.equal(config.mode, id);
    assert.ok(config.boot >= 10, 'boot resolves against the base');
    // The overrides must be accepted by the table without throwing.
    const table = new TeenPattiTable({ ...DEFAULT_CONFIG, ...config, seed: 1 });
    assert.equal(table.config.mode, id);
  }
});

test('fast mode: short clock, doubled boot, capped pot', () => {
  const config = applyMode('fast', { boot: 10 });
  assert.equal(config.turnSeconds, 8);
  assert.equal(config.boot, 20);
  assert.equal(config.potLimit, 800, '40 boots at the doubled boot');
  assert.equal(config.maxRounds, 3);
});

// ── the AI copes with every mode ────────────────────────────────────────────

test('bots make legal decisions under wilds and muflis', () => {
  for (const rules of [
    { wildRanks: [14, 13, 4, 7] },
    { reversed: true },
    { reversed: true, wildRanks: [9] }
  ]) {
    for (let i = 0; i < 20; i += 1) {
      const decision = decideAction({
        cards: ['KS', '9H', '4D'],
        seen: true,
        chips: 500,
        costToCall: 20,
        blindCost: 10,
        pot: 60,
        stake: 10,
        activePlayers: 3,
        round: 1,
        maxRounds: 4,
        minRaise: 11,
        maxRaise: 20,
        canShow: false,
        canSideShow: false,
        personality: 'balanced',
        rules,
        rng: Math.random
      });
      assert.ok(['pack', 'chaal', 'raise', 'allin', 'see', 'show', 'sideshow', 'check'].includes(decision.action),
        `sane action under ${JSON.stringify(rules)}: ${decision.action}`);
    }
  }
});
