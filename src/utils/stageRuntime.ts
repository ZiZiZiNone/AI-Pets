import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import type {
  ActionPriority,
  DesktopWindowState,
  PetActionConfig,
  SystemTelemetry,
} from '@/types/pet';
import type { usePetStore } from '@/store/petStore';
import { useCareStore } from '@/store/careStore';
import {
  DEFAULT_CARE_ITEM,
  DEFAULT_PET_NAME,
  EXTERNAL_POMODORO_LABEL,
  STAGE_MESSAGES,
} from '@/constants/messages';
import {
  AMBIENT_THINK_CHANCE,
  AUTONOMOUS_TICK_MS,
  MIN_WANDER_INTERVAL_SEC,
  POMODORO_DEFAULT_MINUTES,
} from '@/constants/timing';

type PetStore = ReturnType<typeof usePetStore>;

const DEFAULT_SLEEP_SEC = 180;
const DEFAULT_HYDRATION_MIN = 45;
const DEFAULT_POSTURE_MIN = 60;
const EDGE_PEEK_RESTING_X = 420;
const EDGE_PEEK_ACTIVE_X = 140;
const EDGE_PEEK_Y = 260;

/**
 * Autonomous behaviour loop.
 *
 * Timer bookkeeping lives in this closure rather than at module scope, so each host
 * window owns exactly one loop and a disposed loop leaves nothing running.
 */
function createAutonomousLoop(petStore: PetStore) {
  let timer: number | null = null;
  let lastHydrationAt = Date.now();
  let lastPostureAt = Date.now();
  let lastAmbientAt = Date.now();

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function tick(): void {
    const now = Date.now();
    const idleSec = (now - petStore.lastUserActivityAt) / 1000;

    if (petStore.activeMotion === 'sleep') {
      petStore.addXpAndAffinity(0, 0, 0);
    }

    const interrupted =
      petStore.dnd_mode ||
      petStore.studioOpen ||
      petStore.radialMenuOpen ||
      petStore.currentAction !== null;
    if (interrupted) return;

    const sleepAfterSec = petStore.settings.behavior.sleep_after_idle_sec || DEFAULT_SLEEP_SEC;
    if (idleSec >= sleepAfterSec && petStore.activeMotion !== 'sleep') {
      petStore.scheduleAction({
        priority: 'P3',
        motion: 'sleep',
        expression: 'sleepy',
        text: STAGE_MESSAGES.asleep,
        durationMs: 4000,
      });
      return;
    }

    if (petStore.settings.behavior.enable_health_reminders !== false) {
      const hydrationMs =
        (petStore.settings.behavior.hydration_interval_min || DEFAULT_HYDRATION_MIN) * 60_000;
      if (now - lastHydrationAt >= hydrationMs) {
        lastHydrationAt = now;
        petStore.scheduleAction({
          priority: 'P2',
          motion: 'happy',
          expression: 'smile',
          text: STAGE_MESSAGES.hydration,
          durationMs: 6500,
          quickReplies: [
            {
              label: STAGE_MESSAGES.hydrationAck,
              action: {
                type: 'emit',
                app_id: 'internal',
                event: 'pet.feed_care',
                payload: STAGE_MESSAGES.hydrationPayload,
              },
            },
          ],
        });
        return;
      }

      const postureMs =
        (petStore.settings.behavior.posture_interval_min || DEFAULT_POSTURE_MIN) * 60_000;
      if (now - lastPostureAt >= postureMs) {
        lastPostureAt = now;
        petStore.scheduleAction({
          priority: 'P2',
          motion: 'pat',
          expression: 'smile',
          text: STAGE_MESSAGES.posture,
          durationMs: 6500,
          quickReplies: [
            {
              label: STAGE_MESSAGES.postureAck,
              action: {
                type: 'emit',
                app_id: 'internal',
                event: 'pet.feed_care',
                payload: STAGE_MESSAGES.posturePayload,
              },
            },
          ],
        });
        return;
      }
    }

    const wanderSec = Math.max(
      MIN_WANDER_INTERVAL_SEC,
      petStore.settings.behavior.wander_interval_sec || MIN_WANDER_INTERVAL_SEC
    );
    const dueForAmbient =
      petStore.settings.behavior.enable_autonomous_fsm &&
      (now - lastAmbientAt) / 1000 >= wanderSec &&
      idleSec < sleepAfterSec;
    if (!dueForAmbient || Math.random() >= AMBIENT_THINK_CHANCE) return;

    lastAmbientAt = now;
    const thoughts = STAGE_MESSAGES.ambientThoughts(
      petStore.currentPet?.name || DEFAULT_PET_NAME,
      petStore.stats.affinity
    );
    petStore.scheduleAction({
      priority: 'P3',
      motion: 'idle',
      expression: 'smile',
      text: thoughts[Math.floor(Math.random() * thoughts.length)],
      durationMs: 3600,
    });
  }

  function start(): void {
    stop();
    timer = window.setInterval(tick, AUTONOMOUS_TICK_MS);
  }

  return { start, stop };
}

