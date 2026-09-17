/**
 * Teen Patti hand evaluation and comparison.
 *
 * Ranking order (highest first):
 *   1. Trail / Set      — three cards of the same rank (A-A-A is the best)
 *   2. Pure Sequence    — three consecutive cards of the same suit (A-K-Q best,
 *                         A-2-3 is the *lowest* pure sequence)
 *   3. Sequence / Run   — three consecutive cards, mixed suits
 *   4. Colour / Flush   — three cards of the same suit that are not consecutive
 *   5. Pair             — two cards of the same rank
 *   6. High Card        — none of the above
 *
 * Teen Patti is always played with three cards per player, so evaluation is
 * exhaustive and exact — there is never a "kicker" ambiguity beyond the
 * rank-ordered tie-breakers implemented below.
 */

import { parseCard, RANK_LABEL, SUIT_NAME, SUIT_LABEL } from './cards.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  COLOR: 2,
  SEQUENCE: 3,
  PURE_SEQUENCE: 4,
  TRAIL: 5
};

export const CATEGORY_NAME = {
  [CATEGORY.TRAIL]: 'Trail',
  [CATEGORY.PURE_SEQUENCE]: 'Pure Sequence',
  [CATEGORY.SEQUENCE]: 'Sequence',
  [CATEGORY.COLOR]: 'Colour',
  [CATEGORY.PAIR]: 'Pair',
  [CATEGORY.HIGH_CARD]: 'High Card'
};

/** Slightly longer, friendlier name used by the UI and hand history. */
export const CATEGORY_LABEL = {
  [CATEGORY.TRAIL]: 'Trail (three of a kind)',
  [CATEGORY.PURE_SEQUENCE]: 'Pure Sequence (straight flush)',
  [CATEGORY.SEQUENCE]: 'Sequence (straight)',
  [CATEGORY.COLOR]: 'Colour (flush)',
  [CATEGORY.PAIR]: 'Pair',
  [CATEGORY.HIGH_CARD]: 'High Card'
};

/**
 * Ordering used for the "hand rankings reference chart": index 0 is the
 * strongest hand. Kept here so the chart can never drift from the engine.
 */
export const RANKING_CHART = [
  CATEGORY.TRAIL,
  CATEGORY.PURE_SEQUENCE,
  CATEGORY.SEQUENCE,
  CATEGORY.COLOR,
  CATEGORY.PAIR,
  CATEGORY.HIGH_CARD
].map((category) => ({
  category,
  name: CATEGORY_NAME[category],
  fullName: CATEGORY_LABEL[category]
}));

function descRanks(cards) {
  return cards
    .map((card) => parseCard(card).rank)
    .sort((a, b) => b - a);
}

/**
 * Sequence detection. Returns the rank value used for comparisons:
 *   - A-K-Q  -> 14 (highest run)
 *   - A-2-3  -> 3  (lowest run, the ace plays low)
 *   - otherwise -> the highest card of the run
 * Returns 0 when the cards are not consecutive.
 */
export function sequenceHigh(ranks) {
  const [a, b, c] = ranks;
  if (a === 14 && b === 13 && c === 12) return 14;             // A K Q
  if (a === 14 && b === 3 && c === 2) return 3;                // A 3 2 -> play the 3 high
  if (a === b + 1 && b === c + 1) return a;
  return 0;
}

/**
 * Evaluate three cards.
 * @returns {{cards: string[], ranks: number[], category: number, tiebreak: number[],
 *            key: number[], name: string, label: string, high: number}}
 */
export function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error(`Teen Patti hands are exactly 3 cards (received ${cards?.length})`);
  }
  const parsed = cards.map(parseCard);
  const ranks = descRanks(cards);
  const suits = parsed.map((card) => card.suit);
  const sameSuit = suits[0] === suits[1] && suits[1] === suits[2];

  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);

  // Sort groups by count first, then by rank so pair kickers order correctly.
  const groups = [...counts.entries()].sort((x, y) => (y[1] - x[1]) || (y[0] - x[0]));
  const run = sequenceHigh(ranks);
  const isTrail = groups[0][1] === 3;

  let category;
  if (isTrail) category = CATEGORY.TRAIL;
  else if (run && sameSuit) category = CATEGORY.PURE_SEQUENCE;
  else if (run) category = CATEGORY.SEQUENCE;
  else if (sameSuit) category = CATEGORY.COLOR;
  else if (groups[0][1] === 2) category = CATEGORY.PAIR;
  else category = CATEGORY.HIGH_CARD;

  let tiebreak;
  switch (category) {
    case CATEGORY.TRAIL:
      tiebreak = [groups[0][0]];
      break;
    case CATEGORY.PURE_SEQUENCE:
    case CATEGORY.SEQUENCE:
      // Compare runs by their high card (ace-low runs lose to every other run).
      tiebreak = [run];
      break;
    case CATEGORY.COLOR:
    case CATEGORY.HIGH_CARD:
      tiebreak = ranks.slice();
      break;
    case CATEGORY.PAIR:
      tiebreak = [groups[0][0], groups[1][0]];
      break;
    default:
      tiebreak = ranks.slice();
  }

  const result = {
    cards: cards.slice(),
    ranks,
    suits,
    category,
    tiebreak,
    key: [category, ...tiebreak],
    name: CATEGORY_NAME[category],
    label: CATEGORY_LABEL[category],
    high: ranks[0],
    sameSuit,
    run
  };
  result.text = describe(result);
  return result;
}

