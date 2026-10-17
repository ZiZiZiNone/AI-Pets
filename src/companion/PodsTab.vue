<template>
  <main class="spatial-pods-stream">
    <div
      v-for="(widget, idx) in widgets"
      :key="widget.id"
      class="spatial-pod-card"
      :class="[
        idx % 2 === 0 ? 'align-left' : 'align-right',
        { collapsed: collapsedPods[widget.id] }
      ]"
      :style="{ transform: `translateX(${podOffsets[widget.id] || 0}px)` }"
    >
      <div class="pod-meta-bar" @dblclick="togglePodCollapse(widget.id)">
        <span class="pod-code">POD-0{{ idx + 1 }} // {{ widget.type.toUpperCase() }}</span>
        <div class="pod-bar-actions">
          <button
            class="nudge-btn"
            title="左移微调"
            @click.stop="emit('nudge-pod', widget.id, -POD_NUDGE_STEP_PX)"
          >
            ◂
          </button>
          <button
            class="nudge-btn"
            title="右移微调"
            @click.stop="emit('nudge-pod', widget.id, POD_NUDGE_STEP_PX)"
          >
            ▸
          </button>
          <button
            class="nudge-btn"
            :title="collapsedPods[widget.id] ? '展开模块' : '折叠模块'"
            @click.stop="togglePodCollapse(widget.id)"
          >
            {{ collapsedPods[widget.id] ? '+' : '−' }}
          </button>
        </div>
      </div>

      <div v-show="!collapsedPods[widget.id]" class="pod-content">
        <div v-if="widget.type === 'status_badge'" class="pod-row">
          <span class="pod-label">{{ widget.label }}</span>
          <span class="holo-status-badge" :class="widget.tone || 'info'">
            <span class="badge-pulse"></span>
            {{ widget.value }}
          </span>
        </div>

        <div v-else-if="widget.type === 'switch'" class="pod-row">
          <div class="pod-text-group">
            <span class="pod-label">{{ widget.label }}</span>
            <span v-if="widget.description" class="pod-desc">{{ widget.description }}</span>
          </div>
          <button
            class="cyber-switch"
            :class="{ active: widget.value }"
            @click="handleSwitchToggle(widget)"
          >
            <span class="switch-blade"></span>
            <span class="switch-state">{{ widget.value ? 'ON' : 'OFF' }}</span>
          </button>
        </div>

        <div v-else-if="widget.type === 'select'" class="pod-col">
          <label class="pod-label">{{ widget.label }}</label>
          <select
            :value="widget.value"
            class="cyber-select"
            @change="handleSelectChange(widget, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in widget.options" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div v-else-if="widget.type === 'slider'" class="pod-col">
          <div class="slider-top">
            <span class="pod-label">{{ widget.label }}</span>
            <span class="slider-readout">{{ widget.value }}{{ widget.unit || '' }}</span>
          </div>
          <div class="cyber-slider-track">
            <div class="cyber-slider-fill" :style="{ width: `${sliderPercent(widget)}%` }"></div>
            <input
              type="range"
              class="cyber-slider-input"
              :min="widget.min"
              :max="widget.max"
              :step="widget.step || 1"
              :value="widget.value"
              @input="handleSliderChange(widget, Number(($event.target as HTMLInputElement).value))"
            />
          </div>
        </div>

        <div v-else-if="widget.type === 'button_group'" class="pod-col">
          <span class="pod-label">{{ widget.label }}</span>
          <div class="cyber-btn-matrix">
            <button
              v-for="btn in widget.buttons"
              :key="btn.id"
              class="cyber-action-btn"
              :class="btn.variant || 'secondary'"
              @click="handleButtonClick(widget.id, btn.id, btn.label)"
            >
              {{ btn.label }}
            </button>
          </div>
        </div>

        <div v-else-if="widget.type === 'log_viewer'" class="pod-col">
          <div class="log-top">
            <span class="pod-label">{{ widget.label }}</span>
            <button class="clear-btn" @click="widget.lines = []">PURGE</button>
          </div>
          <div class="holo-terminal">
            <div v-for="(line, lIdx) in widget.lines" :key="lIdx" class="term-line">
              <span class="term-prompt">❯</span>
              <span>{{ line }}</span>
            </div>
            <div v-if="widget.lines.length === 0" class="term-empty">
              AWAITING TELEMETRY STREAM...
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emit as tauriEmit } from '@tauri-apps/api/event';
import { usePetStore } from '@/store/petStore';
import { globalLipSync } from '@/utils/audioLipSync';
import type { SduiSchema, SduiWidget } from '@/types/pet';
import { HUD_ANIMATION_BOX, POD_NUDGE_STEP_PX, VOICE_GAIN_PERCENT_SCALE } from '@/constants/timing';
import { STAGE_MESSAGES } from '@/constants/messages';

