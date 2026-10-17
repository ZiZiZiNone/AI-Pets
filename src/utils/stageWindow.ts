import {
  SPRITE_CENTER_Y_RATIO,
  SPRITE_DRAW_HEIGHT_PX,
  SPRITE_DRAW_WIDTH_PX,
  STAGE_GROW_MARGIN,
  STAGE_HEIGHT_PX,
  STAGE_MAX_WINDOW_PX,
  STAGE_WIDTH_PX,
  STUDIO_MAX_SCALE,
  STUDIO_MIN_SCALE,
} from '@/constants/timing';

/**
 * Sizing the stage window around a zoomed sprite.
 *
 * The stage used to be a fixed 360x420 box with the sprite drawn inside it, which meant
 * any zoom past roughly 1.3x pushed the pet outside the window and cropped it. Clamping
 * the zoom instead would have made the control useless. So the window follows the sprite:
 * it grows to hold the draw box and never shrinks below the authored stage size.
 *
 * Kept free of Tauri types so the geometry is unit-testable; `applyStageWindowSize` is
 * the only part that talks to the host.
 */

export function clampStageScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(STUDIO_MAX_SCALE, Math.max(STUDIO_MIN_SCALE, scale));
}

/**
 * Smallest stage height that fully contains the draw box.
 *
 * The sprite is centred on `SPRITE_CENTER_Y_RATIO` of the height, so both edges have to
 * clear the border. The bottom edge is the binding one: it needs `halfHeight` of the
 * margin the centre offset does not cover.
 */
function requiredHeightForScale(scale: number): number {
  const half = (SPRITE_DRAW_HEIGHT_PX * scale) / 2;
  const belowCentre = half / (1 - SPRITE_CENTER_Y_RATIO);
  const aboveCentre = half / SPRITE_CENTER_Y_RATIO;
  return Math.ceil(Math.max(aboveCentre, belowCentre));
}

export function computeStageWindowSize(scale: number): {
  width: number;
  height: number;
} {
  const s = clampStageScale(scale);
  const width = Math.min(
    STAGE_MAX_WINDOW_PX,
    Math.max(STAGE_WIDTH_PX, Math.ceil(SPRITE_DRAW_WIDTH_PX * s * STAGE_GROW_MARGIN))
  );
  const height = Math.min(
    STAGE_MAX_WINDOW_PX,
    Math.max(STAGE_HEIGHT_PX, Math.ceil(requiredHeightForScale(s) * STAGE_GROW_MARGIN))
  );
  return { width, height };
}

/** Position that keeps the window centred on the point it currently occupies. */
export function centredPosition(
  outer: { x: number; y: number; width: number; height: number },
  next: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: Math.round(outer.x + (outer.width - next.width) / 2),
    y: Math.round(outer.y + (outer.height - next.height) / 2),
  };
}

/**
 * Resize the stage window to fit `scale`, holding the pet still on screen.
 *
 * Tauri grows a window from its top-left corner, which would slide the pet down and to
 * the right on every zoom step. Re-centring after the resize keeps it visually pinned.
 * Failures are swallowed: the window only has to be big enough, so a rejected resize
 * degrades to a cropped sprite rather than breaking the studio.
 *
 * The Tauri modules are imported lazily so this file stays importable — and testable —
 * in a plain browser or Node context where no host is present.
 */
export async function applyStageWindowSize(scale: number): Promise<void> {
  const next = computeStageWindowSize(scale);
  try {
    const [{ LogicalPosition, LogicalSize }, { getCurrentWindow }] = await Promise.all([
      import('@tauri-apps/api/dpi'),
      import('@tauri-apps/api/window'),
    ]);
    const win = getCurrentWindow();
    const outer = await win.outerSize();
    const pos = await win.outerPosition();
    const scaleFactor = await win.scaleFactor();
    if (outer.width === next.width && outer.height === next.height) return;

    await win.setSize(new LogicalSize(next.width, next.height));
    // outerSize/outerPosition are physical; convert before re-centring.
    const outerLogical = {
      x: pos.x / scaleFactor,
      y: pos.y / scaleFactor,
      width: outer.width / scaleFactor,
      height: outer.height / scaleFactor,
    };
    const nextPos = centredPosition(outerLogical, next);
    await win.setPosition(new LogicalPosition(nextPos.x, nextPos.y));
  } catch {
    // Not running under Tauri (browser preview) or the window is mid-teardown.
  }
}