function rankText(rank) {
  return RANK_LABEL[rank];
}

export function describe(evaluation) {
  const { category, ranks, suits, tiebreak } = evaluation;
  const suit = SUIT_LABEL[suits[0]];
  switch (category) {
    case CATEGORY.TRAIL:
      return `Trail of ${rankText(tiebreak[0])}s`;
    case CATEGORY.PURE_SEQUENCE:
      return `Pure Sequence ${runText(tiebreak[0])} of ${SUIT_NAME[suits[0]]}`;
    case CATEGORY.SEQUENCE:
      return `Sequence ${runText(tiebreak[0])}`;
    case CATEGORY.COLOR:
      return `Colour ${suits.map((s) => SUIT_LABEL[s]).join('')} high ${rankText(ranks[0])}`;
    case CATEGORY.PAIR:
      return `Pair of ${rankText(tiebreak[0])}s, kicker ${rankText(tiebreak[1])}`;
    default:
      return `High card ${rankText(ranks[0])} (${suit} high)`;
  }
}

function runText(high) {
  if (high === 3) return 'A-2-3';
  return `${rankText(high - 2)}-${rankText(high - 1)}-${rankText(high)}`;
}

/** Lexicographic comparison of two evaluation keys. */
export function compareKeys(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] ?? -1;
    const right = b[i] ?? -1;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/**
 * Compare two hands (arrays of 3 cards, or pre-computed evaluations).
 * @returns {number} 1 when a wins, -1 when b wins, 0 on an exact tie.
 */
export function compareHands(a, b) {
  const evalA = Array.isArray(a) ? evaluate(a) : a;
  const evalB = Array.isArray(b) ? evaluate(b) : b;
  return compareKeys(evalA.key, evalB.key);
}

/** The strongest hand in a list of {hand, ...} entries. */
export function bestOf(entries) {
  let best = null;
  for (const entry of entries) {
    const evaluation = Array.isArray(entry.cards) ? evaluate(entry.cards) : entry.evaluation;
    if (!best || compareKeys(evaluation.key, best.evaluation.key) > 0) {
      best = { ...entry, evaluation };
    }
  }
  return best;
}

/**
 * Normalised 0..1 strength used by the AI. Not a probability — an ordinal
 * score that keeps relative spacing between categories sensible for betting.
 */
export function handStrength(evaluation) {
  const [top, second, third] = evaluation.tiebreak;
  const kicker = (evalObj, index) => (evalObj.tiebreak[index] ?? 0) / 14;
  switch (evaluation.category) {
    case CATEGORY.TRAIL:
      return 0.94 + 0.06 * kicker(evaluation, 0);
    case CATEGORY.PURE_SEQUENCE:
      return 0.86 + 0.06 * ((top - 3) / 11);
    case CATEGORY.SEQUENCE:
      return 0.72 + 0.10 * ((top - 3) / 11);
    case CATEGORY.COLOR: {
      const high = (evaluation.tiebreak[0] - 2) / 12;
      const mid = (evaluation.tiebreak[1] - 2) / 12;
      return 0.47 + 0.19 * (0.65 * high + 0.35 * mid);
    }
    case CATEGORY.PAIR: {
      const pair = (top - 2) / 12;
      const kick = (second - 2) / 12;
      return 0.20 + 0.26 * (0.8 * pair + 0.2 * kick);
    }
    default: {
      const high = (top - 2) / 12;
      const mid = (second - 2) / 12;
      const low = (third - 2) / 12;
      return 0.02 + 0.18 * (0.58 * high + 0.28 * mid + 0.14 * low);
    }
  }
}
