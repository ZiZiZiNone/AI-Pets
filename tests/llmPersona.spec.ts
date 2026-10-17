import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePetStore } from '@/store/petStore';
import {
  appendLlmTurn,
  buildLlmMessages,
  LLM_HISTORY_MAX_CHARS,
  LLM_HISTORY_MAX_MESSAGES,
  LLM_HISTORY_MAX_TURNS,
  requestLlmCompletion,
  resolveLlmHistoryMessages,
  trimLlmHistory,
} from '@/utils/commandEngine';
import { buildPetSystemPrompt, describePetPersona } from '@/utils/petPersona';
import {
  DEFAULT_LLM_PROVIDER_ID,
  isLlmConfigUsable,
  listLlmProviders,
  resolveLlmProvider,
  sendLlmChat,
  type LlmChatMessage,
  type LlmProviderConfig,
} from '@/utils/llmProviders';
import { parsePetManifestYaml } from '@/utils/yamlLoader';
import type { PetManifest } from '@/types/pet';

const basePet = (over: Partial<PetManifest> = {}): PetManifest => ({
  id: 'demo_pet',
  name: '测试体',
  version: '2.0.0',
  type: 'sprite',
  ...over,
});

describe('buildPetSystemPrompt', () => {
  it('names the pet and states the reply contract with no persona at all', () => {
    const prompt = buildPetSystemPrompt(basePet({ description: '一台会打字的机器' }));
    expect(prompt).toContain('测试体');
    expect(prompt).toContain('一台会打字的机器');
    expect(prompt).toContain('60 字');
  });

  it('uses a neutral trait list rather than inventing one when persona is absent', () => {
    const prompt = buildPetSystemPrompt(basePet());
    expect(prompt).toContain('友善');
    expect(prompt).toContain('好奇');
  });

  it('folds structured traits and style notes into the prompt', () => {
    const prompt = buildPetSystemPrompt(
      basePet({
        persona: {
          identity: '你是银羽。',
          traits: ['温柔灵动', '好奇'],
          style_notes: '称听众为「大家」。',
        },
      })
    );
    expect(prompt).toContain('你是银羽。');
    expect(prompt).toContain('温柔灵动、好奇');
    expect(prompt).toContain('称听众为「大家」。');
    // The neutral list must not override a pet that stated its own.
    expect(prompt).not.toContain('友善');
  });

  it('lets a pet override the whole prompt', () => {
    const prompt = buildPetSystemPrompt(
      basePet({ persona: { system_prompt: '你只回答「喵」。' } }),
      '用户的全局覆盖'
    );
    expect(prompt).toBe('你只回答「喵」。');
  });

  it('lets the user override win over the composed persona but not over system_prompt', () => {
    const composed = buildPetSystemPrompt(
      basePet({ persona: { traits: ['高冷'] } }),
      '只说一句冷话。'
    );
    expect(composed).toBe('只说一句冷话。');

    const owned = buildPetSystemPrompt(
      basePet({ persona: { system_prompt: '宠物自己的设定' } }),
      '只说一句冷话。'
    );
    expect(owned).toBe('宠物自己的设定');
  });

  it('drops blank entries instead of emitting empty sentences', () => {
    const prompt = buildPetSystemPrompt(
      basePet({ persona: { identity: '  ', traits: ['  ', '安静'], style_notes: '' } })
    );
    expect(prompt).toContain('安静');
    expect(prompt).not.toContain('性格：、、');
    expect(prompt).not.toMatch(/\n\s*\n/);
  });

  it('survives a missing pet without throwing', () => {
    expect(() => buildPetSystemPrompt(null)).not.toThrow();
    expect(buildPetSystemPrompt(null)).toContain('桌面宠物');
  });
});

describe('describePetPersona', () => {
  it('reports the neutral traits when a pet declares nothing', () => {
    expect(describePetPersona()).toContain('友善');
  });

  it('flags a pet that ships a full prompt', () => {
    expect(describePetPersona({ system_prompt: 'x' })).toBe('自定义人格');
  });
});

describe('parsePetManifestYaml persona', () => {
  it('reads a persona block and trims it', () => {
    const m = parsePetManifestYaml(`
id: p
persona:
  identity: "  你是甲  "
  traits:
    - "  安静  "
    - ""
  style_notes: "简短。"
`);
    expect(m.persona?.identity).toBe('你是甲');
    expect(m.persona?.traits).toEqual(['安静']);
    expect(m.persona?.style_notes).toBe('简短。');
  });

  it('ignores a malformed persona rather than failing the whole manifest', () => {
    const m = parsePetManifestYaml('id: p\nname: 甲\npersona: "not a map"');
    expect(m.persona).toBeUndefined();
    expect(m.id).toBe('p');
  });

  it('rejects non-string traits', () => {
    const m = parsePetManifestYaml('id: p\npersona:\n  traits: [1, true, "好"]');
    expect(m.persona?.traits).toEqual(['好']);
  });
});

