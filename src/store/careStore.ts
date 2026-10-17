import { computed, ref, toRaw } from 'vue';
import { defineStore } from 'pinia';
import type { PetStatsState, PomodoroState, TodoItem } from '@/types/pet';
import { globalLipSync } from '@/utils/audioLipSync';
import { loadStorage, saveStorage } from '@/utils/storage';
import {
  POMODORO_DEFAULT_MINUTES,
  POMODORO_MAX_MINUTES,
  POMODORO_MIN_MINUTES,
  POMODORO_TICK_MS,
  TODO_ID_PREFIX,
} from '@/constants/timing';
import { CARE_MESSAGES, DEFAULT_FOCUS_LABEL } from '@/constants/messages';
import { NOOP_PRESENTER, type CarePresenter } from './carePresenter';

const STORAGE_KEYS = {
  STATS: 'desktop_pet_rpg_stats_v2',
  TODOS: 'desktop_pet_todos_v2',
} as const;

const CHANNEL_NAME = 'desktop_pet_care_bus';
const LEVEL_XP_GROWTH = 1.25;
const XP_PER_COMPLETED_POMODORO = 60;
const XP_PER_COMPLETED_TODO = 20;

function defaultStats(): PetStatsState {
  return {
    level: 3,
    xp: 140,
    xpToNext: 300,
    affinity: 78,
    mood: 92,
    energy: 88,
    totalInteractions: 24,
    completedPomodoros: 4,
    filesAnalyzed: 6,
  };
}

function defaultPomodoro(): PomodoroState {
  return {
    running: false,
    mode: 'focus',
    remainingSec: POMODORO_DEFAULT_MINUTES * 60,
    totalSec: POMODORO_DEFAULT_MINUTES * 60,
    taskLabel: DEFAULT_FOCUS_LABEL,
  };
}

