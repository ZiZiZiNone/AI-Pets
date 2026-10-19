import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePetManifestYaml } from '@/utils/yamlLoader';
import { matchDeclaredHitArea } from '@/adapters/IPetAdapter';
import { resolvePetTheme } from '@/store/themes';

const PET_DIR = resolve(process.cwd(), 'pets', 'silverfeather_chibi');
const manifest = parsePetManifestYaml(
  readFileSync(resolve(PET_DIR, 'pet.yaml'), 'utf8'),
  'silverfeather_chibi'
);

// hit 坐标 -> 舞台坐标：scale=1 offset=0 时 stage = local + (20, 40)
const toStage = (lx: number, ly: number): [number, number] => [lx + 20, ly + 40];

describe('silverfeather_chibi manifest', () => {
  it('parses without falling back', () => {
    expect(manifest.id).toBe('silverfeather_chibi');
    expect(manifest.name).toBe('银羽（Q版）');
    expect(manifest.type).toBe('sprite');
    expect(manifest.model.entry).toBe('idle.png');
    expect(manifest.model.scale).toBe(1.0);
  });

  it('declares every motion the built-in pets declare, plus the three states', () => {
    for (const m of ['idle', 'happy', 'pat', 'feed', 'drag', 'climb', 'sleep']) {
      expect(manifest.model.animations?.[m], m).toBeDefined();
    }
    expect(manifest.model.animations?.thinking?.file).toBe('thinking.png');
    expect(manifest.model.animations?.speaking?.file).toBe('speaking.png');
  });

  it('references only image files that exist on disk', () => {
    const files = new Set<string>([manifest.model.entry]);
    for (const clip of Object.values(manifest.model.animations ?? {})) {
      if (clip?.file) files.add(clip.file);
    }
    expect([...files].sort()).toEqual(['idle.png', 'speaking.png', 'thinking.png']);
    for (const f of files) {
      expect(existsSync(resolve(PET_DIR, f)), f).toBe(true);
    }
  });

  it('resolves head and body hit areas at their centres', () => {
    const [hx, hy] = toStage(160, 65);
    const [bx, by] = toStage(160, 193);
    expect(matchDeclaredHitArea(manifest, hx, hy)?.name).toBe('head');
    expect(matchDeclaredHitArea(manifest, bx, by)?.name).toBe('body');
  });

  it('leaves the legs outside every declared area', () => {
    const [lx, ly] = toStage(160, 300);
    expect(matchDeclaredHitArea(manifest, lx, ly)).toBeUndefined();
  });

  it('hits head and body across the full width of each rect', () => {
    for (const lx of [70, 160, 250]) {
      expect(matchDeclaredHitArea(manifest, ...toStage(lx, 65))?.name, `head@${lx}`).toBe('head');
    }
    for (const lx of [66, 160, 254]) {
      expect(matchDeclaredHitArea(manifest, ...toStage(lx, 193))?.name, `body@${lx}`).toBe('body');
    }
  });

  it('gives every hit area a motion, expression and at least three lines', () => {
    for (const area of manifest.hit_areas ?? []) {
      expect(area.motion, area.name).toBeTruthy();
      expect(area.expression, area.name).toBeTruthy();
      expect(area.texts?.length ?? 0, area.name).toBeGreaterThanOrEqual(3);
    }
  });

  it('routes menu actions at internal events the runtime actually handles', () => {
    const handled = new Set([
      'studio.toggle', 'chat.toggle', 'pet.quick_action', 'pet.feed_care',
      'pet.toggle_climb', 'pet.edge_peek', 'pet.tactical_scan',
      'pet.fortune_divination', 'pet.system_inspect', 'pomodoro.start',
    ]);
    const walk = (items: typeof manifest.menus): string[] =>
      (items ?? []).flatMap((m) => {
        const own = m.action?.type === 'emit' ? [String(m.action.event)] : [];
        return [...own, ...walk(m.children ?? [])];
      });
    const events = walk(manifest.menus);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(handled.has(e), e).toBe(true);
  });

  it('has its own theme instead of falling back', () => {
    expect(manifest.theme?.id).toBe('silverplume_stream');
    expect(resolvePetTheme(manifest.theme).id).toBe('silverplume_stream');
    expect(resolvePetTheme(manifest.theme).primary).toBe('#a5b4fc');
    // Not registered in the built-in palette table any more: the manifest carries it.
    expect(resolvePetTheme().id).toBe('default');
  });
});