describe('llm providers', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (payload: unknown, ok = true) => {
    const fetchMock = vi.fn(async () => ({
      ok,
      json: async () => payload,
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('offers keyless local alongside keyed hosted vendors', () => {
    const ids = listLlmProviders().map((p) => p.id);
    expect(ids).toContain('openai_compatible');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('ollama');
    expect(resolveLlmProvider('ollama').requiresApiKey).toBe(false);
    expect(resolveLlmProvider('anthropic').requiresApiKey).toBe(true);
  });

  it('falls back to the default provider for an unknown id', () => {
    expect(resolveLlmProvider('does_not_exist').id).toBe(DEFAULT_LLM_PROVIDER_ID);
    expect(resolveLlmProvider(undefined).id).toBe(DEFAULT_LLM_PROVIDER_ID);
  });

  it('requires a key only for providers that need one', () => {
    const url = 'http://localhost:11434/api/chat';
    expect(isLlmConfigUsable({ provider: 'ollama', apiUrl: url, apiKey: '' })).toBe(true);
    expect(isLlmConfigUsable({ provider: 'openai_compatible', apiUrl: url, apiKey: '' })).toBe(false);
    expect(isLlmConfigUsable({ provider: 'ollama', apiUrl: '', apiKey: '' })).toBe(false);
  });

  it('reads an OpenAI-compatible reply and sends a bearer token', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: ' 你好 ' } }] });
    const out = await sendLlmChat([{ role: 'user', content: 'hi' }], {
      apiUrl: 'https://example.test/v1/chat/completions',
      apiKey: 'sk-x',
      model: 'm',
    });
    expect(out).toBe('你好');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x');
  });

  it('lifts the system prompt out of the message list for Anthropic', async () => {
    const fetchMock = stubFetch({ content: [{ type: 'text', text: '在的' }] });
    const messages: LlmChatMessage[] = [
      { role: 'system', content: '你是甲' },
      { role: 'user', content: '在吗' },
    ];
    const out = await sendLlmChat(messages, {
      provider: 'anthropic',
      apiUrl: 'https://api.anthropic.test/v1/messages',
      apiKey: 'sk-a',
    });
    expect(out).toBe('在的');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-a');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.system).toBe('你是甲');
    expect((body.messages as unknown[]).length).toBe(1);
  });

  it('reaches Ollama with no auth header at all', async () => {
    const fetchMock = stubFetch({ message: { content: '本地回复' } });
    const out = await sendLlmChat([{ role: 'user', content: 'hi' }], {
      provider: 'ollama',
      apiUrl: 'http://localhost:11434/api/chat',
      apiKey: '',
    });
    expect(out).toBe('本地回复');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('returns null for a non-2xx reply instead of throwing', async () => {
    stubFetch({}, false);
    const out = await sendLlmChat([{ role: 'user', content: 'hi' }], {
      apiUrl: 'https://example.test/v1/chat/completions',
      apiKey: 'sk-x',
    });
    expect(out).toBeNull();
  });

  it('returns null when the vendor answers with an unexpected shape', async () => {
    stubFetch({ error: { message: 'model not found' } });
    const out = await sendLlmChat([{ role: 'user', content: 'hi' }], {
      apiUrl: 'https://example.test/v1/chat/completions',
      apiKey: 'sk-x',
    });
    expect(out).toBeNull();
  });

  it('never calls the network when the config is incomplete', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: 'x' } }] });
    const cfg: LlmProviderConfig = { apiUrl: '', apiKey: 'sk-x' };
    expect(await sendLlmChat([{ role: 'user', content: 'hi' }], cfg)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('configurable memory window', () => {
  const turns = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      { role: 'user' as const, content: `u${i}` },
      { role: 'assistant' as const, content: `a${i}` },
    ]).flat();

  it('falls back to the default for anything that is not a usable number', () => {
    // A config written before the field existed arrives as undefined, not as a number.
    expect(resolveLlmHistoryMessages(undefined)).toBe(LLM_HISTORY_MAX_MESSAGES);
    expect(resolveLlmHistoryMessages(Number.NaN)).toBe(LLM_HISTORY_MAX_MESSAGES);
    expect(resolveLlmHistoryMessages(Number.POSITIVE_INFINITY)).toBe(LLM_HISTORY_MAX_MESSAGES);
  });

  it('clamps an oversized window instead of sending everything', () => {
    expect(resolveLlmHistoryMessages(9999)).toBe(LLM_HISTORY_MAX_TURNS * 2);
  });

  it('treats zero and negatives as no memory rather than as unlimited', () => {
    // `slice(-0)` is `slice(0)`, which would re-send the whole conversation.
    expect(resolveLlmHistoryMessages(0)).toBe(0);
    expect(resolveLlmHistoryMessages(-5)).toBe(0);
    expect(trimLlmHistory(turns(6), 0)).toEqual([]);
    expect(buildLlmMessages('sys', turns(6), '现在', 0)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '现在' },
    ]);
  });

  it('sends exactly the configured number of exchanges', () => {
    const messages = buildLlmMessages('sys', turns(10), '现在', resolveLlmHistoryMessages(2));
    // system + the last 2 exchanges + the new input
    expect(messages).toHaveLength(6);
    expect(messages[1].content).toBe('u8');
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '现在' });
  });

  it('drops the oldest turns as the window fills up', () => {
    let history: ReturnType<typeof appendLlmTurn> = [];
    for (let i = 0; i < 6; i += 1) history = appendLlmTurn(history, `u${i}`, `a${i}`, 4);
    expect(history).toHaveLength(4);
    expect(history[0].content).toBe('u4');
  });
});

