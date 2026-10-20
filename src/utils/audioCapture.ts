import type { WebSpeechSttConfig } from '@/types/pet';

/**
 * Microphone capture and conversion to the one format local engines accept.
 *
 * Recording goes through `MediaRecorder` and is then decoded and re-encoded rather than
 * captured as raw samples, because the alternative — a `ScriptProcessorNode` — is
 * deprecated and an `AudioWorklet` needs a separate module file for no gain here. The
 * output is always 16 kHz mono 16-bit PCM: that is what sherpa-onnx's feature extractor
 * and every hosted transcription endpoint expect, and converting once here means no
 * downstream caller has to know about sample rates.
 */

export const SPEECH_SAMPLE_RATE = 16_000;

interface RecordingResult {
  /** Backed by a plain `ArrayBuffer` so it can go straight into a `Blob` or FormData. */
  bytes: Uint8Array<ArrayBuffer>;
  durationMs: number;
  sampleRate: number;
}

interface RecordOptions {
  /** Upper bound on one utterance, counted from the moment recording starts. */
  maxMs: number;
  /** Called with an RMS level in 0..1 while recording, for a live meter. */
  onLevel?: (level: number) => void;
  /** Resolves early and discards the recording when aborted. */
  signal?: AbortSignal;
}

/** True when this runtime can record at all; checked before prompting for permission. */
export function hasMicrophoneSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

/**
 * Turn a `getUserMedia` rejection into something the user can act on.
 *
 * The names are not obvious — `NotAllowedError` covers both "you clicked deny" and "a
 * policy blocked it", and Chrome reports a busy device as `NotReadableError` — so the
 * message names the likely cause and where to change it rather than echoing the code.
 *
 * A recognised name is checked before the environment: reporting "this runtime cannot
 * record" for a denial would hide the one thing the user can actually fix.
 */
export function describeMicrophoneFailure(error: unknown): string {
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error ?? '');
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return '麦克风权限被拒绝：系统设置 → 隐私和安全性 → 麦克风，允许桌面应用访问后再试';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有检测到可用的麦克风设备';
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风已被其他程序占用，请关闭占用程序后重试';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return '麦克风不支持所要求的录音参数';
    case 'AbortError':
      return '录音被中断';
    default:
      break;
  }
  if (!hasMicrophoneSupport()) {
    return '当前运行环境不支持录音（缺少麦克风接口），请改用键盘输入或云端识别';
  }
  return `录音失败：${message || '未知原因'}`;
}

/**
 * Downsample by averaging each output sample's source window.
 *
 * The box filter is what keeps the result usable: picking every n-th sample would fold
 * everything above 8 kHz back into the speech band as aliasing, and feature extraction is
 * sensitive to that noise. When the rate already matches, the input is returned as is.
 */
export function resampleForSpeech(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SPEECH_SAMPLE_RATE || fromRate <= 0) return input;
  const ratio = fromRate / SPEECH_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  if (ratio < 1) {
    // Upsampling: linear interpolation between neighbours.
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      output[index] = input[left] * (1 - fraction) + input[right] * fraction;
    }
    return output;
  }

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      sum += input[cursor];
      count += 1;
    }
    output[index] = count > 0 ? sum / count : input[Math.min(start, input.length - 1)] ?? 0;
  }
  return output;
}

/** Encode mono float samples as a 16-bit PCM wav. */
export function encodeWavFromFloat32(
  samples: Float32Array,
  sampleRate: number
): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * bytesPerSample, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}

/** Decode any container the recorder produced into mono 16 kHz samples. */
async function decodeToSpeechSamples(
  encoded: Blob
): Promise<{ samples: Float32Array; durationMs: number }> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('当前环境缺少音频解码能力');
  const context = new Ctor();
  try {
    const decoded = await context.decodeAudioData(await encoded.arrayBuffer());
    const samples = resampleForSpeech(decoded.getChannelData(0), decoded.sampleRate);
    return {
      samples,
      durationMs: (decoded.length / decoded.sampleRate) * 1000,
    };
  } finally {
    void context.close();
  }
}

/**
 * Record one utterance and return it as a 16 kHz wav.
 *
 * Resolves as soon as the recorder stops, including when the caller aborted or the
 * cap was reached, so a long silence cannot leave the UI waiting.
 */
