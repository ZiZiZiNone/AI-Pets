import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startContinuousVoice,
  type ContinuousVoiceHandlers,
} from '@/utils/continuousVoice';
import { DEFAULT_VOICE_SETTINGS } from '@/utils/yamlLoader';
import type { VoiceSettings } from '@/types/pet';

/**
 * The pet listens.
 *
 * The switch is the point of this module: with it on, a phrase the user says reaches the
 * pet without a button to press first. So the tests are about the two halves of that —
 * the switch has to actually open a session, and the session has to survive the browser
 * ending it, which is what "keeps listening" means.
 */

interface FakeResult {
  isFinal: boolean;
  0: { transcript: string };
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];

  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: FakeResult[] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.onend?.();
  }
}

function sttWith(overrides: Partial<VoiceSettings['stt']>): VoiceSettings['stt'] {
  return { ...structuredClone(DEFAULT_VOICE_SETTINGS.stt), ...overrides };
}

describe('startContinuousVoice', () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  });

  it('opens no session while the microphone switch is off', () => {
    const statuses: string[] = [];
    startContinuousVoice(sttWith({ enabled: false, provider: 'web_speech' }), {
      onText: () => {},
      onStatus: (message) => statuses.push(message),
    });
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(statuses.join()).toContain('捕捉麦克风');
  });

  it('says what is missing when no recogniser is configured', () => {
    const statuses: string[] = [];
    startContinuousVoice(sttWith({ enabled: true, provider: 'none' }), {
      onText: () => {},
      onStatus: (message) => statuses.push(message),
    });
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(statuses.join()).toContain('识别');
  });

  it('hands every finished phrase to the caller', () => {
    const heard: string[] = [];
    const handlers: ContinuousVoiceHandlers = { onText: (text) => heard.push(text) };
    const stop = startContinuousVoice(sttWith({ enabled: true, provider: 'web_speech' }), handlers);

    expect(FakeRecognition.instances).toHaveLength(1);
    const session = FakeRecognition.instances[0];
    expect(session.started).toBe(true);
    expect(session.continuous).toBe(true);

    session.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: '  你好  ' } }],
    });
    expect(heard).toEqual(['你好']);

    stop();
  });

  it('starts a new session when the browser ends the one it was given', () => {
    vi.useFakeTimers();
    const stop = startContinuousVoice(sttWith({ enabled: true, provider: 'web_speech' }), {
      onText: () => {},
    });

    expect(FakeRecognition.instances).toHaveLength(1);
    // Chromium ends a continuous recogniser after a pause; the pet has to keep listening.
    FakeRecognition.instances[0].onend?.();
    expect(FakeRecognition.instances).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(FakeRecognition.instances).toHaveLength(2);

    stop();
  });

  it('stays stopped once the user stops it', () => {
    vi.useFakeTimers();
    const stop = startContinuousVoice(sttWith({ enabled: true, provider: 'web_speech' }), {
      onText: () => {},
    });
    stop();
    FakeRecognition.instances[0].onend?.();
    vi.advanceTimersByTime(1000);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('reports a refused microphone instead of listening in silence', () => {
    const statuses: string[] = [];
    startContinuousVoice(sttWith({ enabled: true, provider: 'web_speech' }), {
      onText: () => {},
      onStatus: (message) => statuses.push(message),
    });
    FakeRecognition.instances[0].onerror?.({ error: 'not-allowed' });
    expect(statuses.join()).toContain('拒绝');
  });

  it('treats "no speech" as an ordinary ending rather than a failure', () => {
    const statuses: string[] = [];
    startContinuousVoice(sttWith({ enabled: true, provider: 'web_speech' }), {
      onText: () => {},
      onStatus: (message) => statuses.push(message),
    });
    FakeRecognition.instances[0].onerror?.({ error: 'no-speech' });
    expect(statuses).toHaveLength(0);
  });
});