describe('conversation memory', () => {
  const turn = (index: number): LlmChatMessage[] => [
    { role: 'user', content: `u${index}` },
    { role: 'assistant', content: `a${index}` },
  ];

  it('keeps only the newest turns so the request cannot grow without limit', () => {
    let history: LlmChatMessage[] = [];
    for (let index = 1; index <= 10; index += 1) {
      history = appendLlmTurn(history, `u${index}`, `a${index}`);
    }
    expect(history).toHaveLength(LLM_HISTORY_MAX_MESSAGES);
    // The oldest exchange is the one dropped, never the newest.
    expect(history[0].content).toBe('u7');
    expect(history[history.length - 1].content).toBe('a10');
  });

  it('truncates one oversized turn instead of resending it whole', () => {
    const trimmed = trimLlmHistory([
      { role: 'user', content: 'x'.repeat(LLM_HISTORY_MAX_CHARS + 500) },
    ]);
    expect(trimmed[0].content.length).toBe(LLM_HISTORY_MAX_CHARS);
  });

  it('flatmaps a turn into a user/assistant pair in order', () => {
    expect(appendLlmTurn([], '你好', '你也好')).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你也好' },
    ]);
  });

  it('composes the request as brief, remembered turns, then the new input', () => {
    const messages = buildLlmMessages('你是银羽', turn(1), '现在几点了');
    expect(messages[0]).toEqual({ role: 'system', content: '你是银羽' });
    expect(messages.slice(1, 3)).toEqual(turn(1));
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '现在几点了' });
    expect(messages).toHaveLength(4);
  });

  it('sends just the brief and the input for a first message', () => {
    expect(buildLlmMessages('你是银羽', [], '你好')).toEqual([
      { role: 'system', content: '你是银羽' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('carries the remembered turns into the request body', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    }));
    // @ts-expect-error the test replaces the global fetch with a shaped double
    globalThis.fetch = fetchMock;

    await requestLlmCompletion(
      '现在几点了',
      basePet(),
      { enabled: true, apiUrl: 'https://x/v1/chat', apiKey: 'sk', model: 'm', customSystemPrompt: '' },
      appendLlmTurn([], '你好', '你也好')
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.messages).toHaveLength(4);
    expect(body.messages[1]).toEqual({ role: 'user', content: '你好' });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: '你也好' });
  });
});

describe('per-pet conversation memory in the store', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('keeps the turns of different pets apart', () => {
    const store = usePetStore();
    store.recordLlmTurn('silverfeather', '你好', '你好呀');
    store.recordLlmTurn('aether', '启动', '核心就绪');

    expect(store.llmHistoryFor('silverfeather')).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
    ]);
    expect(store.llmHistoryFor('aether')).toHaveLength(2);
    expect(store.llmHistoryFor('unknown_pet')).toEqual([]);
  });

  it('forgets only the addressed pet, and reports how many turns went', () => {
    const store = usePetStore();
    store.recordLlmTurn('silverfeather', 'a', 'b');
    store.recordLlmTurn('silverfeather', 'c', 'd');
    store.recordLlmTurn('aether', 'e', 'f');

    expect(store.clearLlmHistory('silverfeather')).toBe(2);
    expect(store.llmHistoryFor('silverfeather')).toEqual([]);
    expect(store.llmHistoryFor('aether')).toHaveLength(2);
    // Nothing was there to forget the second time; the caller gets 0, not a fake count.
    expect(store.clearLlmHistory('silverfeather')).toBe(0);
  });

  it('ignores a pet id that never spoke', () => {
    const store = usePetStore();
    store.recordLlmTurn('', 'x', 'y');
    expect(store.clearLlmHistory('')).toBe(0);
    expect(store.llmHistoryFor('')).toEqual([]);
  });

  it('restores the remembered turns from storage', () => {
    const first = usePetStore();
    first.recordLlmTurn('silverfeather', '你好', '你好呀');

    setActivePinia(createPinia());
    const second = usePetStore();
    expect(second.llmHistoryFor('silverfeather')).toHaveLength(2);
  });
});
