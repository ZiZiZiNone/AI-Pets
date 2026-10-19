import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  FALLBACK_PET_MANIFEST,
  parseGlobalMenuYaml,
  parseHostSettingsYaml,
  parsePetManifestYaml,
  serializeHostSettingsYaml,
  serializePetManifestYaml,
} from '@/utils/yamlLoader';
import { matchDeclaredHitArea } from '@/adapters/IPetAdapter';
import { DEFAULT_PET_THEME, resolvePetTheme, themeToCssVars } from '@/store/themes';
import { DEFAULT_MENU_INTERACTION } from '@/utils/menuInteraction';

describe('parsePetManifestYaml', () => {
  it('parses a well formed manifest', () => {
    const manifest = parsePetManifestYaml(`
id: test_pet
name: 测试机体
version: '1.2.3'
type: live2d
model:
  entry: model.model3.json
  scale: 1.5
  offset: { x: 10, y: -5 }
`);
    expect(manifest.id).toBe('test_pet');
    expect(manifest.name).toBe('测试机体');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.type).toBe('live2d');
    expect(manifest.model.scale).toBe(1.5);
    expect(manifest.model.offset).toEqual({ x: 10, y: -5 });
  });

  it('uses the supplied id when the manifest omits one', () => {
    expect(parsePetManifestYaml('name: 无ID', 'fallback_id').id).toBe('fallback_id');
  });

  it('falls back to sprite for an unknown adapter type', () => {
    expect(parsePetManifestYaml('type: hologram').type).toBe('sprite');
  });

  it('clamps the model scale into the supported range', () => {
    expect(parsePetManifestYaml('model: { scale: 999 }').model.scale).toBe(5.0);
    expect(parsePetManifestYaml('model: { scale: 0.0001 }').model.scale).toBe(0.1);
  });

  it('rejects a non numeric scale', () => {
    expect(parsePetManifestYaml('model: { scale: "big" }').model.scale).toBe(1.0);
  });

  it('recovers from malformed YAML with the fallback manifest', () => {
    const manifest = parsePetManifestYaml('::not yaml::\n  - [unclosed', 'rescued');
    expect(manifest.id).toBe('rescued');
    expect(manifest.type).toBe('sprite');
    expect(manifest.model.entry).toBeTruthy();
  });

  it('keeps hit areas only when the key holds an array', () => {
    expect(parsePetManifestYaml('hit_areas: not-an-array').hit_areas).toEqual([]);
    const withAreas = parsePetManifestYaml(
      'hit_areas:\n  - name: head\n    label: H\n    rect: { x: 1, y: 2, w: 3, h: 4 }'
    );
    expect(withAreas.hit_areas).toHaveLength(1);
    expect(withAreas.hit_areas?.[0].rect.w).toBe(3);
  });
});

describe('serializePetManifestYaml', () => {
  it('drops the runtime-only basePath before writing', () => {
    const yaml = serializePetManifestYaml({
      ...FALLBACK_PET_MANIFEST,
      basePath: 'C:/secret/runtime/path',
    });
    expect(yaml).not.toContain('basePath');
    expect(yaml).not.toContain('C:/secret/runtime/path');
  });

  it('round-trips back through the parser', () => {
    const parsed = parsePetManifestYaml(serializePetManifestYaml(FALLBACK_PET_MANIFEST));
    expect(parsed.id).toBe(FALLBACK_PET_MANIFEST.id);
    expect(parsed.model.scale).toBe(FALLBACK_PET_MANIFEST.model.scale);
  });
});

