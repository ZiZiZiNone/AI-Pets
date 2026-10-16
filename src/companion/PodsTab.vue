<template>
  <main class="spatial-pods-stream">
    <div
      v-for="(widget, idx) in schema.widgets"
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
          <button class="nudge-btn" title="左移微调" @click.stop="nudgePod(widget.id, -8)">◂</button>
          <button class="nudge-btn" title="右移微调" @click.stop="nudgePod(widget.id, 8)">▸</button>
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
            <div
              class="cyber-slider-fill"
              :style="{
                width: `${Math.min(100, Math.max(0, ((widget.value - widget.min) / Math.max(1, widget.max - widget.min)) * 100))}%`
              }"
            ></div>
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
import { reactive } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emit as tauriEmit } from '@tauri-apps/api/event';
import { usePetStore } from '@/store/petStore';
import { globalLipSync } from '@/utils/audioLipSync';
import type { SduiSchema, SduiWidget } from '@/types/pet';

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

function togglePodCollapse(id: string): void {
  collapsedPods[id] = !collapsedPods[id];
}

function nudgePod(id: string, delta: number): void {
  emit('nudge-pod', id, delta);
}

async function syncWidgetValue(widgetId: string, value: unknown): Promise<void> {
  emit('log', `[SYNAPSE SYNC] ${widgetId} => ${JSON.stringify(value)}`);

  if (widgetId === 'enable_climb' && typeof value === 'boolean') {
    petStore.settings.behavior.enable_window_climbing = value;
    await petStore.saveHostSettings();
  } else if (widgetId === 'enable_click_through' && typeof value === 'boolean') {
    await petStore.dispatchPatch({ is_click_through: value });
  } else if (widgetId === 'enable_tts' && typeof value === 'boolean') {
    petStore.settings.audio.enable_tts = value;
    await petStore.saveHostSettings();
  } else if (widgetId === 'fps_mode' && typeof value === 'string') {
    petStore.fpsOverride = value as 'dynamic' | '60' | '30';
  } else if (widgetId === 'voice_gain' && typeof value === 'number') {
    petStore.settings.audio.rms_gain = Number((value / 25).toFixed(2));
    globalLipSync.setGainMultiplier(value);
    await petStore.saveHostSettings();
  }

  try {
    await invoke('ws_send_event', {
      appId: props.schema.app_id || 'broadcast',
      method: 'panel.state_changed',
      params: { app_id: props.schema.app_id, widget_id: widgetId, value },
    });
  } catch {
    // No external WS client
  }
}

async function handleSwitchToggle(widget: Extract<SduiWidget, { type: 'switch' }>): Promise<void> {
  widget.value = !widget.value;
  await syncWidgetValue(widget.id, widget.value);
}

async function handleSelectChange(
  widget: Extract<SduiWidget, { type: 'select' }>,
  newValue: string
): Promise<void> {
  widget.value = newValue;
  await syncWidgetValue(widget.id, newValue);
}

async function handleSliderChange(
  widget: Extract<SduiWidget, { type: 'slider' }>,
  newValue: number
): Promise<void> {
  widget.value = newValue;
  await syncWidgetValue(widget.id, newValue);
}

async function handleButtonClick(
  widgetId: string,
  buttonId: string,
  label: string
): Promise<void> {
  emit('log', `[TRIGGER] ${label} (${buttonId})`);

  if (buttonId === 'btn_test_bubble') {
    await window.PetBridge.act({
      motion: 'happy',
      expression: 'smile',
      text: '⚡ 空间神经突触信号已送达！声波频谱与姿态同步完成。',
      priority: 'P2',
    });
  } else if (buttonId === 'btn_test_hud') {
    await tauriEmit('hud-draw', {
      annotations: [
        {
          id: 'demo_hud_box',
          app_id: 'host_builtin_panel',
          type: 'box',
          x: 240,
          y: 160,
          w: 340,
          h: 190,
          color: petStore.activeTheme.primary,
          label: '🎯 空间战术锁定 // SECTOR-01',
          sublabel: 'AR 雷达环绕投影 (100% 物理鼠标穿透)',
          countdownSec: 15,
        },
      ],
    });
  } else if (buttonId === 'btn_clear_hud') {
    await tauriEmit('hud-clear', {});
  }

  try {
    await invoke('ws_send_event', {
      appId: props.schema.app_id || 'broadcast',
      method: 'panel.button_clicked',
      params: {
        app_id: props.schema.app_id,
        widget_id: widgetId,
        button_id: buttonId,
        label,
      },
    });
  } catch {
    // Ignore
  }
}
</script>
