<template>
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
        @click="handleButtonClick(widget.id, btn)"
      >
        {{ btn.label }}
      </button>
    </div>
  </div>

  <div v-else-if="widget.type === 'text_input'" class="pod-col">
    <label class="pod-label">{{ widget.label }}</label>
    <span v-if="widget.description" class="pod-desc">{{ widget.description }}</span>
    <textarea
      v-if="widget.multiline"
      v-model="widget.value"
      class="cyber-textarea"
      :placeholder="widget.placeholder"
      rows="3"
      @blur="commitTextInput(widget)"
      @keyup.ctrl.enter="commitTextInput(widget)"
    ></textarea>
    <input
      v-else
      v-model="widget.value"
      type="text"
      class="matrix-url-input"
      :placeholder="widget.placeholder"
      @blur="commitTextInput(widget)"
      @keyup.enter="commitTextInput(widget)"
    />
    <button v-if="widget.submit_label" class="clear-btn" @click="submitTextInput(widget)">
      {{ widget.submit_label }}
    </button>
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

  <div v-else-if="widget.type === 'container'" class="pod-col">
    <span v-if="widget.label" class="pod-label">{{ widget.label }}</span>
    <span v-if="widget.description" class="pod-desc">{{ widget.description }}</span>
    <div
      v-if="depth < SDUI_MAX_NESTING_DEPTH"
      class="sdui-container"
      :class="`layout-${widget.layout || 'stack'}`"
    >
      <SduiWidgetView
        v-for="child in widget.children"
        :key="child.id"
        :widget="child"
        :depth="depth + 1"
        :app-id="appId"
        @log="(line: string) => emit('log', line)"
      />
    </div>
    <span v-else class="pod-desc">
      嵌套层数超过 {{ SDUI_MAX_NESTING_DEPTH }} 层，宿主不再往下渲染这一层。
    </span>
  </div>

  <div v-else class="pod-col">
    <!--
      A schema is data, so `type` can be anything at all. Falling through to nothing left a
      blank card with no explanation; this says which type it was, so a panel author can
      tell a host that is too old from one that never got the value.
    -->
    <span class="pod-label">未知控件类型</span>
    <span class="pod-desc">
      宿主未渲染 [{{ unknownWidgetType(widget) }}]：本版本的控件类型只有
      status_badge / switch / select / slider / button_group / text_input / log_viewer /
      container。
    </span>
  </div>
</template>

<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { emit as tauriEmit } from '@tauri-apps/api/event';
import { usePetStore } from '@/store/petStore';
import { globalLipSync } from '@/utils/audioLipSync';
import type { SduiEffect, SduiWidget } from '@/types/pet';
import { SDUI_SAY_DURATION_MS, SDUI_MAX_NESTING_DEPTH } from '@/constants/timing';
import { planSduiEffect, type SduiEffectCommand } from '@/utils/sduiEffects';

/**
 * Renders one SDUI control and handles what it does.
 *
 * Separate from `PodsTab` because a `container` holds more widgets: a component that can
 * appear inside itself is the whole point, and an SFC may refer to itself by its own file
 * name, so the recursion needs no wiring. The stage's app_id comes through the schema the
 * parent holds, passed as a plain string so a nested control reports to the same app.
 */
const props = defineProps<{
  widget: SduiWidget;
  /** How deep this control already is, so a self-referential schema cannot run away. */
  depth?: number;
  appId?: string;
}>();

const emit = defineEmits<{
  (e: 'log', line: string): void;
}>();

const petStore = usePetStore();
const depth = props.depth ?? 0;

async function notifyHost(method: string, params: Record<string, unknown>): Promise<void> {
  try {
    await invoke('ws_send_event', {
      appId: props.appId || 'broadcast',
      method,
      params: { app_id: props.appId, ...params },
    });
  } catch {
    // No external WebSocket client is attached.
  }
}

function sliderPercent(widget: Extract<SduiWidget, { type: 'slider' }>): number {
  const span = Math.max(1, widget.max - widget.min);
  return Math.min(100, Math.max(0, ((widget.value - widget.min) / span) * 100));
}

/**
 * Name a widget type the host does not render.
 *
 * The else branch is unreachable through the type system — `SduiWidget` is a closed union
 * and every member is handled above — which is exactly why it needs a body: a schema is
 * data, and the value in `type` can be any string the panel author typed.
 */
function unknownWidgetType(widget: SduiWidget): string {
  const raw = (widget as { type?: unknown } | null)?.type;
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? widget);
}

