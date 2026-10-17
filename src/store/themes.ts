import type { PetThemePalette } from '@/types/pet';

export const PET_THEMES: Record<string, PetThemePalette> = {
  aether_mecha_core: {
    id: 'cyber_tactical',
    name: '机能全息装甲 (Cyber-Tactical)',
    primary: '#38bdf8',
    accent: '#f43f5e',
    glow: 'rgba(56, 189, 248, 0.55)',
    surface: 'rgba(9, 13, 24, 0.92)',
    border: 'rgba(56, 189, 248, 0.62)',
    text: '#f8fafc',
    subtext: '#94a3b8',
    particleColor: '#38bdf8',
  },
  nyx_abyssal_familiar: {
    id: 'arcane_astrolabe',
    name: '星轨秘术罗盘 (Arcane Astrolabe)',
    primary: '#facc15',
    accent: '#c084fc',
    glow: 'rgba(250, 204, 21, 0.5)',
    surface: 'rgba(19, 9, 34, 0.92)',
    border: 'rgba(250, 204, 21, 0.6)',
    text: '#fefce8',
    subtext: '#d8b4fe',
    particleColor: '#facc15',
  },
  pulse_glitch_phantom: {
    id: 'acid_glitch',
    name: '高街故障波普 (Acid Glitch)',
    primary: '#06b6d4',
    accent: '#f43f5e',
    glow: 'rgba(244, 63, 94, 0.55)',
    surface: 'rgba(12, 10, 20, 0.93)',
    border: 'rgba(6, 182, 212, 0.65)',
    text: '#fafafa',
    subtext: '#67e8f9',
    particleColor: '#f43f5e',
  },
  demo_sprite_pet: {
    id: 'starlight_core',
    name: '星光微内核 (Starlight Core)',
    primary: '#8ec5fc',
    accent: '#ff8da1',
    glow: 'rgba(142, 197, 252, 0.55)',
    surface: 'rgba(15, 23, 42, 0.9)',
    border: 'rgba(142, 197, 252, 0.62)',
    text: '#f8fafc',
    subtext: '#cbd5e1',
    particleColor: '#8ec5fc',
  },
};

/**
 * Resolve the palette for a pet.
 *
 * Precedence is manifest override > built-in registry > default. The override is
 * what makes `pets/<id>/pet.yaml` self-contained: a third-party pet carries its own
 * `theme:` block and never has to touch this file, which is source code and not
 * something a user editing config can be asked to modify.
 */
export function resolvePetTheme(
  petId?: string,
  override?: Partial<PetThemePalette>
): PetThemePalette {
  const base = (petId && PET_THEMES[petId]) || PET_THEMES.aether_mecha_core;
  return override ? { ...base, ...override } : base;
}

export function themeToCssVars(theme: PetThemePalette): Record<string, string> {
  return {
    '--theme-primary': theme.primary,
    '--theme-accent': theme.accent,
    '--theme-glow': theme.glow,
    '--theme-surface': theme.surface,
    '--theme-border': theme.border,
    '--theme-text': theme.text,
    '--theme-subtext': theme.subtext,
    '--pod-primary': theme.primary,
    '--pod-accent': theme.accent,
  };
}
