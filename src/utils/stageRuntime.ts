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

let fsmInterval: number | null = null;
let lastHydrationAt = Date.now();
let lastPostureAt = Date.now();
let lastAutonomousAt = Date.now();

export function startStageAutonomousLoop(petStore: ReturnType<typeof usePetStore>): void {
  if (fsmInterval !== null) clearInterval(fsmInterval);

  fsmInterval = window.setInterval(() => {
    const now = Date.now();
    const idleSec = (now - petStore.lastUserActivityAt) / 1000;

    if (petStore.activeMotion === 'sleep') {
      petStore.stats.energy = Math.min(100, petStore.stats.energy + 1);
    }

    if (
      petStore.dnd_mode ||
      petStore.studioOpen ||
      petStore.radialMenuOpen ||
      petStore.currentAction
    ) {
      return;
    }

    const sleepThreshold = petStore.settings.behavior.sleep_after_idle_sec || 180;
    if (idleSec >= sleepThreshold && petStore.activeMotion !== 'sleep') {
      petStore.activeMotion = 'sleep';
      petStore.activeExpression = 'sleepy';
      petStore.scheduleAction({
        priority: 'P3',
        motion: 'sleep',
        expression: 'sleepy',
        text: '💤 检测到周围静默，已切入 24FPS 低功耗休眠巡航模式...',
        durationMs: 4000,
      });
      return;
    }

    if (petStore.settings.behavior.enable_health_reminders !== false) {
      const hydrationMs = (petStore.settings.behavior.hydration_interval_min || 45) * 60_000;
      if (now - lastHydrationAt >= hydrationMs) {
        lastHydrationAt = now;
        petStore.scheduleAction({
          priority: 'P2',
          motion: 'happy',
          expression: 'smile',
          text: '💧 贴心健康提醒：连续专注很久啦，喝口水补充一下水分吧！',
          durationMs: 6500,
          quickReplies: [
            {
              label: '💧 已喝水 (+15 XP)',
              action: {
                type: 'emit',
                app_id: 'internal',
                event: 'pet.feed_care',
                payload: { item: '健康补水打卡', energy: 10, affinity: 4, xp: 15 },
              },
            },
          ],
        });
        return;
      }

      const postureMs = (petStore.settings.behavior.posture_interval_min || 60) * 60_000;
      if (now - lastPostureAt >= postureMs) {
        lastPostureAt = now;
        petStore.scheduleAction({
          priority: 'P2',
          motion: 'pat',
          expression: 'smile',
          text: '🧘 护眼与坐姿提醒：久坐容易肩颈疲劳，起身活动 2 分钟、远眺窗外吧！',
          durationMs: 6500,
          quickReplies: [
            {
              label: '🧘 已舒展肩颈 (+15 XP)',
              action: {
                type: 'emit',
                app_id: 'internal',
                event: 'pet.feed_care',
                payload: { item: '舒展肩颈打卡', energy: 12, affinity: 5, xp: 15 },
              },
            },
          ],
        });
        return;
      }
    }

    const wanderSec = Math.max(25, petStore.settings.behavior.wander_interval_sec || 25);
    if (
      petStore.settings.behavior.enable_autonomous_fsm &&
      (now - lastAutonomousAt) / 1000 >= wanderSec &&
      idleSec < sleepThreshold
    ) {
      lastAutonomousAt = now;
      if (Math.random() < 0.35) {
        const thoughts = [
          `✨ [${petStore.currentPet?.name}] 正在守护你的工作区（好感度 ${petStore.stats.affinity}%）~`,
          '💡 按 Ctrl+K 或点击 💬 可唤出快捷指令栏，输入 `/focus 25` 开启番茄冲刺！',
          '⚡ 拖入任意代码文件即可统计行数与字节载荷。',
        ];
        petStore.scheduleAction({
          priority: 'P3',
          motion: 'idle',
          expression: 'smile',
          text: thoughts[Math.floor(Math.random() * thoughts.length)],
          durationMs: 3600,
        });
      }
    }
  }, 5000);
}