export function startStageAutonomousLoop(petStore: PetStore): () => void {
  const loop = createAutonomousLoop(petStore);
  loop.start();
  return loop.stop;
}

export async function snapStageToForeground(
  petStore: PetStore,
  onlyIfNearTop: boolean
): Promise<void> {
  if (onlyIfNearTop && !petStore.settings.behavior.enable_window_climbing) return;

  try {
    const res = await invoke<{ snapped: boolean; target_title?: string }>(
      'snap_pet_to_foreground_window',
      { onlyIfNearTop }
    );
    if (res?.snapped) {
      petStore.isClimbedOnWindow = true;
      petStore.activeMotion = 'climb';
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'climb',
        expression: 'smile',
        text: STAGE_MESSAGES.snappedToWindow(res.target_title || '活动窗口'),
        durationMs: 3600,
      });
      return;
    }
  } catch {
    // Not running inside the Tauri shell.
  }

  if (onlyIfNearTop) {
    petStore.isClimbedOnWindow = false;
    return;
  }

  petStore.isClimbedOnWindow = !petStore.isClimbedOnWindow;
  petStore.scheduleAction({
    priority: 'P2',
    motion: petStore.isClimbedOnWindow ? 'climb' : 'idle',
    expression: 'smile',
    text: petStore.isClimbedOnWindow
      ? STAGE_MESSAGES.climbEnabled
      : STAGE_MESSAGES.climbDisabled,
    durationMs: 3500,
  });
}

async function applyStageEdgePeek(
  petStore: PetStore,
  enable: boolean,
  announce = false
): Promise<void> {
  petStore.isEdgePeeked = enable;
  try {
    await invoke('set_edge_peek_mode', { enable });
  } catch {
    try {
      const win = getCurrentWebviewWindow();
      const targetX = enable
        ? window.screen.availWidth - EDGE_PEEK_ACTIVE_X
        : window.screen.availWidth - EDGE_PEEK_RESTING_X;
      await win.setPosition(new LogicalPosition(targetX, EDGE_PEEK_Y));
    } catch {
      // Browser preview cannot move its window.
    }
  }

  if (!announce) return;
  petStore.scheduleAction({
    priority: 'P1',
    motion: 'idle',
    expression: 'surprised',
    text: enable ? STAGE_MESSAGES.edgePeekOn : STAGE_MESSAGES.edgePeekOff,
    durationMs: 3600,
  });
}

export async function syncDesktopFullscreenState(
  petStore: PetStore,
  state: DesktopWindowState
): Promise<void> {
  if (!petStore.settings.behavior.enable_fullscreen_edge_peek) return;
  if (state.is_fullscreen === petStore.isEdgePeeked) return;
  await applyStageEdgePeek(petStore, state.is_fullscreen, false);
}

export async function projectTacticalHudScan(petStore: PetStore): Promise<void> {
  petStore.scheduleAction({
    priority: 'P1',
    motion: 'happy',
    expression: 'surprised',
    text: STAGE_MESSAGES.tacticalScan,
    durationMs: 4200,
  });

  try {
    const hudWin = await WebviewWindow.getByLabel('hud');
    await hudWin?.show();
  } catch {
    // HUD window is optional.
  }

  await emit('hud-draw', {
    annotations: [
      {
        id: 'tactical_sector_alpha',
        app_id: 'internal',
        type: 'box',
        x: 180,
        y: 120,
        w: 420,
        h: 220,
        color: petStore.activeTheme.primary,
        label: `🎯 TACTICAL LOCK // ${petStore.currentPet?.name || DEFAULT_PET_NAME}`,
        sublabel: 'AR 全息空间透视层 · 物理鼠标穿透已激活',
        countdownSec: 12,
      },
      {
        id: 'tactical_vector_arrow',
        app_id: 'internal',
        type: 'arrow',
        x: 620,
        y: 230,
        targetX: 460,
        targetY: 200,
        color: petStore.activeTheme.accent,
        label: 'VECTOR LINK',
        countdownSec: 12,
      },
    ],
  });
}

export async function inspectSystemTelemetry(petStore: PetStore): Promise<void> {
  try {
    const t = await invoke<SystemTelemetry>('get_system_telemetry');
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.telemetryNative(t),
      durationMs: 5200,
    });
  } catch {
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.telemetryBrowser(
        navigator.hardwareConcurrency || 8,
        petStore.effectiveTargetFps,
        petStore.stats.level
      ),
      durationMs: 4600,
    });
  }
}

async function openCompanionPanel(
  petStore: PetStore,
  action: PetActionConfig
): Promise<void> {
  petStore.requestCompanionLoad({
    mode: action.mode || 'schema',
    title: action.title || '桌面宠物宿主控制中心',
    url: action.url,
    schema: action.schema,
  });

  try {
    await invoke('open_companion_window');
  } catch {
    petStore.scheduleAction({
      priority: 'P2',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.companionWoken,
      durationMs: 3000,
    });
  }
}

