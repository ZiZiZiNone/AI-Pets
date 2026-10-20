import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  normalizeVoiceSettings,
  parseHostSettingsYaml,
  serializeHostSettingsYaml,
} from '@/utils/yamlLoader';
import {
  base64ToBytes,
  bytesToBase64,
  describeEngineFailure,
  substituteArgTemplate,
  type EngineResult,
} from '@/utils/engineBridge';
import {
  describeSttReadiness,
  describeTtsReadiness,
  listSttProviders,
  listTtsProviders,
} from '@/utils/voiceProviders';
import {
  describeMicrophoneFailure,
  encodeWavFromFloat32,
  resampleForSpeech,
  SPEECH_SAMPLE_RATE,
} from '@/utils/audioCapture';
import {
  buildLocalEngineInvocation,
  extractTranscript,
  localEngineArgValues,
  synthesizeSpeech,
  transcribeAudio,
} from '@/utils/voiceEngine';

/** A completed run with no output, for the failure-message tests. */
const engineResult = (over: Partial<EngineResult> = {}): EngineResult => ({
  exit_code: 0,
  stdout: '',
  stderr: '',
  timed_out: false,
  output_truncated: false,
  output_base64: null,
  output_mime: null,
  ...over,
});

describe('voice settings defaults and merging', () => {
  it('ships a usable default: system voice out of the box, microphone closed', () => {
    const settings = parseHostSettingsYaml('');
    expect(settings.audio.tts.provider).toBe('web_speech');
    // The recogniser is the system's own, so it needs no key and no download — but the
    // microphone stays closed, so starting the app never prompts for it.
    expect(settings.audio.stt.provider).toBe('web_speech');
    expect(settings.audio.stt.enabled).toBe(false);
    expect(settings.audio.tts.local.args.length).toBeGreaterThan(0);
  });

  it('keeps the argv template when a config only names the executable', () => {
    // The bug this guards: a shallow spread replaces the whole `local` block, so a user
    // who sets `exe` loses the arguments the engine needs and gets an opaque failure.
    const settings = parseHostSettingsYaml(
      [
        'audio:',
        '  tts:',
        '    provider: local_engine',
        '    local:',
        '      exe: E:\\sherpa\\tts.exe',
        '      model_dir: E:\\sherpa\\model',
      ].join('\n')
    );
    expect(settings.audio.tts.provider).toBe('local_engine');
    expect(settings.audio.tts.local.exe).toBe('E:\\sherpa\\tts.exe');
    expect(settings.audio.tts.local.model_dir).toBe('E:\\sherpa\\model');
    expect(settings.audio.tts.local.args).toEqual(DEFAULT_VOICE_SETTINGS.tts.local.args);
    expect(settings.audio.tts.local.num_threads).toBe(2);
  });

  it('keeps the recognition settings when only the synthesiser is configured', () => {
    const settings = parseHostSettingsYaml(
      ['audio:', '  tts:', '    provider: local_engine'].join('\n')
    );
    expect(settings.audio.tts.provider).toBe('local_engine');
    expect(settings.audio.stt).toEqual(DEFAULT_VOICE_SETTINGS.stt);
  });

  it('honours an explicitly emptied argument template instead of restoring the default', () => {
    const settings = parseHostSettingsYaml(
      ['audio:', '  tts:', '    local:', '      args: []'].join('\n')
    );
    expect(settings.audio.tts.local.args).toEqual([]);
  });

  it('falls back to the base provider for an unknown or misspelled id', () => {
    const settings = parseHostSettingsYaml(
      ['audio:', '  tts:', '    provider: sherpa'].join('\n')
    );
    expect(settings.audio.tts.provider).toBe('web_speech');
  });

  it('lets a pet override one field without losing the host settings', () => {
    const resolved = normalizeVoiceSettings(
      { tts: { local: { exe: 'E:\\pet-voice.exe' } } },
      DEFAULT_VOICE_SETTINGS
    );
    expect(resolved.tts.local.exe).toBe('E:\\pet-voice.exe');
    expect(resolved.tts.local.args).toEqual(DEFAULT_VOICE_SETTINGS.tts.local.args);
    expect(resolved.tts.provider).toBe(DEFAULT_VOICE_SETTINGS.tts.provider);
    expect(resolved.stt).toEqual(DEFAULT_VOICE_SETTINGS.stt);
  });

  it('resolves a pet patch against the host settings rather than the shipped defaults', () => {
    const host = normalizeVoiceSettings(
      { tts: { provider: 'local_engine', local: { model_dir: 'E:\\host-model' } } },
      DEFAULT_VOICE_SETTINGS
    );
    const pet = normalizeVoiceSettings({ tts: { local: { speed: 0.9 } } }, host);
    expect(pet.tts.provider).toBe('local_engine');
    expect(pet.tts.local.model_dir).toBe('E:\\host-model');
    expect(pet.tts.local.speed).toBe(0.9);
  });

  it('written settings still parse back to the same voice configuration', () => {
    const written = serializeHostSettingsYaml(DEFAULT_HOST_SETTINGS);
    expect(written).toContain('docs/使用说明书.md');
    const reread = parseHostSettingsYaml(written);
    expect(reread.audio).toEqual(DEFAULT_HOST_SETTINGS.audio);
  });
});

