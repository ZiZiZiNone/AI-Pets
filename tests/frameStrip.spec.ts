import { describe, expect, it } from 'vitest';
import { frameIndexAt, frameSourceRect } from '@/utils/frameStrip';
import { DEFAULT_CLIP_FPS } from '@/constants/timing';

/**
 * The claims worth checking about a frame strip are the ones that decide whether the pet
 * moves at all: that a cell is chosen, that the choice advances, that it comes back around,
 * and that the cell taken out of the picture is the cell the strip meant. None of them need
 * a canvas.
 */
describe('frameIndexAt', () => {
  it('starts on the first cell', () => {
    expect(frameIndexAt(0, 9, 12)).toBe(0);
  });

  it('advances one cell per frame of the declared rate', () => {
    const rate = 12;
    const step = 1 / rate;
    expect(frameIndexAt(step, 9, rate)).toBe(1);
    expect(frameIndexAt(step * 4, 9, rate)).toBe(4);
    // The cell holds until the next one starts: half a frame later is still the same cell.
    expect(frameIndexAt(step * 4 + step * 0.5, 9, rate)).toBe(4);
  });

  it('comes back around at the end of the strip', () => {
    const rate = 12;
    const step = 1 / rate;
    expect(frameIndexAt(step * 8, 9, rate)).toBe(8);
    expect(frameIndexAt(step * 9, 9, rate)).toBe(0);
    expect(frameIndexAt(step * 18, 9, rate)).toBe(0);
  });

  it('falls back to the host rate when the package names none', () => {
    const step = 1 / DEFAULT_CLIP_FPS;
    expect(frameIndexAt(step, 9, 0)).toBe(1);
    expect(frameIndexAt(step, 9, -1)).toBe(1);
  });

  it('treats a strip of one frame as a still picture', () => {
    expect(frameIndexAt(0, 1, 12)).toBe(0);
    expect(frameIndexAt(5, 1, 12)).toBe(0);
    expect(frameIndexAt(5, 0, 12)).toBe(0);
  });

  it('never points outside the strip', () => {
    for (let tick = 0; tick < 200; tick += 1) {
      const index = frameIndexAt(tick * 0.037, 9, 12);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(9);
    }
  });
});

describe('frameSourceRect', () => {
  it('takes the cell out of the picture at its own place', () => {
    const rect = frameSourceRect(2100, 745, 9, 3);
    expect(rect.x).toBeCloseTo(700, 6);
    expect(rect.y).toBe(0);
    expect(rect.width).toBeCloseTo(2100 / 9, 6);
    expect(rect.height).toBe(745);
  });

  it('covers the whole picture with no gap and no overlap', () => {
    const width = 2100;
    const frames = 9;
    const covered = Array.from({ length: frames }, (_, index) => {
      const rect = frameSourceRect(width, 745, frames, index);
      return [rect.x, rect.x + rect.width];
    });
    expect(covered[0][0]).toBe(0);
    for (let index = 1; index < covered.length; index += 1) {
      expect(covered[index][0]).toBeCloseTo(covered[index - 1][1], 6);
    }
    expect(covered[covered.length - 1][1]).toBeCloseTo(width, 6);
  });

  it('keeps the cell inside the picture even for a cell number out of range', () => {
    const rect = frameSourceRect(2100, 745, 9, 9);
    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.width).toBeCloseTo(2100 / 9, 6);
  });
});
