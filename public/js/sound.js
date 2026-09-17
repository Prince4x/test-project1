/**
 * SoundBoard — every sound in the game, synthesised with the Web Audio API.
 *
 * No audio files: oscillators, noise buffers and filters build the casino
 * atmosphere (room tone, chip clinks, card flicks, winning fanfares) at runtime.
 *
 * Three rules this module exists to solve:
 *  1. Browsers refuse to make noise before a user gesture → `unlock()`.
 *  2. Sound must never be an annoyance → master volume, an ambience switch and
 *     a "test sound" button, all persisted in settings.
 *  3. It must degrade silently → if Web Audio is missing, every call is a no-op.
 */

const VOLUMES = {
  master: 0.8,
  sfx: 1,
  ambience: 0.5
};

export class SoundBoard {
  constructor({ enabled = true, ambience = true, volume = VOLUMES.master, speed = 1 } = {}) {
    this.enabled = enabled;
    this.ambienceEnabled = ambience;
    this.volume = volume;
    this.speed = speed;
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.ambienceBus = null;
    this.ambienceNodes = null;
    this.clinkTimer = null;
    this.unlocked = false;
    this.alive = true;
    /** Every scheduled cue, so leaving a table can silence the tail cleanly. */
    this.timers = new Set();
    this.listeners = new Set();
  }

