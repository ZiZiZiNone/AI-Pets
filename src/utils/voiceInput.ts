import type { VoiceSettings } from '@/types/pet';
import {
  describeMicrophoneFailure,
  hasMicrophoneSupport,
  listenWithWebSpeechRecognition,
  recordWavFromMicrophone,
} from '@/utils/audioCapture';
import { transcribeAudio } from '@/utils/voiceEngine';

/**
 * One recognition attempt, from the two entry points that offer it.
 *
 * The stage's inline chat bar and the companion's voice bridge each grew their own copy of
 * this flow, which is how the two drifted: only one of them drove the pet's mouth while
 * recording. Both now call this, so the provider branching exists once.
 */
type VoiceInputOutcome =
  | { ok: true; text: string; source: 'web_speech' | 'recorded' }
  | { ok: false; reason: string };

interface VoiceInputOptions {
  /** Live microphone level in 0..1, for a meter or for the pet's mouth. */
  onLevel?: (level: number) => void;
  /** Aborts an in-flight recording and discards it. */
  signal?: AbortSignal;
}

/**
 * Listen once and return what was heard.
 *
 * Never throws: every failure is already phrased for the user by the layer that knows what
 * went wrong (a blocked microphone, an unreachable endpoint, an empty recording), and a
 * caller that has to catch would have to invent a second wording for the same problem.
 */
export async function recognizeOnce(
  stt: VoiceSettings['stt'],
  options: VoiceInputOptions = {}
): Promise<VoiceInputOutcome> {
  if (stt.provider === 'none') {
    return { ok: false, reason: '请先选择一种识别方式' };
  }

  try {
    if (stt.provider === 'web_speech') {
      // No level is available on this path: the browser owns the audio and exposes no
      // amplitude, so the meter and the mouth stay still while it listens.
      const text = await listenWithWebSpeechRecognition(stt.web_speech);
      return text.trim()
        ? { ok: true, text: text.trim(), source: 'web_speech' }
        : { ok: false, reason: '没有识别到内容，请再说一次' };
    }

    if (!hasMicrophoneSupport()) {
      return { ok: false, reason: describeMicrophoneFailure(new Error('mediaDevices')) };
    }

    const recorded = await recordWavFromMicrophone({
      maxMs: stt.web_speech.max_ms,
      signal: options.signal,
      onLevel: options.onLevel,
    });
    const outcome = await transcribeAudio(recorded.bytes, stt);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    return outcome.text.trim()
      ? { ok: true, text: outcome.text.trim(), source: 'recorded' }
      : { ok: false, reason: '没有识别到内容，请再说一次' };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : describeMicrophoneFailure(error),
    };
  }
}

/**
 * Turn a bare RMS reading into a mouth position.
 *
 * The speaking path gets its smoothing from an analyser node; the listening path has only
 * one number every 80 ms, so the same job is done here instead. Attack faster than release
 * is what makes it read as speech rather than as a flicker — the mouth opens on the first
 * sample of a syllable and eases shut after it.
 *
 * Separate from the caller so it can be tested without a microphone: what is being pinned
 * is the shape of the response, not the audio pipeline.
 */
export function createMouthLevelSmoother(options: {
  /** Share of the distance to a rising target covered per sample, 0..1. */
  attack?: number;
  /** The same, for a falling target. */
  release?: number;
  /** Most a single sample is allowed to move the mouth, 0..1. A hard ceiling on jitter. */
  maxStep?: number;
} = {}): (level: number) => number {
  const attack = clampRate(options.attack ?? 0.6);
  const release = clampRate(options.release ?? 0.18);
  const maxStep = clamp01(options.maxStep ?? 0.5);
  let current = 0;

  return (level: number): number => {
    const target = clamp01(level);
    const rate = target > current ? attack : release;
    const moved = current + (target - current) * rate;
    current = Math.min(current + maxStep, Math.max(current - maxStep, moved));
    return Number(current.toFixed(3));
  };
}

/**
 * Keep a smoothing factor inside the range where the smoother still moves.
 *
 * Zero would mean "never follow the level at all", which is a mouth that stays exactly where
 * it was — a dead feature that looks like a working one. The window is the same one the
 * speaking path uses for its analyser smoothing.
 */
function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0.6;
  return Math.min(1, Math.max(0.05, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
