import { DEFAULT_CLIP_FPS } from '@/constants/timing';

/**
 * How a strip of frames is stepped through.
 *
 * A browser draws the first frame of an animated picture into a canvas and never advances
 * it, so a pet that wants to move has to bring its frames with it as one horizontal strip.
 * The strip is the only animation format the host can rely on, and everything the host
 * needs to know about it is here: which cell is showing, and where that cell sits inside
 * the picture.
 *
 * Kept as pure functions rather than folded into the renderer because that is what makes
 * them checkable: every claim about timing and geometry is a comparison of two numbers
 * here, with no canvas involved.
 */

interface FrameSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The cell of a strip that is showing at a given moment.
 *
 * The rate comes from the package when it says one and falls back to the host's default
 * when it does not. A strip of one frame is a still picture, so it always shows cell zero.
 */
export function frameIndexAt(elapsedSec: number, frames: number, fps: number): number {
  if (frames <= 1) return 0;
  const rate = fps > 0 ? fps : DEFAULT_CLIP_FPS;
  const index = Math.floor(elapsedSec * rate);
  return ((index % frames) + frames) % frames;
}

/**
 * The rectangle of the strip that holds one cell.
 *
 * The cells are laid out left to right, so the cell's width is the picture's width divided
 * by the number of frames and its left edge is that many pixels times the cell's index.
 */
export function frameSourceRect(
  naturalWidth: number,
  naturalHeight: number,
  frames: number,
  index: number
): FrameSourceRect {
  const width = naturalWidth / Math.max(1, frames);
  const cell = ((index % Math.max(1, frames)) + Math.max(1, frames)) % Math.max(1, frames);
  return { x: cell * width, y: 0, width, height: naturalHeight };
}
