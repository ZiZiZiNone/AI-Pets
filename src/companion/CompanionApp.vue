<template>
  <div class="spatial-companion-viewport" :style="petStore.activeThemeCssVars">
    <svg class="synapse-tether-svg" viewBox="0 0 380 520" preserveAspectRatio="none">
      <defs>
        <linearGradient id="synapseBeam" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" :stop-color="petStore.activeTheme.primary" stop-opacity="0.9" />
          <stop offset="50%" stop-color="#818cf8" stop-opacity="0.65" />
          <stop offset="100%" :stop-color="petStore.activeTheme.accent" stop-opacity="0.85" />
        </linearGradient>
      </defs>
      <g v-if="activeTab === 'pods'">
        <path
          v-for="(tether, idx) in podTetherPaths"
          :key="'tether_' + idx"
          :d="tether"
          fill="none"
          stroke="url(#synapseBeam)"
          stroke-width="1.6"
          stroke-dasharray="6 6"
          class="animated-synapse-path"
        />
      </g>
    </svg>

    <header class="neural-core-hub" @mousedown="handleHeaderDrag">
      <div class="hub-left">
        <div class="core-reactor-orb">
          <span class="orb-ring"></span>
          <span class="orb-dot"></span>
        </div>
        <div class="hub-titles">
          <div class="hub-callsign">NEURAL SYNAPSE // {{ activeSchema.app_id || 'CORE' }}</div>
          <h1 class="hub-title">{{ activeSchema.title || panelTitle }}</h1>
        </div>
      </div>
      <div class="hub-controls" @mousedown.stop>
        <button class="holo-close-btn" title="收起空间伴生舱" @click="hidePanel">✕</button>
      </div>
    </header>

    <nav class="sector-nav-bar">
      <button :class="{ active: activeTab === 'pods' }" @click="activeTab = 'pods'">
        🧬 神经突触舱
      </button>
      <button :class="{ active: activeTab === 'focus' }" @click="activeTab = 'focus'">
        🍅 专注与待办
      </button>
      <button :class="{ active: activeTab === 'care' }" @click="activeTab = 'care'">
        ❤️ 机体羁绊
      </button>
      <button :class="{ active: activeTab === 'matrix' }" @click="activeTab = 'matrix'">
        🌐 网页与AI脑桥
      </button>
    </nav>

    <PodsTab
      v-if="activeTab === 'pods'"
      :schema="activeSchema"
      :pod-offsets="podOffsets"
      @nudge-pod="nudgePod"
      @log="appendLogLine"
    />
    <FocusTodoTab
      v-else-if="activeTab === 'focus'"
      @input-focus="onInputFocus"
      @input-blur="onInputBlur"
      @log="appendLogLine"
    />
    <CareFleetTab
      v-else-if="activeTab === 'care'"
      @log="appendLogLine"
    />
    <WebMatrixTab
      v-else
      :initial-url="externalUrlInput"
      @input-focus="onInputFocus"
      @input-blur="onInputBlur"
      @log="appendLogLine"
    />

    <footer class="neural-injector-bar">
      <span class="injector-prefix">CMD ▸</span>
      <input
        v-model="quickSayText"
        type="text"
        class="injector-input"
        placeholder="输入全息对话或斜杠指令 (/focus 25, /todo, /fortune, /sys)..."
        @focus="onInputFocus"
        @blur="onInputBlur"
        @keyup.enter="sendQuickSay"
      />
      <button class="injector-send-btn" @click="sendQuickSay">TRANSMIT</button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import PodsTab from './PodsTab.vue';
import FocusTodoTab from './FocusTodoTab.vue';
import CareFleetTab from './CareFleetTab.vue';
import WebMatrixTab from './WebMatrixTab.vue';
import { usePetStore } from '@/store/petStore';
import type { SduiSchema, SduiWidget, SystemTelemetry } from '@/types/pet';
import { COMPANION_LOG_LIMIT, POD_NUDGE_LIMIT_PX } from '@/constants/timing';
import { formatMemoryMb } from '@/constants/messages';

/**
 * Writes a remote value into a widget without widening the discriminated union.
 *
 * The companion-update-state payload is attacker-reachable over the bus, so a cast to
 * `{ value: unknown }` would let an arbitrary JSON value land in a field the renderer
 * expects to be a string or boolean.
 */
