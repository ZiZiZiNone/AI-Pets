import { invoke } from '@tauri-apps/api/core';

/**
 * Bridge to the Rust side's generic external-engine runner.
 *
 * Split out from the speech providers because it knows nothing about speech: it executes
 * a configured program with a configured argv and moves bytes in and out. Anything that
 * wants to drive a local model — a different TTS, a translator, a local LLM CLI — can use
 * this without touching the voice modules.
 */

interface EngineRequest {
  /** Absolute path to the executable. */
  exe: string;
  /**
   * Fully expanded argv. `{input}`/`{output}` are the runner's own temp paths and a
   * path-like `*` is resolved to the first matching file, so they must be left intact.
   */
  args: string[];
  stdin?: string;
  cwd?: string;
  timeout_ms?: number;
  /** Base64 audio written to a temp file, whose path replaces `{input}`. */
  input_bytes_base64?: string;
  input_extension?: string;
  /** Extension for a temp file whose path replaces `{output}`, read back as base64. */
  capture_output_extension?: string;
}

export interface EngineResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  /** Output was still arriving when collection gave up, so the text may be partial. */
  output_truncated: boolean;
  output_base64: string | null;
  output_mime: string | null;
}

/** True when the app is hosted by Tauri; the browser fallback has no engine runner. */
function hasEngineRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function runExternalEngine(request: EngineRequest): Promise<EngineResult> {
  if (!hasEngineRuntime()) {
    throw new Error('本地引擎只能在桌面应用内运行（当前为浏览器预览环境）');
  }
  return invoke<EngineResult>('run_external_engine', { request });
}

/**
 * Replace `{name}` placeholders the caller knows about, leaving the rest for later stages.
 *
 * Two stages fill these on purpose: the frontend owns configuration values, and the Rust
 * runner owns `{input}`/`{output}` because those are temp paths only it can name. A single
 * pass would have to invent the temp path in JavaScript, or leak config parsing into Rust.
 */
export function substituteArgTemplate(
  args: readonly string[],
  values: Record<string, string | number>
): string[] {
  return args.map((arg) =>
    Object.entries(values).reduce(
      (acc, [key, value]) => acc.replaceAll(`{${key}}`, String(value)),
      arg
    )
  );
}

/** Encode bytes for a JSON payload without blowing the argument limit of `fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Decoded bytes are backed by a plain `ArrayBuffer`, which is what `Blob` accepts. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Turn a captured audio payload into something an `<audio>` element can play. */
export function engineAudioBlob(result: EngineResult): Blob | null {
  if (!result.output_base64) return null;
  try {
    return new Blob([base64ToBytes(result.output_base64)], {
      type: result.output_mime || 'audio/wav',
    });
  } catch {
    return null;
  }
}

/**
 * A one-line explanation of a failed engine run, for the user rather than the log.
 *
 * `stderr` is preferred because engines report the actual cause there (a missing model
 * file, a bad flag), while the exit code alone says nothing actionable.
 */
export function describeEngineFailure(result: EngineResult, engineLabel: string): string {
  if (result.timed_out) {
    return `${engineLabel} 超时未返回，已终止`;
  }
  const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0] ?? '';
  const code = result.exit_code === null ? '被终止' : `退出码 ${result.exit_code}`;
  if (!detail) {
    return `${engineLabel} 执行失败（${code}）`;
  }
  return `${engineLabel} 执行失败（${code}）：${detail.slice(0, 180)}`;
}
