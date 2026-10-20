/**
 * The pointer's relation to the HUD, and the click-through command that follows from it.
 *
 * Both problems live here because they have the same shape: whether the window receives
 * the pointer is decided in two different places, and neither one knew about the other.
 *
 * - The sprite is found by hit-testing its own alpha mask, so the dock and the status
 *   pill are invisible to that test. A pointer resting on the dock read as "not on the
 *   pet", which made the window click-through *while its own controls were on screen*.
 *   The controls rendered and could not be pressed, and because click-through is a
 *   whole-window flag, the webview also stopped receiving the events that would have
 *   undone it — the dock could not be reached by moving onto it, only by leaving the
 *   window and coming back.
 * - The flag is a whole-window setting, so two commands that cross on their way to the
 *   host can be applied in the opposite order they were sent. The window then sits in
 *   the state the older command asked for while the page believes it is in the newer
 *   one, and nothing in the page can tell the difference.
 */

/**
 * The chrome that has to stay clickable while it is on screen.
 *
 * These are the pieces of the host's own interface, not the sprite. The sprite is found
 * by hit-testing its alpha mask, so none of them is visible to that test.
 */
const HUD_CHROME_SELECTOR =
  '.tactical-dock, .holo-status-pill, .inline-chat-bar, .holo-speech-visor';

/**
 * Is the pointer over a control rather than over the sprite?
 *
 * The answer is read out of the layout rather than out of the event stream on purpose:
 * a click-through window delivers no pointer events at all, so an event-driven answer
 * is only available in the state where the question no longer matters.
 *
 * The rectangles are measured rather than asked for with `elementFromPoint`, because
 * the frame the chrome sits in is `pointer-events: none` — the standard says an
 * element that does not take the pointer is invisible to `elementFromPoint`, so that
 * call answers "nothing is here" for the dock even while the dock is on screen.
 */
export function isPointerOverHud(x: number, y: number): boolean {
  if (typeof document === 'undefined') return false;
  const elements = document.querySelectorAll(HUD_CHROME_SELECTOR);
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return true;
    }
  }
  return false;
}

interface ClickThroughGate {
  /**
   * Ask the window to be clickable (`ignore === false`) or to let the clicks through
   * (`ignore === true`). Requests are sent in the order they were made.
   */
  request(ignore: boolean): Promise<void>;
  /** The state the window is being asked to be in, or null if nothing was asked yet. */
  desired(): boolean | null;
  /** Forget the last request, so the next one is sent even if it repeats it. */
  reset(): void;
}

export function createClickThroughGate(
  send: (ignore: boolean) => Promise<void>
): ClickThroughGate {
  let desired: boolean | null = null;
  let chain: Promise<void> = Promise.resolve();

  const request = (ignore: boolean): Promise<void> => {
    if (desired === ignore) return chain;
    desired = ignore;
    chain = chain
      .then(() => send(ignore))
      .catch(() => {
        // The host refused the command. Forget the state so the next request is
        // actually sent instead of being swallowed as a duplicate.
        desired = null;
      });
    return chain;
  };

  return {
    request,
    desired: () => desired,
    reset: () => {
      desired = null;
    },
  };
}
