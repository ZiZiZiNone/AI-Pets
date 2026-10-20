import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClickThroughGate, isPointerOverHud } from '@/utils/hudHit';

/**
 * The pointer is asked where it is, and the answer decides whether the window still
 * receives clicks. Both halves of that are easy to get wrong in a way no screenshot
 * shows, so they are pinned here.
 */
describe('hud hit testing', () => {
  // The chrome is looked up in the document, so a case that leaves its dock behind
  // would answer for the next one.
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * jsdom has no layout, so every rectangle it hands out is empty. The chrome is placed
   * by hand here for the same reason the production code measures it: the frame the
   * chrome sits in is `pointer-events: none`, which makes `elementFromPoint` report
   * "nothing is here" for the whole dock.
   */
  function place(element: Element, left: number, top: number, width: number, height: number): void {
    element.getBoundingClientRect = () =>
      ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
      }) as DOMRect;
  }

  it('reports a pointer over the dock as being over the chrome', () => {
    const dock = document.createElement('div');
    dock.className = 'tactical-dock';
    place(dock, 288, 218, 66, 188);
    document.body.appendChild(dock);

    expect(isPointerOverHud(320, 232)).toBe(true);
  });

  it('reports a pointer beside the dock as not being over the chrome', () => {
    const dock = document.createElement('div');
    dock.className = 'tactical-dock';
    place(dock, 288, 218, 66, 188);
    document.body.appendChild(dock);

    expect(isPointerOverHud(100, 232)).toBe(false);
  });

  it('ignores chrome that is not on screen', () => {
    const dock = document.createElement('div');
    dock.className = 'tactical-dock';
    // A collapsed element has no area, so nothing can be inside it.
    place(dock, 0, 0, 0, 0);
    document.body.appendChild(dock);

    expect(isPointerOverHud(320, 232)).toBe(false);
  });

  it('reports a pointer over the status pill as being over the chrome', () => {
    const pill = document.createElement('div');
    pill.className = 'holo-status-pill';
    place(pill, 90, 8, 180, 24);
    document.body.appendChild(pill);

    expect(isPointerOverHud(180, 20)).toBe(true);
  });
});

describe('click-through gate', () => {
  it('sends the requests in the order they were made', async () => {
    const sent: boolean[] = [];
    const gate = createClickThroughGate(async (ignore) => {
      sent.push(ignore);
    });

    await Promise.all([gate.request(true), gate.request(false)]);

    // The last request is the state the window must end up in.
    expect(sent).toEqual([true, false]);
    expect(gate.desired()).toBe(false);
  });

  it('does not send the same state twice', async () => {
    const send = vi.fn(async () => {});
    const gate = createClickThroughGate(send);

    await gate.request(false);
    await gate.request(false);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a repeated state again after a reset', async () => {
    const send = vi.fn(async () => {});
    const gate = createClickThroughGate(send);

    await gate.request(false);
    gate.reset();
    await gate.request(false);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('lets the next request through after the host refused one', async () => {
    const send = vi
      .fn<(ignore: boolean) => Promise<void>>()
      .mockRejectedValueOnce(new Error('no host'))
      .mockResolvedValueOnce(undefined);
    const gate = createClickThroughGate(send);

    await gate.request(true);
    expect(gate.desired()).toBe(null);

    await gate.request(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps sending after a failure instead of stalling the chain', async () => {
    const sent: boolean[] = [];
    const gate = createClickThroughGate(async (ignore) => {
      sent.push(ignore);
      if (sent.length === 1) throw new Error('no host');
    });

    await gate.request(true);
    await gate.request(false);

    expect(sent).toEqual([true, false]);
    expect(gate.desired()).toBe(false);
  });
});