async function applyWidgetSideEffect(
  effect: SduiEffect | undefined,
  value: unknown,
  subject: string
): Promise<void> {
  for (const command of planSduiEffect(effect, value)) {
    await runEffectCommand(command, subject);
  }
}

async function runEffectCommand(command: SduiEffectCommand, subject: string): Promise<void> {
  switch (command.type) {
    case 'set_window_climbing':
      petStore.settings.behavior.enable_window_climbing = command.value;
      await petStore.saveHostSettings();
      return;
    case 'set_click_through':
      await petStore.dispatchPatch({ is_click_through: command.value });
      return;
    case 'set_tts':
      petStore.settings.audio.enable_tts = command.value;
      await petStore.saveHostSettings();
      return;
    case 'set_mic_capture':
      petStore.settings.audio.stt.enabled = command.value;
      await petStore.saveHostSettings();
      return;
    case 'set_fps_override':
      petStore.setFpsOverride(command.value);
      return;
    case 'set_voice_gain':
      petStore.settings.audio.rms_gain = command.rmsGain;
      // Apply locally too: the bus only reaches the stage window, not this context.
      globalLipSync.setGainMultiplier(command.percent);
      await petStore.saveHostSettings();
      return;
    case 'say':
      petStore.scheduleAction({
        priority: 'P2',
        motion: 'happy',
        expression: 'smile',
        text: command.text,
        durationMs: command.durationMs || SDUI_SAY_DURATION_MS,
      });
      return;
    case 'hud_draw':
      await tauriEmit('hud-draw', { annotations: command.annotations });
      return;
    case 'hud_clear':
      await tauriEmit('hud-clear', {});
      return;
    case 'unsupported':
      // Readable degradation instead of a silent no-op: the panel's own console says what
      // the schema asked for and why the host could not do it.
      emit('log', `[未执行] ${subject}: ${command.reason}`);
      return;
  }
}

async function commitWidget(
  effect: SduiEffect | undefined,
  widgetId: string,
  value: unknown,
  subject: string
): Promise<void> {
  emit('log', `[SYNAPSE SYNC] ${widgetId} => ${JSON.stringify(value)}`);
  await applyWidgetSideEffect(effect, value, subject);
  await notifyHost('panel.state_changed', { widget_id: widgetId, value });
}

async function handleSwitchToggle(
  widget: Extract<SduiWidget, { type: 'switch' }>
): Promise<void> {
  widget.value = !widget.value;
  await commitWidget(widget.effect, widget.id, widget.value, `开关 ${widget.label}`);
}

async function handleSelectChange(
  widget: Extract<SduiWidget, { type: 'select' }>,
  newValue: string
): Promise<void> {
  widget.value = newValue;
  await commitWidget(widget.effect, widget.id, newValue, `下拉 ${widget.label}`);
}

async function handleSliderChange(
  widget: Extract<SduiWidget, { type: 'slider' }>,
  newValue: number
): Promise<void> {
  widget.value = newValue;
  await commitWidget(widget.effect, widget.id, newValue, `滑杆 ${widget.label}`);
}

/**
 * Upper bound on one text widget's value.
 *
 * The value travels over the WebSocket bus and back to the host, so an unbounded field
 * would let whichever app owns the panel decide how much memory the host spends.
 */
const MAX_SDUI_TEXT_LENGTH = 2000;

type TextInputWidget = Extract<SduiWidget, { type: 'text_input' }>;

function clampSduiText(value: string): string {
  return value.length > MAX_SDUI_TEXT_LENGTH ? value.slice(0, MAX_SDUI_TEXT_LENGTH) : value;
}

async function commitTextInput(widget: TextInputWidget): Promise<void> {
  widget.value = clampSduiText(widget.value);
  await commitWidget(widget.effect, widget.id, widget.value, `文本框 ${widget.label}`);
}

async function submitTextInput(widget: TextInputWidget): Promise<void> {
  widget.value = clampSduiText(widget.value);
  emit('log', `[SUBMIT] ${widget.label} => ${widget.value}`);
  await applyWidgetSideEffect(widget.effect, widget.value, `文本框 ${widget.label}`);
  await notifyHost('panel.text_submitted', { widget_id: widget.id, value: widget.value });
}

async function handleButtonClick(
  widgetId: string,
  button: Extract<SduiWidget, { type: 'button_group' }>['buttons'][number]
): Promise<void> {
  emit('log', `[TRIGGER] ${button.label} (${button.id})`);
  await applyWidgetSideEffect(button.effect, button.label, `按钮 ${button.label}`);
  await notifyHost('panel.button_clicked', {
    widget_id: widgetId,
    button_id: button.id,
    label: button.label,
  });
}
</script>
