import { describe, expect, it } from 'vitest';
import {
  centredPosition,
  clampPositionToArea,
  clampSizeToArea,
  clampStageScale,
  computeStageWindowSize,
} from '@/utils/stageWindow';
import {
  SPRITE_CENTER_Y_RATIO,
  SPRITE_DRAW_HEIGHT_PX,
  SPRITE_DRAW_WIDTH_PX,
  STAGE_HEIGHT_PX,
  STAGE_MAX_WINDOW_PX,
  STAGE_WIDTH_PX,
  STUDIO_MAX_SCALE,
  STUDIO_MIN_SCALE,
} from '@/constants/timing';

/** Edges of the sprite draw box inside a window of the given size. */
function drawBoxEdges(scale: number, width: number, height: number) {
  const halfW = (SPRITE_DRAW_WIDTH_PX * scale) / 2;
  const halfH = (SPRITE_DRAW_HEIGHT_PX * scale) / 2;
  const cx = width / 2;
  const cy = height * SPRITE_CENTER_Y_RATIO;
  return { left: cx - halfW, right: cx + halfW, top: cy - halfH, bottom: cy + halfH };
}

describe('clampStageScale', () => {
  it('keeps a zoomable pet inside the authored bounds', () => {
    expect(clampStageScale(0.01)).toBe(STUDIO_MIN_SCALE);
    expect(clampStageScale(99)).toBe(STUDIO_MAX_SCALE);
    expect(clampStageScale(1.4)).toBe(1.4);
  });

  it('never returns a scale that could hide the pet', () => {
    for (const raw of [-5, 0, 0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampStageScale(raw)).toBeGreaterThanOrEqual(STUDIO_MIN_SCALE);
    }
  });

  it('falls back to 1 for unusable input instead of producing NaN geometry', () => {
    expect(clampStageScale(Number.NaN)).toBe(1);
  });
});

describe('computeStageWindowSize', () => {
  it('leaves the authored stage untouched at the neutral zoom', () => {
    expect(computeStageWindowSize(1)).toEqual({ width: STAGE_WIDTH_PX, height: STAGE_HEIGHT_PX });
  });

  it('grows past the authored size once the sprite would overflow it', () => {
    const grown = computeStageWindowSize(STUDIO_MAX_SCALE);
    expect(grown.width).toBeGreaterThan(STAGE_WIDTH_PX);
    expect(grown.height).toBeGreaterThan(STAGE_HEIGHT_PX);
  });

  it('never returns a window smaller than the authored stage', () => {
    for (const s of [STUDIO_MIN_SCALE, 0.5, 0.8, 1]) {
      const size = computeStageWindowSize(s);
      expect(size.width).toBeGreaterThanOrEqual(STAGE_WIDTH_PX);
      expect(size.height).toBeGreaterThanOrEqual(STAGE_HEIGHT_PX);
    }
  });

  it('caps the window so a large zoom cannot swallow the desktop', () => {
    const size = computeStageWindowSize(STUDIO_MAX_SCALE);
    expect(size.width).toBeLessThanOrEqual(STAGE_MAX_WINDOW_PX);
    expect(size.height).toBeLessThanOrEqual(STAGE_MAX_WINDOW_PX);
  });

  it('keeps the whole sprite inside the window at every zoom in range', () => {
    // This is the invariant the old fixed window violated: the sprite was cropped
    // anywhere past roughly 1.3x, which is what made the zoom control pointless.
    for (let raw = STUDIO_MIN_SCALE; raw <= STUDIO_MAX_SCALE + 1e-9; raw += 0.05) {
      const s = clampStageScale(raw);
      const { width, height } = computeStageWindowSize(raw);
      const box = drawBoxEdges(s, width, height);
      const where = `scale=${s.toFixed(2)} window=${width}x${height}`;
      expect(box.left, `left @ ${where}`).toBeGreaterThanOrEqual(0);
      expect(box.right, `right @ ${where}`).toBeLessThanOrEqual(width);
      expect(box.top, `top @ ${where}`).toBeGreaterThanOrEqual(0);
      expect(box.bottom, `bottom @ ${where}`).toBeLessThanOrEqual(height);
    }
  });

  it('is monotonic: a bigger pet never gets a smaller window', () => {
    let prev = computeStageWindowSize(STUDIO_MIN_SCALE);
    for (let s = STUDIO_MIN_SCALE + 0.1; s <= STUDIO_MAX_SCALE; s += 0.1) {
      const next = computeStageWindowSize(s);
      expect(next.width).toBeGreaterThanOrEqual(prev.width);
      expect(next.height).toBeGreaterThanOrEqual(prev.height);
      prev = next;
    }
  });
});

describe('clampSizeToArea', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };

  it('leaves a window that fits alone', () => {
    expect(clampSizeToArea({ width: 360, height: 420 }, screen)).toEqual({
      width: 360,
      height: 420,
    });
  });

  it('shrinks a window that asks for more room than the screen has', () => {
    // The zoom is allowed to ask for a huge window; the host answers with what fits,
    // because a pet that is half off the screen is worse than a smaller pet.
    const clamped = clampSizeToArea({ width: 4000, height: 3000 }, screen);
    expect(clamped).toEqual({ width: 1920, height: 1040 });
  });

  it('never returns a window of zero size', () => {
    const clamped = clampSizeToArea({ width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 0 });
    expect(clamped.width).toBeGreaterThan(0);
    expect(clamped.height).toBeGreaterThan(0);
  });
});

describe('clampPositionToArea', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };

  it('does not move a window that is already on screen', () => {
    const pos = clampPositionToArea({ x: 400, y: 300 }, { width: 360, height: 420 }, screen);
    expect(pos).toEqual({ x: 400, y: 300 });
  });

  it('pulls a window that hangs off the right edge back onto the screen', () => {
    const pos = clampPositionToArea({ x: 1900, y: 300 }, { width: 360, height: 420 }, screen);
    expect(pos.x).toBe(1920 - 360);
    expect(pos.y).toBe(300);
  });

  it('pulls a window that hangs off the top back onto the screen', () => {
    const pos = clampPositionToArea({ x: 400, y: -50 }, { width: 360, height: 420 }, screen);
    expect(pos.y).toBe(0);
    expect(pos.x).toBe(400);
  });

  it('keeps the top-left corner in place when the window is larger than the screen', () => {
    const pos = clampPositionToArea({ x: 120, y: 80 }, { width: 3000, height: 2000 }, screen);
    expect(pos).toEqual({ x: 0, y: 0 });
  });
});

describe('centredPosition', () => {
  it('holds the window centre still while the size changes', () => {
    const outer = { x: 1000, y: 500, width: 360, height: 420 };
    const next = { width: 720, height: 840 };
    const pos = centredPosition(outer, next);
    expect(pos.x + next.width / 2).toBeCloseTo(outer.x + outer.width / 2, 5);
    expect(pos.y + next.height / 2).toBeCloseTo(outer.y + outer.height / 2, 5);
  });

  it('grows up and to the left so the pet does not drift down-right', () => {
    const pos = centredPosition({ x: 1000, y: 500, width: 360, height: 420 }, {
      width: 720,
      height: 840,
    });
    expect(pos.x).toBeLessThan(1000);
    expect(pos.y).toBeLessThan(500);
  });

  it('returns whole pixels, which is what the window API wants', () => {
    const pos = centredPosition({ x: 1001, y: 503, width: 361, height: 421 }, {
      width: 721,
      height: 841,
    });
    expect(Number.isInteger(pos.x)).toBe(true);
    expect(Number.isInteger(pos.y)).toBe(true);
  });
});