function applyWidgetValue(widget: SduiWidget, value: unknown): boolean {
  switch (widget.type) {
    case 'status_badge':
    case 'select':
      if (typeof value !== 'string') return false;
      widget.value = value;
      return true;
    case 'switch':
      if (typeof value !== 'boolean') return false;
      widget.value = value;
      return true;
    case 'slider':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      widget.value = value;
      return true;
    case 'text_input':
      if (typeof value !== 'string') return false;
      widget.value = value;
      return true;
    default:
      return false;
  }
}

const petStore = usePetStore();

const activeTab = ref<'pods' | 'focus' | 'care' | 'matrix'>('pods');
const panelTitle = ref<string>('空间神经突触伴生舱');
const externalUrlInput = ref<string>('');
const quickSayText = ref<string>('');
const podOffsets = reactive<Record<string, number>>({});
const unlistenFns: UnlistenFn[] = [];

const activeSchema = ref<SduiSchema>({
  app_id: 'host_builtin_panel',
  title: 'AETHER 空间神经突触控制台',
  subtitle: 'SVG 能量束实时连接的可折叠空间悬浮舱',
  widgets: [
    {
      id: 'host_status',
      type: 'status_badge',
      label: '微内核神经总线',
      value: 'ONLINE // :9527 READY',
      tone: 'success',
    },
    {
      id: 'enable_climb',
      type: 'switch',
      label: '前景窗口标题栏磁吸攀爬',
      description: '拖拽靠近活动窗口顶部时自动产生磁吸驻留',
      value: true,
    },
    {
      id: 'enable_click_through',
      type: 'switch',
      label: '全局物理鼠标穿透模式',
      description: '开启后宠物窗口完全不拦截鼠标点击',
      value: false,
    },
    {
      id: 'enable_tts',
      type: 'switch',
      label: '语音合成播报 (TTS)',
      description: '弹出对话气泡时朗读文本；用哪种声音在「🌐 网页与AI脑桥」的语音桥里选',
      value: true,
    },
    {
      id: 'fps_mode',
      type: 'select',
      label: 'WebGL 渲染引擎时序策略',
      value: 'dynamic',
      options: [
        { label: '动态自适应 (Idle 24 / Active 60 FPS)', value: 'dynamic' },
        { label: '全功率超频 (锁定 60 FPS)', value: '60' },
        { label: '静默巡航 (锁定 30 FPS)', value: '30' },
      ],
    },
    {
      id: 'voice_gain',
      type: 'slider',
      label: '声波 RMS 口型同步增益',
      value: 80,
      min: 10,
      max: 200,
      step: 5,
      unit: '%',
    },
    {
      id: 'quick_cmds',
      type: 'button_group',
      label: '空间战术指令矩阵',
      buttons: [
        { id: 'btn_test_bubble', label: '全息脉冲播报', variant: 'primary' },
        { id: 'btn_test_hud', label: '投射AR雷达', variant: 'secondary' },
        { id: 'btn_clear_hud', label: '静默清除HUD', variant: 'danger' },
      ],
    },
    {
      id: 'runtime_logs',
      type: 'log_viewer',
      label: '微内核实时遥测流',
      lines: [
        '[Kernel] Spatial Neural Companion Pods initialized',
        '[Win32] WS_EX_NOACTIVATE zero-focus-steal active',
      ],
    },
  ],
});

const podTetherPaths = computed<string[]>(() => {
  const startX = 190;
  const startY = 48;
  return activeSchema.value.widgets.map((w, i) => {
    const shiftX = podOffsets[w.id] || 0;
    const targetX = (i % 2 === 0 ? 110 : 270) + shiftX;
    const targetY = 128 + i * 68;
    const ctrlY1 = startY + (targetY - startY) * 0.45;
    const ctrlY2 = startY + (targetY - startY) * 0.75;
    return `M ${startX} ${startY} C ${startX} ${ctrlY1}, ${targetX} ${ctrlY2}, ${targetX} ${targetY}`;
  });
});

