import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type {
  ActionPriority,
  CanonicalPetState,
  DesktopWindowState,
  HostSettings,
  LipSyncFrame,
  LlmBridgeConfig,
  MenuItemSchema,
  PetActionConfig,
  PetManifest,
  PetStatsState,
  PetThemePalette,
  PomodoroState,
  QuickReplyChip,
  ScheduledPetTask,
  TodoItem,
} from '@/types/pet';
import {
  DEFAULT_HOST_SETTINGS,
  FALLBACK_PET_MANIFEST,
  fetchWebFallbackBundle,
  parseGlobalMenuYaml,
  parseHostSettingsYaml,
  parsePetManifestYaml,
  serializeHostSettingsYaml,
  serializePetManifestYaml,
} from '@/utils/yamlLoader';
import { executeChatOrSlashCommand, pickDailyFortune } from '@/utils/commandEngine';
import {
  executeExternalSafeAction,
  executeInternalStageEvent,
  executeStagePetAction,
  snapStageToForeground,
  startStageAutonomousLoop,
  syncDesktopFullscreenState,
} from '@/utils/stageRuntime';
import { globalLipSync } from '@/utils/audioLipSync';
import { useCareStore } from './careStore';
import { PET_THEMES, resolvePetTheme, themeToCssVars } from './themes';

export { PET_THEMES, resolvePetTheme, themeToCssVars };