const props = defineProps<{
  schema: SduiSchema;
  podOffsets: Record<string, number>;
}>();

const emit = defineEmits<{
  (e: 'nudge-pod', id: string, delta: number): void;
  (e: 'log', line: string): void;
}>();

const petStore = usePetStore();
const collapsedPods = reactive<Record<string, boolean>>({});

// The schema arrives through a prop but is driven by a remote host over the bus, so the
// view works on its own deep copy. Editing in place would otherwise mutate a prop and
// corrupt the state the companion emits back to the stage.
const widgets = ref<SduiWidget[]>(structuredClone(props.schema.widgets));

watch(
  () => props.schema.widgets,
  (next) => {
    widgets.value = structuredClone(next);
  },
  { deep: true }
);

function togglePodCollapse(id: string): void {
  collapsedPods[id] = !collapsedPods[id];
}

function sliderPercent(widget: Extract<SduiWidget, { type: 'slider' }>): number {
  const span = Math.max(1, widget.max - widget.min);
  return Math.min(100, Math.max(0, ((widget.value - widget.min) / span) * 100));
}

async function notifyHost(method: string, params: Record<string, unknown>): Promise<void> {
  try {
    await invoke('ws_send_event', {
      appId: props.schema.app_id || 'broadcast',
      method,
      params: { app_id: props.schema.app_id, ...params },
    });
  } catch {
    // No external WebSocket client is attached.
  }
}

async function applyWidgetSideEffect(widgetId: string, value: unknown): Promise<void> {
  if (widgetId === 'enable_climb' && typeof value === 'boolean') {
    petStore.settings.behavior.enable_window_climbing = value;
    await petStore.saveHostSettings();
  } else if (widgetId === 'enable_click_through' && typeof value === 'boolean') {
    await petStore.dispatchPatch({ is_click_through: value });
  } else if (widgetId === 'enable_tts' && typeof value === 'boolean') {
    petStore.settings.audio.enable_tts = value;
    await petStore.saveHostSettings();
  } else if (widgetId === 'fps_mode' && typeof value === 'string') {
    petStore.setFpsOverride(value as 'dynamic' | '60' | '30');
  } else if (widgetId === 'voice_gain' && typeof value === 'number') {
    petStore.settings.audio.rms_gain = Number(
      (value / VOICE_GAIN_PERCENT_SCALE).toFixed(2)
    );
    // Apply locally too: the bus only reaches the stage window, not this context.
    globalLipSync.setGainMultiplier(value);
    await petStore.saveHostSettings();
  }
}

async function commitWidget(widgetId: string, value: unknown): Promise<void> {
  emit('log', `[SYNAPSE SYNC] ${widgetId} => ${JSON.stringify(value)}`);
  await applyWidgetSideEffect(widgetId, value);
  await notifyHost('panel.state_changed', { widget_id: widgetId, value });
}

async function handleSwitchToggle(
  widget: Extract<SduiWidget, { type: 'switch' }>
): Promise<void> {
  widget.value = !widget.value;
  await commitWidget(widget.id, widget.value);
}

async function handleSelectChange(
  widget: Extract<SduiWidget, { type: 'select' }>,
  newValue: string
): Promise<void> {
  widget.value = newValue;
  await commitWidget(widget.id, newValue);
}

async function handleSliderChange(
  widget: Extract<SduiWidget, { type: 'slider' }>,
  newValue: number
): Promise<void> {
  widget.value = newValue;
  await commitWidget(widget.id, newValue);
}

async function handleButtonClick(
  widgetId: string,
  buttonId: string,
  label: string
): Promise<void> {
  emit('log', `[TRIGGER] ${label} (${buttonId})`);

  if (buttonId === 'btn_test_bubble') {
    petStore.scheduleAction({
      priority: 'P2',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.companionWoken,
      durationMs: 3600,
    });
  } else if (buttonId === 'btn_test_hud') {
    await tauriEmit('hud-draw', {
      annotations: [
        {
          id: 'demo_hud_box',
          app_id: 'host_builtin_panel',
          type: 'box',
          x: HUD_ANIMATION_BOX.x,
          y: HUD_ANIMATION_BOX.y,
          w: HUD_ANIMATION_BOX.w,
          h: HUD_ANIMATION_BOX.h,
          color: petStore.activeTheme.primary,
          label: '🎯 空间战术锁定 // SECTOR-01',
          sublabel: 'AR 雷达环绕投影 (100% 物理鼠标穿透)',
          countdownSec: HUD_ANIMATION_BOX.countdownSec,
        },
      ],
    });
  } else if (buttonId === 'btn_clear_hud') {
    await tauriEmit('hud-clear', {});
  }

  await notifyHost('panel.button_clicked', { widget_id: widgetId, button_id: buttonId, label });
}
</script>
