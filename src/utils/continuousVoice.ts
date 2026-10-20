import type { VoiceSettings } from '@/types/pet';
import {
  describeMicrophoneFailure,
  describeRecognitionFailure,
  hasMicrophoneSupport,
  recordWavFromMicrophone,
  type SpeechRecognitionLike,
} from '@/utils/audioCapture';
import { transcribeAudio } from '@/utils/voiceEngine';

/**
 * The pet listens.
 *
 * A provider says *how* a phrase is turned into text; this module says *that the pet
 * keeps listening*, which is a different decision and therefore a different setting. The
 * user turns it on in the companion panel and the pet answers whatever it hears, without
 * a button to press first.
 *
 * Two transports, one shape:
 *
 *  - `web_speech` hands the microphone to the browser's own recogniser, which keeps the
 *    session open on its own. Nothing is recorded here and nothing leaves the machine
 *    unless the browser's own implementation decides to send it somewhere.
 *  - `http` and `local_engine` record in the page and transcribe the recording, so the
 *    "session" is a loop: record a chunk, transcribe it, hand over whatever was said,
 *    record the next chunk. The chunk length is the latency of this path.
 *
 * Both paths report failure instead of throwing: a microphone that is busy or blocked is
 * something the user can fix, and the message has to say which.
 */

export interface ContinuousVoiceHandlers {
  /** A finished phrase, ready to be handed to the pet. */
  onText: (text: string) => void;
  /** Something worth telling the user about the session itself. */
  onStatus?: (message: string) => void;
  /** Live microphone level in 0..1, for a meter or for the pet's mouth. */
  onLevel?: (level: number) => void;
}

/**
 * Start listening and keep listening until the returned function is called.
 *
 * Never throws: an unusable configuration is reported through `onStatus` and the session
 * simply does not start.
 */
export function startContinuousVoice(
  stt: VoiceSettings['stt'],
  handlers: ContinuousVoiceHandlers
): () => void {
  if (!stt.enabled) {
    handlers.onStatus?.('捕捉麦克风未开启');
    return () => {};
  }

  if (stt.provider === 'none') {
    handlers.onStatus?.('语音识别已关闭：请先在语音桥里选一种识别方式');
    return () => {};
  }

  if (stt.provider === 'web_speech') {
    return listenWithWebSpeech(stt.web_speech, handlers);
  }

  return startRecordedLoop(stt, handlers);
}

/**
 * Keep the browser's own recogniser running and report every finished phrase.
 *
 * The one-shot listener in `audioCapture` resolves once and is done. A pet that answers
 * whatever it hears needs the opposite: a session that survives the browser ending it.
 * Chromium stops a continuous recogniser after a pause, so the session is restarted when
 * that happens — the restart is what turns "one utterance" into "always listening".
 *
 * A failure the browser reports as ordinary (no speech heard, the session aborted) ends
 * the session too, and the restart picks it up. A failure that means the recogniser
 * cannot run at all — permission refused, service blocked, no network — is reported and
 * ends the session for good, because retrying it would only produce the same error.
 */
function listenWithWebSpeech(
  config: VoiceSettings['stt']['web_speech'],
  handlers: ContinuousVoiceHandlers
): () => void {
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
  if (!Ctor) {
    handlers.onStatus?.('当前运行环境没有 Web Speech 识别接口');
    return () => {};
  }

  let stopped = false;
  let recognition: SpeechRecognitionLike | null = null;

  const start = (): void => {
    if (stopped) return;
    const current = new Ctor();
    recognition = current;
    current.lang = config.lang;
    current.continuous = true;
    current.interimResults = false;

    current.onresult = (event) => {
      let finalText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
      }
      const text = finalText.trim();
      if (text) handlers.onText(text);
    };

    current.onerror = (event) => {
      // An empty description means the browser considers this an ordinary ending.
      const message = describeRecognitionFailure(event.error);
      if (!message) return;
      stopped = true;
      handlers.onStatus?.(message);
    };

    current.onend = () => {
      if (stopped) return;
      window.setTimeout(start, 250);
    };

    try {
      current.start();
    } catch (error) {
      stopped = true;
      handlers.onStatus?.(error instanceof Error ? error.message : String(error));
    }
  };

  start();

  return () => {
    stopped = true;
    try {
      recognition?.stop();
    } catch {
      // Already stopped.
    }
    recognition = null;
  };
}

/**
 * Record, transcribe, repeat.
 *
 * The chunk length comes from the same `max_ms` the one-shot path uses, so the two
 * recognisers agree on how long a phrase may be.
 */
function startRecordedLoop(
  stt: VoiceSettings['stt'],
  handlers: ContinuousVoiceHandlers
): () => void {
  if (!hasMicrophoneSupport()) {
    handlers.onStatus?.(describeMicrophoneFailure(new Error('mediaDevices')));
    return () => {};
  }

  let stopped = false;
  const abort = new AbortController();

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let recorded: { bytes: Uint8Array<ArrayBuffer> };
      try {
        const result = await recordWavFromMicrophone({
          maxMs: stt.web_speech.max_ms,
          signal: abort.signal,
          onLevel: handlers.onLevel,
        });
        recorded = result;
      } catch (error) {
        if (!stopped) {
          handlers.onStatus?.(
            error instanceof Error ? error.message : describeMicrophoneFailure(error)
          );
        }
        return;
      }
      if (stopped) return;

      const outcome = await transcribeAudio(recorded.bytes, stt);
      if (stopped) return;
      if (outcome.ok) {
        const text = outcome.text.trim();
        if (text) handlers.onText(text);
      } else {
        handlers.onStatus?.(outcome.reason);
        return;
      }
    }
  };

  void loop();

  return () => {
    stopped = true;
    abort.abort();
  };
}
