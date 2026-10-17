import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAnthropicStreamLine,
  parseOllamaStreamLine,
  parseOpenAiStreamLine,
  readResponseLines,
  sendLlmChatStream,
  type LlmChatMessage,
} from '@/utils/llmProviders';

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A stream that yields exactly these byte chunks. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A stream that yields these chunks and then fails, mid-response. */
function breakingStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
        return;
      }
      controller.error(new Error('connection reset by peer'));
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readResponseLines(stream)) lines.push(line);
  return lines;
}

function stubStreamResponse(chunks: Uint8Array[], ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok, body: streamOf(chunks) }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const messages: LlmChatMessage[] = [{ role: 'user', content: '在吗' }];

describe('readResponseLines', () => {
  it('splits on newlines and strips the carriage return', async () => {
    const lines = await collect(streamOf([encoder.encode('a\r\nb\nc')]));
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('joins a line that arrives in two chunks', async () => {
    const lines = await collect(
      streamOf([encoder.encode('data: {"cho'), encoder.encode('ices":[]}\n')])
    );
    expect(lines).toEqual(['data: {"choices":[]}']);
  });

  it('keeps a multi-byte character that is split across chunk boundary', async () => {
    // '你' is E4 BD A0. Decoding each chunk separately would yield two replacement
    // characters, which would corrupt every Chinese reply at a chunk boundary.
    const bytes = encoder.encode('data: 你好\n');
    const cut = 8; // inside the first character, after the ASCII prefix
    const lines = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(lines).toEqual(['data: 你好']);
    expect(lines[0]).not.toContain('\uFFFD');
  });

  it('yields a trailing line that has no newline', async () => {
    const lines = await collect(streamOf([encoder.encode('one\ntwo')]));
    expect(lines).toEqual(['one', 'two']);
  });
});

describe('stream frame parsers', () => {
  it('reads the delta out of an OpenAI-compatible SSE line', () => {
    expect(
      parseOpenAiStreamLine('data: {"choices":[{"delta":{"content":"你好"}}]}')
    ).toBe('你好');
  });

  it('treats the OpenAI terminator and non-data lines as no content', () => {
    expect(parseOpenAiStreamLine('data: [DONE]')).toBeNull();
    expect(parseOpenAiStreamLine('event: message')).toBeNull();
    expect(parseOpenAiStreamLine('')).toBeNull();
    expect(parseOpenAiStreamLine('data: {not json')).toBeNull();
  });

  it('keeps a whitespace-only delta instead of trimming it away', () => {
    // Trimming here would glue the words of a streamed English sentence together.
    expect(parseOpenAiStreamLine('data: {"choices":[{"delta":{"content":" "}}]}')).toBe(' ');
  });

  it('reads only text deltas out of the Anthropic event stream', () => {
    expect(
      parseAnthropicStreamLine(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"在的"}}'
      )
    ).toBe('在的');
    expect(parseAnthropicStreamLine('event: content_block_delta')).toBeNull();
    expect(parseAnthropicStreamLine('data: {"type":"message_start","message":{}}')).toBeNull();
    expect(parseAnthropicStreamLine('data: {"type":"content_block_stop","index":0}')).toBeNull();
    expect(parseAnthropicStreamLine('data: {"type":"message_stop"}')).toBeNull();
  });

  it('reads Ollama NDJSON, which has no data: prefix at all', () => {
    expect(parseOllamaStreamLine('{"message":{"content":"本地"},"done":false}')).toBe('本地');
    expect(parseOllamaStreamLine('{"message":{"content":""},"done":true}')).toBe('');
    expect(parseOllamaStreamLine('{"done":true,"total_duration":1}')).toBeNull();
    expect(parseOllamaStreamLine('not json')).toBeNull();
  });
});

describe('sendLlmChatStream', () => {
  it('accumulates OpenAI-compatible deltas and returns the whole reply', async () => {
    const fetchMock = stubStreamResponse([
      encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n'),
      encoder.encode('data: [DONE]\n'),
    ]);
    const deltas: string[] = [];
    const out = await sendLlmChatStream(
      messages,
      { apiUrl: 'https://example.test/v1/chat/completions', apiKey: 'sk-x' },
      (d) => deltas.push(d)
    );

    expect(out).toBe('你好');
    expect(deltas).toEqual(['你', '好']);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as Record<string, unknown>).stream).toBe(true);
  });

  it('accumulates Anthropic deltas and skips the framing events', async () => {
    stubStreamResponse([
      encoder.encode('event: message_start\ndata: {"type":"message_start"}\n'),
      encoder.encode(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"在"}}\n'
      ),
      encoder.encode(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"的"}}\n'
      ),
      encoder.encode('data: {"type":"message_stop"}\n'),
    ]);
    const deltas: string[] = [];
    const out = await sendLlmChatStream(
      messages,
      { provider: 'anthropic', apiUrl: 'https://example.test/v1/messages', apiKey: 'sk-a' },
      (d) => deltas.push(d)
    );

    expect(out).toBe('在的');
    expect(deltas).toEqual(['在', '的']);
  });

  it('accumulates Ollama NDJSON lines', async () => {
    stubStreamResponse([
      encoder.encode('{"message":{"content":"本"},"done":false}\n'),
      encoder.encode('{"message":{"content":"地"},"done":false}\n'),
      encoder.encode('{"done":true}\n'),
    ]);
    const deltas: string[] = [];
    const out = await sendLlmChatStream(
      messages,
      { provider: 'ollama', apiUrl: 'http://localhost:11434/api/chat', apiKey: '' },
      (d) => deltas.push(d)
    );

    expect(out).toBe('本地');
    expect(deltas).toEqual(['本', '地']);
  });

  it('falls back to one whole reply when the gateway rejects stream:true', async () => {
    // A 400 on the streaming request is the common shape of "this gateway does not stream".
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, body: null })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '整段回复' } }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const out = await sendLlmChatStream(
      messages,
      { apiUrl: 'https://example.test/v1/chat/completions', apiKey: 'sk-x' },
      (d) => deltas.push(d)
    );

    expect(out).toBe('整段回复');
    expect(deltas).toEqual(['整段回复']);
    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(
      (JSON.parse(String(retryInit.body)) as Record<string, unknown>).stream
    ).toBeUndefined();
  });

  it('keeps the partial reply when the stream breaks after emitting text', async () => {
    // Re-sending here would stack a second copy on top of the half already on screen.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: breakingStream([encoder.encode('data: {"choices":[{"delta":{"content":"一半"}}]}\n')]),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const out = await sendLlmChatStream(
      messages,
      { apiUrl: 'https://example.test/v1/chat/completions', apiKey: 'sk-x' },
      (d) => deltas.push(d)
    );

    expect(out).toBe('一半');
    expect(deltas).toEqual(['一半']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports failure instead of an empty bubble when the stream carries no text', async () => {
    stubStreamResponse([encoder.encode('data: [DONE]\n')]);
    const deltas: string[] = [];
    const out = await sendLlmChatStream(
      messages,
      { apiUrl: 'https://example.test/v1/chat/completions', apiKey: 'sk-x' },
      (d) => deltas.push(d)
    );

    expect(out).toBeNull();
    expect(deltas).toEqual([]);
  });

  it('does not touch the network when the config is incomplete', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await sendLlmChatStream(
      messages,
      { apiUrl: 'https://example.test/v1/chat/completions', apiKey: '' },
      () => {}
    );

    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