function syncWidgetsFromLiveState(telemetry?: SystemTelemetry): void {
  for (const w of activeSchema.value.widgets) {
    if (w.id === 'host_status' && w.type === 'status_badge' && telemetry) {
      w.value = `ONLINE // :${telemetry.ws_port} (${telemetry.connected_clients} CONN)`;
    } else if (w.id === 'enable_climb' && w.type === 'switch') {
      w.value = petStore.settings.behavior.enable_window_climbing;
    } else if (w.id === 'enable_click_through' && w.type === 'switch') {
      w.value = petStore.is_click_through;
    } else if (w.id === 'enable_tts' && w.type === 'switch') {
      w.value = petStore.settings.audio.enable_tts;
    } else if (w.id === 'fps_mode' && w.type === 'select') {
      w.value = petStore.fpsOverride;
    } else if (w.id === 'voice_gain' && w.type === 'slider') {
      w.value = Math.round((petStore.settings.audio.rms_gain || 3.2) * 25);
    }
  }
}

async function handleHeaderDrag(): Promise<void> {
  try {
    await getCurrentWebviewWindow().startDragging();
  } catch {
    // Browser preview
  }
}

function nudgePod(id: string, delta: number): void {
  podOffsets[id] = Math.max(
    -POD_NUDGE_LIMIT_PX,
    Math.min(POD_NUDGE_LIMIT_PX, (podOffsets[id] || 0) + delta)
  );
}

async function hidePanel(): Promise<void> {
  await window.PetBridge?.panel.close();
}

async function onInputFocus(): Promise<void> {
  try {
    await invoke('set_companion_focusable', { focusable: true });
  } catch {
    // Ignore
  }
}

async function onInputBlur(): Promise<void> {
  try {
    await invoke('set_companion_focusable', { focusable: false });
  } catch {
    // Ignore
  }
}

async function sendQuickSay(): Promise<void> {
  const text = quickSayText.value.trim();
  if (!text) return;
  quickSayText.value = '';
  await petStore.submitUserChatCommand(text);
  appendLogLine(`[CMD -> PET] ${text}`);
}

function appendLogLine(line: string): void {
  const logWidget = activeSchema.value.widgets.find(
    (w): w is Extract<SduiWidget, { type: 'log_viewer' }> => w.type === 'log_viewer'
  );
  if (logWidget) {
    logWidget.lines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (logWidget.lines.length > COMPANION_LOG_LIMIT) {
      logWidget.lines.splice(0, logWidget.lines.length - COMPANION_LOG_LIMIT);
    }
  }
}

onMounted(async () => {
  await petStore.initializeHost('companion');

  try {
    const telemetry = await invoke<SystemTelemetry>('get_system_telemetry');
    syncWidgetsFromLiveState(telemetry);
    appendLogLine(
      `[Telemetry] ${telemetry.os_name} (${telemetry.arch}) // WS :${telemetry.ws_port} // RAM ${formatMemoryMb(telemetry.memory_usage_mb)}`
    );
  } catch {
    syncWidgetsFromLiveState();
  }

  try {
    unlistenFns.push(
      await listen('pet-state:sync', () => {
        syncWidgetsFromLiveState();
      })
    );

    unlistenFns.push(
      await listen('config-hot-reload', async () => {
        await petStore.initializeHost('companion');
        syncWidgetsFromLiveState();
        appendLogLine('[HotReload] Synced updated YAML configs from disk');
      })
    );

    unlistenFns.push(
      await listen<{
        mode: 'schema' | 'url';
        url?: string;
        title?: string;
        schema?: SduiSchema;
      }>('companion-load', (evt) => {
        const p = evt.payload;
        if (p.title) panelTitle.value = p.title;
        if (p.mode === 'url' && p.url) {
          activeTab.value = 'matrix';
          externalUrlInput.value = p.url;
        } else if (p.schema) {
          activeTab.value = 'pods';
          activeSchema.value = p.schema;
        }
      })
    );

    unlistenFns.push(
      await listen<{
        app_id?: string;
        widget_id?: string;
        value?: unknown;
        log_line?: string;
      }>('companion-update-state', (evt) => {
        const p = evt.payload;
        if (p.log_line) appendLogLine(p.log_line);
        if (p.widget_id !== undefined && p.value !== undefined) {
          const target = activeSchema.value.widgets.find((w) => w.id === p.widget_id);
          if (target) applyWidgetValue(target, p.value);
        }
      })
    );

    unlistenFns.push(
      await listen<{ line: string }>('companion-log-line', (evt) =>
        appendLogLine(evt.payload.line)
      )
    );
  } catch {
    // Browser preview
  }
});

onBeforeUnmount(() => {
  for (const fn of unlistenFns) fn();
});
</script>
