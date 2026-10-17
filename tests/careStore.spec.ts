import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCareStore } from '@/store/careStore';
import type { ScheduledPetTask } from '@/types/pet';

function bindPresenter() {
  const scheduled: ScheduledPetTask[] = [];
  const store = useCareStore();
  store.bindPresenter({
    schedule: (task) => scheduled.push(task),
    audioPrefs: () => ({ dnd: true, volume: 0.5, petName: 'TESTER' }),
  });
  return { store, scheduled };
}

describe('careStore progression', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('counts every interaction', () => {
    const { store } = bindPresenter();
    const before = store.stats.totalInteractions;
    store.addXpAndAffinity(1);
    expect(store.stats.totalInteractions).toBe(before + 1);
  });

  it('clamps affinity and mood into 0..100', () => {
    const { store } = bindPresenter();
    store.addXpAndAffinity(0, 500, 500);
    expect(store.stats.affinity).toBe(100);
    expect(store.stats.mood).toBe(100);

    store.addXpAndAffinity(0, -500, -500);
    expect(store.stats.affinity).toBe(0);
    expect(store.stats.mood).toBe(0);
  });

  it('carries surplus xp across a level-up and grows the threshold', () => {
    const { store, scheduled } = bindPresenter();
    const storeRef = store;
    storeRef.stats = { ...storeRef.stats, xp: 290, xpToNext: 300 };
    store.addXpAndAffinity(40, 0, 0);

    expect(storeRef.stats.level).toBe(4);
    // 330 xp earned against a 300 threshold leaves 30 over, and the bar grows 25%.
    expect(storeRef.stats.xp).toBe(30);
    expect(storeRef.stats.xpToNext).toBe(375);
    expect(storeRef.stats.energy).toBe(100);
    expect(scheduled.map((t) => t.text).join()).toMatch(/升至 Lv\.4/);
  });

  it('can level up more than once in a single grant', () => {
    const { store } = bindPresenter();
    store.stats = { ...store.stats, xp: 290, xpToNext: 300 };
    store.addXpAndAffinity(500, 0, 0);
    // 290 + 500 = 790 clears the 300 bar, then the 375 bar, leaving 115 spare.
    expect(store.stats.level).toBe(5);
    expect(store.stats.xp).toBe(115);
    expect(store.stats.xpToNext).toBe(469);
  });

  it('announces a level-up exactly once per crossing', () => {
    const { store, scheduled } = bindPresenter();
    store.stats = { ...store.stats, xp: 0, xpToNext: 100 };
    store.addXpAndAffinity(100, 0, 0);
    expect(scheduled).toHaveLength(1);
    store.addXpAndAffinity(1, 0, 0);
    expect(scheduled).toHaveLength(1);
  });

  it('reports xp progress as a percentage', () => {
    const { store } = bindPresenter();
    store.stats = { ...store.stats, xp: 150, xpToNext: 300 };
    expect(store.xpProgressPercent).toBe(50);
  });

  it('never divides by a zero threshold', () => {
    const { store } = bindPresenter();
    store.stats = { ...store.stats, xp: 5, xpToNext: 0 };
    expect(store.xpProgressPercent).toBe(100);
  });
});

describe('careStore feeding', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('caps energy at 100 and reports the resulting value', () => {
    const { store, scheduled } = bindPresenter();
    store.stats = { ...store.stats, energy: 95 };
    store.feedCareItem('晶块', 25, 8, 30);
    expect(store.stats.energy).toBe(100);
    expect(scheduled.some((t) => t.text.includes('能量 +25%'))).toBe(true);
  });
});

describe('careStore todos', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('ignores blank input', () => {
    const { store } = bindPresenter();
    const before = store.todos.length;
    store.addTodo('   ');
    expect(store.todos).toHaveLength(before);
  });

  it('prepends new todos', () => {
    const { store } = bindPresenter();
    store.addTodo('写测试', 'high');
    expect(store.todos[0].text).toBe('写测试');
    expect(store.todos[0].priority).toBe('high');
    expect(store.todos[0].done).toBe(false);
  });

  it('awards xp only when a todo is completed, not when reopened', () => {
    const { store, scheduled } = bindPresenter();
    const id = store.todos[0].id;
    const xpBefore = store.stats.xp;

    store.toggleTodo(id);
    expect(store.stats.xp).toBeGreaterThan(xpBefore);
    expect(scheduled.some((t) => t.text.includes('任务达成'))).toBe(true);

    const xpAfterComplete = store.stats.xp;
    store.toggleTodo(id);
    expect(store.stats.xp).toBe(xpAfterComplete);
  });

  it('ignores toggling an unknown id', () => {
    const { store } = bindPresenter();
    const before = store.todos.length;
    store.toggleTodo('nope');
    expect(store.todos).toHaveLength(before);
  });

  it('removes a single todo and clears only completed ones', () => {
    const { store } = bindPresenter();
    const [first] = store.todos;
    store.toggleTodo(first.id);
    store.removeTodo(first.id);
    expect(store.todos.some((t) => t.id === first.id)).toBe(false);

    store.toggleTodo(store.todos[0].id);
    const remaining = store.todos.length;
    store.clearCompletedTodos();
    expect(store.todos.length).toBeLessThan(remaining);
    expect(store.todos.every((t) => !t.done)).toBe(true);
  });
});