describe('parseHostSettingsYaml', () => {
  it('keeps defaults for sections the file omits', () => {
    const settings = parseHostSettingsYaml('audio:\n  rms_gain: 9.5\n');
    expect(settings.audio.rms_gain).toBe(9.5);
    expect(settings.render.active_fps).toBe(DEFAULT_HOST_SETTINGS.render.active_fps);
    expect(settings.behavior.sleep_after_idle_sec).toBe(
      DEFAULT_HOST_SETTINGS.behavior.sleep_after_idle_sec
    );
  });

  it('round-trips a full settings document', () => {
    const original = structuredClone(DEFAULT_HOST_SETTINGS);
    original.host.default_pet = 'qilin_ling';
    expect(parseHostSettingsYaml(serializeHostSettingsYaml(original))).toEqual(original);
  });

  it('falls back to defaults on malformed YAML', () => {
    expect(parseHostSettingsYaml('a: [1,\n  b: {')).toEqual(DEFAULT_HOST_SETTINGS);
  });
});

describe('parseGlobalMenuYaml', () => {
  it('reads a menu tree', () => {
    const config = parseGlobalMenuYaml('menus:\n  - id: a\n    label: A\n');
    expect(config.menus).toHaveLength(1);
    expect(config.menus[0].id).toBe('a');
  });

  it('reads the menu interaction defaults alongside the tree', () => {
    const config = parseGlobalMenuYaml(
      ['interaction:', '  expand: hover', '  hover_intent_ms: 300', 'menus: []'].join('\n')
    );
    expect(config.interaction).toMatchObject({ expand: 'hover', hover_intent_ms: 300 });
  });

  it('yields an empty tree for malformed or missing menus', () => {
    expect(parseGlobalMenuYaml('menus: 5').menus).toEqual([]);
    expect(parseGlobalMenuYaml('::: bad :::').menus).toEqual([]);
  });
});

describe('menu interaction in pet.yaml', () => {
  it('reads the interaction block from a manifest', () => {
    // The end-to-end path that matters: a pet folder declares its menu feel and the host
    // reads it, with no code change and no second configuration file.
    const manifest = parsePetManifestYaml(
      [
        'id: probe',
        'menu_interaction:',
        '  trigger: double_click',
        '  expand: hover',
        '  hover_intent_ms: 250',
        '  long_press_ms: 700',
        '  auto_expand_first: false',
      ].join('\n')
    );
    expect(manifest.menu_interaction).toMatchObject({
      trigger: 'double_click',
      expand: 'hover',
      hover_intent_ms: 250,
      long_press_ms: 700,
      auto_expand_first: false,
    });
  });

  it('fills the block with working defaults when the manifest omits it', () => {
    const manifest = parsePetManifestYaml('id: probe\n');
    expect(manifest.menu_interaction).toEqual(DEFAULT_MENU_INTERACTION);
  });

  it('does not let a bad gesture reach the renderer', () => {
    const manifest = parsePetManifestYaml(
      ['id: probe', 'menu_interaction:', '  trigger: quadruple_click'].join('\n')
    );
    expect(manifest.menu_interaction?.trigger).toBe('click');
  });

  it('keeps declarations meant for another host through a save', () => {
    // The parser builds a known shape and the studio writes that shape back out. Without a
    // round trip, editing a pet here would delete exactly the fields that exist so another
    // host can read the same package — silently, and only after someone presses save.
    const original = [
      'id: probe',
      'name: 探针',
      'ai_pets:',
      '  factual_rule: 只讲有证据的话',
      '  speech_priority:',
      '    - stop_and_fault',
      '    - small_talk',
      '  voice_reference: voice.wav',
    ].join('\n');

    const reparsed = parsePetManifestYaml(serializePetManifestYaml(parsePetManifestYaml(original)));

    expect(reparsed.name).toBe('探针');
    expect(reparsed.extensions?.ai_pets).toMatchObject({
      factual_rule: '只讲有证据的话',
      voice_reference: 'voice.wav',
    });
    expect((reparsed.extensions?.ai_pets as { speech_priority: string[] }).speech_priority).toEqual([
      'stop_and_fault',
      'small_talk',
    ]);
  });

  it('leaves a manifest that declares nothing extra alone', () => {
    expect(parsePetManifestYaml('id: probe\n').extensions).toBeUndefined();
  });

  it('reads the moments a package maps onto its own clips', () => {
    const manifest = parsePetManifestYaml(
      [
        'id: probe',
        'dynamics:',
        '  moments:',
        '    sleep: { motion: doze, expression: sleepy }',
        '    ambient: { motion: idle }',
        '  behaviors:',
        '    health_reminders: false',
      ].join('\n')
    );
    expect(manifest.dynamics?.moments?.sleep).toEqual({ motion: 'doze', expression: 'sleepy' });
    expect(manifest.dynamics?.moments?.ambient).toEqual({ motion: 'idle' });
    expect(manifest.dynamics?.behaviors?.health_reminders).toBe(false);
  });

  it('does not let a malformed dynamics block take the pet down', () => {
    // Same defensive shape as the theme and persona: a broken block leaves the character on
    // the host's default names rather than stopping the loop or pointing at nothing.
    const manifest = parsePetManifestYaml(
      ['id: probe', 'dynamics:', '  moments: not-a-mapping', '  behaviors: 7'].join('\n')
    );
    expect(manifest.dynamics).toBeUndefined();
    expect(manifest.id).toBe('probe');
  });

  it('keeps the dynamics block through a save', () => {
    const original = ['id: probe', 'dynamics:', '  moments:', '    sleep: { motion: doze }'].join(
      '\n'
    );
    const reparsed = parsePetManifestYaml(serializePetManifestYaml(parsePetManifestYaml(original)));
    expect(reparsed.dynamics?.moments?.sleep?.motion).toBe('doze');
  });
});

