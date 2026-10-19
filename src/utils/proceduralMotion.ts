import {
  BREATH_DEFAULT_AMOUNT,
  BREATH_DEFAULT_PERIOD_MS,
  BREATH_MAX_AMOUNT,
  SWAY_DEFAULT_AMOUNT,
  SWAY_DEFAULT_PERIOD_MS,
  SWAY_MAX_AMOUNT,
} from '@/constants/timing';

/**
 * Idle life for a character drawn from a single still image.
 *
 * The renderer already gives each named motion its own procedural shape — a bounce for
 * `happy`, a squash for `pat`. What it had no notion of is the motion a character should
 * have *while doing nothing*: a breath and a slow shift of weight. Those are what keep a
 * still frame from reading as a sticker, and they are what this module computes.
 *
 * Kept as pure functions of elapsed time rather than folded into the renderer because that
 * is what makes them checkable: every claim about amplitude, period and continuity is a
 * comparison of two numbers here, with no canvas involved.
 */

interface BreathingSpec {
  period_ms?: number;
  /** Peak scale change, e.g. `0.012` is a 1.2% breath. Clamped. */
  amount?: number;
}

interface SwaySpec {
  period_ms?: number;
  /** Peak horizontal travel in stage pixels. Clamped. */
  amount?: number;
}

/**
 * Motions the renderer already gives their own shape to.
 *
 * Listed rather than inferred because the renderer owns them: a name that appears here is
 * one whose scale, bob and rotation the renderer is already deciding, and idle life must
 * keep its hands off it. A package cannot extend this set — asking for a breath while the
 * character is mid-bounce is not a thing anybody wants twice.
 */
const POSED_MOTIONS = new Set(['happy', 'pat', 'feed', 'drag', 'climb', 'sleep']);

interface DeclaredIdleMotion {
  breathing?: BreathingSpec;
  sway?: SwaySpec;
}

/**
 * The idle motion to apply for a pose, or nothing.
 *
 * This is the decision the renderer would otherwise make inline, kept here so it can be
 * checked without a canvas: that a declared package gets its motion, that an undeclared one
 * gets none, and that a posed motion is left alone even when the package asked for both.
 */
export function idleMotionFor(
  motion: string,
  dynamics: { motion?: DeclaredIdleMotion } | undefined
): DeclaredIdleMotion | undefined {
  if (POSED_MOTIONS.has(motion)) return undefined;
  return dynamics?.motion;
}

interface ScalePair {
  x: number;
  y: number;
}

interface SwayOffset {
  dx: number;
  rotation: number;
}

function periodSeconds(declared: number | undefined, fallbackMs: number): number {
  const ms = Number.isFinite(declared) && (declared as number) > 0 ? (declared as number) : fallbackMs;
  return ms / 1000;
}

function clampAmount(declared: number | undefined, fallback: number, ceiling: number): number {
  const value = Number.isFinite(declared) ? Math.abs(declared as number) : fallback;
  // Clamped rather than trusted: a slip of a decimal place in a package's YAML would
  // otherwise let a character breathe hard enough to look broken, and the package is data
  // somebody else wrote.
  return Math.min(value, ceiling);
}

/**
 * One breath as a scale pair: the chest rises, so the character grows slightly taller and
 * narrows by the same fraction. Volume is not preserved exactly — a breath is not a stretch,
 * and matching x to y would make the motion look like the whole sprite being scaled.
 */
export function breathingScale(elapsedSec: number, spec: BreathingSpec): ScalePair {
  const period = periodSeconds(spec.period_ms, BREATH_DEFAULT_PERIOD_MS);
  const amount = clampAmount(spec.amount, BREATH_DEFAULT_AMOUNT, BREATH_MAX_AMOUNT);
  const phase = Math.sin((elapsedSec / period) * Math.PI * 2);
  return { x: 1 - phase * amount * 0.5, y: 1 + phase * amount };
}

/**
 * A slow lean from one side to the other, with a rotation that follows it.
 *
 * The rotation is a fraction of the travel rather than an independent wave: a body that
 * shifts sideways without tilting reads as sliding, and one that tilts without moving reads
 * as wobbling.
 */
export function weightShift(elapsedSec: number, spec: SwaySpec): SwayOffset {
  const period = periodSeconds(spec.period_ms, SWAY_DEFAULT_PERIOD_MS);
  const amount = clampAmount(spec.amount, SWAY_DEFAULT_AMOUNT, SWAY_MAX_AMOUNT);
  const phase = Math.sin((elapsedSec / period) * Math.PI * 2);
  return { dx: phase * amount, rotation: phase * amount * 0.01 };
}