describe('careStore pomodoro', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  it('clamps the requested duration into the supported window', () => {
    const { store } = bindPresenter();
    store.startPomodoro(9999, 'focus', '过长');
    expect(store.pomodoro.totalSec).toBe(180 * 60);

    store.stopPomodoro();
    store.startPomodoro(0, 'focus', '过短');
    expect(store.pomodoro.totalSec).toBe(60);
  });

  it('counts down one second per tick', () => {
    const { store } = bindPresenter();
    store.startPomodoro(25, 'focus', '冲刺');
    expect(store.pomodoro.remainingSec).toBe(1500);

    vi.advanceTimersByTime(3000);
    expect(store.pomodoro.remainingSec).toBe(1497);
  });

  it('completes at zero, credits focus runs and releases the timer', () => {
    const { store, scheduled } = bindPresenter();
    const completedBefore = store.stats.completedPomodoros;
    store.startPomodoro(1, 'focus', '冲刺');

    vi.advanceTimersByTime(60_000);

    expect(store.pomodoro.running).toBe(false);
    expect(store.pomodoro.remainingSec).toBe(0);
    expect(store.stats.completedPomodoros).toBe(completedBefore + 1);
    expect(scheduled.some((t) => t.text.includes('专注冲刺达成'))).toBe(true);

    // A released interval cannot re-fire, so further time must change nothing.
    const scheduledAfter = scheduled.length;
    vi.advanceTimersByTime(120_000);
    expect(scheduled).toHaveLength(scheduledAfter);
    expect(store.stats.completedPomodoros).toBe(completedBefore + 1);
  });

  it('does not credit xp for a completed break', () => {
    const { store } = bindPresenter();
    const completedBefore = store.stats.completedPomodoros;
    store.startPomodoro(1, 'short_break', '休息');
    vi.advanceTimersByTime(60_000);
    expect(store.stats.completedPomodoros).toBe(completedBefore);
  });

  it('restores the full duration on reset and stops counting', () => {
    const { store } = bindPresenter();
    store.startPomodoro(10, 'focus', '冲刺');
    vi.advanceTimersByTime(5000);
    const stoppedAt = store.pomodoro.remainingSec;
    store.stopPomodoro();

    expect(store.pomodoro.running).toBe(false);
    expect(store.pomodoro.remainingSec).toBe(store.pomodoro.totalSec);

    vi.advanceTimersByTime(30_000);
    expect(store.pomodoro.remainingSec).toBe(store.pomodoro.totalSec);
    expect(store.pomodoro.remainingSec).not.toBe(stoppedAt);
  });

  it('restarts cleanly when a second timer replaces a running one', () => {
    const { store } = bindPresenter();
    store.startPomodoro(10, 'focus', '一');
    vi.advanceTimersByTime(2000);
    store.startPomodoro(20, 'focus', '二');

    expect(store.pomodoro.totalSec).toBe(1200);
    expect(store.pomodoro.remainingSec).toBe(1200);

    // Only one timer may be live: a leaked interval would double the countdown rate.
    vi.advanceTimersByTime(10_000);
    expect(store.pomodoro.remainingSec).toBe(1190);
  });

  it('formats the clock with a zero padded minute and second', () => {
    const { store } = bindPresenter();
    store.pomodoro = { ...store.pomodoro, remainingSec: 65 };
    expect(store.formattedPomodoroTime).toBe('01:05');
    store.pomodoro = { ...store.pomodoro, remainingSec: 3600 };
    expect(store.formattedPomodoroTime).toBe('60:00');
  });

  it('propagates a label edit to the other windows', () => {
    const { store } = bindPresenter();
    store.setPomodoroTaskLabel('  重构调度器  ');
    expect(store.pomodoro.taskLabel).toBe('重构调度器');

    store.setPomodoroTaskLabel('   ');
    expect(store.pomodoro.taskLabel).toBe('深度代码冲刺');
  });
});

describe('careStore cross-window ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('forwards timer commands to the master window instead of running locally', () => {
    const { store } = bindPresenter();
    store.initCareSync(false);

    store.startPomodoro(25, 'focus', '转发');
    expect(store.pomodoro.running).toBe(false);
    expect(store.pomodoro.totalSec).toBe(DEFAULT_TOTAL);
  });

  it('runs the timer itself when it owns the master role', () => {
    const { store } = bindPresenter();
    store.initCareSync(true);
    store.startPomodoro(25, 'focus', '本地');
    expect(store.pomodoro.running).toBe(true);
    store.disposeCareSync();
  });
});

const DEFAULT_TOTAL = 25 * 60;
