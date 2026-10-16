import type { LipSyncFrame } from '@/types/pet';

export class FormantLipSyncEngine {
  private analyser: AnalyserNode;
  private freqBins: Uint8Array;
  private sampleRate: number;
  private smoothingOpenY = 0;
  private smoothingFormX = 0;

  private readonly attackAlpha = 0.65;
  private readonly releaseAlpha = 0.22;
  private readonly noiseGate = 0.04;

  constructor(audioCtx: AudioContext, fftSize = 1024, smoothingTimeConstant = 0.75) {
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = Math.min(0.95, Math.max(0.1, smoothingTimeConstant));
    this.freqBins = new Uint8Array(this.analyser.frequencyBinCount);
    this.sampleRate = audioCtx.sampleRate;
  }

  public connectSource(source: AudioNode): void {
    source.connect(this.analyser);
  }

  public getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  private hzToBin(hz: number): number {
    const nyquist = this.sampleRate / 2;
    return Math.min(
      this.freqBins.length - 1,
      Math.max(0, Math.round((hz / nyquist) * this.freqBins.length))
    );
  }

  private computeBandEnergy(lowHz: number, highHz: number): number {
    const start = this.hzToBin(lowHz);
    const end = this.hzToBin(highHz);
    if (end <= start) return 0;
    let sum = 0;
    for (let i = start; i <= end; i++) {
      sum += this.freqBins[i];
    }
    return sum / ((end - start + 1) * 255);
  }

  public sampleFrame(gain = 1.0): LipSyncFrame {
    this.analyser.getByteFrequencyData(this.freqBins);

    const eLow = this.computeBandEnergy(80, 300) * gain;
    const eMid = this.computeBandEnergy(300, 2000) * gain;
    const eHigh = this.computeBandEnergy(2000, 6000) * gain;

    const bands = [
      this.computeBandEnergy(80, 220),
      this.computeBandEnergy(220, 450),
      this.computeBandEnergy(450, 900),
      this.computeBandEnergy(900, 1800),
      this.computeBandEnergy(1800, 3200),
      this.computeBandEnergy(3200, 5200),
      this.computeBandEnergy(5200, 8000),
    ].map((v) => Math.min(1, Number((v * gain).toFixed(3))));

    const rawRms = Math.min(1, eLow * 0.25 + eMid * 0.55 + eHigh * 0.2);
    const rawOpenY =
      rawRms < this.noiseGate ? 0 : Math.min(1, eMid * 1.65 + eLow * 0.35);
    const rawFormX =
      rawRms < this.noiseGate
        ? 0
        : Math.max(-1, Math.min(1, (eHigh - eLow) * 2.2));

    const alphaY =
      rawOpenY > this.smoothingOpenY ? this.attackAlpha : this.releaseAlpha;
    this.smoothingOpenY =
      alphaY * rawOpenY + (1 - alphaY) * this.smoothingOpenY;

    const alphaX =
      Math.abs(rawFormX) > Math.abs(this.smoothingFormX) ? 0.5 : 0.2;
    this.smoothingFormX =
      alphaX * rawFormX + (1 - alphaX) * this.smoothingFormX;

    return {
      mouthOpenY: Number(this.smoothingOpenY.toFixed(3)),
      mouthFormX: Number(this.smoothingFormX.toFixed(3)),
      rms: Number(rawRms.toFixed(3)),
      bands,
    };
  }
}

const ZERO_FRAME: LipSyncFrame = {
  mouthOpenY: 0,
  mouthFormX: 0,
  rms: 0,
  bands: [0, 0, 0, 0, 0, 0, 0],
};

export type UiSoundTone = 'pat' | 'feed' | 'levelup' | 'pomo' | 'click';

class GlobalLipSyncController {
  private audioCtx: AudioContext | null = null;
  private activeAudioEl: HTMLAudioElement | null = null;
  private activeSourceNode: MediaElementAudioSourceNode | null = null;
  private activeAnalyserNode: AnalyserNode | null = null;
  private rafId: number | null = null;
  private synthTimer: number | null = null;
  private gainMultiplier = 1.0;
  private rmsSmoothing = 0.75;

