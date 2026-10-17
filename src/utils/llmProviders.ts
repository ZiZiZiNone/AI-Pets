import { LLM_DEFAULT_MODEL, LLM_MAX_TOKENS } from '@/constants/messages';

/**
 * LLM transports.
 *
 * The gateway used to be one hardcoded `fetch` with a Bearer header and a hardcoded read
 * of `choices[0].message.content`, which quietly assumed every vendor speaks OpenAI's
 * dialect. Most hosted vendors do, but local runners and Anthropic do not, so "swap the
 * model" silently meant "swap the vendor too, by editing source".
 *
 * Each provider below only owns request shaping and response reading. Personality,
 * history and fallback behaviour stay outside this module.
 */

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProviderConfig {
  /** Provider id, e.g. `openai_compatible`. Falls back to that when unset or unknown. */
  provider?: string;
  apiUrl: string;
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Not exported: nothing outside this module names it, and an unused export is dead weight. */
interface LlmProvider {
  id: string;
  label: string;
  /** False for providers that run on the user's own machine and need no secret. */
  requiresApiKey: boolean;
  send(messages: LlmChatMessage[], cfg: LlmProviderConfig): Promise<string | null>;
  /**
   * Optional incremental transport.
   *
   * A provider without this one still streams from the caller's point of view: the whole
   * reply is handed over as a single delta. That keeps the caller free of branches.
   */
  stream?(
    messages: LlmChatMessage[],
    cfg: LlmProviderConfig,
    onDelta: (delta: string) => void
  ): Promise<string | null>;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Read a `string` out of an unknown payload without throwing on a missing branch. */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function atPath(payload: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = payload;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

/**
 * Read a string without trimming it.
 *
 * Deltas may legitimately be a single space or a newline, so `readString` — which trims and
 * rejects blanks — cannot be used here: it would silently delete the whitespace between
 * words and the streamed sentence would come out glued together.
 */
function rawString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Split a byte stream into lines.
 *
 * Bytes are collected through a `TextDecoder` in streaming mode, because a multi-byte
 * character can be split across two chunks and decoding each chunk on its own would turn
 * every Chinese word at a chunk boundary into a replacement character.
 */
export async function* readResponseLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

/** The payload of one `data:` line, or null when the line is not a data line. */
function sseData(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('data:')) return null;
  return trimmed.slice(5).trim();
}

function parseJsonLine(payload: string | null): unknown {
  if (payload === null || !payload || payload === '[DONE]') return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/**
 * One line of OpenAI-compatible SSE: `data: {"choices":[{"delta":{"content":"…"}}]}`.
 *
 * Partial JSON is impossible here because the transport guarantees whole lines.
 */
export function parseOpenAiStreamLine(line: string): string | null {
  return rawString(atPath(parseJsonLine(sseData(line)), ['choices', 0, 'delta', 'content']));
}

/**
 * One line of Anthropic SSE: `data: {"type":"content_block_delta","delta":{"text":"…"}}`.
 *
 * The same stream also carries `message_start`, `ping` and `content_block_stop` events,
 * none of which contain text, so anything that is not a text delta reads as null.
 */
export function parseAnthropicStreamLine(line: string): string | null {
  const payload = parseJsonLine(sseData(line));
  if (atPath(payload, ['type']) !== 'content_block_delta') return null;
  return rawString(atPath(payload, ['delta', 'text']));
}

/**
 * One line of Ollama's NDJSON stream: `{"message":{"content":"…"},"done":false}`.
 *
 * Ollama does not use SSE at all — there is no `data:` prefix and no event names, just one
 * complete JSON object per line — which is why it needs its own parser despite also being
 * "a stream of JSON lines".
 */
export function parseOllamaStreamLine(line: string): string | null {
  return rawString(atPath(parseJsonLine(line), ['message', 'content']));
}

async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<Response | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) return null;
  return res;
}

async function drainStream(
  res: Response,
  extract: (line: string) => string | null,
  onDelta: (delta: string) => void
): Promise<string | null> {
  let full = '';
  for await (const line of readResponseLines(res.body as ReadableStream<Uint8Array>)) {
    const delta = extract(line);
    if (!delta) continue;
    full += delta;
    onDelta(delta);
  }
  // An empty stream is a failure, not an empty answer: the caller falls back rather than
  // showing the user a blank bubble.
  return full.trim() ? full : null;
}

const openaiCompatible: LlmProvider = {
  id: 'openai_compatible',
  label: 'OpenAI 兼容（OpenAI / DeepSeek / 通义 / 智谱 / SiliconFlow / LM Studio / one-api…）',
  requiresApiKey: true,
  async send(messages, cfg) {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const payload = await postJson(cfg.apiUrl, headers, {
      model: cfg.model || LLM_DEFAULT_MODEL,
      messages,
      max_tokens: cfg.maxTokens ?? LLM_MAX_TOKENS,
      ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
    });
    return readString(atPath(payload, ['choices', 0, 'message', 'content']));
  },
  async stream(messages, cfg, onDelta) {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const res = await postStream(cfg.apiUrl, headers, {
      model: cfg.model || LLM_DEFAULT_MODEL,
      messages,
      max_tokens: cfg.maxTokens ?? LLM_MAX_TOKENS,
      stream: true,
      ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
    });
    if (!res) return null;
    return drainStream(res, parseOpenAiStreamLine, onDelta);
  },
};

const anthropic: LlmProvider = {
  id: 'anthropic',
  label: 'Anthropic Claude（x-api-key + system 顶层字段）',
  requiresApiKey: true,
  async send(messages, cfg) {
    // Anthropic takes the system prompt out of band rather than as a message.
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const rest = messages.filter((m) => m.role !== 'system');
    const payload = await postJson(
      cfg.apiUrl,
      {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      anthropicBody(system, rest, cfg)
    );
    return readString(atPath(payload, ['content', 0, 'text']));
  },
  async stream(messages, cfg, onDelta) {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const rest = messages.filter((m) => m.role !== 'system');
    const res = await postStream(
      cfg.apiUrl,
      {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      { ...anthropicBody(system, rest, cfg), stream: true }
    );
    if (!res) return null;
    return drainStream(res, parseAnthropicStreamLine, onDelta);
  },
};

/** Shared between the buffered and the streaming call so the two cannot drift apart. */
function anthropicBody(
  system: string,
  rest: LlmChatMessage[],
  cfg: LlmProviderConfig
): Record<string, unknown> {
  return {
    model: cfg.model || LLM_DEFAULT_MODEL,
    max_tokens: cfg.maxTokens ?? LLM_MAX_TOKENS,
    ...(system ? { system } : {}),
    messages: rest,
    ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
  };
}

const ollama: LlmProvider = {
  id: 'ollama',
  label: 'Ollama 本地（免费离线，/api/chat）',
  requiresApiKey: false,
  async send(messages, cfg) {
    const payload = await postJson(cfg.apiUrl, {}, { ...ollamaBody(messages, cfg), stream: false });
    return readString(atPath(payload, ['message', 'content']));
  },
  async stream(messages, cfg, onDelta) {
    const res = await postStream(cfg.apiUrl, {}, { ...ollamaBody(messages, cfg), stream: true });
    if (!res) return null;
    return drainStream(res, parseOllamaStreamLine, onDelta);
  },
};

function ollamaBody(
  messages: LlmChatMessage[],
  cfg: LlmProviderConfig
): Record<string, unknown> {
  // Ollama reads the system prompt from the message list, so it is normalised to the front
  // rather than sent separately the way Anthropic needs it.
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const rest = messages.filter((m) => m.role !== 'system');
  return {
    model: cfg.model || LLM_DEFAULT_MODEL,
    messages: system ? [{ role: 'system', content: system }, ...rest] : rest,
    options: { num_predict: cfg.maxTokens ?? LLM_MAX_TOKENS },
  };
}

const LLM_PROVIDERS: Record<string, LlmProvider> = {
  [openaiCompatible.id]: openaiCompatible,
  [anthropic.id]: anthropic,
  [ollama.id]: ollama,
};

export const DEFAULT_LLM_PROVIDER_ID = openaiCompatible.id;

/** Unknown ids resolve to the default rather than throwing; a bad config should not break chat. */
export function resolveLlmProvider(providerId?: string): LlmProvider {
  if (!providerId) return openaiCompatible;
  return LLM_PROVIDERS[providerId] ?? openaiCompatible;
}

export function listLlmProviders(): LlmProvider[] {
  return Object.values(LLM_PROVIDERS);
}

/**
 * True when the configuration is complete enough to attempt a call.
 *
 * Keyless providers (Ollama) only need a URL, so requiring a key would lock the local
 * path out entirely.
 */
export function isLlmConfigUsable(cfg: LlmProviderConfig): boolean {
  if (!cfg.apiUrl?.trim()) return false;
  return resolveLlmProvider(cfg.provider).requiresApiKey ? Boolean(cfg.apiKey?.trim()) : true;
}

export async function sendLlmChat(
  messages: LlmChatMessage[],
  cfg: LlmProviderConfig
): Promise<string | null> {
  if (!isLlmConfigUsable(cfg)) return null;
  try {
    return await resolveLlmProvider(cfg.provider).send(messages, cfg);
  } catch {
    return null;
  }
}

/**
 * Ask for the reply incrementally, handing each new fragment to `onDelta`.
 *
 * Returns the full text, or null when nothing usable arrived. Three cases end in null, and
 * the caller treats them the same way — fall back to the offline personality:
 *
 * - the config is incomplete;
 * - the stream produced no text at all;
 * - the stream failed *before* emitting anything, which is common enough to be worth a
 *   retry: gateways that do not implement `stream` answer 400 rather than ignoring it, and
 *   some proxies buffer until close and then return a plain JSON body.
 *
 * When the stream fails *after* emitting text the partial reply is kept instead. Retrying
 * there would re-send the whole answer on top of a bubble that already shows the first
 * half of it.
 */
export async function sendLlmChatStream(
  messages: LlmChatMessage[],
  cfg: LlmProviderConfig,
  onDelta: (delta: string) => void
): Promise<string | null> {
  if (!isLlmConfigUsable(cfg)) return null;
  const provider = resolveLlmProvider(cfg.provider);

  let emitted = '';
  const sink = (delta: string): void => {
    if (!delta) return;
    emitted += delta;
    onDelta(delta);
  };

  if (provider.stream) {
    try {
      const streamed = await provider.stream(messages, cfg, sink);
      if (streamed) return streamed;
      if (emitted) return emitted;
    } catch {
      if (emitted) return emitted;
    }
  }

  try {
    const whole = await provider.send(messages, cfg);
    if (!whole) return null;
    sink(whole);
    return whole;
  } catch {
    return null;
  }
}
