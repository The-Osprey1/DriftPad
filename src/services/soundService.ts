// Web Audio API Synthetic Mechanical Acoustics for DriftPad
// Synthesizes crisp PBT Hall-effect switch bottom-out "thock", switch top-out "tick",
// and rotary encoder detent clicks with zero external audio assets.

class SoundService {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private volume: number = 0.45;

  private initCtx() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
    try {
      localStorage.setItem('driftpad_audio_muted', muted ? 'true' : 'false');
    } catch {}
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
  }

  public getVolume(): number {
    return this.volume;
  }

  public initFromStorage() {
    try {
      const stored = localStorage.getItem('driftpad_audio_muted');
      if (stored !== null) {
        this.isMuted = stored === 'true';
      }
    } catch {}
  }

  /**
   * Synthesize mechanical switch bottom-out / actuation "thock"
   * Deep resonant impact with low-frequency body and transient snap
   */
  public playSwitchDown(travelMm: number = 2.5, isBottomOut: boolean = false) {
    if (this.isMuted) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const masterGain = this.ctx.createGain();
      const intensity = Math.min(1, Math.max(0.3, travelMm / 3.8));
      masterGain.gain.setValueAtTime(this.volume * (isBottomOut ? 1.0 : 0.75) * intensity, now);
      masterGain.connect(this.ctx.destination);

      // Low-end "thock" body (subtle sine oscillator dropping from 140Hz to 45Hz)
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isBottomOut ? 120 : 160, now);
      osc.frequency.exponentialRampToValueAtTime(45, now + 0.045);

      oscGain.gain.setValueAtTime(0.8, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

      osc.connect(oscGain);
      oscGain.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.055);

      // Transient plastic snap (white noise burst through high-pass filter)
      const bufferSize = this.ctx.sampleRate * 0.018;
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(isBottomOut ? 1600 : 2200, now);
      filter.Q.setValueAtTime(3.0, now);

      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(0.5, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.016);

      noise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(masterGain);

      noise.start(now);
      noise.stop(now + 0.02);
    } catch {
      // AudioContext policy safe fallback
    }
  }

  /**
   * Synthesize mechanical switch upstroke top-out "tick"
   * Lighter, snappier release transient
   */
  public playSwitchUp() {
    if (this.isMuted) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const masterGain = this.ctx.createGain();
      masterGain.gain.setValueAtTime(this.volume * 0.4, now);
      masterGain.connect(this.ctx.destination);

      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.025);

      oscGain.gain.setValueAtTime(0.4, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

      osc.connect(oscGain);
      oscGain.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.035);
    } catch {}
  }

  /**
   * Synthesize rotary encoder tactile detent tick
   * Ultra-short metallic notch click (1200Hz - 800Hz snap)
   */
  public playEncoderTick(_direction: 'cw' | 'ccw' | 'click' = 'cw') {
    if (this.isMuted) return;
    this.initCtx();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const masterGain = this.ctx.createGain();
      masterGain.gain.setValueAtTime(this.volume * 0.55, now);
      masterGain.connect(this.ctx.destination);

      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1100, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.012);

      oscGain.gain.setValueAtTime(0.3, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.014);

      osc.connect(oscGain);
      oscGain.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.016);
    } catch {}
  }
}

export const soundService = new SoundService();
