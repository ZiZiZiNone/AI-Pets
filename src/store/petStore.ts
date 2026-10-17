import { computed, ref, toRaw } from 'vue';
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ActionPriority,
  CanonicalPetState,
  CompanionLoadPayload,
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
import { appendLlmTurn, executeChatOrSlashCommand, pickDailyFortune } from '@/utils/commandEngine';
import type { LlmChatMessage } from '@/utils/llmProviders';
import {
  executeExternalSafeAction,
  executeInternalStageEvent,
  executeStagePetAction,
  snapStageToForeground,
  startStageAutonomousLoop,
  syncDesktopFullscreenState,
} from '@/utils/stageRuntime';
import { globalLipSync } from '@/utils/audioLipSync';
import { loadStorage, saveStorage } from '@/utils/storage';
import {
  ACTION_ID_PREFIX,
  COMMAND_HISTORY_KEY,
  COMMAND_HISTORY_LIMIT,
  DEFAULT_ACTION_DURATION_MS,
  MIN_ACTION_DURATION_MS,
  VOICE_GAIN_PERCENT_SCALE,
} from '@/constants/timing';
import {
  DEFAULT_CARE_ITEM,
  DEFAULT_FOCUS_LABEL,
  DEFAULT_PET_NAME,
  FEDIBLE_QUANTUM_CRYSTAL,
  LLM_DEFAULT_MODEL,
  STAGE_MESSAGES,
} from '@/constants/messages';
import { useCareStore } from './careStore';
import type { AudioPrefs, CarePresenter } from './carePresenter';
import { resolvePetTheme, themeToCssVars } from './themes';

type WindowRole = 'main' | 'companion';
type FpsOverride = 'dynamic' | '60' | '30';

const STAGE_CHANNEL_NAME = 'desktop_pet_stage_bus';
const PRIORITY_RANK: Record<ActionPriority, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
const DEFAULT_PET_ID = 'aether_mecha_core';

const STORAGE_KEYS = {
  LLM: 'desktop_pet_llm_config_v2',
  HISTORY: COMMAND_HISTORY_KEY,
  LLM_HISTORY: 'desktop_pet_llm_history_v1',
} as const;

const DEFAULT_LLM_CONFIG: LlmBridgeConfig = {
  enabled: false,
  provider: 'openai_compatible',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  model: LLM_DEFAULT_MODEL,
  customSystemPrompt: '',
};

const DEFAULT_COMMAND_HISTORY = ['/focus 25', '/fortune', '/sys'];

