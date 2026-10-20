import type {
  HudAnnotation,
  PetFpsOverride,
  SduiEffect,
  SduiSettingEffect,
  SduiWidget,
} from '@/types/pet';
import { VOICE_GAIN_PERCENT_SCALE } from '@/constants/timing';

/**
 * One thing the panel wants the host to do, with its arguments already resolved.
 *
 * Planning and doing are separate on purpose. The renderer's job — deciding *what* a
 * schema asked for — is pure and testable; the store's job — writing a setting, saving it,
 * poking the lip-sync analyser — needs a live host and is not.
 */
export type SduiEffectCommand =
  | { type: 'set_window_climbing'; value: boolean }
  | { type: 'set_click_through'; value: boolean }
  | { type: 'set_tts'; value: boolean }
  | { type: 'set_mic_capture'; value: boolean }
  | { type: 'set_fps_override'; value: PetFpsOverride }
  | { type: 'set_voice_gain'; percent: number; rmsGain: number }
  | { type: 'say'; text: string; durationMs?: number }
  | { type: 'hud_draw'; annotations: HudAnnotation[] }
  | { type: 'hud_clear' }
  /**
   * Something the host cannot carry out, with a reason fit to show the panel author.
   *
   * This is the command that replaces silence. The renderer used to recognise five widget
   * ids by name and do nothing at all for anything else, so a panel that came from
   * anywhere but the built-in one had controls that looked live and were inert.
   */
  | { type: 'unsupported'; reason: string };

/**
 * Resolve the effect declared on a widget (or on a button inside a `button_group`).
 *
 * `value` is the widget's own value, which is what a setting effect writes. Returns an
 * empty list when no effect was declared — that is a panel choosing to only report state to
 * its own app, which is a legitimate choice and not a mistake to report.
 */
export function planSduiEffect(
  effect: SduiEffect | undefined,
  value: unknown
): SduiEffectCommand[] {
  if (!effect) return [];

  switch (effect.kind) {
    case 'setting':
      return planSettingEffect(effect.setting, value);
    case 'say': {
      const text = effect.text ?? (typeof value === 'string' ? value : '');
      if (!text) {
        return [unsupported('副作用 [say] 既没有写死 text，控件值也不是字符串')];
      }
      return [{ type: 'say', text, durationMs: effect.durationMs }];
    }
    case 'hud_draw':
      if (effect.annotations.length === 0) {
        return [unsupported('副作用 [hud_draw] 的 annotations 是空的，画出来什么也没有')];
      }
      return [{ type: 'hud_draw', annotations: effect.annotations }];
    case 'hud_clear':
      return [{ type: 'hud_clear' }];
    default:
      return [
        unsupported(
          `未知副作用 [${describeUnknown(effect)}]，宿主没有执行；请改用宿主支持的种类或升级宿主`
        ),
      ];
  }
}

function planSettingEffect(setting: SduiSettingEffect, value: unknown): SduiEffectCommand[] {
  switch (setting) {
    case 'window_climbing':
      return typeof value === 'boolean'
        ? [{ type: 'set_window_climbing', value }]
        : [unsupported(setting, '布尔开关')];
    case 'click_through':
      return typeof value === 'boolean'
        ? [{ type: 'set_click_through', value }]
        : [unsupported(setting, '布尔开关')];
    case 'tts':
      return typeof value === 'boolean'
        ? [{ type: 'set_tts', value }]
        : [unsupported(setting, '布尔开关')];
    case 'mic_capture':
      return typeof value === 'boolean'
        ? [{ type: 'set_mic_capture', value }]
        : [unsupported(setting, '布尔开关')];
    case 'fps_mode':
      return isFpsOverride(value)
        ? [{ type: 'set_fps_override', value }]
        : [unsupported(setting, "取值为 'dynamic' / '60' / '30' 的字符串")];
    case 'voice_gain': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [unsupported(setting, '数字')];
      }
      return [
        {
          type: 'set_voice_gain',
          percent: value,
          // Same conversion the host applies when it reads the setting back, so a panel
          // that writes 40 and reads 40 sees the same number.
          rmsGain: Number((value / VOICE_GAIN_PERCENT_SCALE).toFixed(2)),
        },
      ];
    }
    default:
      return [
        unsupported(
          `未知设置项 [${describeUnknown(setting)}]，宿主没有执行；可用的是 window_climbing / click_through / tts / mic_capture / fps_mode / voice_gain`
        ),
      ];
  }
}

function isFpsOverride(value: unknown): value is PetFpsOverride {
  return value === 'dynamic' || value === '60' || value === '30';
}

/**
 * The host value a widget should show before anyone touches it.
 *
 * Written effects need this to be symmetric: without it a panel could set a setting and
 * still display a stale value, and only the built-in panel happened to look right because
 * its ids were the ones the renderer compared against.
 */
export function readSduiSettingValue<
  Live extends Partial<Record<SduiSettingEffect, unknown>>,
>(setting: SduiSettingEffect, live: Live): unknown {
  return live[setting];
}

/**
 * The setting a widget declares, if it declares one.
 *
 * Lets the panel seed its controls from live host state without naming any id.
 */
export function declaredSettingEffect(widget: SduiWidget): SduiSettingEffect | null {
  const effect: SduiEffect | undefined =
    'effect' in widget ? (widget.effect as SduiEffect | undefined) : undefined;
  return effect?.kind === 'setting' ? effect.setting : null;
}

function unsupported(reason: string, expected?: string): SduiEffectCommand {
  return {
    type: 'unsupported',
    reason: expected ? `副作用参数类型不符：${reason} 需要 ${expected}` : reason,
  };
}

/**
 * Name an unrecognised effect or setting in the message.
 *
 * A schema is data, so its `kind` can be any string at all; reading it back is the only way
 * the message can say which value it did not understand.
 */
function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'kind' in value) {
    const kind = (value as { kind: unknown }).kind;
    return typeof kind === 'string' ? kind : JSON.stringify(kind);
  }
  return JSON.stringify(value) ?? String(value);
}
