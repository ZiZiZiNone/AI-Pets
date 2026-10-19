import { describe, expect, it } from 'vitest';
import { breathingScale, idleMotionFor, weightShift } from '@/utils/proceduralMotion';
import {
  BREATH_DEFAULT_AMOUNT,
  BREATH_DEFAULT_PERIOD_MS,
  BREATH_MAX_AMOUNT,
  SWAY_DEFAULT_AMOUNT,
  SWAY_DEFAULT_PERIOD_MS,
  SWAY_MAX_AMOUNT,
} from '@/constants/timing';

/**
 * The claims worth checking about idle life are numeric ones: how far it moves, how often,
 * and whether a package can make it look broken. None of them need a canvas.
 */
describe('breathing', () => {
  it('starts and returns to rest within one period', () => {
    const spec = { period_ms: 4000, amount: 0.02 };
    const periodSec = 4;
    expect(breathingScale(0, spec).y).toBeCloseTo(1, 6);
    expect(breathingScale(periodSec, spec).y).toBeCloseTo(1, 6);
    expect(breathingScale(periodSec * 2, spec).y).toBeCloseTo(1, 6);
  });

  it('peaks at a quarter period and troughs at three quarters', () => {
    const spec = { period_ms: 4000, amount: 0.02 };
    expect(breathingScale(1, spec).y).toBeCloseTo(1.02, 6);
    expect(breathingScale(3, spec).y).toBeCloseTo(0.98, 6);
  });

  it('narrows as it rises, but by less than it grows', () => {
    // A breath is not a uniform scale: matching x to y would make the whole sprite zoom.
    const spec = { period_ms: 4000, amount: 0.02 };
    const peak = breathingScale(1, spec);
    expect(peak.x).toBeLessThan(1);
    expect(1 - peak.x).toBeLessThan(peak.y - 1);
  });

  it('never leaves the character visibly distorted', () => {
    const wild = { period_ms: 4000, amount: 99 };
    for (let step = 0; step <= 40; step += 1) {
      const scale = breathingScale(step * 0.1, wild);
      expect(scale.y).toBeLessThanOrEqual(1 + BREATH_MAX_AMOUNT + 1e-9);
      expect(scale.x).toBeGreaterThan(1 - BREATH_MAX_AMOUNT);
    }
  });

  it('fills in a period the package leaves out', () => {
    const omitted = breathingScale(0.9, {});
    expect(omitted.y).toBeCloseTo(1 + Math.sin(0.9 / (BREATH_DEFAULT_PERIOD_MS / 1000) * Math.PI * 2) * BREATH_DEFAULT_AMOUNT, 9);
  });
});

describe('weight shift', () => {
  it('returns to the centre once per period', () => {
    const spec = { period_ms: 5000, amount: 2 };
    expect(weightShift(0, spec).dx).toBeCloseTo(0, 6);
    expect(weightShift(5, spec).dx).toBeCloseTo(0, 6);
  });

  it('travels the declared distance at a quarter period', () => {
    expect(weightShift(1.25, { period_ms: 5000, amount: 2 }).dx).toBeCloseTo(2, 6);
  });

  it('tilts in proportion to the travel', () => {
    // A body that slides without tilting reads as sliding, and one that tilts without
    // moving reads as wobbling; the two have to come from the same phase.
    const spec = { period_ms: 5000, amount: 2 };
    const atRest = weightShift(0, spec);
    const atPeak = weightShift(1.25, spec);
    expect(atRest.rotation).toBeCloseTo(0, 9);
    expect(atPeak.rotation).toBeGreaterThan(0);
  });

  it('clamps a travel no character should have', () => {
    const wild = { period_ms: 5000, amount: 500 };
    expect(Math.abs(weightShift(1.25, wild).dx)).toBeLessThanOrEqual(SWAY_MAX_AMOUNT + 1e-9);
  });

  it('fills in the numbers a package leaves out', () => {
    expect(weightShift(SWAY_DEFAULT_PERIOD_MS / 4000, {}).dx).toBeCloseTo(SWAY_DEFAULT_AMOUNT, 6);
  });
});

describe('whether idle motion applies at all', () => {
  const declared = { motion: { breathing: { amount: 0.01 }, sway: { amount: 1 } } };

  it('applies what the package declared while the pose is at rest', () => {
    expect(idleMotionFor('idle', declared)).toBe(declared.motion);
    expect(idleMotionFor('thinking', declared)).toBe(declared.motion);
  });

  it('leaves a motion the renderer already shapes alone', () => {
    // Two rhythms over one body: the renderer is already moving these, and a breath added
    // on top of a bounce reads as a malfunction rather than as life.
    for (const posed of ['happy', 'pat', 'feed', 'drag', 'climb', 'sleep']) {
      expect(idleMotionFor(posed, declared)).toBeUndefined();
    }
  });

  it('adds nothing to a package that declared nothing', () => {
    expect(idleMotionFor('idle', undefined)).toBeUndefined();
    expect(idleMotionFor('idle', {})).toBeUndefined();
  });
});