function seededTodos(): TodoItem[] {
  return [
    {
      id: 'todo_1',
      text: '体验右键【双轨陀螺仪星盘】与四大旗舰机体切换',
      done: false,
      createdAt: Date.now() - 3600_000,
      priority: 'high',
    },
    {
      id: 'todo_2',
      text: '开启一个 25 分钟番茄专注冲刺',
      done: false,
      createdAt: Date.now() - 1800_000,
      priority: 'normal',
    },
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const useCareStore = defineStore('careStore', () => {
  const isMasterWindow = ref(true);
  const stats = ref<PetStatsState>(loadStorage(STORAGE_KEYS.STATS, defaultStats()));
  const pomodoro = ref<PomodoroState>(defaultPomodoro());
  const todos = ref<TodoItem[]>(loadStorage(STORAGE_KEYS.TODOS, seededTodos()));

  const xpProgressPercent = computed(() =>
    Math.min(100, Math.round((stats.value.xp / Math.max(1, stats.value.xpToNext)) * 100))
  );

  const pomoProgressPercent = computed(() => {
    const elapsed = Math.max(0, pomodoro.value.totalSec - pomodoro.value.remainingSec);
    return Math.min(100, Math.round((elapsed / Math.max(1, pomodoro.value.totalSec)) * 100));
  });

  const formattedPomodoroTime = computed(() => {
    const mins = Math.floor(pomodoro.value.remainingSec / 60);
    const secs = pomodoro.value.remainingSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  });

  // Per-instance runtime state. Keeping these inside the store closure means each
  // window owns exactly one timer and one bus binding, and neither can leak into
  // another store instance or survive disposal.
  let presenter: CarePresenter = NOOP_PRESENTER;
  let tickTimer: number | null = null;
  let busBound = false;

  function bindPresenter(next: CarePresenter): void {
    presenter = next;
  }

  function stopTicking(): void {
    if (tickTimer === null) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  function playTone(tone: 'feed' | 'levelup' | 'pomo'): void {
    const prefs = presenter.audioPrefs();
    if (prefs.dnd) return;
    globalLipSync.playUiFeedbackTone(tone, prefs.volume);
  }

  const bus =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

  /**
   * Detaches a state tree from Vue reactivity.
   *
   * `BroadcastChannel.postMessage` runs the structured clone algorithm, which throws on
   * a reactive proxy. Broadcasting `todos` directly raised a DataCloneError on every
   * mutation, so every outgoing payload is flattened first.
   */
  function plain<T>(value: T): T {
    return structuredClone(toRaw(value));
  }

  /**
   * Reads the todo list without reactivity.
   *
   * Spreading or mapping the reactive array yields reactive element objects, which would
   * then be written back into state and break cloning on publish.
   */
  function currentTodos(): TodoItem[] {
    return toRaw(todos.value);
  }

  function publishStats(): void {
    saveStorage(STORAGE_KEYS.STATS, stats.value);
    bus?.postMessage({ stats: plain(stats.value) });
  }

  function publishTodos(): void {
    saveStorage(STORAGE_KEYS.TODOS, todos.value);
    bus?.postMessage({ todos: plain(todos.value) });
  }

  function publishPomodoro(): void {
    bus?.postMessage({ pomodoro: plain(pomodoro.value) });
  }

  function setPomodoroTaskLabel(label: string): void {
    const clean = label.trim() || DEFAULT_FOCUS_LABEL;
    if (pomodoro.value.taskLabel === clean) return;
    pomodoro.value = { ...pomodoro.value, taskLabel: clean };
    publishPomodoro();
  }

  function addXpAndAffinity(xpDelta: number, affinityDelta = 1, moodDelta = 1): void {
    stats.value = {
      ...stats.value,
      totalInteractions: stats.value.totalInteractions + 1,
      xp: stats.value.xp + xpDelta,
      affinity: clamp(stats.value.affinity + affinityDelta, 0, 100),
      mood: clamp(stats.value.mood + moodDelta, 0, 100),
    };

    let next = stats.value;
    let leveledUp = false;
    while (next.xp >= next.xpToNext) {
      next = {
        ...next,
        xp: next.xp - next.xpToNext,
        level: next.level + 1,
        xpToNext: Math.round(next.xpToNext * LEVEL_XP_GROWTH),
        energy: 100,
      };
      leveledUp = true;
    }
    stats.value = next;
    publishStats();

    if (!leveledUp) return;
    playTone('levelup');
    presenter.schedule({
      priority: 'P0',
      motion: 'happy',
      expression: 'smile',
      text: CARE_MESSAGES.levelUp(presenter.audioPrefs().petName, stats.value.level),
      durationMs: 5200,
    });
  }

  function feedCareItem(itemName: string, energyGain: number, affinityGain: number, xpGain: number): void {
    playTone('feed');
    stats.value = {
      ...stats.value,
      energy: Math.min(100, stats.value.energy + energyGain),
    };
    addXpAndAffinity(xpGain, affinityGain, 5);
    presenter.schedule({
      priority: 'P1',
      motion: 'feed',
      expression: 'smile',
      text: CARE_MESSAGES.fed(
        itemName,
        energyGain,
        stats.value.energy,
        stats.value.affinity,
        xpGain
      ),
      durationMs: 4200,
    });
  }

  function completePomodoro(): void {
    playTone('pomo');
    const wasFocus = pomodoro.value.mode === 'focus';
    if (wasFocus) {
      stats.value = {
        ...stats.value,
        completedPomodoros: stats.value.completedPomodoros + 1,
      };
      addXpAndAffinity(XP_PER_COMPLETED_POMODORO, 5, 8);
    }
    publishPomodoro();

    presenter.schedule({
      priority: 'P0',
      motion: 'happy',
      expression: 'smile',
      text: wasFocus
        ? CARE_MESSAGES.focusCompleted(pomodoro.value.taskLabel)
        : CARE_MESSAGES.breakCompleted,
      durationMs: 7500,
      quickReplies: wasFocus
        ? [
            {
              label: CARE_MESSAGES.breakQuickReply,
              action: {
                type: 'emit',
                app_id: 'internal',
                event: 'pomodoro.start',
                payload: CARE_MESSAGES.breakQuickReplyPayload,
              },
            },
            {
              label: CARE_MESSAGES.focusQuickReply,
              action: {
                type: 'emit',
                app_id: 'internal',
                event: 'pomodoro.start',
                payload: {
                  minutes: POMODORO_DEFAULT_MINUTES,
                  mode: 'focus',
                  label: pomodoro.value.taskLabel,
                },
              },
            },
          ]
        : [
            {
              label: CARE_MESSAGES.nextFocusQuickReply,
              action: {
                type: 'emit',
                app_id: 'internal',
                event: 'pomodoro.start',
                payload: {
                  minutes: POMODORO_DEFAULT_MINUTES,
                  mode: 'focus',
                  label: DEFAULT_FOCUS_LABEL,
                },
              },
            },
          ],
    });
  }

  function startPomodoro(
    minutes: number = POMODORO_DEFAULT_MINUTES,
    mode: PomodoroState['mode'] = 'focus',
    label: string = DEFAULT_FOCUS_LABEL
  ): void {
    if (!isMasterWindow.value) {
      bus?.postMessage({ rpcPomodoro: { cmd: 'start', minutes, mode, label } });
      return;
    }

    stopTicking();
    // A missing argument falls back to the default, but an explicit 0 clamps to the
    // minimum rather than silently becoming a full session.
    const requested = Number(minutes);
    const clamped = clamp(
      Number.isFinite(requested) ? requested : POMODORO_DEFAULT_MINUTES,
      POMODORO_MIN_MINUTES,
      POMODORO_MAX_MINUTES
    );
    const totalSec = Math.round(clamped * 60);
    pomodoro.value = { running: true, mode, remainingSec: totalSec, totalSec, taskLabel: label };
    publishPomodoro();

    presenter.schedule({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text:
        mode === 'focus'
          ? CARE_MESSAGES.focusStarted(clamped, label)
          : CARE_MESSAGES.breakStarted(clamped),
      durationMs: 4200,
    });

    tickTimer = window.setInterval(() => {
      if (!pomodoro.value.running) return;
      if (pomodoro.value.remainingSec > 1) {
        pomodoro.value = { ...pomodoro.value, remainingSec: pomodoro.value.remainingSec - 1 };
        publishPomodoro();
        return;
      }
      pomodoro.value = { ...pomodoro.value, remainingSec: 0, running: false };
      stopTicking();
      completePomodoro();
    }, POMODORO_TICK_MS);
  }

  function togglePomodoroPause(): void {
    if (!isMasterWindow.value) {
      bus?.postMessage({ rpcPomodoro: { cmd: 'pause' } });
      return;
    }
    pomodoro.value = { ...pomodoro.value, running: !pomodoro.value.running };
    publishPomodoro();
  }

  function stopPomodoro(): void {
    if (!isMasterWindow.value) {
      bus?.postMessage({ rpcPomodoro: { cmd: 'stop' } });
      return;
    }
    stopTicking();
    pomodoro.value = {
      ...pomodoro.value,
      running: false,
      remainingSec: pomodoro.value.totalSec,
    };
    publishPomodoro();
    presenter.schedule({
      priority: 'P2',
      motion: 'pat',
      expression: 'neutral',
      text: CARE_MESSAGES.stopped,
      durationMs: 3000,
    });
  }

  function addTodo(text: string, priority: TodoItem['priority'] = 'normal'): void {
    const clean = text.trim();
    if (!clean) return;
    todos.value = [
      {
        id: `${TODO_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        text: clean,
        done: false,
        createdAt: Date.now(),
        priority,
      },
      ...currentTodos(),
    ];
    publishTodos();
  }

  function toggleTodo(id: string): void {
    const current = currentTodos();
    const target = current.find((t) => t.id === id);
    if (!target) return;
    const done = !target.done;
    todos.value = current.map((t) => (t.id === id ? { ...t, done } : t));
    publishTodos();
    if (!done) return;

    addXpAndAffinity(XP_PER_COMPLETED_TODO, 2, 3);
    presenter.schedule({
      priority: 'P2',
      motion: 'happy',
      expression: 'smile',
      text: CARE_MESSAGES.todoDone(target.text),
      durationMs: 3400,
    });
  }

  function removeTodo(id: string): void {
    const current = currentTodos();
    const next = current.filter((t) => t.id !== id);
    if (next.length === current.length) return;
    todos.value = next;
    publishTodos();
  }

  function clearCompletedTodos(): void {
    const current = currentTodos();
    const next = current.filter((t) => !t.done);
    if (next.length === current.length) return;
    todos.value = next;
    publishTodos();
  }

  function registerFilesAnalyzed(count: number): void {
    if (count <= 0) return;
    stats.value = { ...stats.value, filesAnalyzed: stats.value.filesAnalyzed + count };
    publishStats();
  }

  function initCareSync(master: boolean): void {
    isMasterWindow.value = master;
    if (busBound || !bus) return;
    busBound = true;

    bus.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.stats) stats.value = data.stats;
      if (data.pomodoro) pomodoro.value = data.pomodoro;
      if (data.todos) todos.value = data.todos;
      if (!isMasterWindow.value || !data.rpcPomodoro) return;

      const { cmd, minutes, mode, label } = data.rpcPomodoro;
      if (cmd === 'start') startPomodoro(minutes, mode, label);
      else if (cmd === 'pause') togglePomodoroPause();
      else if (cmd === 'stop') stopPomodoro();
    };
  }

  function disposeCareSync(): void {
    stopTicking();
  }

  return {
    isMasterWindow,
    stats,
    pomodoro,
    todos,
    xpProgressPercent,
    pomoProgressPercent,
    formattedPomodoroTime,
    bindPresenter,
    initCareSync,
    disposeCareSync,
    addXpAndAffinity,
    feedCareItem,
    addTodo,
    toggleTodo,
    removeTodo,
    clearCompletedTodos,
    registerFilesAnalyzed,
    setPomodoroTaskLabel,
    startPomodoro,
    togglePomodoroPause,
    stopPomodoro,
  };
});
