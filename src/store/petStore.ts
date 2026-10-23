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
  MenuInteractionDef,
  MenuItemSchema,
  PetActionConfig,
  PetManifest,
  PetStatsState,
  PetFpsOverride,
  PetSwitchOutcome,
  PetThemePalette,
  PomodoroState,
  QuickReplyChip,
  ScheduledPetTask,
  TodoItem,
} from '@/types/pet';
import {
  DEFAULT_HOST_SETTINGS,
  DEFAULT_RMS_GAIN,
  FALLBACK_PET_MANIFEST,
  fetchWebFallbackBundle,
  parseGlobalMenuYaml,
  parseHostSettingsYaml,
  parsePetManifestYaml,
  serializeHostSettingsYaml,
  serializePetManifestYaml,
} from '@/utils/yamlLoader';
import {
  appendLlmTurn,
  executeChatOrSlashCommand,
  pickDailyFortune,
  LLM_HISTORY_DEFAULT_TURNS,
  resolveLlmHistoryMessages,
} from '@/utils/commandEngine';
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
  PET_SWITCH_FAILURE_MS,
  STREAMING_HOLD_MS,
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
import {
  collectMenuInteractionWarnings,
  resolveMenuDefaults,
} from '@/utils/menuInteraction';

type WindowRole = 'main' | 'companion';

const STAGE_CHANNEL_NAME = 'desktop_pet_stage_bus';
const PRIORITY_RANK: Record<ActionPriority, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
// The pet the host opens on when the configuration names none. It is a real shipped
// package, so the first frame is a character rather than the neutral placeholder.
const DEFAULT_PET_ID = 'silverfeather_chibi';

/**
 * How many items one external program may keep in the astrolabe at a time.
 *
 * A quota rather than a free-for-all: the astrolabe is one ring, and a program that
 * fills it leaves no room for the pet's own menu or for the other programs.
 */
const MAX_EXTERNAL_MENU_ITEMS_PER_APP = 8;

/**
 * One externally registered menu item, as the registry keeps it.
 *
 * The item is held apart from its ordering data because the two answer different
 * questions: the item is what the menu shows, the priority and the sequence are how
 * the host decides where it goes and which one has to make room for a new one.
 */
