import { describe, expect, it } from 'vitest';
import { createMouthLevelSmoother, recognizeOnce } from '@/utils/voiceInput';
import { DEFAULT_VOICE_SETTINGS } from '@/utils/yamlLoader';

/**
 * The two entry points that offer recognition — the stage's chat bar and the companion's
 * voice bridge — each used to have their own copy of this flow, and only one of them drove
 * the pet's mouth while recording. These tests cover the shared pieces: the response shape
 * of one attempt, and the smoothing that turns an 80 ms sample into a mouth position.
 */
describe('voice input', () => {
  it('refuses to listen when no provider is selected, in words', () => {
    const stt = { ...DEFAULT_VOICE_SETTINGS.stt, provider: 'none' as const };
    return expect(recognizeOnce(stt)).resolves.toEqual({
      ok: false,
      reason: '请先选择一种识别方式',
    });
  });

  it('reports a missing microphone rather than rejecting', async () => {
    // The caller is a click handler in a bar with a status line; an exception would have to
    // be caught and re-worded there, which is how the two copies drifted apart.
    const outcome = await recognizeOnce({
      ...DEFAULT_VOICE_SETTINGS.stt,
      provider: 'openai_compatible',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason.length).toBeGreaterThan(0);
  });

  it('reports a runtime without speech recognition instead of throwing', async () => {
    const outcome = await recognizeOnce({
      ...DEFAULT_VOICE_SETTINGS.stt,
      provider: 'web_speech',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason.length).toBeGreaterThan(0);
  });
});

describe('mouth level smoothing', () => {
  it('starts closed and stays within the value it is given', () => {
    const smear = createMouthLevelSmoother({ attack: 1, release: 1, maxStep: 1 });
    expect(smear(0)).toBe(0);
    expect(smear(1)).toBe(1);
    expect(smear(2)).toBe(1);
    expect(smear(-1)).toBe(0);
    expect(smear(Number.NaN)).toBe(0);
  });

  it('opens faster than it closes', () => {
    // One sample in each direction over the same distance, so the only thing that can
    // differ is which factor applied. A smoother that used one factor for both would move
    // them by the same amount, and the numbers below are the two factors themselves.
    const riser = createMouthLevelSmoother({ attack: 0.8, release: 0.2, maxStep: 1 });
    const rise = riser(1);

    const faller = createMouthLevelSmoother({ attack: 0.8, release: 0.2, maxStep: 1 });
    for (let i = 0; i < 40; i += 1) faller(1);
    const fall = 1 - faller(0);

    expect(rise).toBeCloseTo(0.8, 3);
    expect(fall).toBeCloseTo(0.2, 3);
    expect(rise).toBeGreaterThan(fall);
  });

  it('caps how far one sample can move the mouth', () => {
    // A single loud sample — a door, a cough — must not snap the jaw open.
    const smear = createMouthLevelSmoother({ attack: 1, release: 1, maxStep: 0.25 });
    expect(smear(1)).toBe(0.25);
    expect(smear(1)).toBe(0.5);
  });

  it('approaches a steady level without overshooting it', () => {
    const smear = createMouthLevelSmoother({ attack: 0.5, release: 0.5, maxStep: 1 });
    const samples = Array.from({ length: 8 }, () => smear(0.6));
    for (const value of samples) {
      expect(value).toBeLessThanOrEqual(0.6);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(samples[samples.length - 1]).toBeGreaterThan(samples[0]);
  });

  it('clamps out-of-range smoothing parameters into a range that still moves', () => {
    // A factor of zero would mean "never follow the level", i.e. a mouth stuck where it was:
    // a dead feature that looks like a working one. The clamp keeps it moving.
    const smear = createMouthLevelSmoother({ attack: 9, release: -3, maxStep: 99 });
    expect(smear(1)).toBe(1);
    const afterQuietSample = smear(0);
    expect(afterQuietSample).toBeLessThan(1);
    expect(afterQuietSample).toBeGreaterThanOrEqual(0);
  });

  it('falls back for a non-numeric parameter instead of producing NaN', () => {
    const smear = createMouthLevelSmoother({
      attack: Number.NaN,
      release: Number.POSITIVE_INFINITY,
      maxStep: Number.NaN,
    });
    for (const value of [smear(1), smear(0.4), smear(0)]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
