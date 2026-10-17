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
      {
        model: cfg.model || LLM_DEFAULT_MODEL,
        max_tokens: cfg.maxTokens ?? LLM_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: rest,
        ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
      }
    );
    return readString(atPath(payload, ['content', 0, 'text']));
  },
};

const ollama: LlmProvider = {
  id: 'ollama',
  label: 'Ollama 本地（免费离线，/api/chat）',
  requiresApiKey: false,
  async send(messages, cfg) {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const rest = messages.filter((m) => m.role !== 'system');
    const payload = await postJson(cfg.apiUrl, {}, {
      model: cfg.model || LLM_DEFAULT_MODEL,
      stream: false,
      messages: system ? [{ role: 'system', content: system }, ...rest] : rest,
      options: { num_predict: cfg.maxTokens ?? LLM_MAX_TOKENS },
    });
    return readString(atPath(payload, ['message', 'content']));
  },
};

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