interface ExternalMenuEntry {
  /** The item as the program declared it, tagged with the app that registered it. */
  item: MenuItemSchema;
  /** Ordering weight: the item's own `priority`, or 0 when it declares none. */
  priority: number;
  /** Registration counter. The tiebreak that keeps equal priorities in a stable order. */
  seq: number;
}

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
  historyTurns: LLM_HISTORY_DEFAULT_TURNS,
  stream: true,
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
  /**
   * Which external client currently owns the character, if any.
   *
   * The host's own autonomous behaviour stands down while this is set: two deciders share
   * one character otherwise, and the result is a pet that contradicts itself. `null` means
   * nobody has claimed driving rights, which is the state a host with no client attached
   * is always in.
   */
  const externalDriver = ref<string | null>(null);

  const settings = ref<HostSettings>(structuredClone(DEFAULT_HOST_SETTINGS));
  const availablePets = ref<PetManifest[]>([structuredClone(FALLBACK_PET_MANIFEST)]);
  const currentPet = ref<PetManifest | null>(structuredClone(FALLBACK_PET_MANIFEST));
  const globalMenus = ref<MenuItemSchema[]>([]);
  /**
   * Menu feel declared by `config/global_menu.yaml`, used by every pet that does not
   * declare its own. Kept beside the menus rather than folded into them because it applies
   * to the merged tree, not to the items that happened to come from that file.
   */
  const globalMenuInteraction = ref<MenuInteractionDef>({});
  /**
   * The menu items external programs registered, grouped by the app that registered them.
   *
   * Grouped because a program owns its items: unregistering the app takes its whole
   * group away, and the quota on how many items one app may show is a per-app rule.
   */
  const externalMenuRegistry = ref<Record<string, ExternalMenuEntry[]>>({});
  /**
   * The order items were registered in, across every app.
   *
   * One counter for all apps so that items from different apps have a single order to
   * be sorted by; a per-app counter would leave the order between apps undefined.
   */
  let externalMenuSeq = 0;

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
  const fpsOverride = ref<PetFpsOverride>('dynamic');
  const commandHistory = ref<string[]>(
    loadStorage(STORAGE_KEYS.HISTORY, DEFAULT_COMMAND_HISTORY)
  );
  // Merged over the defaults, not replaced by the stored object: a config written before a
  // field existed would otherwise leave that field `undefined`, and an undefined history
  // window reads as "unbounded" rather than as "invalid".
  const llmConfig = ref<LlmBridgeConfig>({
    ...DEFAULT_LLM_CONFIG,
    ...loadStorage(STORAGE_KEYS.LLM, DEFAULT_LLM_CONFIG),
  });
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
    () => resolvePetTheme(currentPet.value?.theme)
  );
  const activeThemeCssVars = computed(() => themeToCssVars(activeTheme.value));
  const mouthOpenY = computed(() => lipSync.value.mouthOpenY);
  const stats = computed<PetStatsState>(() => careStore.stats);
  const pomodoro = computed<PomodoroState>(() => careStore.pomodoro);
  const todos = computed<TodoItem[]>(() => careStore.todos);
  const xpProgressPercent = computed(() => careStore.xpProgressPercent);
  const formattedPomodoroTime = computed(() => careStore.formattedPomodoroTime);

  /**
   * The registered items, grouped by app, in the order they were registered.
   *
   * A view of the registry rather than a second copy of it: two copies would drift
   * apart, and the registry is the one that decides what the menu shows.
   */
  const externalMenusByApp = computed<Record<string, MenuItemSchema[]>>(() => {
    const grouped: Record<string, MenuItemSchema[]> = {};
    for (const [appId, entries] of Object.entries(externalMenuRegistry.value)) {
      grouped[appId] = entries.map((entry) => entry.item);
    }
    return grouped;
  });

  /**
   * The external items in the order the astrolabe shows them.
   *
   * Priority first, bigger in front. The order items were registered in only breaks
   * ties, because it is not an order a program can rely on: its own items come and go
   * as its state changes, so an item registered late would otherwise shove the others
   * around every time the program refreshed itself.
   */
  const externalMenuItems = computed<MenuItemSchema[]>(() =>
    Object.values(externalMenuRegistry.value)
      .flat()
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
      .map((entry) => entry.item)
  );

  /**
   * The astrolabe's menu, built from what is registered right now.
   *
   * Built on demand rather than kept: a program registers, replaces and drops its items
   * while the menu is closed, so the menu has to be built from the registration state of
   * the moment it opens.
   */
  function buildMenuTree(): MenuItemSchema[] {
    return [
      ...(currentPet.value?.menus || []),
      ...globalMenus.value,
      ...externalMenuItems.value,
    ];
  }

  const mergedMenuTree = computed<MenuItemSchema[]>(buildMenuTree);

  /**
   * Menu feel for the active pet: its own `menu_interaction`, else
   * `config/global_menu.yaml`'s, else the built-in. Individual items may still override it.
   */
  const menuInteraction = computed<Required<MenuInteractionDef>>(() =>
    resolveMenuDefaults(currentPet.value?.menu_interaction, globalMenuInteraction.value)
  );

  /**
   * Configurations whose two gestures collide, so the menu opens its submenu where the
   * author expected an action.
   *
   * Computed here rather than in the renderer so it covers the merged tree — a pet item, a
   * global item and an externally registered one can each be the mistake.
   */
  const menuInteractionWarnings = computed<string[]>(() =>
    collectMenuInteractionWarnings(
      mergedMenuTree.value,
      currentPet.value ?? undefined,
      globalMenuInteraction.value
    )
  );

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
      (settings.value.audio.rms_gain || DEFAULT_RMS_GAIN) * VOICE_GAIN_PERCENT_SCALE
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

  /**
   * Drive the mouth from what the microphone hears, so the pet visibly listens.
   *
   * Published as an ordinary lip-sync frame on purpose: the mouth follows it exactly as it
   * follows a speech synthesiser, so nothing downstream needs to know which of the two is
   * talking. The caller smooths the level first — a raw 80 ms sample would flicker.
   */
  function broadcastMouthLevel(mouthOpenY: number): void {
    const level = Math.min(1, Math.max(0, Number.isFinite(mouthOpenY) ? mouthOpenY : 0));
    // No formant shift: the microphone drives how far the mouth is open, not what shape the
    // vowel has, and inventing one here would fight whatever the speech path last set.
    broadcastLipSync({ mouthOpenY: level, mouthFormX: 0, rms: level, bands: [] });
  }

  function markUserActivity(): void {
    lastUserActivityAt.value = Date.now();
    if (activeMotion.value === 'sleep' && !currentAction.value) {
      activeMotion.value = 'idle';
      activeExpression.value = 'neutral';
    }
  }

  /**
   * Record who owns the character, as reported by the bus.
   *
   * Kept here rather than derived from `connected_clients`, because those are different
   * facts: a client that only wants to show a bubble should not silence the host, and the
   * bus reports the lease separately for exactly that reason.
   */
  function setExternalDriver(appId: string | null): void {
    externalDriver.value = appId;
    // Console rather than a bubble: taking over must not put words in the driver's mouth,
    // and a takeover that leaves no trace at all is indistinguishable from a broken host.
    console.info(
      appId ? `[driver] 外部驱动已接管：${appId}` : '[driver] 外部驱动已释放，宿主恢复自主行为'
    );
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

  /**
   * Id of the bubble currently being filled in by a streamed reply, if any.
   *
   * Kept as an id rather than a boolean because a reply can arrive while a higher-priority
   * action is on stage: the bubble is then still queued, and fragments must not be written
   * into whatever bubble happens to be visible. They are held until the reply ends, and the
   * finished sentence is shown then.
   */
  const streamingReplyId = ref<string | null>(null);

  /** True while the text on stage is still growing; the bubble uses it to hold its voice. */
  const replyStreaming = computed(
    () => streamingReplyId.value !== null && currentAction.value?.id === streamingReplyId.value
  );

  /** Put up a bubble that `pushStreamedText` will fill in; returns its id. */
  function beginStreamedReply(): string {
    const id = `${ACTION_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    streamingReplyId.value = id;
    scheduleAction({
      id,
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: '',
      durationMs: STREAMING_HOLD_MS,
    });
    return id;
  }

  /** Replace the text of a streamed reply that is already on stage. */
  function pushStreamedText(id: string, text: string): void {
    if (streamingReplyId.value !== id || currentAction.value?.id !== id) return;
    bubbleText.value = text;
    currentAction.value = { ...currentAction.value, text };
    rearmActiveAction(STREAMING_HOLD_MS);
  }

  /**
   * Close a streamed reply.
   *
   * The text is only assigned when it differs from what is on screen: re-assigning the same
   * string would retrigger the bubble's text watcher and make the finished sentence type
   * itself out a second time from an empty bubble.
   */
  function endStreamedReply(id: string, text: string, durationMs: number): void {
    const owns = streamingReplyId.value === id;
    if (owns) streamingReplyId.value = null;

    if (owns && currentAction.value?.id === id) {
      if (bubbleText.value !== text) bubbleText.value = text;
      rearmActiveAction(durationMs);
      return;
    }
    // Queued behind something else, or replaced: behave like a normal reply.
    scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text,
      durationMs,
    });
  }

  /** Restart the countdown for the action on stage without touching its text. */
  function rearmActiveAction(durationMs: number): void {
    if (actionTimer !== null) clearTimeout(actionTimer);
    actionTimer = window.setTimeout(
      advanceActionQueue,
      Math.max(MIN_ACTION_DURATION_MS, durationMs)
    );
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

  /**
   * Switch the active pet, reporting the outcome to the caller *and* on the bubble.
   *
   * It used to return nothing and return early when the id was not among the loaded pets.
   * Every caller treated that as success: a menu entry naming a pet that is not installed
   * looked like a dead item rather than a mistake, and an external switch request was
   * acknowledged with `status: "ok"` while the interface did nothing. The failure now
   * announces itself in the same place the success message does.
   */
  function switchPetById(petId: string): PetSwitchOutcome {
    if (!petId) {
      const reason = STAGE_MESSAGES.petSwitchWithoutId;
      announcePetSwitchFailure(reason);
      return { ok: false, reason };
    }
    const target = availablePets.value.find((p) => p.id === petId);
    if (!target) {
      const reason = STAGE_MESSAGES.petNotInstalled(petId);
      announcePetSwitchFailure(reason);
      return { ok: false, reason };
    }
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
    return { ok: true };
  }

  function announcePetSwitchFailure(reason: string): void {
    scheduleAction({
      priority: 'P1',
      motion: 'idle',
      expression: 'surprised',
      text: reason,
      durationMs: PET_SWITCH_FAILURE_MS,
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
        const globalMenu = parseGlobalMenuYaml(bundle.global_menu_yaml);
        globalMenus.value = globalMenu.menus;
        globalMenuInteraction.value = globalMenu.interaction ?? {};
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
      globalMenuInteraction.value = fallback.globalMenuInteraction;
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

  /**
   * Take in the menu items an external program contributes.
   *
   * Two conventions the program on the other side of the bus has to know:
   *
   * - **Registering the same id again replaces the item.** A program that changes its
   *   own state re-registers the item under the same id with the title of the moment —
   *   "暂停" becomes "继续" — so the menu shows what is true now instead of a title that
   *   went stale. This is why an item is looked up by id and not appended blindly:
   *   appending would leave the old title sitting on the menu next to the new one.
   * - **The order on the ring comes from `priority`, not from the order of
   *   registration.** Items come and go, so the registration order of what is on screen
   *   is not something a program can rely on. `priority` is the only order that
   *   survives an item being added or taken away.
   *
   * One program may keep eight items at a time; a ninth one pushes out the item with
   * the lowest priority, and the one registered longest ago among equals. An item that
   * should no longer be on the menu is taken away by unregistering the app.
   *
   * An item that would run a command (`action.type: "exec"`) is refused here as well as
   * in the host: running a command is a capability rather than an extension point, and
   * the refusal cannot live only on the far side of the bus.
   */
  function registerExternalMenu(payload: {
    app_id: string;
    menus?: MenuItemSchema[];
    item?: MenuItemSchema;
  }): void {
    const { app_id, menus, item } = payload;
    if (!app_id) return;

    const declared = Array.isArray(menus) ? menus : item ? [item] : [];
    const accepted = declared.flatMap((declaredItem) =>
      acceptExternalMenuItem(declaredItem, app_id)
    );
    if (accepted.length === 0) return;

    const group = [...(externalMenuRegistry.value[app_id] || [])];
    for (const acceptedItem of accepted) {
      const priority = readPriority(acceptedItem);
      const index = group.findIndex((entry) => entry.item.id === acceptedItem.id);
      if (index >= 0) {
        // 同一个 id 再注册一次 = 换标题与处理器，位置不动：菜单里的条目不该因为
        // 程序刷新了一下自己的状态就跳来跳去。
        group[index] = { item: acceptedItem, priority, seq: group[index].seq };
        continue;
      }
      externalMenuSeq += 1;
      group.push({ item: acceptedItem, priority, seq: externalMenuSeq });
    }

    externalMenuRegistry.value = {
      ...externalMenuRegistry.value,
      [app_id]: enforceExternalMenuQuota(app_id, group),
    };

    scheduleAction({
      priority: 'P2',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.externalMenuMounted(app_id),
      durationMs: 3600,
    });
  }

  /**
   * The parts of a registration the host is willing to show, tagged with the app that
   * registered them.
   *
   * An item that would run a command is dropped rather than shown: the host refuses
   * `exec` too, but the interface cannot lean on that — an item that runs a command is
   * a capability rather than an extension point, and the refusal has to happen where
   * the item is accepted, not only on the other side of the bus.
   */
  function acceptExternalMenuItem(item: MenuItemSchema, appId: string): MenuItemSchema[] {
    if (item.action?.type === 'exec') {
      console.warn(
        `[menu] 外部菜单项 [${item.id}] 声明了 action.type=exec，已忽略：` +
          `外部程序不得通过菜单执行命令。`
      );
      return [];
    }
    const children =
      item.children?.flatMap((child) => acceptExternalMenuItem(child, appId)) ?? [];
    const tagged: MenuItemSchema = { ...item, app_id: appId };
    if (item.children) tagged.children = children;
    return [tagged];
  }

  /**
   * The ordering weight of an item; no weight declared means no weight at all.
   *
   * The value arrives as raw JSON from outside, so a weight that is not a number is
   * treated as "not declared" rather than left to poison the sort.
   */
  function readPriority(item: MenuItemSchema): number {
    const raw = item.priority;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  }

  /**
   * Keep one app's group inside its quota.
   *
   * The lowest priority goes first; among equals the one registered longest ago goes
   * first, because that is the one the app has had the longest chance to refresh.
   */
  function enforceExternalMenuQuota(
    appId: string,
    group: ExternalMenuEntry[]
  ): ExternalMenuEntry[] {
    const kept = [...group];
    while (kept.length > MAX_EXTERNAL_MENU_ITEMS_PER_APP) {
      let victim = 0;
      for (let i = 1; i < kept.length; i += 1) {
        const candidate = kept[i];
        const current = kept[victim];
        const isWorse =
          candidate.priority < current.priority ||
          (candidate.priority === current.priority && candidate.seq < current.seq);
        if (isWorse) victim = i;
      }
      const [evicted] = kept.splice(victim, 1);
      console.warn(
        `[menu] 外部程序 [${appId}] 的菜单项超过 ${MAX_EXTERNAL_MENU_ITEMS_PER_APP} 条上限，` +
          `已淘汰优先级最低的一条：[${evicted.item.id}]（priority=${evicted.priority}）。`
      );
    }
    return kept;
  }

  function unregisterExternalMenu(appId: string): void {
    if (!externalMenuRegistry.value[appId]) return;
    const next = { ...externalMenuRegistry.value };
    delete next[appId];
    externalMenuRegistry.value = next;
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
      [petId]: appendLlmTurn(
        llmHistoryFor(petId),
        userInput,
        reply,
        resolveLlmHistoryMessages(llmConfig.value.historyTurns)
      ),
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

  function setFpsOverride(next: PetFpsOverride): void {
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
    externalDriver,
    setExternalDriver,
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
    buildMenuTree,
    menuInteraction,
    menuInteractionWarnings,
    globalMenuInteraction,
    effectiveTargetFps,

    getAudioPrefs,
    initializeHost,
    applySnapshot,
    dispatchPatch,
    broadcastLipSync,
    broadcastMouthLevel,
    markUserActivity,
    switchPetById,
    scheduleAction,
    dismissCurrentBubble,
    replyStreaming,
    beginStreamedReply,
    pushStreamedText,
    endStreamedReply,
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