  /**
   * setTimeout that is tracked (and therefore cancellable) and never fires once
   * the board has been destroyed. Without this, a coin shower scheduled on the
   * winning hand could fire after the player left the table.
   */
  later(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.alive) return;
      try {
        fn();
      } catch { /* audio must never break the game */ }
    }, ms);
    this.timers.add(id);
    return id;
  }

  /** Cancel queued cues (used when leaving a table / tearing down the view). */
  stopPending() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  /** Release the audio graph entirely. */
  destroy() {
    this.alive = false;
    this.stopPending();
    this.stopAmbience();
    try {
      this.ctx?.close();
    } catch { /* already closed */ }
    this.ctx = null;
    this.master = null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Create the audio graph (safe to call repeatedly). */
  ensure() {
    if (!this.alive) return null;
    if (this.ctx) return this.ctx;
    const Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = VOLUMES.sfx;
    this.sfxBus.connect(this.master);

    this.ambienceBus = this.ctx.createGain();
    this.ambienceBus.gain.value = 0;   // faded in by startAmbience()
    this.ambienceBus.connect(this.master);

    return this.ctx;
  }

  /**
   * Must be called from inside a user gesture. Also the single place where
   * "sound is available" is decided, so the UI can prompt when it is not.
   */
  unlock() {
    const ctx = this.ensure();
    if (!ctx) {
      this.setAvailable(false);
      return false;
    }
    if (ctx.state === 'suspended') ctx.resume();
    this.unlocked = ctx.state !== 'suspended';
    this.setAvailable(true);
    if (this.enabled && this.ambienceEnabled) this.startAmbience();
    return true;
  }

  /** Alias kept for readability at call sites that just want audio running. */
  resume() {
    return this.unlock();
  }

  setAvailable(available) {
    if (this.available === available) return;
    this.available = available;
    for (const listener of this.listeners) listener({ available });
  }

  onAvailability(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state() {
    return {
      available: Boolean(this.ctx) && this.ctx.state === 'running',
      enabled: this.enabled,
      ambience: this.ambienceEnabled,
      volume: this.volume
    };
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.master) {
      this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.02);
    }
    if (!this.enabled && this.ambienceNodes) this.stopAmbience();
    if (this.enabled && this.ambienceEnabled && this.ctx?.state === 'running') this.startAmbience();
  }

  setVolume(volume) {
    this.volume = Math.min(1, Math.max(0, Number(volume) || 0));
    if (this.master && this.enabled) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
    }
  }

  setAmbience(enabled) {
    this.ambienceEnabled = Boolean(enabled);
    if (this.ambienceEnabled && this.enabled) this.startAmbience();
    else this.stopAmbience();
  }

  /** Animation speed also stretches or shortens the audio cues. */
  setSpeed(speed = 1) {
    this.speed = speed || 1;
  }

  // ── primitives ──────────────────────────────────────────────────────────

  tone({ freq = 440, type = 'sine', duration = 0.12, gain = 0.16, delay = 0, sweep = null, bus = 'sfx' }) {
    if (!this.enabled || !this.alive) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state === 'suspended') return;
    const start = ctx.currentTime + delay * this.speed;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), start + duration * this.speed);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration * this.speed);
    osc.connect(env).connect(bus === 'ambience' ? this.ambienceBus : this.sfxBus);
    osc.start(start);
    osc.stop(start + duration * this.speed + 0.05);
  }

  noise({ duration = 0.18, gain = 0.12, delay = 0, filter = 2200, q = 1, type = 'lowpass', bus = 'sfx' }) {
    if (!this.enabled || !this.alive) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state === 'suspended') return;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration * this.speed));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const biquad = ctx.createBiquadFilter();
    biquad.type = type;
    biquad.frequency.value = filter;
    biquad.Q.value = q;
    const env = ctx.createGain();
    env.gain.value = gain;
    source.connect(biquad).connect(env).connect(bus === 'ambience' ? this.ambienceBus : this.sfxBus);
    source.start(ctx.currentTime + delay * this.speed);
  }

  /** A short metallic clink — the sound of one chip landing on others. */
  clink({ delay = 0, gain = 0.05, pitch = 1 } = {}) {
    if (!this.enabled || !this.alive) return;
    const base = (2100 + Math.random() * 900) * pitch;
    this.tone({ freq: base, type: 'triangle', duration: 0.045, gain, delay });
    this.tone({ freq: base * 1.71, type: 'sine', duration: 0.035, gain: gain * 0.6, delay: delay + 0.008 });
    this.noise({ duration: 0.03, gain: gain * 0.5, delay, filter: 6500, type: 'highpass' });
  }

  // ── ambience ────────────────────────────────────────────────────────────

  /** Low casino room tone plus the occasional distant chip clink. */
  startAmbience() {
    if (!this.enabled || !this.ambienceEnabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || this.ambienceNodes) return;

    const bedGain = ctx.createGain();
    bedGain.gain.value = 0;
    bedGain.connect(this.ambienceBus);

    // Room tone: filtered pink-ish noise, looped.
    const seconds = 4;
    const frames = ctx.sampleRate * seconds;
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < frames; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;      // brown-ish noise
      data[i] = last * 3.2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    source.connect(lp).connect(bedGain);
    source.start();

    // Slow shimmer that breathes over the top — distant slot machines.
    const shimmer = ctx.createOscillator();
    const shimmerGain = ctx.createGain();
    shimmer.type = 'sine';
    shimmer.frequency.value = 1180;
    shimmerGain.gain.value = 0;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 0.006;
    lfo.connect(lfoGain).connect(shimmerGain.gain);
    shimmer.connect(shimmerGain).connect(this.ambienceBus);
    shimmer.start();
    lfo.start();

    bedGain.gain.setTargetAtTime(0.05, ctx.currentTime, 1.6);
    this.ambienceNodes = { source, shimmer, lfo, bedGain, shimmerGain };

    // Occasional chip clinks far away.
    const scheduleClink = () => {
      if (!this.ambienceNodes || !this.enabled) return;
      this.clink({ gain: 0.012, delay: 0, pitch: 0.85 + Math.random() * 0.3 });
      if (Math.random() < 0.4) this.clink({ gain: 0.009, delay: 0.08 + Math.random() * 0.12, pitch: 0.8 });
      this.clinkTimer = this.later(scheduleClink, 2600 + Math.random() * 5200);
    };
    this.clinkTimer = this.later(scheduleClink, 1800);
  }

  stopAmbience() {
    if (this.clinkTimer) clearTimeout(this.clinkTimer);
    this.clinkTimer = null;
    const nodes = this.ambienceNodes;
    if (!nodes || !this.ctx) return;
    this.ambienceNodes = null;
    const now = this.ctx.currentTime;
    nodes.bedGain.gain.setTargetAtTime(0, now, 0.5);
    nodes.shimmerGain?.gain.setTargetAtTime?.(0, now, 0.5);
    this.later(() => {
      try {
        nodes.source.stop();
        nodes.shimmer?.stop();
        nodes.lfo?.stop();
      } catch { /* already stopped */ }
    }, 2600);
  }

  // ── table cues ──────────────────────────────────────────────────────────

  click() { this.tone({ freq: 620, type: 'triangle', duration: 0.05, gain: 0.07 }); }
  hover() { this.tone({ freq: 1150, type: 'sine', duration: 0.025, gain: 0.028 }); }
  shuffle() {
    for (let i = 0; i < 9; i += 1) {
      this.noise({ duration: 0.05, gain: 0.075, delay: i * 0.035, filter: 3400 + i * 120, type: 'bandpass', q: 0.7 });
    }
  }
  deal(index = 0) {
    this.noise({ duration: 0.07, gain: 0.1, delay: index * 0.07, filter: 2600, type: 'bandpass', q: 0.8 });
    this.tone({ freq: 900 - index * 40, type: 'triangle', duration: 0.04, gain: 0.045, delay: index * 0.07 });
  }
  flip() { this.noise({ duration: 0.09, gain: 0.1, filter: 4200, type: 'bandpass', q: 0.6 }); }

  chip() { this.clink({ gain: 0.05 }); }
  chipStack(count = 3) {
    for (let i = 0; i < Math.min(count, 6); i += 1) {
      this.later(() => this.clink({ gain: 0.045, pitch: 0.9 + i * 0.06 }), i * 55);
    }
  }
  call() { this.chipStack(2); }
  raise() { this.chipStack(4); }
  check() { this.noise({ duration: 0.1, gain: 0.05, filter: 1200, type: 'bandpass' }); }
  fold() { this.noise({ duration: 0.22, gain: 0.08, filter: 900 }); }

  /** Dramatic riser for an all-in. */
  allIn() {
    this.tone({ freq: 180, type: 'sawtooth', duration: 0.85, gain: 0.07, sweep: 900 });
    this.noise({ duration: 0.9, gain: 0.06, filter: 900, type: 'bandpass', q: 0.5 });
    this.later(() => this.chipStack(6), 420);
  }

  turn() {
    this.tone({ freq: 880, type: 'sine', duration: 0.1, gain: 0.11 });
    this.tone({ freq: 1320, type: 'sine', duration: 0.14, gain: 0.075, delay: 0.08 });
  }

  /** Countdown warning: a tick per second for the last few seconds. */
  tick(secondsLeft = 5) {
    const urgency = secondsLeft <= 2 ? 1.25 : 1;
    this.tone({ freq: 1180 * urgency, type: 'square', duration: 0.04, gain: 0.05 });
  }

  show() {
    this.tone({ freq: 392, type: 'triangle', duration: 0.16, gain: 0.12 });
    this.tone({ freq: 587, type: 'triangle', duration: 0.24, gain: 0.1, delay: 0.12 });
  }

  message() { this.tone({ freq: 740, type: 'sine', duration: 0.08, gain: 0.07 }); }
  reaction() { this.tone({ freq: 1046, type: 'sine', duration: 0.12, gain: 0.08, sweep: 1568 }); }
  error() {
    this.tone({ freq: 220, type: 'square', duration: 0.14, gain: 0.08 });
    this.tone({ freq: 165, type: 'square', duration: 0.16, gain: 0.06, delay: 0.1 });
  }
  join() {
    [659.25, 987.77, 1318.5].forEach((freq, i) => this.tone({ freq, type: 'triangle', duration: 0.16, gain: 0.09, delay: i * 0.07 }));
  }
  whoosh() { this.noise({ duration: 0.32, gain: 0.05, filter: 500, type: 'highpass' }); }

  /** Winning fanfare; a big pot gets the full treatment. */
  win(big = false) {
    const notes = big
      ? [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98]
      : [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      this.tone({ freq, type: 'triangle', duration: 0.3, gain: 0.13, delay: i * 0.09 });
      this.tone({ freq: freq / 2, type: 'sine', duration: 0.34, gain: 0.06, delay: i * 0.09 });
    });
    // coin shower
    const drops = big ? 14 : 7;
    for (let i = 0; i < drops; i += 1) {
      this.later(() => this.clink({ gain: 0.03, pitch: 1.1 + Math.random() * 0.5 }), 200 + i * 90);
    }
    this.noise({ duration: big ? 0.8 : 0.45, gain: 0.04, delay: 0.1, filter: 6000, type: 'highpass' });
  }

  lose() {
    this.tone({ freq: 320, type: 'sawtooth', duration: 0.3, gain: 0.075, sweep: 150 });
    this.tone({ freq: 214, type: 'sine', duration: 0.4, gain: 0.05, delay: 0.16, sweep: 120 });
  }

  /** Rising "time is nearly up" alarm for your own turn. */
  warning() {
    this.tone({ freq: 660, type: 'square', duration: 0.09, gain: 0.06 });
    this.tone({ freq: 880, type: 'square', duration: 0.09, gain: 0.06, delay: 0.1 });
  }
}

export default SoundBoard;