export const usePetStore = defineStore('petStore', () => {
  const careStore = useCareStore();

  const windowRole = ref<WindowRole>('main');
  const revision = ref(0);
  const active_pet_id = ref(DEFAULT_PET_ID);
  const emotion = ref('idle');
  const is_click_through = ref(false);
  const volume = ref(0.85);
  const studio_mode = ref(false);
  const inline_hud = ref(true);
  const dnd_mode = ref(false);

  const settings = ref<HostSettings>(structuredClone(DEFAULT_HOST_SETTINGS));
  const availablePets = ref<PetManifest[]>([structuredClone(FALLBACK_PET_MANIFEST)]);
  const currentPet = ref<PetManifest | null>(structuredClone(FALLBACK_PET_MANIFEST));
  const globalMenus = ref<MenuItemSchema[]>([]);
  const externalMenusByApp = ref<Record<string, MenuItemSchema[]>>({});

  const radialMenuOpen = ref(false);
  const studioOpen = ref(false);
  const quickChatOpen = ref(false);

  const isDraggingWindow = ref(false);
  const isClimbedOnWindow = ref(false);
  const isEdgePeeked = ref(false);

  const activeMotion = ref('idle');
  const activeExpression = ref('neutral');
  const bubbleText = ref('');
  const bubbleQuickReplies = ref<QuickReplyChip[]>([]);
  const currentAction = ref<ScheduledPetTask | null>(null);
  const actionQueue = ref<ScheduledPetTask[]>([]);

  const lipSync = ref<LipSyncFrame>({
    mouthOpenY: 0,
    mouthFormX: 0,
    rms: 0,
    bands: [0, 0, 0, 0, 0, 0, 0],
  });
  const lastUserActivityAt = ref(Date.now());
  const fpsOverride = ref<FpsOverride>('dynamic');
  const commandHistory = ref<string[]>(
    loadStorage(STORAGE_KEYS.HISTORY, DEFAULT_COMMAND_HISTORY)
  );
  const llmConfig = ref<LlmBridgeConfig>(loadStorage(STORAGE_KEYS.LLM, DEFAULT_LLM_CONFIG));
  /**
   * Conversation memory, keyed by pet.
   *
   * Keyed rather than shared because the pets are different characters: a single history
   * would let one pet read the other's half of the conversation and answer as if it had
   * said it. Values are bounded by `appendLlmTurn`, so the stored payload cannot grow
   * without limit across sessions either.
   */
  const llmHistory = ref<Record<string, LlmChatMessage[]>>(
    loadStorage(STORAGE_KEYS.LLM_HISTORY, {})
  );
  const pendingCompanionLoad = ref<CompanionLoadPayload | null>(null);

  // Per-instance runtime state: no module-level singletons, so one window can never
  // clobber another's action timer or bus binding.
  let actionTimer: number | null = null;
  let syncInitialized = false;
  const busListeners: UnlistenFn[] = [];

  const stageBus =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(STAGE_CHANNEL_NAME) : null;

  const activeTheme = computed<PetThemePalette>(
    () => resolvePetTheme(currentPet.value?.id || active_pet_id.value, currentPet.value?.theme)
  );
  const activeThemeCssVars = computed(() => themeToCssVars(activeTheme.value));
  const mouthOpenY = computed(() => lipSync.value.mouthOpenY);
  const stats = computed<PetStatsState>(() => careStore.stats);
  const pomodoro = computed<PomodoroState>(() => careStore.pomodoro);
  const todos = computed<TodoItem[]>(() => careStore.todos);
  const xpProgressPercent = computed(() => careStore.xpProgressPercent);
  const formattedPomodoroTime = computed(() => careStore.formattedPomodoroTime);

  const mergedMenuTree = computed<MenuItemSchema[]>(() => [
    ...(currentPet.value?.menus || []),
    ...globalMenus.value,
    ...Object.values(externalMenusByApp.value).flat(),
  ]);

  const effectiveTargetFps = computed(() => {
    if (fpsOverride.value === '60') return 60;
    if (fpsOverride.value === '30') return 30;
    const idleMs = Date.now() - lastUserActivityAt.value;
    const idleThreshold = settings.value.render.idle_timeout_ms || 5000;
    const busy =
      currentAction.value !== null || radialMenuOpen.value || studioOpen.value;
    if (idleMs > idleThreshold && !busy) {
      return settings.value.render.idle_fps || 24;
    }
    return settings.value.render.active_fps || 60;
  });

  function getAudioPrefs(): AudioPrefs {
    return {
      dnd: dnd_mode.value,
      volume: volume.value,
      petName: currentPet.value?.name || DEFAULT_PET_NAME,
    };
  }

  // The store instance is resolved lazily at call time. Re-entering `usePetStore()`
  // while the setup body is still running would rebuild it, so it is only safe to use
  // from actions, which always run after setup has completed.
  const presenter: CarePresenter = {
    schedule: (task) => scheduleAction(task),
    audioPrefs: getAudioPrefs,
  };

  function applyAudioSettings(): void {
    globalLipSync.setGainMultiplier(
      (settings.value.audio.rms_gain || 3.2) * VOICE_GAIN_PERCENT_SCALE
    );
    globalLipSync.setRmsSmoothing(settings.value.audio.rms_smoothing || 0.75);
  }

  function applySnapshot(snap: CanonicalPetState): void {
    if (snap.revision <= revision.value) return;
    revision.value = snap.revision;
    if (snap.active_pet_id && snap.active_pet_id !== active_pet_id.value) {
      active_pet_id.value = snap.active_pet_id;
      const found = availablePets.value.find((p) => p.id === snap.active_pet_id);
      if (found) currentPet.value = found;
    }
    emotion.value = snap.emotion;
    is_click_through.value = snap.is_click_through;
    volume.value = snap.volume;
    studio_mode.value = snap.studio_mode;
    inline_hud.value = snap.inline_hud;
    if (typeof snap.dnd_mode === 'boolean') dnd_mode.value = snap.dnd_mode;
  }

  async function dispatchPatch(patch: Partial<CanonicalPetState>): Promise<void> {
    try {
      applySnapshot(await invoke<CanonicalPetState>('mutate_canonical_state', { patch }));
    } catch {
      Object.assign(
        { active_pet_id, emotion, is_click_through, volume, studio_mode, inline_hud, dnd_mode },
        patch
      );
      revision.value += 1;
    }
  }

  function broadcastLipSync(frame: LipSyncFrame): void {
    lipSync.value = frame;
    stageBus?.postMessage({ lipSync: frame });
  }

  function markUserActivity(): void {
    lastUserActivityAt.value = Date.now();
    if (activeMotion.value === 'sleep' && !currentAction.value) {
      activeMotion.value = 'idle';
      activeExpression.value = 'neutral';
    }
  }

  function advanceActionQueue(): void {
    if (actionTimer !== null) {
      clearTimeout(actionTimer);
      actionTimer = null;
    }
    currentAction.value = null;
    bubbleText.value = '';
    bubbleQuickReplies.value = [];

    const next = actionQueue.value.shift();
    if (next) {
      runAction(next);
      return;
    }
    activeMotion.value = isClimbedOnWindow.value ? 'climb' : 'idle';
    activeExpression.value = 'neutral';
  }

  function runAction(task: ScheduledPetTask): void {
    if (actionTimer !== null) clearTimeout(actionTimer);
    currentAction.value = task;
    if (task.motion) activeMotion.value = task.motion;
    if (task.expression) activeExpression.value = task.expression;
    bubbleText.value = task.text || '';
    bubbleQuickReplies.value = task.quickReplies || [];
    actionTimer = window.setTimeout(
      advanceActionQueue,
      Math.max(MIN_ACTION_DURATION_MS, task.durationMs || DEFAULT_ACTION_DURATION_MS)
    );
  }

  function scheduleAction(task: ScheduledPetTask, fromRemoteBus = false): void {
    markUserActivity();
    if (dnd_mode.value && task.priority === 'P3') return;

    const incoming: ScheduledPetTask = {
      ...task,
      id:
        task.id ||
        `${ACTION_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      durationMs: task.durationMs ?? DEFAULT_ACTION_DURATION_MS,
    };

    if (windowRole.value === 'companion' && !fromRemoteBus) {
      stageBus?.postMessage({ scheduledAction: incoming });
      return;
    }

    const active = currentAction.value;
    if (!active) {
      runAction(incoming);
      return;
    }

    if (PRIORITY_RANK[incoming.priority] >= PRIORITY_RANK[active.priority]) {
      if (active.resumeAfterInterrupt) {
        actionQueue.value = [
          { ...active, resumeAfterInterrupt: false },
          ...actionQueue.value,
        ];
      }
      runAction(incoming);
      return;
    }

    actionQueue.value = [...actionQueue.value, incoming].sort(
      (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
    );
  }

  function dismissCurrentBubble(): void {
    markUserActivity();
    advanceActionQueue();
  }

  function addXpAndAffinity(xpDelta: number, affinityDelta = 1, moodDelta = 1): void {
    careStore.addXpAndAffinity(xpDelta, affinityDelta, moodDelta);
  }

  function feedPetCareItem(
    itemName: string,
    energy = 20,
    affinity = 6,
    xp = 25
  ): void {
    careStore.feedCareItem(itemName, energy, affinity, xp);
  }

  function startPomodoro(
    minutes = 25,
    mode: PomodoroState['mode'] = 'focus',
    label = DEFAULT_FOCUS_LABEL
  ): void {
    careStore.startPomodoro(minutes, mode, label);
  }

  function togglePomodoroPause(): void {
    careStore.togglePomodoroPause();
  }

  function stopPomodoro(): void {
    careStore.stopPomodoro();
  }

  function switchPetById(petId: string): void {
    const target = availablePets.value.find((p) => p.id === petId);
    if (!target) return;
    currentPet.value = target;
    active_pet_id.value = target.id;
    void dispatchPatch({ active_pet_id: target.id });
    scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.petSwitched(target.name, activeTheme.value.name),
      durationMs: 3800,
    });
  }

  function triggerFortuneDivination(): void {
    addXpAndAffinity(15, 3, 5);
    scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: pickDailyFortune(),
      durationMs: 5500,
    });
  }

  async function submitUserChatCommand(rawInput: string): Promise<void> {
    const input = rawInput.trim();
    if (!input) return;
    markUserActivity();
    commandHistory.value = [input, ...commandHistory.value.filter((i) => i !== input)].slice(
      0,
      COMMAND_HISTORY_LIMIT
    );
    saveStorage(STORAGE_KEYS.HISTORY, commandHistory.value);
    addXpAndAffinity(6, 1, 1);
    await executeChatOrSlashCommand(usePetStore(), input);
  }

  async function initializeHost(role: WindowRole = 'main'): Promise<void> {
    windowRole.value = role;
    careStore.bindPresenter(presenter);
    careStore.initCareSync(role === 'main');
    await initCrossWindowSync();

    try {
      const bundle = await invoke<{
        settings_yaml?: string;
        global_menu_yaml?: string;
        pets?: Array<{ id: string; yaml: string; base_path: string }>;
      }>('load_host_configs');

      if (bundle.settings_yaml) settings.value = parseHostSettingsYaml(bundle.settings_yaml);
      if (bundle.global_menu_yaml) {
        globalMenus.value = parseGlobalMenuYaml(bundle.global_menu_yaml).menus;
      }
      if (Array.isArray(bundle.pets) && bundle.pets.length > 0) {
        availablePets.value = bundle.pets.map((entry) => ({
          ...parsePetManifestYaml(entry.yaml, entry.id),
          basePath: entry.base_path,
        }));
      }
    } catch {
      const fallback = await fetchWebFallbackBundle();
      settings.value = fallback.settings;
      globalMenus.value = fallback.globalMenus;
      availablePets.value = fallback.pets;
    }

    const desiredId =
      active_pet_id.value || settings.value.host.default_pet || DEFAULT_PET_ID;
    currentPet.value =
      availablePets.value.find((p) => p.id === desiredId) ??
      availablePets.value[0] ??
      structuredClone(FALLBACK_PET_MANIFEST);
    active_pet_id.value = currentPet.value.id;
    applyAudioSettings();

    if (role === 'main') startStageAutonomousLoop(usePetStore());
  }

  async function initCrossWindowSync(): Promise<void> {
    if (syncInitialized) return;
    syncInitialized = true;

    try {
      applySnapshot(await invoke<CanonicalPetState>('get_canonical_state'));
    } catch {
      // Browser preview has no canonical state.
    }

    try {
      busListeners.push(
        await listen<CanonicalPetState>('pet-state:sync', (ev) => applySnapshot(ev.payload))
      );

      if (windowRole.value === 'main') {
        busListeners.push(
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
            const priority: ActionPriority =
              p.priority && p.priority >= 2 ? 'P0' : p.priority === 1 ? 'P1' : 'P2';
            if (p.msg_type === 'speak' && p.text) {
              scheduleAction({
                priority,
                motion: p.motion || 'happy',
                expression: p.emotion || 'smile',
                text: p.text,
                durationMs: p.duration_ms || 4200,
              });
            } else if (p.msg_type === 'safe_action' && p.action) {
              executeExternalSafeAction(usePetStore(), p.action.action_id, p.action.params || {}, priority);
            }
          })
        );
      }
    } catch {
      // Outside the Tauri webview.
    }

    if (!stageBus) return;
    stageBus.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.lipSync) lipSync.value = data.lipSync;
      if (data.fpsOverride) fpsOverride.value = data.fpsOverride;
      if (data.settings) {
        settings.value = data.settings;
        applyAudioSettings();
      }
      if (data.scheduledAction && windowRole.value === 'main') {
        scheduleAction(data.scheduledAction, true);
      }
    };
  }

  async function dispatchPetAction(
    action: PetActionConfig,
    extraPaths?: string[]
  ): Promise<void> {
    await executeStagePetAction(usePetStore(), action, extraPaths);
  }

  async function handleInternalEvent(
    name: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await executeInternalStageEvent(usePetStore(), name, payload);
  }

  async function evaluatePostDragSnap(): Promise<void> {
    await snapStageToForeground(usePetStore(), true);
  }

  async function handleDesktopWindowState(state: DesktopWindowState): Promise<void> {
    await syncDesktopFullscreenState(usePetStore(), state);
  }

  function registerExternalMenu(payload: {
    app_id: string;
    menus?: MenuItemSchema[];
    item?: MenuItemSchema;
  }): void {
    const { app_id, menus, item } = payload;
    if (!app_id) return;

    if (Array.isArray(menus)) {
      externalMenusByApp.value = {
        ...externalMenusByApp.value,
        [app_id]: menus.map((m) => ({ ...m, app_id })),
      };
    } else if (item) {
      const existing = externalMenusByApp.value[app_id] || [];
      const index = existing.findIndex((m) => m.id === item.id);
      const tagged = { ...item, app_id };
      const next = [...existing];
      if (index >= 0) next[index] = tagged;
      else next.push(tagged);
      externalMenusByApp.value = { ...externalMenusByApp.value, [app_id]: next };
    }

    scheduleAction({
      priority: 'P2',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.externalMenuMounted(app_id),
      durationMs: 3600,
    });
  }

  function unregisterExternalMenu(appId: string): void {
    if (!externalMenusByApp.value[appId]) return;
    const next = { ...externalMenusByApp.value };
    delete next[appId];
    externalMenusByApp.value = next;
    void emit('hud-clear', { app_id: appId });
  }

  function saveLlmConfig(cfg: Partial<LlmBridgeConfig>): void {
    llmConfig.value = { ...llmConfig.value, ...cfg };
    saveStorage(STORAGE_KEYS.LLM, llmConfig.value);
  }

  /** Turns remembered for one pet, newest last. Empty for a pet that has not spoken yet. */
  function llmHistoryFor(petId: string): LlmChatMessage[] {
    if (!petId) return [];
    return llmHistory.value[petId] ?? [];
  }

  function recordLlmTurn(petId: string, userInput: string, reply: string): void {
    if (!petId) return;
    llmHistory.value = {
      ...llmHistory.value,
      [petId]: appendLlmTurn(llmHistoryFor(petId), userInput, reply),
    };
    saveStorage(STORAGE_KEYS.LLM_HISTORY, llmHistory.value);
  }

  /** Returns how many turns were forgotten, so the confirmation can be specific. */
  function clearLlmHistory(petId: string): number {
    if (!petId) return 0;
    const turns = Math.floor(llmHistoryFor(petId).length / 2);
    if (turns === 0) return 0;
    const next = { ...llmHistory.value };
    delete next[petId];
    llmHistory.value = next;
    saveStorage(STORAGE_KEYS.LLM_HISTORY, llmHistory.value);
    return turns;
  }

  async function saveHostSettings(): Promise<void> {
    stageBus?.postMessage({ settings: structuredClone(toRaw(settings.value)) });
    try {
      await invoke('save_host_settings', {
        yamlContent: serializeHostSettingsYaml(settings.value),
      });
    } catch {
      // Browser preview persists in memory only.
    }
  }

  function setFpsOverride(next: FpsOverride): void {
    fpsOverride.value = next;
    stageBus?.postMessage({ fpsOverride: next });
  }

  /** Parks a companion panel request until the companion webview reports readiness. */
  function requestCompanionLoad(payload: CompanionLoadPayload): void {
    pendingCompanionLoad.value = payload;
  }

  function takeCompanionLoad(): CompanionLoadPayload | null {
    const payload = pendingCompanionLoad.value;
    pendingCompanionLoad.value = null;
    return payload;
  }

  async function saveCurrentPetManifest(): Promise<void> {
    const pet = currentPet.value;
    if (!pet) return;
    try {
      await invoke('save_pet_manifest', {
        petId: pet.id,
        yamlContent: serializePetManifestYaml(pet),
      });
      scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: STAGE_MESSAGES.petManifestPersisted(pet.id),
        durationMs: 3800,
      });
    } catch {
      scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: STAGE_MESSAGES.petManifestLiveOnly(pet.model.scale),
        durationMs: 3400,
      });
    }
  }

  function feedDefaultCareItem(): void {
    feedPetCareItem(DEFAULT_CARE_ITEM);
  }

  function feedQuantumCrystal(): void {
    feedPetCareItem(FEDIBLE_QUANTUM_CRYSTAL, 25, 8, 30);
  }

  function disposeStage(): void {
    if (actionTimer !== null) {
      clearTimeout(actionTimer);
      actionTimer = null;
    }
    for (const off of busListeners) off();
    busListeners.length = 0;
    careStore.disposeCareSync();
  }

  const store = {
    windowRole,
    revision,
    active_pet_id,
    emotion,
    is_click_through,
    volume,
    studio_mode,
    inline_hud,
    dnd_mode,
    settings,
    availablePets,
    currentPet,
    globalMenus,
    externalMenusByApp,
    radialMenuOpen,
    studioOpen,
    quickChatOpen,
    isDraggingWindow,
    isClimbedOnWindow,
    isEdgePeeked,
    activeMotion,
    activeExpression,
    bubbleText,
    bubbleQuickReplies,
    currentAction,
    actionQueue,
    lipSync,
    lastUserActivityAt,
    fpsOverride,
    commandHistory,
    llmConfig,

    activeTheme,
    activeThemeCssVars,
    mouthOpenY,
    stats,
    pomodoro,
    todos,
    xpProgressPercent,
    formattedPomodoroTime,
    mergedMenuTree,
    effectiveTargetFps,

    getAudioPrefs,
    initializeHost,
    applySnapshot,
    dispatchPatch,
    broadcastLipSync,
    markUserActivity,
    switchPetById,
    scheduleAction,
    dismissCurrentBubble,
    addXpAndAffinity,
    feedPetCareItem,
    feedDefaultCareItem,
    feedQuantumCrystal,
    startPomodoro,
    togglePomodoroPause,
    stopPomodoro,
    addTodo: (text: string, priority?: TodoItem['priority']) => careStore.addTodo(text, priority),
    toggleTodo: (id: string) => careStore.toggleTodo(id),
    removeTodo: (id: string) => careStore.removeTodo(id),
    clearCompletedTodos: () => careStore.clearCompletedTodos(),
    dispatchPetAction,
    handleInternalEvent,
    triggerFortuneDivination,
    submitUserChatCommand,
    evaluatePostDragSnap,
    handleDesktopWindowState,
    registerExternalMenu,
    unregisterExternalMenu,
    saveLlmConfig,
    llmHistoryFor,
    recordLlmTurn,
    clearLlmHistory,
    saveHostSettings,
    setFpsOverride,
    requestCompanionLoad,
    takeCompanionLoad,
    saveCurrentPetManifest,
    disposeStage,
  };

  return store;
});

export type PetStore = ReturnType<typeof usePetStore>;