export async function snapStageToForeground(
  petStore: ReturnType<typeof usePetStore>,
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
        text: `🧲 已磁吸驻留在窗口【${res.target_title || '活动窗口'}】顶栏~`,
        durationMs: 3600,
      });
      return;
    }
  } catch {
    // Fallback outside Tauri
  }

  if (onlyIfNearTop) {
    petStore.isClimbedOnWindow = false;
  } else {
    petStore.isClimbedOnWindow = !petStore.isClimbedOnWindow;
    petStore.scheduleAction({
      priority: 'P2',
      motion: petStore.isClimbedOnWindow ? 'climb' : 'idle',
      expression: 'smile',
      text: petStore.isClimbedOnWindow
        ? '🧗 反重力攀爬已激活！拖拽靠近任何窗口标题栏即可磁吸锁定。'
        : '⚓ 已解除窗口顶栏磁吸锁定，恢复自由悬浮姿态。',
      durationMs: 3500,
    });
  }
}

export async function applyStageEdgePeek(
  petStore: ReturnType<typeof usePetStore>,
  enable: boolean,
  announce = false
): Promise<void> {
  petStore.isEdgePeeked = enable;
  try {
    await invoke('set_edge_peek_mode', { enable });
  } catch {
    try {
      const win = getCurrentWebviewWindow();
      const targetX = enable ? window.screen.availWidth - 140 : window.screen.availWidth - 420;
      await win.setPosition(new LogicalPosition(targetX, 260));
    } catch {
      // Browser preview fallback
    }
  }
  if (announce) {
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'idle',
      expression: 'surprised',
      text: enable
        ? '👀 已进入【贴边探头 Edge-Peek】姿态，全屏时绝不遮挡视野~'
        : '✨ 已从屏幕边缘回归主工作区！',
      durationMs: 3600,
    });
  }
}

export async function syncDesktopFullscreenState(
  petStore: ReturnType<typeof usePetStore>,
  state: DesktopWindowState
): Promise<void> {
  if (!petStore.settings.behavior.enable_fullscreen_edge_peek) return;
  if (state.is_fullscreen && !petStore.isEdgePeeked) {
    await applyStageEdgePeek(petStore, true, false);
  } else if (!state.is_fullscreen && petStore.isEdgePeeked) {
    await applyStageEdgePeek(petStore, false, false);
  }
}

export async function projectTacticalHudScan(
  petStore: ReturnType<typeof usePetStore>
): Promise<void> {
  petStore.scheduleAction({
    priority: 'P1',
    motion: 'happy',
    expression: 'surprised',
    text: '🎯 全屏战术 AR 雷达扫描已投射！标注层具备 100% 物理鼠标穿透能力。',
    durationMs: 4200,
  });

  try {
    const hudWin = await WebviewWindow.getByLabel('hud');
    await hudWin?.show();
  } catch {
    // Ignore
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
        label: `🎯 TACTICAL LOCK // ${petStore.currentPet?.name || 'AETHER-VII'}`,
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

export async function inspectSystemTelemetry(
  petStore: ReturnType<typeof usePetStore>
): Promise<void> {
  try {
    const t = await invoke<SystemTelemetry>('get_system_telemetry');
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: `💻 系统巡检：${t.os_name} (${t.arch}) | CPU ${t.cpu_cores} 核 | 运存 ${t.memory_usage_mb}MB | WS :${t.ws_port} 在线`,
      durationMs: 5200,
    });
  } catch {
    const cores = navigator.hardwareConcurrency || 8;
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: `💻 系统巡检：逻辑核心 ${cores} Threads | 渲染帧率 ${petStore.effectiveTargetFps} FPS | 等级 Lv.${petStore.stats.level}`,
      durationMs: 4600,
    });
  }
}

export async function executeStagePetAction(
  petStore: ReturnType<typeof usePetStore>,
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
    } else {
      try {
        await invoke('ws_send_event', {
          appId: action.app_id,
          method: eventName,
          params: payload,
        });
      } catch {
        // No external WS client
      }
      await emit('internal-menu-action', { event: eventName, payload });
    }
    return;
  }

  if (action.type === 'panel') {
    try {
      await invoke('open_companion_window');
      setTimeout(() => {
        void emit('companion-load', {
          mode: action.mode || 'schema',
          title: action.title || '桌面宠物宿主控制中心',
          url: action.url,
          schema: action.schema,
        });
      }, 160);
    } catch {
      petStore.scheduleAction({
        priority: 'P2',
        motion: 'happy',
        expression: 'smile',
        text: '🎛️ 伴生神经突触控制中心已唤醒！',
        durationMs: 3000,
      });
    }
    return;
  }

  if (action.type === 'exec' || action.type === 'open' || action.type === 'url') {
    if (extraPaths?.length) {
      const care = useCareStore();
      care.stats.filesAnalyzed += extraPaths.length;
      care.persistStats();
    }
    try {
      const stdout = await invoke<string>('execute_pet_action', {
        action,
        extraArgs: extraPaths || null,
      });
      if (stdout?.trim()) {
        petStore.scheduleAction({
          priority: 'P1',
          motion: 'happy',
          expression: 'smile',
          text: stdout.trim(),
          durationMs: 5200,
        });
      }
    } catch {
      petStore.scheduleAction({
        priority: 'P2',
        motion: 'pat',
        expression: 'surprised',
        text: `⚡ 本地指令执行完成 (${action.command || action.target || action.url || 'OK'})`,
        durationMs: 3600,
      });
    }
  }
}