const stageBus = new BroadcastChannel('desktop_pet_stage_bus');
const PRIORITY_RANK: Record<ActionPriority, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
const STORAGE_KEYS = {
  LLM: 'desktop_pet_llm_config_v2',
  HISTORY: 'desktop_pet_cmd_history_v2',
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

let actionTimer: number | null = null;
let syncInitialized = false;

export const usePetStore = defineStore('petStore', {
  state: () => ({
    windowRole: 'main' as 'main' | 'companion',
    revision: 0,
    active_pet_id: 'aether_mecha_core',
    emotion: 'idle',
    is_click_through: false,
    volume: 0.85,
    studio_mode: false,
    inline_hud: true,
    dnd_mode: false,
    settings: structuredClone(DEFAULT_HOST_SETTINGS) as HostSettings,
    availablePets: [structuredClone(FALLBACK_PET_MANIFEST)] as PetManifest[],
    currentPet: structuredClone(FALLBACK_PET_MANIFEST) as PetManifest | null,
    globalMenus: [] as MenuItemSchema[],
    externalMenusByApp: {} as Record<string, MenuItemSchema[]>,
    radialMenuOpen: false,
    studioOpen: false,
    quickChatOpen: false,
    showMiniStatusBar: true,
    isDraggingWindow: false,
    isClimbedOnWindow: false,
    isEdgePeeked: false,
    activeMotion: 'idle',
    activeExpression: 'neutral',
    bubbleText: '',
    bubbleQuickReplies: [] as QuickReplyChip[],
    currentAction: null as ScheduledPetTask | null,
    actionQueue: [] as ScheduledPetTask[],
    lipSync: { mouthOpenY: 0, mouthFormX: 0, rms: 0, bands: [0, 0, 0, 0, 0, 0, 0] } as LipSyncFrame,
    lastUserActivityAt: Date.now(),
    fpsOverride: 'dynamic' as 'dynamic' | '60' | '30',
    commandHistory: loadStorage<string[]>(STORAGE_KEYS.HISTORY, ['/focus 25', '/fortune', '/sys']),
    llmConfig: loadStorage<LlmBridgeConfig>(STORAGE_KEYS.LLM, {
      enabled: false,
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: '',
      model: 'gpt-4o-mini',
      customSystemPrompt: '',
    }),
  }),

  getters: {
    activeTheme(state): PetThemePalette {
      return resolvePetTheme(state.currentPet?.id || state.active_pet_id);
    },
    activeThemeCssVars(): Record<string, string> {
      return themeToCssVars(this.activeTheme);
    },
    mouthOpenY(state): number {
      return state.lipSync.mouthOpenY;
    },
    stats(): PetStatsState {
      return useCareStore().stats;
    },
    pomodoro(): PomodoroState {
      return useCareStore().pomodoro;
    },
    todos(): TodoItem[] {
      return useCareStore().todos;
    },
    xpProgressPercent(): number {
      return useCareStore().xpProgressPercent;
    },
    formattedPomodoroTime(): string {
      return useCareStore().formattedPomodoroTime;
    },
    mergedMenuTree(state): MenuItemSchema[] {
      return [
        ...(state.currentPet?.menus || []),
        ...state.globalMenus,
        ...Object.values(state.externalMenusByApp).flat(),
      ];
    },
    effectiveTargetFps(state): number {
      if (state.fpsOverride === '60') return 60;
      if (state.fpsOverride === '30') return 30;
      const idleMs = Date.now() - state.lastUserActivityAt;
      if (
        idleMs > (state.settings.render.idle_timeout_ms || 5000) &&
        !state.currentAction &&
        !state.radialMenuOpen &&
        !state.studioOpen
      ) {
        return state.settings.render.idle_fps || 24;
      }
      return state.settings.render.active_fps || 60;
    },
  },

  actions: {
    getAudioPrefs() {
      return {
        dnd: this.dnd_mode,
        volume: this.volume,
        petName: this.currentPet?.name || 'AETHER-VII',
      };
    },

    async initializeHost(role: 'main' | 'companion' = 'main'): Promise<void> {
      this.windowRole = role;
      useCareStore().initCareSync(
        role === 'main',
        (task) => this.scheduleAction(task),
        () => this.getAudioPrefs()
      );
      await this.initCrossWindowSync();

      try {
        const bundle = await invoke<{
          settings_yaml?: string;
          global_menu_yaml?: string;
          pets?: Array<{ id: string; yaml: string; base_path: string }>;
        }>('load_host_configs');

        if (bundle.settings_yaml) this.settings = parseHostSettingsYaml(bundle.settings_yaml);
        if (bundle.global_menu_yaml) {
          this.globalMenus = parseGlobalMenuYaml(bundle.global_menu_yaml).menus;
        }
        if (Array.isArray(bundle.pets) && bundle.pets.length > 0) {
          this.availablePets = bundle.pets.map((entry) => {
            const manifest = parsePetManifestYaml(entry.yaml, entry.id);
            manifest.basePath = entry.base_path;
            return manifest;
          });
        }
      } catch {
        const fallback = await fetchWebFallbackBundle();
        this.settings = fallback.settings;
        this.globalMenus = fallback.globalMenus;
        this.availablePets = fallback.pets;
      }

      const defaultId =
        this.active_pet_id || this.settings.host.default_pet || 'aether_mecha_core';
      const matched =
        this.availablePets.find((p) => p.id === defaultId) ||
        this.availablePets[0] ||
        structuredClone(FALLBACK_PET_MANIFEST);

      this.currentPet = matched;
      this.active_pet_id = matched.id;
      globalLipSync.setGainMultiplier((this.settings.audio.rms_gain || 3.2) * 25);
      globalLipSync.setRmsSmoothing(this.settings.audio.rms_smoothing || 0.75);

      if (this.windowRole === 'main') startStageAutonomousLoop(this);
    },

    async initCrossWindowSync(): Promise<void> {
      if (syncInitialized) return;
      syncInitialized = true;

      try {
        this.applySnapshot(await invoke<CanonicalPetState>('get_canonical_state'));
      } catch {
        // Standalone preview
      }

      try {
        await listen<CanonicalPetState>('pet-state:sync', (ev) => this.applySnapshot(ev.payload));

        if (this.windowRole === 'main') {
          await listen<{
            msg_type: string;
            text?: string;
            emotion?: string;
            motion?: string;
            duration_ms?: number;
            priority?: number;
            action?: { action_id: string; params?: Record<string, unknown> };
          }>('ws-external-command', (ev) => {
            const p = ev.payload;
            const prio: ActionPriority =
              p.priority && p.priority >= 2 ? 'P0' : p.priority === 1 ? 'P1' : 'P2';
            if (p.msg_type === 'speak' && p.text) {
              this.scheduleAction({
                priority: prio,
                motion: p.motion || 'happy',
                expression: p.emotion || 'smile',
                text: p.text,
                durationMs: p.duration_ms || 4200,
              });
            } else if (p.msg_type === 'safe_action' && p.action) {
              executeExternalSafeAction(this, p.action.action_id, p.action.params || {}, prio);
            }
          });
        }
      } catch {
        // Outside Tauri webview
      }

      stageBus.onmessage = (ev) => {
        const data = ev.data;
        if (!data || typeof data !== 'object') return;
        if (data.lipSync) this.lipSync = data.lipSync;
        if (data.fpsOverride) this.fpsOverride = data.fpsOverride;
        if (data.settings) {
          this.settings = data.settings;
          globalLipSync.setGainMultiplier((this.settings.audio.rms_gain || 3.2) * 25);
          globalLipSync.setRmsSmoothing(this.settings.audio.rms_smoothing || 0.75);
        }
        if (this.windowRole === 'main' && data.scheduledAction) {
          this.scheduleAction(data.scheduledAction, true);
        }
      };
    },

    applySnapshot(snap: CanonicalPetState): void {
      if (snap.revision <= this.revision) return;
      this.revision = snap.revision;
      if (snap.active_pet_id && snap.active_pet_id !== this.active_pet_id) {
        this.active_pet_id = snap.active_pet_id;
        const found = this.availablePets.find((p) => p.id === snap.active_pet_id);
        if (found) this.currentPet = found;
      }
      this.emotion = snap.emotion;
      this.is_click_through = snap.is_click_through;
      this.volume = snap.volume;
      this.studio_mode = snap.studio_mode;
      this.inline_hud = snap.inline_hud;
      if (typeof snap.dnd_mode === 'boolean') this.dnd_mode = snap.dnd_mode;
    },

    async dispatchPatch(patch: Partial<CanonicalPetState>): Promise<void> {
      try {
        this.applySnapshot(await invoke<CanonicalPetState>('mutate_canonical_state', { patch }));
      } catch {
        Object.assign(this, patch);
        this.revision += 1;
      }
    },

    broadcastLipSync(frame: LipSyncFrame): void {
      this.lipSync = frame;
      stageBus.postMessage({ lipSync: frame });
    },

    markUserActivity(): void {
      this.lastUserActivityAt = Date.now();
      if (this.activeMotion === 'sleep' && !this.currentAction) {
        this.activeMotion = 'idle';
        this.activeExpression = 'neutral';
      }
    },

    switchPetById(petId: string): void {
      const target = this.availablePets.find((p) => p.id === petId);
      if (!target) return;
      this.currentPet = target;
      this.active_pet_id = target.id;
      void this.dispatchPatch({ active_pet_id: target.id });
      this.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: `🧬 机体跃迁完成：已装载【${target.name}】// 主题切换至 ${this.activeTheme.name}！`,
        durationMs: 3800,
      });
    },

    scheduleAction(task: ScheduledPetTask, fromRemoteBus = false): void {
      this.markUserActivity();
      if (this.dnd_mode && task.priority === 'P3') return;

      const incoming: ScheduledPetTask = {
        ...task,
        id: task.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        durationMs: task.durationMs ?? 3800,
      };

      if (this.windowRole === 'companion' && !fromRemoteBus) {
        stageBus.postMessage({ scheduledAction: incoming });
        return;
      }

      if (!this.currentAction) {
        this.executeActionImmediately(incoming);
        return;
      }

      if (PRIORITY_RANK[incoming.priority] >= PRIORITY_RANK[this.currentAction.priority]) {
        if (this.currentAction.resumeAfterInterrupt) {
          this.actionQueue.unshift({ ...this.currentAction, resumeAfterInterrupt: false });
        }
        this.executeActionImmediately(incoming);
      } else {
        this.actionQueue.push(incoming);
        this.actionQueue.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
      }
    },

    executeActionImmediately(task: ScheduledPetTask): void {
      if (actionTimer !== null) clearTimeout(actionTimer);
      this.currentAction = task;
      if (task.motion) this.activeMotion = task.motion;
      if (task.expression) this.activeExpression = task.expression;
      this.bubbleText = task.text || '';
      this.bubbleQuickReplies = task.quickReplies || [];
      actionTimer = window.setTimeout(
        () => this.advanceActionQueue(),
        Math.max(800, task.durationMs || 3800)
      );
    },

    dismissCurrentBubble(): void {
      this.markUserActivity();
      this.advanceActionQueue();
    },

    advanceActionQueue(): void {
      if (actionTimer !== null) {
        clearTimeout(actionTimer);
        actionTimer = null;
      }
      this.currentAction = null;
      this.bubbleText = '';
      this.bubbleQuickReplies = [];
      if (this.actionQueue.length > 0) {
        this.executeActionImmediately(this.actionQueue.shift()!);
      } else {
        this.activeMotion = this.isClimbedOnWindow ? 'climb' : 'idle';
        this.activeExpression = 'neutral';
      }
    },

    addXpAndAffinity(xpDelta: number, affinityDelta = 1, moodDelta = 1): void {
      useCareStore().addXpAndAffinity(
        xpDelta,
        affinityDelta,
        moodDelta,
        (t) => this.scheduleAction(t),
        this.getAudioPrefs()
      );
    },

    feedPetCareItem(itemName: string, energy = 20, affinity = 6, xp = 25): void {
      useCareStore().feedCareItem(
        itemName,
        energy,
        affinity,
        xp,
        (t) => this.scheduleAction(t),
        this.getAudioPrefs()
      );
    },

    startPomodoro(
      minutes = 25,
      mode: 'focus' | 'short_break' | 'long_break' = 'focus',
      label = '深度代码冲刺'
    ): void {
      useCareStore().startPomodoro(
        minutes,
        mode,
        label,
        (t) => this.scheduleAction(t),
        () => this.getAudioPrefs()
      );
    },

    togglePomodoroPause(): void {
      useCareStore().togglePomodoroPause();
    },

    stopPomodoro(): void {
      useCareStore().stopPomodoro((t) => this.scheduleAction(t));
    },

    addTodo(text: string, priority: 'high' | 'normal' | 'low' = 'normal'): void {
      useCareStore().addTodo(text, priority);
    },

    toggleTodo(id: string): void {
      useCareStore().toggleTodo(id, (t) => this.scheduleAction(t), this.getAudioPrefs());
    },

    removeTodo(id: string): void {
      useCareStore().removeTodo(id);
    },

    clearCompletedTodos(): void {
      useCareStore().clearCompletedTodos();
    },

    async dispatchPetAction(action: PetActionConfig, extraPaths?: string[]): Promise<void> {
      await executeStagePetAction(this, action, extraPaths);
    },

    async handleInternalEvent(name: string, payload: Record<string, unknown>): Promise<void> {
      await executeInternalStageEvent(this, name, payload);
    },

    triggerFortuneDivination(): void {
      this.addXpAndAffinity(15, 3, 5);
      this.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: pickDailyFortune(),
        durationMs: 5500,
      });
    },

    async submitUserChatCommand(rawInput: string): Promise<void> {
      const input = rawInput.trim();
      if (!input) return;
      this.markUserActivity();
      this.commandHistory = [input, ...this.commandHistory.filter((i) => i !== input)].slice(0, 25);
      try {
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(this.commandHistory));
      } catch {
        // Ignore
      }
      this.addXpAndAffinity(6, 1, 1);
      await executeChatOrSlashCommand(this, input);
    },

    async evaluatePostDragSnap(): Promise<void> {
      await snapStageToForeground(this, true);
    },

    async handleDesktopWindowState(state: DesktopWindowState): Promise<void> {
      await syncDesktopFullscreenState(this, state);
    },

    registerExternalMenu(payload: {
      app_id: string;
      menus?: MenuItemSchema[];
      item?: MenuItemSchema;
    }): void {
      const { app_id, menus, item } = payload;
      if (!app_id) return;
      if (Array.isArray(menus)) {
        this.externalMenusByApp[app_id] = menus.map((m) => ({ ...m, app_id }));
      } else if (item) {
        const list = [...(this.externalMenusByApp[app_id] || [])];
        const idx = list.findIndex((m) => m.id === item.id);
        const tagged = { ...item, app_id };
        if (idx >= 0) list[idx] = tagged;
        else list.push(tagged);
        this.externalMenusByApp[app_id] = list;
      }
      this.scheduleAction({
        priority: 'P2',
        motion: 'happy',
        expression: 'smile',
        text: `🔌 外部应用 [${app_id}] 已挂载战术菜单！右键星盘即可调用。`,
        durationMs: 3600,
      });
    },

    unregisterExternalMenu(appId: string): void {
      if (this.externalMenusByApp[appId]) {
        delete this.externalMenusByApp[appId];
        void emit('hud-clear', { app_id: appId });
      }
    },

    saveLlmConfig(cfg: Partial<LlmBridgeConfig>): void {
      this.llmConfig = { ...this.llmConfig, ...cfg };
      try {
        localStorage.setItem(STORAGE_KEYS.LLM, JSON.stringify(this.llmConfig));
      } catch {
        // Ignore
      }
    },

    async saveHostSettings(): Promise<void> {
      stageBus.postMessage({ settings: JSON.parse(JSON.stringify(this.settings)) });
      try {
        await invoke('save_host_settings', {
          yamlContent: serializeHostSettingsYaml(this.settings),
        });
      } catch {
        // Browser fallback
      }
    },

    async saveCurrentPetManifest(): Promise<void> {
      if (!this.currentPet) return;
      const yamlContent = serializePetManifestYaml(this.currentPet);
      try {
        await invoke('save_pet_manifest', { petId: this.currentPet.id, yamlContent });
        this.scheduleAction({
          priority: 'P1',
          motion: 'happy',
          expression: 'smile',
          text: `💾 蓝图校准已持久化写入 pets/${this.currentPet.id}/pet.yaml！`,
          durationMs: 3800,
        });
      } catch {
        this.scheduleAction({
          priority: 'P1',
          motion: 'happy',
          expression: 'smile',
          text: `💾 蓝图参数已实时生效（Scale: ${this.currentPet.model.scale}x）！`,
          durationMs: 3400,
        });
      }
    },
  },
});
