import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePetStore } from '@/store/petStore';

/**
 * The streamed-reply bubble.
 *
 * The engine hands fragments over as they arrive; the store's job is to keep them on a
 * single bubble and to survive the two cases a naive implementation gets wrong — a fragment
 * that arrives while the bubble is still queued behind a higher-priority action, and a reply
 * that never streamed at all because the gateway refused `stream:true`.
 */
describe('streamed reply bubble', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  it('opens an empty bubble and marks it as still arriving', () => {
    const store = usePetStore();
    store.beginStreamedReply();

    expect(store.currentAction).not.toBeNull();
    expect(store.bubbleText).toBe('');
    expect(store.replyStreaming).toBe(true);
  });

  it('replaces the text on every fragment', () => {
    const store = usePetStore();
    const id = store.beginStreamedReply();
    store.pushStreamedText(id, '你');
    expect(store.bubbleText).toBe('你');
    store.pushStreamedText(id, '你好');
    expect(store.bubbleText).toBe('你好');
    expect(store.replyStreaming).toBe(true);
  });

  it('ignores a fragment that belongs to a superseded reply', () => {
    const store = usePetStore();
    const stale = store.beginStreamedReply();
    const fresh = store.beginStreamedReply();
    store.pushStreamedText(stale, '旧的一行');
    store.pushStreamedText(fresh, '新的');
    expect(store.bubbleText).toBe('新的');
  });

  it('does not paint fragments into a bubble that is still queued', () => {
    const store = usePetStore();
    // A P0 action owns the stage, so the reply bubble is waiting its turn.
    store.scheduleAction({ priority: 'P0', text: '拦截弹窗', durationMs: 5000 });
    const id = store.beginStreamedReply();
    expect(store.currentAction?.text).toBe('拦截弹窗');
    expect(store.replyStreaming).toBe(false);

    store.pushStreamedText(id, '半句话');
    expect(store.bubbleText).toBe('拦截弹窗');
  });

  it('shows the whole reply once the queued bubble gets its turn', () => {
    const store = usePetStore();
    store.scheduleAction({ priority: 'P0', text: '拦截弹窗', durationMs: 5000 });
    const id = store.beginStreamedReply();
    store.pushStreamedText(id, '半句话');
    store.endStreamedReply(id, '完整的回复', 3000);

    // Nothing of the reply may be silently swallowed just because it was streamed.
    expect(store.actionQueue.map((t) => t.text)).toContain('完整的回复');
  });

  it('keeps the finished sentence and stops marking the bubble as arriving', () => {
    const store = usePetStore();
    const id = store.beginStreamedReply();
    store.pushStreamedText(id, '你好呀');
    store.endStreamedReply(id, '你好呀', 3000);

    expect(store.bubbleText).toBe('你好呀');
    expect(store.replyStreaming).toBe(false);
    expect(store.currentAction?.text).toBe('你好呀');
  });

  it('still shows a reply that never produced a fragment', () => {
    // The gateway refused `stream`, so the buffered fallback produced the text in one piece.
    const store = usePetStore();
    const id = store.beginStreamedReply();
    store.endStreamedReply(id, '整段回复', 3000);

    expect(store.bubbleText).toBe('整段回复');
    expect(store.replyStreaming).toBe(false);
  });

  it('holds the bubble open between fragments instead of letting it expire', () => {
    const store = usePetStore();
    const id = store.beginStreamedReply();
    // Well past the default action duration: a long pause between tokens must not clear it.
    vi.advanceTimersByTime(20000);
    expect(store.bubbleText).toBe('');

    store.pushStreamedText(id, '迟到的一句');
    expect(store.currentAction).not.toBeNull();
    expect(store.bubbleText).toBe('迟到的一句');
  });

  it('clears the bubble once the finished reply has been on screen long enough', () => {
    const store = usePetStore();
    const id = store.beginStreamedReply();
    store.pushStreamedText(id, '说完了');
    store.endStreamedReply(id, '说完了', 1000);
    vi.advanceTimersByTime(1000);

    expect(store.currentAction).toBeNull();
    expect(store.bubbleText).toBe('');
  });
});
