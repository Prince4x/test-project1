/**
 * Local profile, settings and lifetime statistics.
 * Everything lives in localStorage so a player keeps their identity, chips and
 * win-rate between sessions without any account system.
 */

const KEY = 'teen-patti-arena/v2';

const AVATARS = ['🐯', '🦋', '🦅', '🌸', '🐘', '🪔', '🐉', '🦚', '🦁', '🌙', '⚡', '💎', '🎯', '🔥', '🎲', '🐧', '🦊', '🌟'];

const DEFAULTS = {
  profile: {
    id: '',
    name: '',
    avatar: '🙂',
    createdAt: 0
  },
  settings: {
    sound: true,
    ambience: true,
    volume: 0.8,
    animations: 'normal',      // slow | normal | fast
    theme: 'dark',
    hints: true,               // show the "what should I do" helper
    autoRebuy: true,           // top bots up in practice mode
    practicePlayers: 4,
    practiceBoot: 10,
    practiceRounds: 4,
    practiceTimer: 25
  },
  stats: {
    hands: 0,
    wins: 0,
    folds: 0,
    net: 0,
    biggestPot: 0,
    bestHand: null,
    sessions: 0,
    startedAt: 0
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function randomId() {
  return `p-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

const TAB_KEY = 'teen-patti-arena/tab';

/**
 * Seat id for this browser *tab*.
 *
 * The persistent profile id lives in localStorage, but a seat must belong to a
 * tab: that way two tabs on the same PC — or two devices that happen to share a
 * browser profile — are two separate players instead of fighting over one seat.
 * sessionStorage survives a reload (so reconnecting keeps your seat) but is not
 * shared between tabs.
 */
function tabSeatId(baseId) {
  try {
    let suffix = sessionStorage.getItem(TAB_KEY);
    if (!suffix) {
      suffix = Math.random().toString(36).slice(2, 6);
      sessionStorage.setItem(TAB_KEY, suffix);
    }
    return `${baseId}-${suffix}`;
  } catch {
    return baseId;
  }
}

export function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    saved = {};
  }
  const state = {
    profile: { ...DEFAULTS.profile, ...(saved.profile || {}) },
    settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
    stats: { ...DEFAULTS.stats, ...(saved.stats || {}) }
  };
  if (!state.profile.id) state.profile.id = randomId();
  if (!state.profile.name) {
    const names = ['Ace', 'Rani', 'Badshah', 'Chhota', 'Pocket', 'Shah', 'Nawab', 'Rocket', 'Diamond', 'Tiger'];
    state.profile.name = `${names[Math.floor(Math.random() * names.length)]}${Math.floor(Math.random() * 90 + 10)}`;
  }
  if (!state.profile.createdAt) state.profile.createdAt = Date.now();
  state.profile.seatId = tabSeatId(state.profile.id);
  return state;
}

export class Store {
  constructor() {
    const state = loadState();
    this.profile = state.profile;
    /** Stable identity (stats, leaderboard) — local to this browser. */
    this.playerId = this.profile.seatId;
    this.settings = state.settings;
    this.stats = state.stats;
    this.listeners = new Set();
    this.save();
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        profile: this.profile,
        settings: this.settings,
        stats: this.stats
      }));
    } catch { /* private mode: keep going in memory */ }
    for (const listener of this.listeners) listener(this);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setProfile(patch) {
    Object.assign(this.profile, patch);
    // Seat id follows the identity but stays tab-scoped.
    if (patch.id) this.playerId = tabSeatId(patch.id);
    this.save();
  }

  setSetting(key, value) {
    this.settings[key] = value;
    this.save();
  }

  /** Fold one hand's outcome into the lifetime statistics. */
  recordHand({ won, amount, net, bestHand, folded, hands = 1 }) {
    this.stats.hands += hands;
    if (won) this.stats.wins += 1;
    if (folded) this.stats.folds += 1;
    if (typeof net === 'number') this.stats.net += net;
    if (amount && amount > this.stats.biggestPot) this.stats.biggestPot = amount;
    if (bestHand && (!this.stats.bestHand || bestHand.rank > this.stats.bestHand.rank)) {
      this.stats.bestHand = { name: bestHand.name, rank: bestHand.rank };
    }
    this.save();
  }

  get winRate() {
    return this.stats.hands ? Math.round((this.stats.wins / this.stats.hands) * 100) : 0;
  }

  resetStats() {
    this.stats = clone(DEFAULTS.stats);
    this.stats.startedAt = Date.now();
    this.save();
  }
}

export { AVATARS, DEFAULTS };
export default Store;
