import type { VoiceProviderId, VoiceSettings } from '@/types/pet';

/**
 * What each voice transport is, and whether the current configuration can use it.
 *
 * Readiness is reported as an explanation rather than a boolean because every unusable
 * state has a different fix — a missing key, an unset executable, a system without the
 * browser API — and a silent `false` would leave the user guessing which one applies.
 */

interface VoiceProviderInfo {
  id: VoiceProviderId;
  label: string;
  /** One line for the settings UI: what this choice actually talks to. */
  hint: string;
}

const TTS_PROVIDERS: readonly VoiceProviderInfo[] = [
  {
    id: 'web_speech',
    label: '系统语音（Web Speech，零配置）',
    hint: '用操作系统已安装的语音朗读，无需 Key 与下载。',
  },
  {
    id: 'openai_compatible',
    label: '云端/自建语音接口（OpenAI 兼容）',
    hint: '调用 /v1/audio/speech，支持 OpenAI、SiliconFlow、本地 TTS 服务器等。',
  },
  {
    id: 'local_engine',
    label: '本地命令行引擎（sherpa-onnx / piper / …）',
    hint: '完全离线，不联网；需填写引擎可执行文件与模型目录。',
  },
  {
    id: 'none',
    label: '关闭语音合成',
    hint: '只显示气泡文字，不再朗读。',
  },
];

const STT_PROVIDERS: readonly VoiceProviderInfo[] = [
  {
    id: 'none',
    label: '关闭语音识别',
    hint: '不录音；聊天仍可用键盘输入。',
  },
  {
    id: 'openai_compatible',
    label: '云端/自建识别接口（OpenAI 兼容）',
    hint: '调用 /v1/audio/transcriptions，支持 OpenAI、Groq、本地 whisper 服务器等。',
  },
  {
    id: 'local_engine',
    label: '本地命令行引擎（sherpa-onnx / whisper.cpp / …）',
    hint: '完全离线；录音会写成一个临时 wav 交给引擎。',
  },
  {
    id: 'web_speech',
    label: '系统识别（Web Speech，需联网）',
    hint: '用系统自带的识别服务，多数实现会把音频发往厂商云端。',
  },
];

interface VoiceReadiness {
  usable: boolean;
  /** Empty when usable; otherwise what is missing and what to do about it. */
  reason: string;
}

export function listTtsProviders(): readonly VoiceProviderInfo[] {
  return TTS_PROVIDERS;
}

export function listSttProviders(): readonly VoiceProviderInfo[] {
  return STT_PROVIDERS;
}

export function ttsProviderInfo(id: VoiceProviderId): VoiceProviderInfo {
  return TTS_PROVIDERS.find((entry) => entry.id === id) ?? TTS_PROVIDERS[0];
}

export function sttProviderInfo(id: VoiceProviderId): VoiceProviderInfo {
  return STT_PROVIDERS.find((entry) => entry.id === id) ?? STT_PROVIDERS[0];
}

/** True when the browser exposes the synthesis API this provider needs. */
function hasWebSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Names differ per engine and the standard is still prefixed in every shipping browser,
 * so both spellings have to be checked before concluding the API is absent.
 */
function hasWebSpeechRecognition(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof w.SpeechRecognition === 'function' || typeof w.webkitSpeechRecognition === 'function';
}

function localEngineReadiness(
  exe: string,
  args: readonly string[],
  capability: string
): VoiceReadiness {
  if (!exe.trim()) {
    return { usable: false, reason: `未填写本地引擎可执行文件，无法${capability}` };
  }
  if (args.length === 0) {
    return { usable: false, reason: '本地引擎的参数模板为空，请恢复默认或填写完整参数' };
  }
  return { usable: true, reason: '' };
}

function httpReadiness(apiUrl: string, capability: string): VoiceReadiness {
  if (!apiUrl.trim()) {
    return { usable: false, reason: `未填写接口地址，无法${capability}` };
  }
  return { usable: true, reason: '' };
}

export function describeTtsReadiness(tts: VoiceSettings['tts']): VoiceReadiness {
  switch (tts.provider) {
    case 'none':
      return { usable: false, reason: '语音合成已关闭' };
    case 'web_speech':
      return hasWebSpeechSynthesis()
        ? { usable: true, reason: '' }
        : { usable: false, reason: '当前运行环境没有 Web Speech 合成接口，请改用接口或本地引擎' };
    case 'openai_compatible':
      return httpReadiness(tts.http.api_url, '朗读');
    case 'local_engine':
      return localEngineReadiness(tts.local.exe, tts.local.args, '朗读');
    default:
      return { usable: false, reason: '未知的语音合成方式' };
  }
}

export function describeSttReadiness(stt: VoiceSettings['stt']): VoiceReadiness {
  switch (stt.provider) {
    case 'none':
      return { usable: false, reason: '语音识别已关闭' };
    case 'web_speech':
      return hasWebSpeechRecognition()
        ? { usable: true, reason: '' }
        : { usable: false, reason: '当前运行环境没有 Web Speech 识别接口，请改用接口或本地引擎' };
    case 'openai_compatible':
      return httpReadiness(stt.http.api_url, '识别');
    case 'local_engine':
      return localEngineReadiness(stt.local.exe, stt.local.args, '识别');
    default:
      return { usable: false, reason: '未知的语音识别方式' };
  }
}