  private ensureAudioContext(): AudioContext | null {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return null;
      if (!this.audioCtx) {
        this.audioCtx = new AudioContextCtor();
      }
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  public setGainMultiplier(gainPercent: number): void {
    this.gainMultiplier = Math.max(0.1, Math.min(3.0, gainPercent / 75));
  }

  public setRmsSmoothing(smoothing: number): void {
    this.rmsSmoothing = Math.min(0.95, Math.max(0.1, smoothing));
  }

  public playUiFeedbackTone(tone: UiSoundTone, volume = 0.85): void {
    if (volume <= 0.01) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const masterPeak = Math.min(0.18, volume * 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      };

      if (tone === 'levelup') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.09);
        osc.frequency.setValueAtTime(783.99, now + 0.18);
        osc.frequency.setValueAtTime(1046.5, now + 0.27);
        gain.gain.setValueAtTime(masterPeak, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
        osc.start(now);
        osc.stop(now + 0.52);
      } else if (tone === 'pomo') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880.0, now + 0.14);
        gain.gain.setValueAtTime(masterPeak, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.start(now);
        osc.stop(now + 0.45);
      } else if (tone === 'feed') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.16);
        gain.gain.setValueAtTime(masterPeak * 0.85, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(tone === 'pat' ? 620 : 740, now);
        osc.frequency.exponentialRampToValueAtTime(tone === 'pat' ? 820 : 520, now + 0.08);
        gain.gain.setValueAtTime(masterPeak * 0.65, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      }
    } catch {
      // Ignore audio synthesis restrictions when autoplay is blocked
    }
  }

  public speakWithWebSpeechTts(text: string, volume = 0.85): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const cleanText = text.replace(/[\u{1F300}-\u{1FAFF}⚡✦💥🎯🔮🍬🍅💧🧘]/gu, '').trim();
      if (!cleanText) return;
      const utter = new SpeechSynthesisUtterance(cleanText);
      utter.lang = 'zh-CN';
      utter.volume = Math.min(1, Math.max(0, volume));
      utter.rate = 1.08;
      utter.pitch = 1.05;
      window.speechSynthesis.speak(utter);
    } catch {
      // Ignore if speechSynthesis is unsupported in webview
    }
  }

  public async playAudioWithLipSync(
    audioUrl: string,
    onUpdate: (frame: LipSyncFrame) => void
  ): Promise<void> {
    this.stop(onUpdate);

    try {
      const ctx = this.ensureAudioContext();
      if (!ctx) {
        this.startSyntheticLipSync(2200, onUpdate);
        return;
      }

      const audio = new Audio(audioUrl);
      audio.crossOrigin = 'anonymous';
      this.activeAudioEl = audio;

      const engine = new FormantLipSyncEngine(ctx, 1024, this.rmsSmoothing);
      const source = ctx.createMediaElementSource(audio);
      engine.connectSource(source);
      const analyser = engine.getAnalyser();
      analyser.connect(ctx.destination);

      this.activeSourceNode = source;
      this.activeAnalyserNode = analyser;

      const tick = () => {
        if (!this.activeAudioEl || this.activeAudioEl.paused || this.activeAudioEl.ended) {
          onUpdate(ZERO_FRAME);
          return;
        }
        onUpdate(engine.sampleFrame(this.gainMultiplier));
        this.rafId = requestAnimationFrame(tick);
      };

      audio.onended = () => {
        this.stop(onUpdate);
      };
      audio.onerror = () => {
        this.startSyntheticLipSync(2200, onUpdate);
      };

      await audio.play();
      this.rafId = requestAnimationFrame(tick);
    } catch {
      this.startSyntheticLipSync(2200, onUpdate);
    }
  }

  public startSyntheticLipSync(
    durationMs: number,
    onUpdate: (frame: LipSyncFrame) => void
  ): void {
    this.stop(onUpdate);
    const startTime = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= durationMs) {
        onUpdate(ZERO_FRAME);
        this.synthTimer = null;
        return;
      }

      const t = elapsed * 0.016;
      const syllableWave =
        Math.abs(Math.sin(t * 1.4)) * 0.55 +
        Math.abs(Math.cos(t * 2.3)) * 0.35 +
        Math.sin(t * 4.1) * 0.1;
      const openY = Number(
        Math.min(1.0, Math.max(0.05, syllableWave * this.gainMultiplier)).toFixed(3)
      );
      const formX = Number((Math.sin(t * 0.9) * 0.45).toFixed(3));
      const bands = Array.from({ length: 7 }, (_, idx) =>
        Number(
          Math.min(
            1,
            Math.max(0.04, Math.abs(Math.sin(t * 1.8 + idx * 0.7)) * openY)
          ).toFixed(3)
        )
      );

      onUpdate({
        mouthOpenY: openY,
        mouthFormX: formX,
        rms: openY,
        bands,
      });

      this.synthTimer = window.setTimeout(tick, 32);
    };

    tick();
  }

  public stop(onUpdate?: (frame: LipSyncFrame) => void): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.synthTimer !== null) {
      clearTimeout(this.synthTimer);
      this.synthTimer = null;
    }
    if (this.activeSourceNode) {
      try {
        this.activeSourceNode.disconnect();
      } catch {
        // Ignore disconnect error
      }
      this.activeSourceNode = null;
    }
    if (this.activeAnalyserNode) {
      try {
        this.activeAnalyserNode.disconnect();
      } catch {
        // Ignore disconnect error
      }
      this.activeAnalyserNode = null;
    }
    if (this.activeAudioEl) {
      try {
        this.activeAudioEl.pause();
        this.activeAudioEl.src = '';
      } catch {
        // Ignore cleanup errors
      }
      this.activeAudioEl = null;
    }
    if (onUpdate) {
      onUpdate(ZERO_FRAME);
    }
  }
}

export const globalLipSync = new GlobalLipSyncController();