describe('shipped local-engine templates', () => {
  // The Rust runner refuses a capture request whose argv has no `{output}`, and an engine
  // invoked without `{input}` would read the microphone's temp file path from nowhere.
  // These are contracts between two languages, so they are asserted rather than assumed.
  it('the synthesis template fills the text, the model directory and the output file', () => {
    const args = DEFAULT_VOICE_SETTINGS.tts.local.args;
    expect(args.some((arg) => arg.includes('{text}'))).toBe(true);
    expect(args.some((arg) => arg.includes('{model_dir}'))).toBe(true);
    expect(args.some((arg) => arg.includes('{output}'))).toBe(true);
    expect(args.some((arg) => arg.includes('{input}'))).toBe(false);
  });

  it('the recognition template points at the recorded file', () => {
    const args = DEFAULT_VOICE_SETTINGS.stt.local.args;
    expect(args.some((arg) => arg.includes('{input}'))).toBe(true);
    expect(args.some((arg) => arg.includes('{model_dir}'))).toBe(true);
  });

  it('keeps a wildcard next to a path separator so the runner can resolve it', () => {
    for (const args of [
      DEFAULT_VOICE_SETTINGS.tts.local.args,
      DEFAULT_VOICE_SETTINGS.stt.local.args,
    ]) {
      const patterned = args.filter((arg) => arg.includes('*'));
      expect(patterned.length).toBeGreaterThan(0);
      for (const arg of patterned) {
        // The runner only treats an argument as a glob when it also looks like a path;
        // a star without a separator is left alone, which is how a spoken `*` survives.
        expect(arg.includes('/') || arg.includes('\\')).toBe(true);
      }
    }
  });
});

describe('argument templates', () => {
  it('fills what it knows and leaves the runner-owned placeholders alone', () => {
    const args = substituteArgTemplate(
      ['--model={model_dir}/*.onnx', '--out={output}', '{text}'],
      { model_dir: 'E:\\m', text: '你好' }
    );
    expect(args[0]).toBe('--model=E:\\m/*.onnx');
    expect(args[1]).toBe('--out={output}');
    expect(args[2]).toBe('你好');
  });

  it('appends extra arguments after the template so a flag cannot be swallowed', () => {
    const invocation = buildLocalEngineInvocation(
      { ...DEFAULT_VOICE_SETTINGS.tts.local, exe: 'e.exe', extra_args: ['--sid=3'] },
      '你好'
    );
    expect(invocation.args[invocation.args.length - 1]).toBe('--sid=3');
    expect(invocation.stdin).toBeUndefined();
  });

  it('pipes the text to stdin when the template has no place to put it', () => {
    const invocation = buildLocalEngineInvocation(
      { ...DEFAULT_VOICE_SETTINGS.tts.local, args: ['--speak', '--out={output}'] },
      '你好'
    );
    expect(invocation.args).toEqual(['--speak', '--out={output}']);
    expect(invocation.stdin).toBe('你好');
  });

  it('offers the length scale a VITS engine wants without dividing by zero', () => {
    const normal = localEngineArgValues(
      { ...DEFAULT_VOICE_SETTINGS.tts.local, speed: 2 },
      'x'
    );
    expect(normal.speed).toBe(2);
    expect(normal.length_scale).toBe(0.5);
    const degenerate = localEngineArgValues(
      { ...DEFAULT_VOICE_SETTINGS.tts.local, speed: 0 },
      'x'
    );
    expect(degenerate.length_scale).toBe(1);
  });
});

