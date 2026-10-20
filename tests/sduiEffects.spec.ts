import { describe, expect, it } from 'vitest';
import {
  declaredSettingEffect,
  planSduiEffect,
  readSduiSettingValue,
} from '@/utils/sduiEffects';
import type { SduiEffect, SduiSettingEffect, SduiWidget } from '@/types/pet';
import { VOICE_GAIN_PERCENT_SCALE } from '@/constants/timing';

/**
 * The panel renderer used to decide side effects by comparing widget ids against a list
 * compiled into it (`enable_climb`, `enable_tts`, …), so a panel from anyone else had
 * controls that looked live and did nothing. These tests pin the replacement: the schema
 * declares the effect, and everything the host cannot carry out comes back as a reason
 * rather than as silence.
 */
describe('SDUI effect planning', () => {
  it('plans nothing when no effect was declared', () => {
    // A panel that only reports state to its own app is making a choice, not a mistake.
    expect(planSduiEffect(undefined, true)).toEqual([]);
  });

  it('maps each setting to the command that writes it', () => {
    expect(planSduiEffect({ kind: 'setting', setting: 'window_climbing' }, true)).toEqual([
      { type: 'set_window_climbing', value: true },
    ]);
    expect(planSduiEffect({ kind: 'setting', setting: 'click_through' }, false)).toEqual([
      { type: 'set_click_through', value: false },
    ]);
    expect(planSduiEffect({ kind: 'setting', setting: 'tts' }, true)).toEqual([
      { type: 'set_tts', value: true },
    ]);
    expect(planSduiEffect({ kind: 'setting', setting: 'mic_capture' }, true)).toEqual([
      { type: 'set_mic_capture', value: true },
    ]);
    expect(planSduiEffect({ kind: 'setting', setting: 'fps_mode' }, '30')).toEqual([
      { type: 'set_fps_override', value: '30' },
    ]);
  });

  it('converts the voice gain the same way in both directions', () => {
    // The slider shows a percentage and the store keeps a multiplier. Writing 80 and
    // reading 80 back has to be the same number, or a panel's own control drifts.
    const [command] = planSduiEffect({ kind: 'setting', setting: 'voice_gain' }, 80);
    expect(command).toEqual({
      type: 'set_voice_gain',
      percent: 80,
      rmsGain: Number((80 / VOICE_GAIN_PERCENT_SCALE).toFixed(2)),
    });

    const live = { voice_gain: Math.round(3.2 * VOICE_GAIN_PERCENT_SCALE) };
    expect(readSduiSettingValue('voice_gain', live)).toBe(80);
  });

  it('plans the stage effects a panel can reach', () => {
    expect(planSduiEffect({ kind: 'say', text: 'hello' }, undefined)).toEqual([
      { type: 'say', text: 'hello', durationMs: undefined },
    ]);
    expect(planSduiEffect({ kind: 'say' }, 'typed into a box')).toEqual([
      { type: 'say', text: 'typed into a box', durationMs: undefined },
    ]);
    expect(planSduiEffect({ kind: 'hud_clear' }, undefined)).toEqual([{ type: 'hud_clear' }]);
    expect(
      planSduiEffect(
        {
          kind: 'hud_draw',
          annotations: [{ id: 'a', type: 'box', x: 1, y: 2, w: 3, h: 4 }],
        },
        undefined
      )
    ).toMatchObject([{ type: 'hud_draw' }]);
  });

  it('reports an unknown effect kind instead of ignoring it', () => {
    // A typo, or a schema written for a newer host. Either way the panel gets a line it
    // can act on, which is what the id list never gave it.
    const effect = { kind: 'launch_missiles' } as unknown as SduiEffect;
    const commands = planSduiEffect(effect, true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'unsupported' });
    expect((commands[0] as { reason: string }).reason).toContain('launch_missiles');
  });

  it('reports an unknown setting rather than writing nothing', () => {
    const effect = {
      kind: 'setting',
      setting: 'not_a_setting',
    } as unknown as SduiEffect;
    const commands = planSduiEffect(effect, true);
    expect(commands[0]).toMatchObject({ type: 'unsupported' });
    const reason = (commands[0] as { reason: string }).reason;
    expect(reason).toContain('not_a_setting');
    expect(reason).toContain('window_climbing');
  });

  it('reports a value the setting cannot accept', () => {
    const cases: Array<[SduiSettingEffect, unknown]> = [
      // A switch that was given a string, a select that was given a number, a slider that
      // was given text: each would previously have been dropped by a `typeof` check with
      // nothing said about it.
      ['window_climbing', 'yes'],
      ['tts', 1],
      ['click_through', null],
      ['fps_mode', 60],
      ['fps_mode', '144'],
      ['voice_gain', '80'],
      ['voice_gain', Number.NaN],
    ];
    for (const [setting, value] of cases) {
      const commands = planSduiEffect({ kind: 'setting', setting }, value);
      expect(commands[0], `setting=${setting} value=${JSON.stringify(value)}`).toMatchObject({
        type: 'unsupported',
      });
      expect((commands[0] as { reason: string }).reason).toContain(setting);
    }
  });

  it('refuses a hud_draw with nothing to draw', () => {
    const commands = planSduiEffect({ kind: 'hud_draw', annotations: [] }, undefined);
    expect(commands[0]).toMatchObject({ type: 'unsupported' });
  });

  it('refuses a say with neither literal text nor a usable value', () => {
    expect(planSduiEffect({ kind: 'say' }, 42)[0]).toMatchObject({ type: 'unsupported' });
    expect(planSduiEffect({ kind: 'say' }, '')[0]).toMatchObject({ type: 'unsupported' });
  });

  it('finds the setting a widget declares, whatever its id is', () => {
    const widget: SduiWidget = {
      id: 'whatever_the_author_called_it',
      type: 'switch',
      label: '语音播报',
      value: true,
      effect: { kind: 'setting', setting: 'tts' },
    };
    expect(declaredSettingEffect(widget)).toBe('tts');

    const noEffect: SduiWidget = { id: 'x', type: 'switch', label: 'x', value: true };
    expect(declaredSettingEffect(noEffect)).toBeNull();

    const otherEffect: SduiWidget = {
      id: 'y',
      type: 'button_group',
      label: 'y',
      buttons: [],
    };
    expect(declaredSettingEffect(otherEffect)).toBeNull();
  });
});
