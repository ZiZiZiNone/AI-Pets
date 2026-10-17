import type { VoiceSettings } from '@/types/pet';
import {
  bytesToBase64,
  describeEngineFailure,
  engineAudioBlob,
  runExternalEngine,
  substituteArgTemplate,
  type EngineResult,
} from '@/utils/engineBridge';

/**
 * Synthesis and recognition across the three transports.
 *
 * Each function returns a discriminated result instead of throwing, because every failure
 * here has a user-facing next step ("fill in the endpoint", "install the model") and a
 * rejected promise in a bubble handler would surface as nothing at all.
 */

type SynthesisOutcome =
  | {
      kind: 'system_voice';
      lang: string;
      rate: number;
      pitch: number;
      voice: string;
    }
  | { kind: 'audio'; blob: Blob }
  | { kind: 'failed'; reason: string };

interface TranscriptionOutcome {
  ok: boolean;
  text: string;
  reason: string;
}

/** Values the host fills into a local engine's argv template. */
export function localEngineArgValues(
  local: VoiceSettings['tts']['local'],
  text: string
): Record<string, string | number> {
  return {
    model_dir: local.model_dir,
    text,
    speed: local.speed,
    num_threads: local.num_threads,
    speaker_id: local.speaker_id,
    // Provided as well as `speed` because VITS and several other engines express rate as a
    // length scale, where a larger value means slower.
    length_scale: local.speed === 0 ? 1 : Number((1 / local.speed).toFixed(4)),
  };
}

/**
 * Build the argv for one local-engine call, and decide how the text reaches the process.
 *
 * A template with `{text}` receives the sentence as an argument; one without gets it on
 * stdin. That single rule covers both engine families without a second config field, and
 * it keeps the sentence out of the argv when the engine expects it on stdin — where a
 * shell-free `Command` cannot mangle it.
 */
export function buildLocalEngineInvocation(
  local: VoiceSettings['tts']['local'],
  text: string
): { args: string[]; stdin?: string } {
  const args = substituteArgTemplate(local.args, localEngineArgValues(local, text));
  const expectsTextArgument = local.args.some((arg) => arg.includes('{text}'));
  if (local.extra_args.length > 0) args.push(...local.extra_args);
  return expectsTextArgument ? { args } : { args, stdin: text };
}

async function synthesizeWithLocalEngine(
  text: string,
  local: VoiceSettings['tts']['local']
): Promise<SynthesisOutcome> {
  const invocation = buildLocalEngineInvocation(local, text);
  let result: EngineResult;
  try {
    result = await runExternalEngine({
      exe: local.exe,
      args: invocation.args,
      stdin: invocation.stdin,
      timeout_ms: local.timeout_ms,
      capture_output_extension: local.output_extension,
    });
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }

  if (result.timed_out || result.exit_code !== 0) {
    return { kind: 'failed', reason: describeEngineFailure(result, '本地语音引擎') };
  }
  const blob = engineAudioBlob(result);
  if (!blob) {
    return { kind: 'failed', reason: '本地语音引擎没有产出音频数据' };
  }
  return { kind: 'audio', blob };
}