export async function recordWavFromMicrophone(options: RecordOptions): Promise<RecordingResult> {
  if (!hasMicrophoneSupport()) {
    throw new Error(describeMicrophoneFailure(new Error('mediaDevices unavailable')));
  }
  if (options.signal?.aborted) throw new Error('录音被中断');

  let stream: MediaStream;
  try {
    // A mono, processed stream: beam-forming and noise suppression measurably help a
    // single distant speaker, which is the usual case for a desktop pet.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    throw new Error(describeMicrophoneFailure(error));
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  const mimeType = recorder.mimeType || 'audio/webm';

  return await new Promise<RecordingResult>((resolve, reject) => {
    let timer: number | null = null;
    let levelTimer: number | null = null;
    let audioContext: AudioContext | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      if (levelTimer !== null) window.clearInterval(levelTimer);
      if (audioContext) void audioContext.close();
      stream.getTracks().forEach((track) => track.stop());
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };

    const finish = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size === 0) {
          reject(new Error('没有录到声音，请确认麦克风输入设备'));
          return;
        }
        const { samples, durationMs } = await decodeToSpeechSamples(blob);
        resolve({
          bytes: encodeWavFromFloat32(samples, SPEECH_SAMPLE_RATE),
          durationMs,
          sampleRate: SPEECH_SAMPLE_RATE,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    function onAbort(): void {
      if (recorder.state !== 'inactive') recorder.stop();
      else void finish();
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      settled = true;
      cleanup();
      reject(new Error('录音过程中出错，请重试'));
    };
    recorder.onstop = () => {
      void finish();
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.onLevel) {
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        audioContext = new Ctor();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const bins = new Uint8Array(analyser.frequencyBinCount);
        levelTimer = window.setInterval(() => {
          analyser.getByteTimeDomainData(bins);
          let sum = 0;
          for (const value of bins) {
            const centred = (value - 128) / 128;
            sum += centred * centred;
          }
          options.onLevel?.(Math.min(1, Math.sqrt(sum / bins.length) * 4));
        }, 80);
      } catch {
        // A level meter is a nicety; losing it must not lose the recording.
        audioContext = null;
      }
    }

    recorder.start();
    timer = window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, Math.max(1000, options.maxMs));
  });
}

/**
 * Recognise one utterance with the browser's own speech service.
 *
 * Resolves with an empty string rather than throwing when nothing was heard, because "the
 * user said nothing" is a normal outcome and not an error to report.
 */
export async function listenWithWebSpeechRecognition(
  config: WebSpeechSttConfig
): Promise<string> {
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
  if (!Ctor) {
    throw new Error('当前运行环境没有 Web Speech 识别接口');
  }

  const recognition = new Ctor();
  recognition.lang = config.lang;
  recognition.continuous = false;
  recognition.interimResults = config.interim;

  return await new Promise<string>((resolve, reject) => {
    let transcript = '';
    let settled = false;

    const timer = window.setTimeout(() => {
      try {
        recognition.stop();
      } catch {
        // Already stopped.
      }
    }, Math.max(1000, config.max_ms));

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      action();
    };

    recognition.onresult = (event) => {
      let finalText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
      }
      if (finalText) transcript = (transcript + finalText).trim();
    };
    recognition.onerror = (event) => {
      settle(() => reject(new Error(describeRecognitionFailure(event.error))));
    };
    recognition.onend = () => {
      settle(() => resolve(transcript));
    };

    try {
      recognition.start();
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

/**
 * Name a recognition failure in words.
 *
 * Two of the codes are ordinary rather than failures — the browser ran out of speech and
 * the session was aborted — and they are reported as an empty message, so a caller can
 * tell "nothing happened" apart from "something went wrong".
 */
export function describeRecognitionFailure(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '系统识别被拒绝或被策略禁用，可改用本地引擎或接口识别';
    case 'no-speech':
      return '';
    case 'audio-capture':
      return '没有可用的麦克风输入';
    case 'network':
      return '系统识别需要联网，当前网络不可用';
    case 'aborted':
      return '';
    default:
      return `系统识别失败：${code}`;
  }
}
