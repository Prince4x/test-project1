/**
 * Practice-mode AI.
 *
 * The bot plays the same information set as a human: it only ever sees its own
 * cards, the public stake/pot and how many players are still live. Decisions
 * combine a Monte-Carlo win-rate estimate with a personality profile so the
 * four archetypes play noticeably differently.
 */

import { makeDeck, shuffle, createRng } from './cards.js';
import { evaluate, compareKeys, handStrength } from './evaluator.js';

export const PERSONALITIES = {
  rock: {
    label: 'Rock',
    blurb: 'Tight and patient — only plays strong hands.',
    aggression: 0.18,
    looseness: 0.24,
    bluff: 0.03,
    blindRounds: 1,
    sideShow: 0.45
  },
  balanced: {
    label: 'Balanced',
    blurb: 'Solid all-round play.',
    aggression: 0.38,
    looseness: 0.42,
    bluff: 0.10,
    blindRounds: 2,
    sideShow: 0.35
  },
  shark: {
    label: 'Shark',
    blurb: 'Calculated — punishes weakness, picks its spots.',
    aggression: 0.52,
    looseness: 0.46,
    bluff: 0.18,
    blindRounds: 2,
    sideShow: 0.5
  },
  maniac: {
    label: 'Maniac',
    blurb: 'Loose and loud — raises first, thinks later.',
    aggression: 0.78,
    looseness: 0.72,
    bluff: 0.3,
    blindRounds: 3,
    sideShow: 0.3
  }
};

export const BOT_NAMES = [
  ['Ravi', '🐯'], ['Priya', '🦋'], ['Arjun', '🦅'], ['Meera', '🌸'],
  ['Vikram', '🐘'], ['Anjali', '🪔'], ['Dev', '🐉'], ['Kavya', '🦚'],
  ['Rohan', '🦁'], ['Sana', '🌙'], ['Kabir', '⚡'], ['Nisha', '💎']
];

export function randomBotIdentity(rng = Math.random, exclude = new Set()) {
  const pool = BOT_NAMES.filter(([name]) => !exclude.has(name));
  const list = pool.length ? pool : BOT_NAMES;
  const [name, avatar] = list[Math.floor(rng() * list.length)];
  return { name, avatar, personality: randomPersonality(rng) };
}

export function randomPersonality(rng = Math.random) {
  const keys = Object.keys(PERSONALITIES);
  return keys[Math.floor(rng() * keys.length)];
}

/**
 * Monte-Carlo equity: deal random hands to `opponents` and count how often we
 * hold the best hand. Cheap enough (a few hundred 3-card evaluations) to run on
 * every decision.
 */
export function estimateWinRate(cards, opponents, rng = Math.random, trials = 36) {
  if (opponents <= 0) return 1;
  const mine = evaluate(cards);
  const deck = makeDeck().filter((card) => !cards.includes(card));
  let wins = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const shuffled = shuffle(deck, rng);
    let best = true;
    for (let i = 0; i < opponents && best; i += 1) {
      const hand = [shuffled[i * 3], shuffled[i * 3 + 1], shuffled[i * 3 + 2]];
      if (compareKeys(evaluate(hand).key, mine.key) >= 0) best = false;
    }
    if (best) wins += 1;
  }
  return wins / trials;
}

/**
 * Decide what a bot does on its turn.
 * @param {object} view - public + private information for this decision.
 * @returns {{action: string, stake?: number, seen?: boolean, note?: string}}
 */
export function decideAction(view) {
  const rng = view.rng || Math.random;
  const profile = PERSONALITIES[view.personality] || PERSONALITIES.balanced;
  const {
    seen, chips, costToCall, pot, stake, activePlayers, round, maxRounds,
    minRaise, maxRaise, canShow, canSideShow, blindCost
  } = view;

  const noise = () => (rng() * 2 - 1) * 0.12;
  const canRaise = maxRaise >= minRaise;

  // ── Blind decisions ──────────────────────────────────────────────────────
  if (!seen) {
    const blindTurn = blindCost;
    const stayBlind = round <= profile.blindRounds && rng() < 0.62 && chips > blindTurn * 3;
    if (!stayBlind) return { action: 'see', note: 'looks at their cards' };

    const cheap = blindTurn <= Math.max(4, pot * 0.12);
    if (cheap && canRaise && rng() < profile.aggression * 0.5) {
      const target = Math.min(maxRaise, Math.max(minRaise, Math.round(minRaise * (1 + profile.aggression))));
      return { action: 'raise', stake: target, note: 'raises blind' };
    }
    if (chips <= blindTurn) return { action: 'allin', note: 'shoves blind' };
    if (cheap || rng() < profile.looseness * 0.5) return { action: 'blind', note: 'plays blind' };
    return { action: 'see' };
  }

  // ── Seen decisions ───────────────────────────────────────────────────────
  const equity = view.equity ?? estimateWinRate(view.cards, Math.max(1, activePlayers - 1), rng);
  const strength = handStrength(evaluate(view.cards));
  const score = Math.min(1, Math.max(0, equity * 0.62 + strength * 0.38 + noise()));
  const potOdds = costToCall / Math.max(1, pot + costToCall);
  const pressure = costToCall / Math.max(1, chips);
  const lateRound = round >= maxRounds;

  // Compulsory show coming up: a mediocre hand is not worth another round.
  const showDownSoon = lateRound && score < 0.45;

  // Heads-up with a monster: call a show and take the pot.
  if (canShow && score > 0.72 && rng() < 0.55 + profile.aggression * 0.2) {
    return { action: 'show', note: 'calls a show' };
  }

  // Ask for a side show when we hold a strong hand against a live neighbour.
  if (canSideShow && score > 0.7 && rng() < profile.sideShow) {
    return { action: 'sideshow', note: 'wants a side show' };
  }

  // Fold when the maths does not work, or when we are clearly beaten.
  const foldThreshold = 0.26 + potOdds * 0.5 - profile.looseness * 0.12;
  if ((showDownSoon && score < 0.4) || (score < foldThreshold && pressure > 0.05 && rng() < 0.82)) {
    return { action: 'pack', note: 'packs' };
  }

  // All-in decisions: shove with premium hands, call off when committed.
  if (chips <= costToCall) {
    if (score > 0.5 || potOdds < 0.2) return { action: 'allin', note: 'commits the stack' };
    return { action: 'pack', note: 'packs rather than bust' };
  }

  // Raising.
  const raiseAppetite = profile.aggression + (score - 0.5) * 1.3 + (score > 0.75 ? 0.25 : 0);
  const isBluff = score < 0.4 && rng() < profile.bluff;
  if (canRaise && (rng() < raiseAppetite || isBluff) && pressure < 0.55) {
    const step = Math.max(minRaise - stake, 1);
    const aggressionScale = isBluff ? 1 : 1 + (score - 0.5) * 2.2;
    const wanted = Math.round(stake + step * Math.max(1, aggressionScale * (0.8 + rng() * 1.2)));
    const target = Math.max(minRaise, Math.min(maxRaise, wanted));
    if (target >= minRaise) return { action: 'raise', stake: target, note: isBluff ? 'raises (bluff)' : 'raises' };
  }

  // Otherwise chaal.
  if (costToCall === 0) return { action: 'check', note: 'checks' };
  return { action: 'chaal', note: 'chaals' };
}

/** Convenience wrapper used by the practice-mode controller. */
export function botTurn(view) {
  const decision = decideAction(view);
  if (!decision.action) return { action: 'chaal' };
  return decision;
}

export default { decideAction, estimateWinRate, PERSONALITIES, botTurn, createRng };
