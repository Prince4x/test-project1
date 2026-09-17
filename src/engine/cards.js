/**
 * Card primitives shared by the server and the browser.
 *
 * A card is a 2-3 character string: rank + suit, e.g. "AS" (ace of spades),
 * "10H" (ten of hearts). Keeping cards as strings makes network payloads tiny
 * and JSON friendly, and parseCard() is cheap enough for gameplay use.
 */

export const SUITS = ['S', 'H', 'D', 'C'];

export const SUIT_LABEL = {
  S: '\u2660', // ♠
  H: '\u2665', // ♥
  D: '\u2666', // ♦
  C: '\u2663'  // ♣
};

export const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

export const RANK_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

export const RANK_NAME = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace'
};

export const RANK_VALUE = Object.fromEntries(
  Object.entries(RANK_LABEL).map(([value, label]) => [label, Number(value)])
);

/** Build the card id from a numeric rank (2..14) and a suit letter. */
export function makeCard(rank, suit) {
  return `${RANK_LABEL[rank]}${suit}`;
}

/** Split a card id into { rank, suit, id }. */
export function parseCard(card) {
  const suit = card.slice(-1).toUpperCase();
  const rank = RANK_VALUE[card.slice(0, -1).toUpperCase()];
  if (!rank || !SUITS.includes(suit)) throw new Error(`Invalid card: ${card}`);
  return { id: `${RANK_LABEL[rank]}${suit}`, rank, suit };
}

/** A fresh, ordered 52 card deck. */
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank += 1) deck.push(makeCard(rank, suit));
  }
  return deck;
}

/**
 * xorshift128 PRNG — deterministic when seeded, which the test-suite relies on.
 * Returns a function producing floats in [0, 1).
 */
export function createRng(seed = Date.now()) {
  let a = (seed >>> 0) || 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = 0xdeadbeef;
  return function next() {
    const t = a ^ (a << 11);
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19)) ^ (t ^ (t >>> 8));
    return (d >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle. Pass a seeded rng for reproducible deals. */
export function shuffle(cards, rng = Math.random) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export function cardLabel(card) {
  const { rank, suit } = parseCard(card);
  return `${RANK_LABEL[rank]}${SUIT_LABEL[suit]}`;
}