async function synthesizeWithHttp(
  text: string,
  http: VoiceSettings['tts']['http']
): Promise<SynthesisOutcome> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (http.api_key.trim()) headers.Authorization = `Bearer ${http.api_key.trim()}`;
  const body: Record<string, unknown> = {
    model: http.model,
    input: text,
    speed: http.speed,
  };
  if (http.voice.trim()) body.voice = http.voice;
  if (http.format.trim()) body.response_format = http.format;

  try {
    const response = await fetch(http.api_url.trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 180);
      return {
        kind: 'failed',
        reason: `语音接口返回 ${response.status}${detail ? `：${detail}` : ''}`,
      };
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      return { kind: 'failed', reason: '语音接口返回了空音频' };
    }
    return { kind: 'audio', blob };
  } catch (error) {
    return {
      kind: 'failed',
      reason: `无法访问语音接口：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function synthesizeSpeech(
  text: string,
  tts: VoiceSettings['tts']
): Promise<SynthesisOutcome> {
  const spoken = text.trim();
  if (!spoken) return { kind: 'failed', reason: '没有可朗读的文本' };

  switch (tts.provider) {
    case 'web_speech':
      return {
        kind: 'system_voice',
        lang: tts.web_speech.lang,
        rate: tts.web_speech.rate,
        pitch: tts.web_speech.pitch,
        voice: tts.web_speech.voice,
      };
    case 'openai_compatible':
      return await synthesizeWithHttp(spoken, tts.http);
    case 'local_engine':
      return await synthesizeWithLocalEngine(spoken, tts.local);
    default:
      return { kind: 'failed', reason: '语音合成已关闭' };
  }
}

/**
 * Pull the recognised sentence out of an engine's output.
 *
 * Current sherpa-onnx releases print one JSON object per utterance on stdout; older ones
 * print `<file>: <text>`. Both are handled, and a line that matches neither is kept
 * verbatim rather than dropped, so an unrecognised format shows up as odd text in the
 * input box instead of a silent empty result.
 */
export function extractTranscript(stdout: string): string {
  const parts: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && 'text' in parsed) {
          const text = (parsed as { text: unknown }).text;
          if (typeof text === 'string' && text.trim()) parts.push(text.trim());
          continue;
        }
      } catch {
        // Not JSON after all; fall through to the textual forms.
      }
    }

    // Progress lines from the synthesiser and feature dumps are not speech.
    if (/^sample=\d+, progress=/.test(line)) continue;
    if (
      /^(num threads|decoding method|Elapsed seconds|Real time factor|Creating|recognizer created|Started|Done!)/.test(
        line
      )
    ) {
      continue;
    }
    if (line === '----') continue;

    const prefixed = /^(?:[A-Za-z]:)?[^:]*\.(?:wav|mp3|flac|ogg):\s*(.+)$/i.exec(line);
    parts.push(prefixed ? prefixed[1].trim() : line);
  }
  return parts.join(' ').trim();
}

async function transcribeWithLocalEngine(
  wav: Uint8Array<ArrayBuffer> | null,
  local: VoiceSettings['stt']['local']
): Promise<TranscriptionOutcome> {
  const directPath = local.input_path.trim();
  const values = {
    model_dir: local.model_dir,
    num_threads: local.num_threads,
  };
  const args = substituteArgTemplate(local.args, values);
  if (local.extra_args.length > 0) args.push(...local.extra_args);

  if (!directPath && !wav) {
    return { ok: false, text: '', reason: '没有可识别的音频' };
  }

  let result: EngineResult;
  try {
    result = await runExternalEngine({
      exe: local.exe,
      args: directPath ? args.map((arg) => arg.replaceAll('{input}', directPath)) : args,
      timeout_ms: local.timeout_ms,
      ...(directPath || !wav
        ? {}
        : { input_bytes_base64: bytesToBase64(wav), input_extension: 'wav' }),
    });
  } catch (error) {
    return {
      ok: false,
      text: '',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.timed_out || result.exit_code !== 0) {
    return { ok: false, text: '', reason: describeEngineFailure(result, '本地识别引擎') };
  }
  const text = extractTranscript(result.stdout);
  if (!text) {
    return {
      ok: false,
      text: '',
      reason: result.output_truncated
        ? '本地识别引擎的输出被截断，未取到完整文本'
        : '本地识别引擎没有返回文本，请确认模型与参数',
    };
  }
  return { ok: true, text, reason: '' };
}

async function transcribeWithHttp(
  wav: Uint8Array<ArrayBuffer> | null,
  http: VoiceSettings['stt']['http']
): Promise<TranscriptionOutcome> {
  if (!wav) {
    return { ok: false, text: '', reason: '没有可识别的音频' };
  }
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', http.model);
  if (http.language.trim()) form.append('language', http.language.trim());
  if (http.prompt.trim()) form.append('prompt', http.prompt.trim());

  const headers: Record<string, string> = {};
  if (http.api_key.trim()) headers.Authorization = `Bearer ${http.api_key.trim()}`;

  try {
    const response = await fetch(http.api_url.trim(), { method: 'POST', headers, body: form });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 180);
      return {
        ok: false,
        text: '',
        reason: `识别接口返回 ${response.status}${detail ? `：${detail}` : ''}`,
      };
    }
    const payload: unknown = await response.json().catch(() => null);
    const text =
      payload && typeof payload === 'object' && 'text' in payload
        ? String((payload as { text: unknown }).text ?? '').trim()
        : '';
    if (!text) {
      return { ok: false, text: '', reason: '识别接口没有返回文本' };
    }
    return { ok: true, text, reason: '' };
  } catch (error) {
    return {
      ok: false,
      text: '',
      reason: `无法访问识别接口：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Transcribe captured audio. `wav` may be null only for the local engine, which can read a
 * file directly — the path is how the chain is exercised on a machine with no microphone.
 */
export async function transcribeAudio(
  wav: Uint8Array<ArrayBuffer> | null,
  stt: VoiceSettings['stt']
): Promise<TranscriptionOutcome> {
  switch (stt.provider) {
    case 'openai_compatible':
      return await transcribeWithHttp(wav, stt.http);
    case 'local_engine':
      return await transcribeWithLocalEngine(wav, stt.local);
    case 'web_speech':
      return {
        ok: false,
        text: '',
        reason: '系统识别由浏览器直接接管麦克风，不经过录音文件',
      };
    default:
      return { ok: false, text: '', reason: '语音识别已关闭' };
  }
}
