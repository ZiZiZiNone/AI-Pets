import { defineStore } from 'pinia';
import type {
  PetStatsState,
  PomodoroState,
  ScheduledPetTask,
  TodoItem,
} from '@/types/pet';
import { globalLipSync } from '@/utils/audioLipSync';

const careBus = new BroadcastChannel('desktop_pet_care_bus');

const STORAGE_KEYS = {
  STATS: 'desktop_pet_rpg_stats_v2',
  TODOS: 'desktop_pet_todos_v2',
};

function loadStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(fallback)
      ? ((Array.isArray(parsed) ? parsed : fallback) as T)
      : { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

let pomoTimer: number | null = null;
let careBusInitialized = false;

export const useCareStore = defineStore('careStore', {
  state: () => ({
    isMasterWindow: true,
    stats: loadStorage<PetStatsState>(STORAGE_KEYS.STATS, {
      level: 3,
      xp: 140,
      xpToNext: 300,
      affinity: 78,
      mood: 92,
      energy: 88,
      totalInteractions: 24,
      completedPomodoros: 4,
      filesAnalyzed: 6,
    }),
    pomodoro: {
      running: false,
      mode: 'focus',
      remainingSec: 25 * 60,
      totalSec: 25 * 60,
      taskLabel: '深度代码冲刺',
    } as PomodoroState,
    todos: loadStorage<TodoItem[]>(STORAGE_KEYS.TODOS, [
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
    ]),
  }),

  getters: {
    xpProgressPercent(state): number {
      return Math.min(100, Math.round((state.stats.xp / Math.max(1, state.stats.xpToNext)) * 100));
    },
    pomoProgressPercent(state): number {
      const elapsed = Math.max(0, state.pomodoro.totalSec - state.pomodoro.remainingSec);
      return Math.min(100, Math.round((elapsed / Math.max(1, state.pomodoro.totalSec)) * 100));
    },
    formattedPomodoroTime(state): string {
      const mins = Math.floor(state.pomodoro.remainingSec / 60);
      const secs = state.pomodoro.remainingSec % 60;
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    },
  },

  actions: {
    initCareSync(
      isMaster: boolean,
      onScheduleAction: (task: ScheduledPetTask) => void,
      getAudioPrefs: () => { dnd: boolean; volume: number; petName: string }
    ): void {
      this.isMasterWindow = isMaster;
      if (careBusInitialized) return;
      careBusInitialized = true;

      careBus.onmessage = (ev) => {
        const data = ev.data;
        if (!data || typeof data !== 'object') return;
        if (data.stats) this.stats = data.stats;
        if (data.pomodoro) this.pomodoro = data.pomodoro;
        if (data.todos) this.todos = data.todos;
        if (this.isMasterWindow && data.rpcPomodoro) {
          const { cmd, minutes, mode, label } = data.rpcPomodoro;
          if (cmd === 'start') this.startPomodoro(minutes, mode, label, onScheduleAction, getAudioPrefs);
          else if (cmd === 'pause') this.togglePomodoroPause();
          else if (cmd === 'stop') this.stopPomodoro(onScheduleAction);
        }
      };
    },

    addXpAndAffinity(
      xpDelta: number,
      affinityDelta = 1,
      moodDelta = 1,
      onScheduleAction?: (task: ScheduledPetTask) => void,
      audioPrefs?: { dnd: boolean; volume: number; petName: string }
    ): void {
      this.stats.totalInteractions += 1;
      this.stats.xp += xpDelta;
      this.stats.affinity = Math.min(100, Math.max(0, this.stats.affinity + affinityDelta));
      this.stats.mood = Math.min(100, Math.max(0, this.stats.mood + moodDelta));

      let leveledUp = false;
      while (this.stats.xp >= this.stats.xpToNext) {
        this.stats.xp -= this.stats.xpToNext;
        this.stats.level += 1;
        this.stats.xpToNext = Math.round(this.stats.xpToNext * 1.25);
        this.stats.energy = 100;
        leveledUp = true;
      }
      this.persistStats();

      if (leveledUp && onScheduleAction) {
        if (audioPrefs && !audioPrefs.dnd) {
          globalLipSync.playUiFeedbackTone('levelup', audioPrefs.volume);
        }
        onScheduleAction({
          priority: 'P0',
          motion: 'happy',
          expression: 'smile',
          text: `🎉 羁绊突破！[${audioPrefs?.petName || 'CORE'}] 升至 Lv.${this.stats.level}！能量已满载 ✨`,
          durationMs: 5200,
        });
      }
    },

    feedCareItem(
      itemName: string,
      energyGain: number,
      affinityGain: number,
      xpGain: number,
      onScheduleAction: (task: ScheduledPetTask) => void,
      audioPrefs: { dnd: boolean; volume: number; petName: string }
    ): void {
      if (!audioPrefs.dnd) {
        globalLipSync.playUiFeedbackTone('feed', audioPrefs.volume);
      }
      this.stats.energy = Math.min(100, this.stats.energy + energyGain);
      this.addXpAndAffinity(xpGain, affinityGain, 5, onScheduleAction, audioPrefs);
      onScheduleAction({
        priority: 'P1',
        motion: 'feed',
        expression: 'smile',
        text: `🍬 已吸收【${itemName}】！能量 +${energyGain}% (当前 ${this.stats.energy}%) · 好感度 ${this.stats.affinity}% · EXP +${xpGain} ✨`,
        durationMs: 4200,
      });
    },

    persistStats(): void {
      try {
        localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(this.stats));
      } catch {
        // Ignore quota error
      }
      careBus.postMessage({ stats: { ...this.stats } });
    },

    startPomodoro(
      minutes = 25,
      mode: 'focus' | 'short_break' | 'long_break' = 'focus',
      label = '深度代码冲刺',
      onScheduleAction?: (task: ScheduledPetTask) => void,
      getAudioPrefs?: () => { dnd: boolean; volume: number; petName: string }
    ): void {
      if (!this.isMasterWindow) {
        careBus.postMessage({ rpcPomodoro: { cmd: 'start', minutes, mode, label } });
        return;
      }

      if (pomoTimer !== null) {
        clearInterval(pomoTimer);
        pomoTimer = null;
      }

      const clampedMins = Math.min(180, Math.max(1, Number(minutes) || 25));
      const totalSec = Math.round(clampedMins * 60);
      this.pomodoro = {
        running: true,
        mode,
        remainingSec: totalSec,
        totalSec,
        taskLabel: label,
      };
      careBus.postMessage({ pomodoro: { ...this.pomodoro } });

      onScheduleAction?.({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text:
          mode === 'focus'
            ? `🍅 番茄专注已启动（${clampedMins} 分钟：${label}）！我会安静陪伴你冲刺~`
            : `🍵 护眼休息已启动（${clampedMins} 分钟），起身喝口水、远眺放松一下吧！`,
        durationMs: 4200,
      });

      pomoTimer = window.setInterval(() => {
        if (!this.pomodoro.running) return;
        if (this.pomodoro.remainingSec > 1) {
          this.pomodoro.remainingSec -= 1;
          careBus.postMessage({ pomodoro: { ...this.pomodoro } });
        } else {
          this.pomodoro.remainingSec = 0;
          this.pomodoro.running = false;
          if (pomoTimer !== null) {
            clearInterval(pomoTimer);
            pomoTimer = null;
          }
          this.completePomodoro(onScheduleAction, getAudioPrefs?.());
        }
      }, 1000);
    },

    togglePomodoroPause(): void {
      if (!this.isMasterWindow) {
        careBus.postMessage({ rpcPomodoro: { cmd: 'pause' } });
        return;
      }
      this.pomodoro.running = !this.pomodoro.running;
      careBus.postMessage({ pomodoro: { ...this.pomodoro } });
    },

    stopPomodoro(onScheduleAction?: (task: ScheduledPetTask) => void): void {
      if (!this.isMasterWindow) {
        careBus.postMessage({ rpcPomodoro: { cmd: 'stop' } });
        return;
      }
      if (pomoTimer !== null) {
        clearInterval(pomoTimer);
        pomoTimer = null;
      }
      this.pomodoro.running = false;
      this.pomodoro.remainingSec = this.pomodoro.totalSec;
      careBus.postMessage({ pomodoro: { ...this.pomodoro } });
      onScheduleAction?.({
        priority: 'P2',
        motion: 'pat',
        expression: 'neutral',
        text: '⏹️ 当前番茄计时已重置，随时准备开启下一轮专注！',
        durationMs: 3000,
      });
    },

    completePomodoro(
      onScheduleAction?: (task: ScheduledPetTask) => void,
      audioPrefs?: { dnd: boolean; volume: number; petName: string }
    ): void {
      if (audioPrefs && !audioPrefs.dnd) {
        globalLipSync.playUiFeedbackTone('pomo', audioPrefs.volume);
      }
      const wasFocus = this.pomodoro.mode === 'focus';
      if (wasFocus) {
        this.stats.completedPomodoros += 1;
        this.addXpAndAffinity(60, 5, 8, onScheduleAction, audioPrefs);
      }
      careBus.postMessage({ pomodoro: { ...this.pomodoro } });

      onScheduleAction?.({
        priority: 'P0',
        motion: 'happy',
        expression: 'smile',
        text: wasFocus
          ? `🏆 专注冲刺达成！【${this.pomodoro.taskLabel}】圆满完成，获得 +60 EXP！现在休息 5 分钟吧？`
          : '⚡ 休息结束！精力已恢复满格，准备好开启下一轮专注了吗？',
        durationMs: 7500,
        quickReplies: wasFocus
          ? [
              {
                label: '🍵 开启5m休息',
                action: {
                  type: 'emit',
                  app_id: 'internal',
                  event: 'pomodoro.start',
                  payload: { minutes: 5, mode: 'short_break', label: '护眼补水休息' },
                },
              },
              {
                label: '🔥 再战25m',
                action: {
                  type: 'emit',
                  app_id: 'internal',
                  event: 'pomodoro.start',
                  payload: { minutes: 25, mode: 'focus', label: this.pomodoro.taskLabel },
                },
              },
            ]
          : [
              {
                label: '🔥 开启25m专注',
                action: {
                  type: 'emit',
                  app_id: 'internal',
                  event: 'pomodoro.start',
                  payload: { minutes: 25, mode: 'focus', label: '深度代码冲刺' },
                },
              },
            ],
      });
    },

    addTodo(text: string, priority: 'high' | 'normal' | 'low' = 'normal'): void {
      const clean = text.trim();
      if (!clean) return;
      this.todos.unshift({
        id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        text: clean,
        done: false,
        createdAt: Date.now(),
        priority,
      });
      this.persistTodos();
    },

    toggleTodo(
      id: string,
      onScheduleAction?: (task: ScheduledPetTask) => void,
      audioPrefs?: { dnd: boolean; volume: number; petName: string }
    ): void {
      const item = this.todos.find((t) => t.id === id);
      if (!item) return;
      item.done = !item.done;
      this.persistTodos();
      if (item.done) {
        this.addXpAndAffinity(20, 2, 3, onScheduleAction, audioPrefs);
        onScheduleAction?.({
          priority: 'P2',
          motion: 'happy',
          expression: 'smile',
          text: `✅ 任务达成：【${item.text}】！奖励 +20 EXP ✨`,
          durationMs: 3400,
        });
      }
    },

    removeTodo(id: string): void {
      this.todos = this.todos.filter((t) => t.id !== id);
      this.persistTodos();
    },

    clearCompletedTodos(): void {
      const next = this.todos.filter((t) => !t.done);
      if (next.length !== this.todos.length) {
        this.todos = next;
        this.persistTodos();
      }
    },

    persistTodos(): void {
      try {
        localStorage.setItem(STORAGE_KEYS.TODOS, JSON.stringify(this.todos));
      } catch {
        // Ignore quota error
      }
      careBus.postMessage({ todos: [...this.todos] });
    },
  },
});
