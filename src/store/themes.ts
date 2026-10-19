import type { PetThemePalette } from '@/types/pet';

/**
 * The palette a pet falls back to when its manifest carries no `theme:` block.
 *
 * There is no per-pet palette registry here any more. A colour scheme belongs to the
 * pet package that owns it, so `pets/<id>/pet.yaml` is the one place a palette is
 * decided — a third-party pet then looks like itself without anyone editing this file,
 * and a palette can never disagree with the character it belongs to.
 */
export const DEFAULT_PET_THEME: PetThemePalette = {
  id: 'default',
  name: '默认 (Default)',
  primary: '#38bdf8',
  accent: '#f43f5e',
  glow: 'rgba(56, 189, 248, 0.55)',
  surface: 'rgba(9, 13, 24, 0.92)',
  border: 'rgba(56, 189, 248, 0.62)',
  text: '#f8fafc',
  subtext: '#94a3b8',
  particleColor: '#38bdf8',
};

/**
 * Resolve the palette for a pet.
 *
 * The manifest's own `theme:` block wins; every key it leaves out keeps the host
 * default, so a package can declare two colours and still be readable.
 */
export function resolvePetTheme(override?: Partial<PetThemePalette>): PetThemePalette {
  return override ? { ...DEFAULT_PET_THEME, ...override } : DEFAULT_PET_THEME;
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
