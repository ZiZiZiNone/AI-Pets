import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStageAutonomousLoop } from '@/utils/stageRuntime';
import { AUTONOMOUS_TICK_MS } from '@/constants/timing';

/**
 * The autonomous loop is the host deciding things on its own. It has to stop deciding the
 * moment an external driver owns the character, and "it stopped" is only meaningful if the
 * same setup demonstrably *does* decide when nobody is driving — otherwise a loop that never
 * ran at all would pass the first assertion too.
 */
function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    externalDriver: null,
    lastUserActivityAt: Date.now(),
    activeMotion: 'idle',
    activeExpression: 'neutral',
    dnd_mode: false,
    studioOpen: false,
    radialMenuOpen: false,
    currentAction: null,
    isClimbedOnWindow: false,
    currentPet: { name: '测试机体' },
    stats: { affinity: 50 },
    settings: {
      behavior: {
        enable_health_reminders: true,
        enable_autonomous_fsm: true,
        hydration_interval_min: 1,
        posture_interval_min: 1,
        wander_interval_sec: 1,
        sleep_after_idle_sec: 180,
      },
    },
    scheduleAction: vi.fn(),
    addXpAndAffinity: vi.fn(),
    ...overrides,
  };
}
/** Enough ticks that the one-minute hydration reminder would have fired. */
const TICKS_PAST_A_REMINDER = Math.ceil((61_000 / AUTONOMOUS_TICK_MS) as number);

describe('stage autonomous loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('decides on its own when nobody is driving', () => {
    const store = fakeStore();
    const stop = startStageAutonomousLoop(store as never);
    vi.advanceTimersByTime(TICKS_PAST_A_REMINDER * AUTONOMOUS_TICK_MS);
    stop();
    expect(store.scheduleAction).toHaveBeenCalled();
  });

  it('stands down entirely while an external driver holds the character', () => {
    const store = fakeStore({ externalDriver: 'omnicore' });
    const stop = startStageAutonomousLoop(store as never);
    vi.advanceTimersByTime(TICKS_PAST_A_REMINDER * AUTONOMOUS_TICK_MS);
    stop();
    expect(store.scheduleAction).not.toHaveBeenCalled();
    // Sleep upkeep is part of the same stand-down: a driver that owns the character also
    // owns whether it sleeps, so the host must not be awarding anything on its own.
    expect(store.addXpAndAffinity).not.toHaveBeenCalled();
  });

  it('resumes deciding once the driver releases the lease', () => {
    const store = fakeStore({ externalDriver: 'omnicore' });
    const stop = startStageAutonomousLoop(store as never);
    vi.advanceTimersByTime(TICKS_PAST_A_REMINDER * AUTONOMOUS_TICK_MS);
    expect(store.scheduleAction).not.toHaveBeenCalled();

    // Same loop, same tick, one field changed: the stand-down is a live check rather than
    // a decision taken when the loop started.
    store.externalDriver = null;
    vi.advanceTimersByTime(TICKS_PAST_A_REMINDER * AUTONOMOUS_TICK_MS);
    stop();
    expect(store.scheduleAction).toHaveBeenCalled();
  });
});

describe('declared moments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const withMoments = (moments: Record<string, { motion?: string; expression?: string }>) =>
    fakeStore({ currentPet: { name: '测试机体', dynamics: { moments } } });

  it('plays the clip the package names for a reminder', () => {
    const store = withMoments({ hydration: { motion: 'doze', expression: 'sleepy' } });
    const stop = startStageAutonomousLoop(store as never);
    vi.advanceTimersByTime(TICKS_PAST_A_REMINDER * AUTONOMOUS_TICK_MS);
    stop();

    const reminder = store.scheduleAction.mock.calls.find(
      (call) => call[0].text && call[0].priority === 'P2'
    );
    expect(reminder?.[0].motion).toBe('doze');
    expect(reminder?.[0].expression).toBe('sleepy');
  });

  it('falls back to the host name for a moment the package does not declare', () => {
    const store = withMoments({ posture: { motion: 'stretch' } });
    const stop = startStageAutonomousLoop(store as never);
    vi.advanceTimersByTime(TICKS_PAST_A_REMINDER * AUTONOMOUS_TICK_MS);
    stop();

    const motions = store.scheduleAction.mock.calls.map((call) => call[0].motion);
    // Hydration is not declared, so the loop's own name stands; posture is.
    expect(motions).toContain('happy');
    expect(motions).toContain('stretch');
  });

  it('lets a package opt out of the health reminders entirely', () => {
    const store = fakeStore({
      currentPet: { name: '测试机体', dynamics: { behaviors: { health_reminders: false } } },
    });
    const stop = startStageAutonomousLoop(store as never);
    vi.advanceTimersByTime(TICKS_PAST_A_REMINDER * AUTONOMOUS_TICK_MS);
    stop();

    const reminded = store.scheduleAction.mock.calls.filter(
      (call) => call[0].priority === 'P2'
    );
    expect(reminded).toHaveLength(0);
    // The ambient thought is P3 and unrelated, so opting out of reminders must not silence
    // the whole loop — that would be a different behaviour than the one that was asked for.
    expect(store.scheduleAction).toHaveBeenCalled();
  });
});