describe('matchDeclaredHitArea', () => {
  const manifest = parsePetManifestYaml(`
id: probe
hit_areas:
  - name: head
    label: 头部
    rect: { x: 80, y: 28, w: 160, h: 118 }
`);

  it('matches a point inside the declared rectangle', () => {
    // Local (100, 40) maps back to the stage centre at 1x scale.
    const x = 180 + (100 - 160);
    const y = 210 + (40 - 170);
    expect(matchDeclaredHitArea(manifest, x, y)?.name).toBe('head');
  });

  it('misses a point outside every rectangle', () => {
    expect(matchDeclaredHitArea(manifest, 5, 5)).toBeUndefined();
  });

  it('returns undefined when the manifest declares no areas', () => {
    expect(matchDeclaredHitArea(parsePetManifestYaml('id: bare'), 180, 210)).toBeUndefined();
    expect(matchDeclaredHitArea(null, 180, 210)).toBeUndefined();
  });

  it('applies the model transform when mapping stage to local space', () => {
    const scaled = { ...manifest, model: { ...manifest.model, scale: 2, offset: { x: 10, y: 0 } } };
    const x = 180 + 10 + (100 - 160) * 2;
    const y = 210 + (40 - 170) * 2;
    expect(matchDeclaredHitArea(scaled, x, y)?.name).toBe('head');
  });
});

describe('themes', () => {
  it('falls back to the host default when a package declares no palette', () => {
    expect(resolvePetTheme().id).toBe('default');
    expect(resolvePetTheme(undefined).id).toBe('default');
  });

  it('lets the package palette win and keeps the rest of the defaults', () => {
    const theme = resolvePetTheme({ id: 'moss_camp', primary: '#0ea5e9' });
    expect(theme.id).toBe('moss_camp');
    expect(theme.primary).toBe('#0ea5e9');
    expect(theme.accent).toBe(DEFAULT_PET_THEME.accent);
    expect(theme.glow).toBe(DEFAULT_PET_THEME.glow);
  });

  it('exposes a complete palette for every theme', () => {
    for (const theme of [DEFAULT_PET_THEME, resolvePetTheme({ id: 'x', primary: '#123456' })]) {
      expect(theme.id).toBeTruthy();
      expect(theme.primary).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.glow).toContain('rgba');
    }
  });

  it('exports css variables for every colour slot', () => {
    const vars = themeToCssVars(DEFAULT_PET_THEME);
    expect(vars['--theme-primary']).toBe(DEFAULT_PET_THEME.primary);
    expect(vars['--pod-accent']).toBe(DEFAULT_PET_THEME.accent);
  });
});