describe('transcript extraction', () => {
  it('reads the JSON line current sherpa-onnx releases print', () => {
    // Captured verbatim from `sherpa-onnx-offline --paraformer=… model.int8.onnx recording.wav`.
    const stdout =
      '{"lang": "", "emotion": "", "event": "", "text": "你好我是你的桌面宠物很高兴见到你", ' +
      '"timestamps": [], "durations": [], "tokens":["你", "好"], "ys_log_probs": [], "words": []}';
    expect(extractTranscript(stdout)).toBe('你好我是你的桌面宠物很高兴见到你');
  });

  it('reads the older "<file>: <text>" form', () => {
    expect(extractTranscript('E:\\audio\\rec.wav: 今天天气不错')).toBe('今天天气不错');
    expect(extractTranscript('rec.wav: 今天天气不错')).toBe('今天天气不错');
  });

  it('drops synthesiser progress and recogniser banner lines', () => {
    const stdout = [
      'sample=12168, progress=0.250000',
      'Creating recognizer ...',
      'recognizer created in 1.615 s',
      'Started',
      'Done!',
      '----',
      'num threads: 2',
      'decoding method: greedy_search',
      'Elapsed seconds: 0.078 s',
      'Real time factor (RTF): 0.016',
      '{"lang": "", "text": "识别结果", "tokens": []}',
    ].join('\n');
    expect(extractTranscript(stdout)).toBe('识别结果');
  });

  it('keeps an unrecognised line rather than silently returning nothing', () => {
    expect(extractTranscript('some new engine format')).toBe('some new engine format');
  });

  it('returns an empty string for empty output', () => {
    expect(extractTranscript('')).toBe('');
    expect(extractTranscript('\n\n  \n')).toBe('');
  });
});

describe('engine bridge payloads', () => {
  it('round-trips arbitrary bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 66]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('round-trips a payload larger than one encoding chunk', () => {
    const bytes = new Uint8Array(70_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const restored = base64ToBytes(bytesToBase64(bytes));
    expect(restored.length).toBe(bytes.length);
    expect(restored[69_999]).toBe(bytes[69_999]);
  });

  it('names the engine and the last stderr line when a run fails', () => {
    const message = describeEngineFailure(
      engineResult({ exit_code: -1, stderr: 'line one\nUnknown option: --nope' }),
      '本地语音引擎'
    );
    expect(message).toContain('本地语音引擎');
    expect(message).toContain('-1');
    expect(message).toContain('Unknown option: --nope');
  });

  it('reports a timeout as a timeout, not as an exit code', () => {
    const message = describeEngineFailure(
      engineResult({ exit_code: null, timed_out: true }),
      '本地语音引擎'
    );
    expect(message).toContain('超时');
  });
});

describe('provider readiness explains what is missing', () => {
  it('lists every transport in both directions, including the off switch', () => {
    const ids = listTtsProviders().map((entry) => entry.id);
    expect(ids).toContain('none');
    expect(ids).toContain('local_engine');
    expect(listSttProviders().map((entry) => entry.id)).toContain('none');
  });

  it('names the missing executable rather than answering false', () => {
    const readiness = describeTtsReadiness({
      ...DEFAULT_VOICE_SETTINGS.tts,
      provider: 'local_engine',
      local: { ...DEFAULT_VOICE_SETTINGS.tts.local, exe: '' },
    });
    expect(readiness.usable).toBe(false);
    expect(readiness.reason).toContain('可执行文件');
  });

  it('accepts a completely configured local engine', () => {
    const readiness = describeSttReadiness({
      ...DEFAULT_VOICE_SETTINGS.stt,
      provider: 'local_engine',
      local: { ...DEFAULT_VOICE_SETTINGS.stt.local, exe: 'E:\\asr.exe' },
    });
    expect(readiness).toEqual({ usable: true, reason: '' });
  });

  it('explains the missing endpoint when an http provider has no url', () => {
    const readiness = describeTtsReadiness({
      ...DEFAULT_VOICE_SETTINGS.tts,
      provider: 'openai_compatible',
      http: { ...DEFAULT_VOICE_SETTINGS.tts.http, api_url: '  ' },
    });
    expect(readiness.usable).toBe(false);
    expect(readiness.reason).toContain('接口地址');
  });

  it('says the capability is switched off rather than that it is broken', () => {
    expect(describeTtsReadiness({ ...DEFAULT_VOICE_SETTINGS.tts, provider: 'none' }).reason)
      .toContain('关闭');
    expect(describeSttReadiness({ ...DEFAULT_VOICE_SETTINGS.stt, provider: 'none' }).reason)
      .toContain('关闭');
  });
});

