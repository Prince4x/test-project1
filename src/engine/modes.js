/**
 * Game-mode registry: ONE rules engine, many configs.
 *
 * A mode is nothing but a bundle of table-config overrides (wild ranks,
 * reversed ranking, timers, limits…). The engine — evaluator + table — never
 * branches on a mode id, so new variants are data, not code.
 *
 * `potLimitBoots` / `bootMultiplier` are relative knobs resolved against the
 * table's boot by applyMode(), because the same mode must work at a 10-chip
 * friendly table and a 100-chip high roller.
 */

export const MODES = {
  classic: {
    id: 'classic',
    name: 'Classic',
    icon: '🃏',
    tagline: 'The original — no wilds, best hand wins.',
    howTo: [
      'Everyone posts the boot and gets three cards.',
      'Bet blind (1x the stake) or look and play chaal (2x the stake).',
      'Trail > Pure Sequence > Sequence > Colour > Pair > High Card.',
      'Last player standing, or the best hand at a show, takes the pot.'
    ],
    config: {}
  },
  joker: {
    id: 'joker',
    name: 'Joker',
    icon: '🤡',
    tagline: 'One card is revealed each hand — that rank is wild.',
    howTo: [
      'After the deal, one card from the deck is turned face up.',
      'Every card of that rank in any hand plays as a wild card.',
      'A wild card becomes whatever makes your hand strongest.',
      'Everything else is Classic Teen Patti.'
    ],
    config: { jokerReveal: true }
  },
  muflis: {
    id: 'muflis',
    name: 'Muflis',
    icon: '🙃',
    tagline: 'Lowball — the worst classic hand wins.',
    howTo: [
      'The ranking is fully reversed: the LOWEST hand wins the pot.',
      'The best possible hand is 5-3-2 of mixed suits.',
      'A trail of aces — the classic monster — is now the worst hand.',
      'Betting, side shows and shows all work exactly as in Classic.'
    ],
    config: { reversed: true }
  },
  ak47: {
    id: 'ak47',
    name: 'AK47',
    icon: '🔫',
    tagline: 'Every Ace, King, 4 and 7 is wild.',
    howTo: [
      'All Aces, Kings, Fours and Sevens play as wild cards.',
      'A wild card becomes whatever makes your hand strongest.',
      'With 16 wilds in the deck, big hands come fast — bet accordingly.',
      'Everything else is Classic Teen Patti.'
    ],
    config: { wildRanks: [14, 13, 4, 7] }
  },
  1942: {
    id: '1942',
    name: '1942',
    icon: '🎬',
    tagline: 'Every Ace, 9, 4 and 2 is wild.',
    howTo: [
      'All Aces, Nines, Fours and Twos play as wild cards.',
      'A wild card becomes whatever makes your hand strongest.',
      'Named after the film “1942: A Love Story”.',
      'Everything else is Classic Teen Patti.'
    ],
    config: { wildRanks: [14, 9, 4, 2] }
  },
  fast: {
    id: 'fast',
    name: 'Fast',
    icon: '⚡',
    tagline: 'Blink and you miss it — 8 second turns, capped pot.',
    howTo: [
      'Only 8 seconds to act — run out of time and you pack.',
      'The boot is doubled and the pot is capped at 40 boots.',
      'When the pot cap is reached everyone left shows immediately.',
      'Three betting rounds instead of four.'
    ],
    config: { turnSeconds: 8, maxRounds: 3, bootMultiplier: 2, potLimitBoots: 40 }
  }
};

export const MODE_IDS = ['classic', 'joker', 'muflis', 'ak47', '1942', 'fast'];

export function modeInfo(modeId) {
  return MODES[modeId] || MODES.classic;
}

/**
 * Resolve a mode into concrete table-config overrides.
 * @param {string} modeId
 * @param {{boot?: number}} base - the table's base boot, for relative knobs.
 * @returns {object} overrides to spread into the TeenPattiTable config.
 */
export function applyMode(modeId, { boot = 10 } = {}) {
  const mode = modeInfo(modeId);
  const { bootMultiplier, potLimitBoots, ...direct } = mode.config;
  const resolvedBoot = Math.max(1, Math.round(boot * (bootMultiplier || 1)));
  const overrides = { mode: mode.id, boot: resolvedBoot, ...direct };
  if (potLimitBoots) overrides.potLimit = resolvedBoot * potLimitBoots;
  return overrides;
}

export default { MODES, MODE_IDS, modeInfo, applyMode };
