import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  compareHands,
  sequenceHigh,
  CATEGORY,
  CATEGORY_NAME,
  handStrength
} from '../src/engine/evaluator.js';

test('identifies every hand category', () => {
  assert.equal(evaluate(['AS', 'AH', 'AD']).category, CATEGORY.TRAIL);
  assert.equal(evaluate(['KS', 'QS', 'JS']).category, CATEGORY.PURE_SEQUENCE);
  assert.equal(evaluate(['KS', 'QH', 'JD']).category, CATEGORY.SEQUENCE);
  assert.equal(evaluate(['KS', 'QH', 'JC']).category, CATEGORY.SEQUENCE);
  assert.equal(evaluate(['KS', '9S', '4S']).category, CATEGORY.COLOR);
  assert.equal(evaluate(['KS', 'KH', '3D']).category, CATEGORY.PAIR);
  assert.equal(evaluate(['KS', '9H', '4D']).category, CATEGORY.HIGH_CARD);
  assert.equal(CATEGORY_NAME[CATEGORY.TRAIL], 'Trail');
});

test('category order is Trail > Pure Sequence > Sequence > Colour > Pair > High Card', () => {
  // Sorted ascending by strength: the result must run weakest -> strongest.
  const hands = [
    ['AH', 'KD', '9C'], // high card
    ['7S', '7H', '2D'], // pair
    ['AC', 'QC', '2C'], // colour
    ['AH', 'KH', 'QD'], // sequence
    ['AS', 'KS', 'QS'], // pure sequence
    ['2S', '2H', '2D']  // trail
  ];
  const sortedNames = [...hands].sort(compareHands).map((hand) => evaluate(hand).name);
  assert.deepEqual(sortedNames, ['High Card', 'Pair', 'Colour', 'Sequence', 'Pure Sequence', 'Trail']);

  // Explicit pairwise assertions (the part that actually matters)
  assert.equal(compareHands(['2S', '2H', '2D'], ['AS', 'KS', 'QS']), 1, 'trail beats pure sequence');
  assert.equal(compareHands(['AS', 'KS', 'QS'], ['AH', 'KH', 'QD']), 1, 'pure sequence beats sequence');
  assert.equal(compareHands(['AH', 'KH', 'QD'], ['AC', 'QC', '2C']), 1, 'sequence beats colour');
  assert.equal(compareHands(['AC', 'QC', '2C'], ['7S', '7H', '2D']), 1, 'colour beats pair');
  assert.equal(compareHands(['7S', '7H', '2D'], ['AH', 'KD', '9C']), 1, 'pair beats high card');
});

test('trails compare by rank', () => {
  assert.equal(compareHands(['AS', 'AH', 'AD'], ['KS', 'KH', 'KD']), 1);
  assert.equal(compareHands(['2S', '2H', '2D'], ['AS', 'AH', 'AD']), -1);
});

test('A-2-3 is the lowest pure sequence and A-K-Q the highest', () => {
  assert.equal(sequenceHigh([14, 3, 2]), 3);
  assert.equal(sequenceHigh([14, 13, 12]), 14);
  assert.equal(sequenceHigh([7, 6, 5]), 7);
  assert.equal(sequenceHigh([14, 5, 4]), 0, 'A-5-4 is not a run');

  const best = ['AS', 'KS', 'QS'];
  assert.equal(compareHands(best, ['4H', '3H', '2H']), 1, 'A-K-Q beats 4-3-2');
  assert.equal(compareHands(['4H', '3H', '2H'], ['AS', '3S', '2S']), 1, 'any run beats A-2-3');
  assert.equal(compareHands(['AH', '3H', '2H'], ['4C', '3C', '2C']), -1, 'A-2-3 loses to 4-3-2');
});

test('pairs are decided by pair rank, then kicker', () => {
  assert.equal(compareHands(['KS', 'KH', '2D'], ['QS', 'QH', 'AD']), 1, 'bigger pair wins');
  assert.equal(compareHands(['KS', 'KH', 'AD'], ['KC', 'KD', '2H']), 1, 'kicker decides equal pairs');
  assert.equal(compareHands(['KS', 'KH', '9D'], ['KC', 'KD', '9H']), 0, 'identical hands tie');
});

test('colours and high cards compare down to the third card', () => {
  assert.equal(compareHands(['AS', '9S', '4S'], ['AH', '9H', '3H']), 1, 'third card settles colours');
  assert.equal(compareHands(['AH', 'KD', '9C'], ['AC', 'KH', '9S']), 0, 'same ranks tie');
  assert.equal(compareHands(['AH', 'KD', '8C'], ['AC', 'KH', '9S']), -1);
});

test('a colour is never a sequence, and a run of one suit is a pure sequence', () => {
  const colour = evaluate(['AS', 'QS', '2S']);
  assert.equal(colour.category, CATEGORY.COLOR);
  const run = evaluate(['AS', 'KS', 'QS']);
  assert.equal(run.category, CATEGORY.PURE_SEQUENCE);
  assert.equal(run.sameSuit, true);
});

test('handStrength is monotonic across categories', () => {
  const points = [
    ['7S', '2H', '9D'], // high card
    ['7S', '7H', '2D'], // pair
    ['AS', '3S', '2S'].includes('AS') ? ['AC', 'QC', '2C'] : [], // colour
    ['AH', 'KH', 'QD'], // sequence
    ['AS', 'KS', 'QS'], // pure sequence
    ['2S', '2H', '2D']  // trail
  ].map((hand) => handStrength(evaluate(hand)));
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i] > points[i - 1], `strength ${i} should beat ${i - 1} (${points.join(', ')})`);
  }
});

test('evaluate rejects malformed hands', () => {
  assert.throws(() => evaluate(['AS', 'AH']), /3 cards/);
  assert.throws(() => evaluate(['1S', 'AH', 'AD']), /Invalid card/);
});
