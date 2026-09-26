/**
 * The department's sound, made in the browser (no recordings): monitor beeps, an overhead
 * chime for alerts, a siren for incoming ambulances, and a murmur that grows with the
 * waiting room. Starts on the first user gesture (browsers require one); muting is remembered.
 */

const KEY = 'er-sound';

export function soundPreference(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveSoundPreference(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked
  }
}

export class Soundscape {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private murmur: GainNode | null = null;
  private nextBeep = 0;
  private sirenUntil = 0;
  on: boolean;

  constructor(on: boolean) {
    this.on = on;
  }

  /** Create the audio graph; call from a click or key handler. */
  start(): void {
    if (this.ctx || typeof AudioContext === 'undefined') return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 0.6 : 0;
    this.master.connect(ctx.destination);
    // Murmur: looping brown-ish noise through a band-pass, like voices down a corridor.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    let x = 0x2545f491; // xorshift: audio noise only, but no Math.random anywhere in the project
    for (let i = 0; i < len; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      last = (last + 0.02 * ((x >>> 0) / 0x80000000 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 450;
    band.Q.value = 0.7;
    this.murmur = ctx.createGain();
    this.murmur.gain.value = 0;
    src.connect(band).connect(this.murmur).connect(this.master);
    src.start();
  }

  setOn(on: boolean): void {
    this.on = on;
    saveSoundPreference(on);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.05);
  }

  /** Called every frame with the state of the floor. */
  update(state: { waiting: number; inBeds: number; running: boolean }): void {
    const ctx = this.ctx;
    if (!ctx || !this.murmur) return;
    const t = ctx.currentTime;
    const crowd = state.running ? Math.min(1, state.waiting / 30) : 0;
    this.murmur.gain.setTargetAtTime(0.02 + 0.28 * crowd, t, 0.8);
    // Monitor beeps: somewhere in the department a monitor sounds every second or so.
    if (state.running && state.inBeds > 0 && t >= this.nextBeep) {
      this.tone(988, 0.07, 0.05);
      this.nextBeep = t + 0.6 + 2.4 / Math.sqrt(state.inBeds);
    }
  }

  /** Two-tone overhead chime. */
  chime(): void {
    if (!this.ctx) return;
    this.tone(659, 0.25, 0.12);
    this.tone(523, 0.35, 0.12, 0.28);
  }

  /** A siren that gets louder, as an ambulance approaches. */
  siren(seconds = 4): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.currentTime < this.sirenUntil) return;
    const t = ctx.currentTime;
    this.sirenUntil = t + seconds;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + seconds * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    for (let k = 0; k < seconds * 2; k++) {
      osc.frequency.setValueAtTime(700, t + k * 0.5);
      osc.frequency.linearRampToValueAtTime(1050, t + k * 0.5 + 0.25);
      osc.frequency.linearRampToValueAtTime(700, t + k * 0.5 + 0.5);
    }
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + seconds);
  }

  close(): void {
    void this.ctx?.close();
    this.ctx = null;
  }

  private tone(freq: number, dur: number, vol: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
