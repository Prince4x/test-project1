/**
 * Sound effects, synthesised with the Web Audio API — no asset downloads.
 * Every sound respects the "sound" setting and the animation speed, and the
 * context is only created after the first user gesture (browser policy).
 */

export class SoundBoard {
  constructor({ enabled = true, speed = 1 } = {}) {
    this.enabled = enabled;
    this.speed = speed;
    this.ctx = null;
    this.master = null;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.master) this.master.gain.value = this.enabled ? 0.7 : 0;
  }

  /** Animation speed also stretches or shortens the audio cues. */
  setSpeed(speed = 1) {
    this.speed = speed || 1;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.7 : 0;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  tone({ freq = 440, type = 'sine', duration = 0.12, gain = 0.16, delay = 0, sweep = null }) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const start = ctx.currentTime + delay * this.speed;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), start + duration * this.speed);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration * this.speed);
    osc.connect(env).connect(this.master);
    osc.start(start);
    osc.stop(start + duration * this.speed + 0.05);
  }

  noise({ duration = 0.18, gain = 0.12, delay = 0, filter = 2200 }) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const frames = Math.floor(ctx.sampleRate * duration * this.speed);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filter;
    const env = ctx.createGain();
    env.gain.value = gain;
    source.connect(lp).connect(env).connect(this.master);
    source.start(ctx.currentTime + delay * this.speed);
  }

  // ── cues ────────────────────────────────────────────────────────────────
  click() { this.tone({ freq: 620, type: 'triangle', duration: 0.05, gain: 0.08 }); }
  shuffle() {
    for (let i = 0; i < 7; i += 1) this.noise({ duration: 0.06, gain: 0.08, delay: i * 0.045, filter: 3400 });
  }
  deal(index = 0) {
    this.noise({ duration: 0.07, gain: 0.1, delay: index * 0.07, filter: 2600 });
    this.tone({ freq: 900 - index * 40, type: 'triangle', duration: 0.04, gain: 0.05, delay: index * 0.07 });
  }
  flip() { this.noise({ duration: 0.09, gain: 0.1, filter: 4200 }); }
  chip() {
    this.tone({ freq: 1180, type: 'square', duration: 0.05, gain: 0.07 });
    this.tone({ freq: 1580, type: 'square', duration: 0.045, gain: 0.05, delay: 0.035 });
  }
  chipStack(count = 3) {
    for (let i = 0; i < Math.min(count, 5); i += 1) this.chip();
  }
  turn() {
    this.tone({ freq: 880, type: 'sine', duration: 0.1, gain: 0.12 });
    this.tone({ freq: 1320, type: 'sine', duration: 0.14, gain: 0.08, delay: 0.08 });
  }
  fold() { this.noise({ duration: 0.22, gain: 0.09, filter: 900 }); }
  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      this.tone({ freq, type: 'triangle', duration: 0.28, gain: 0.14, delay: i * 0.1 });
    });
    this.noise({ duration: 0.5, gain: 0.05, delay: 0.1, filter: 6000 });
  }
  lose() {
    this.tone({ freq: 320, type: 'sawtooth', duration: 0.3, gain: 0.09, sweep: 150 });
  }
  show() {
    this.tone({ freq: 392, type: 'triangle', duration: 0.16, gain: 0.12 });
    this.tone({ freq: 587, type: 'triangle', duration: 0.24, gain: 0.1, delay: 0.12 });
  }
  message() { this.tone({ freq: 740, type: 'sine', duration: 0.08, gain: 0.08 }); }
  reaction() { this.tone({ freq: 1046, type: 'sine', duration: 0.12, gain: 0.09, sweep: 1568 }); }
  error() { this.tone({ freq: 220, type: 'square', duration: 0.14, gain: 0.09 }); }
}

export default SoundBoard;