export async function executeInternalStageEvent(
  petStore: ReturnType<typeof usePetStore>,
  name: string,
  payload: Record<string, unknown>
): Promise<void> {
  switch (name) {
    case 'studio.toggle':
      petStore.studioOpen = !petStore.studioOpen;
      break;
    case 'chat.toggle':
      petStore.quickChatOpen = !petStore.quickChatOpen;
      break;
    case 'pet.quick_action':
      petStore.scheduleAction({
        priority: 'P2',
        motion: (payload.motion as string) || 'happy',
        expression: (payload.expression as string) || 'smile',
        text: (payload.text as string) || '',
        durationMs: 4000,
      });
      break;
    case 'pet.feed_care':
      petStore.feedPetCareItem(
        (payload.item as string) || '全息数据糖果',
        Number(payload.energy) || 20,
        Number(payload.affinity) || 8,
        Number(payload.xp) || 25
      );
      break;
    case 'pet.toggle_climb':
      await snapStageToForeground(petStore, false);
      break;
    case 'pet.edge_peek':
      await applyStageEdgePeek(petStore, !petStore.isEdgePeeked, true);
      break;
    case 'pet.tactical_scan':
      await projectTacticalHudScan(petStore);
      break;
    case 'pet.fortune_divination':
      petStore.triggerFortuneDivination();
      break;
    case 'pet.system_inspect':
      await inspectSystemTelemetry(petStore);
      break;
    case 'pomodoro.start':
      petStore.startPomodoro(
        Number(payload.minutes) || 25,
        ((payload.mode as string) || 'focus') as 'focus' | 'short_break' | 'long_break',
        (payload.label as string) || '深度代码冲刺'
      );
      break;
    case 'pomodoro.stop':
      petStore.stopPomodoro();
      break;
    case 'pet.switch_model':
      if (typeof payload.pet_id === 'string') petStore.switchPetById(payload.pet_id);
      break;
  }
}

export function executeExternalSafeAction(
  petStore: ReturnType<typeof usePetStore>,
  actionId: string,
  params: Record<string, unknown>,
  prio: ActionPriority
): void {
  switch (actionId) {
    case 'open_companion':
      void invoke('open_companion_window').catch(() => {});
      break;
    case 'toggle_studio':
      petStore.studioOpen = !petStore.studioOpen;
      break;
    case 'switch_emotion': {
      const emo = String(params.emotion || 'smile');
      petStore.scheduleAction({
        priority: prio,
        motion: emo === 'sleep' ? 'sleep' : 'happy',
        expression: emo,
        text: `⚡ 已响应外部指令切换状态：[${emo.toUpperCase()}]`,
        durationMs: 3200,
      });
      break;
    }
    case 'switch_pet':
      if (typeof params.pet_id === 'string') petStore.switchPetById(params.pet_id);
      break;
    case 'trigger_greeting':
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: `👋 外部神经链路握手成功！我是 ${petStore.currentPet?.name || 'AETHER-VII'}。`,
        durationMs: 4000,
      });
      break;
    case 'start_pomodoro':
      petStore.startPomodoro(Number(params.minutes) || 25, 'focus', '外部联调专注冲刺');
      break;
    case 'trigger_scan':
      void projectTacticalHudScan(petStore);
      break;
    case 'open_official_docs':
      petStore.scheduleAction({
        priority: prio,
        motion: 'happy',
        expression: 'smile',
        text: '🌐 已为您在浏览器打开官方文档！',
        durationMs: 3000,
      });
      break;
  }
}