describe('synthesis and recognition dispatch', () => {
  it('refuses to synthesise when the capability is off', async () => {
    const outcome = await synthesizeSpeech('你好', { ...DEFAULT_VOICE_SETTINGS.tts, provider: 'none' });
    expect(outcome.kind).toBe('failed');
  });

  it('treats blank text as nothing to do', async () => {
    const outcome = await synthesizeSpeech('   ', DEFAULT_VOICE_SETTINGS.tts);
    expect(outcome.kind).toBe('failed');
  });

  it('hands system-voice parameters to the caller instead of the network', async () => {
    const outcome = await synthesizeSpeech('你好', {
      ...DEFAULT_VOICE_SETTINGS.tts,
      provider: 'web_speech',
      web_speech: { lang: 'zh-TW', rate: 0.9, pitch: 1.2, voice: 'Xiaoxiao' },
    });
    expect(outcome).toEqual({
      kind: 'system_voice',
      lang: 'zh-TW',
      rate: 0.9,
      pitch: 1.2,
      voice: 'Xiaoxiao',
    });
  });

  it('refuses recognition when it is off, with a reason', async () => {
    const outcome = await transcribeAudio(null, { ...DEFAULT_VOICE_SETTINGS.stt, provider: 'none' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('关闭');
  });

  it('explains that system recognition does not take a recorded file', async () => {
    const outcome = await transcribeAudio(new Uint8Array(8), {
      ...DEFAULT_VOICE_SETTINGS.stt,
      provider: 'web_speech',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('麦克风');
  });
});

describe('recording helpers', () => {
  it('writes a 16-bit mono wav header the engines can read', () => {
    const wav = encodeWavFromFloat32(new Float32Array(800), SPEECH_SAMPLE_RATE);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(...wav.subarray(offset, offset + length));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SPEECH_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(800 * 2);
    expect(wav.length).toBe(44 + 800 * 2);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
  });

  it('clamps samples instead of wrapping them into noise', () => {
    const wav = encodeWavFromFloat32(new Float32Array([1, -1, 2, -2, 0]), 16_000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(view.getInt16(50, true)).toBe(-32767);
    expect(view.getInt16(52, true)).toBe(0);
  });

  it('averages when downsampling, so a constant signal stays constant', () => {
    const input = new Float32Array(4800).fill(0.5);
    const output = resampleForSpeech(input, 48_000);
    expect(output.length).toBe(1600);
    expect(Array.from(output.slice(0, 5))).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it('passes a signal that is already at the target rate straight through', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resampleForSpeech(input, SPEECH_SAMPLE_RATE)).toBe(input);
  });

  it('maps each microphone failure name to a distinct, actionable message', () => {
    // The test runtime has no microphone API at all, which is exactly the trap: reporting
    // "this environment cannot record" for every error would hide the real cause.
    const denied = describeMicrophoneFailure({ name: 'NotAllowedError', message: 'denied' });
    const missing = describeMicrophoneFailure({ name: 'NotFoundError', message: 'none' });
    const busy = describeMicrophoneFailure({ name: 'NotReadableError', message: 'busy' });
    expect(denied).toContain('权限');
    expect(denied).toContain('麦克风');
    expect(missing).toContain('没有检测到');
    expect(busy).toContain('占用');
    expect(new Set([denied, missing, busy]).size).toBe(3);
  });

  it('still produces a message for an error with no name at all', () => {
    expect(describeMicrophoneFailure(new Error('boom')).length).toBeGreaterThan(0);
    expect(describeMicrophoneFailure(null).length).toBeGreaterThan(0);
  });
});