export async function executeStagePetAction(
  petStore: PetStore,
  action: PetActionConfig,
  extraPaths?: string[]
): Promise<void> {
  petStore.markUserActivity();
  petStore.addXpAndAffinity(8, 2);

  if (action.type === 'emit') {
    const eventName = action.event || 'pet.quick_action';
    const payload = action.payload || {};
    if (!action.app_id || action.app_id === 'internal') {
      await executeInternalStageEvent(petStore, eventName, payload);
      return;
    }
    try {
      await invoke('ws_send_event', {
        appId: action.app_id,
        method: eventName,
        params: payload,
      });
    } catch {
      // No external client is attached.
    }
    await emit('internal-menu-action', { event: eventName, payload });
    return;
  }

  if (action.type === 'panel') {
    await openCompanionPanel(petStore, action);
    return;
  }

  if (action.type !== 'exec' && action.type !== 'open' && action.type !== 'url') return;

  if (extraPaths?.length) {
    useCareStore().registerFilesAnalyzed(extraPaths.length);
  }

  const label = action.command || action.target || action.url || 'OK';
  try {
    const stdout = await invoke<string>('execute_pet_action', {
      action,
      extraArgs: extraPaths || null,
    });
    const output = stdout?.trim();
    if (!output) return;
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: output,
      durationMs: 5200,
    });
  } catch {
    petStore.scheduleAction({
      priority: 'P2',
      motion: 'pat',
      expression: 'surprised',
      text: STAGE_MESSAGES.localCommandDone(label),
      durationMs: 3600,
    });
  }
}

function readString(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function readNumber(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(payload[key]);
  return Number.isFinite(value) ? value : fallback;
}

export async function executeInternalStageEvent(
  petStore: PetStore,
  name: string,
  payload: Record<string, unknown>
): Promise<void> {
  switch (name) {
    case 'studio.toggle':
      petStore.studioOpen = !petStore.studioOpen;
      return;
    case 'chat.toggle':
      petStore.quickChatOpen = !petStore.quickChatOpen;
      return;
    case 'pet.quick_action':
      petStore.scheduleAction({
        priority: 'P2',
        motion: readString(payload, 'motion', 'happy'),
        expression: readString(payload, 'expression', 'smile'),
        text: readString(payload, 'text', ''),
        durationMs: 4000,
      });
      return;
    case 'pet.feed_care':
      petStore.feedPetCareItem(
        readString(payload, 'item', DEFAULT_CARE_ITEM),
        readNumber(payload, 'energy', 20),
        readNumber(payload, 'affinity', 8),
        readNumber(payload, 'xp', 25)
      );
      return;
    case 'pet.toggle_climb':
      await snapStageToForeground(petStore, false);
      return;
    case 'pet.edge_peek':
      await applyStageEdgePeek(petStore, !petStore.isEdgePeeked, true);
      return;
    case 'pet.tactical_scan':
      await projectTacticalHudScan(petStore);
      return;
    case 'pet.fortune_divination':
      petStore.triggerFortuneDivination();
      return;
    case 'pet.system_inspect':
      await inspectSystemTelemetry(petStore);
      return;
    case 'pomodoro.start': {
      const rawMode = readString(payload, 'mode', 'focus');
      const mode =
        rawMode === 'short_break' || rawMode === 'long_break' ? rawMode : 'focus';
      petStore.startPomodoro(
        readNumber(payload, 'minutes', POMODORO_DEFAULT_MINUTES),
        mode,
        readString(payload, 'label', '深度代码冲刺')
      );
      return;
    }
    case 'pomodoro.stop':
      petStore.stopPomodoro();
      return;
    case 'pet.switch_model':
      petStore.switchPetById(readString(payload, 'pet_id', ''));
      return;
    default:
      return;
  }
}

export function executeExternalSafeAction(
  petStore: PetStore,
  actionId: string,
  params: Record<string, unknown>,
  prio: ActionPriority
): void {
  switch (actionId) {
    case 'open_companion':
      void invoke('open_companion_window').catch(() => {});
      return;
    case 'toggle_studio':
      petStore.studioOpen = !petStore.studioOpen;
      return;
    case 'switch_emotion': {
      const emotion = String(params.emotion || 'smile');
      petStore.scheduleAction({
        priority: prio,
        motion: emotion === 'sleep' ? 'sleep' : 'happy',
        expression: emotion,
        text: STAGE_MESSAGES.emotionSwitched(emotion),
        durationMs: 3200,
      });
      return;
    }
    case 'switch_pet':
      petStore.switchPetById(String(params.pet_id || ''));
      return;
    case 'trigger_greeting':
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: STAGE_MESSAGES.externalGreeting(petStore.currentPet?.name || DEFAULT_PET_NAME),
        durationMs: 4000,
      });
      return;
    case 'start_pomodoro':
      petStore.startPomodoro(
        readNumber(params, 'minutes', POMODORO_DEFAULT_MINUTES),
        'focus',
        EXTERNAL_POMODORO_LABEL
      );
      return;
    case 'trigger_scan':
      void projectTacticalHudScan(petStore);
      return;
    case 'open_official_docs':
      petStore.scheduleAction({
        priority: prio,
        motion: 'happy',
        expression: 'smile',
        text: STAGE_MESSAGES.docsOpened,
        durationMs: 3000,
      });
      return;
    default:
      return;
  }
}

