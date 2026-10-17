import yaml from 'js-yaml';
import type {
  AdapterType,
  GlobalMenuConfig,
  HostSettings,
  LocalEngineConfig,
  MenuItemSchema,
  PetManifest,
  PetVoiceDef,
  VoiceProviderId,
  VoiceSettings,
} from '@/types/pet';

const BUILTIN_PET_IDS = [
  'aether_mecha_core',
  'nyx_abyssal_familiar',
  'pulse_glitch_phantom',
  'demo_sprite_pet',
] as const;

/**
 * Default argv for the local engine, written against sherpa-onnx's non-streaming TTS.
 *
 * Every entry here was taken from the engine's own argument registration and then run for
 * real (`sherpa-onnx-offline-tts.cc`, v1.13.8), because a guessed flag fails at synthesis
 * time on the user's machine rather than at review time. The two placeholders the matcher
 * understands are `{model_dir}`, filled in below, and `{output}`, filled in by the Rust
 * runner with a temp path it reads back as audio.
 */
const DEFAULT_LOCAL_TTS_ARGS = [
  '--vits-model={model_dir}/*.onnx',
  '--vits-lexicon={model_dir}/lexicon.txt',
  '--vits-tokens={model_dir}/tokens.txt',
  '--tts-rule-fsts={model_dir}/phone.fst,{model_dir}/date.fst,{model_dir}/number.fst',
  '--num-threads={num_threads}',
  '--speed={speed}',
  '--output-filename={output}',
  '{text}',
];

/** Default argv for sherpa-onnx's non-streaming ASR, verified against the same release. */
const DEFAULT_LOCAL_STT_ARGS = [
  '--paraformer={model_dir}/*.onnx',
  '--tokens={model_dir}/tokens.txt',
  '--num-threads={num_threads}',
  '{input}',
];

const DEFAULT_LOCAL_ENGINE = {
  exe: '',
  model_dir: '',
  timeout_ms: 60_000,
  extra_args: [] as string[],
  speaker_id: 0,
  speed: 1.0,
  num_threads: 2,
  input_path: '',
  output_extension: 'wav',
};

const DEFAULT_TTS_LOCAL: LocalEngineConfig = {
  ...DEFAULT_LOCAL_ENGINE,
  args: DEFAULT_LOCAL_TTS_ARGS,
};

const DEFAULT_STT_LOCAL: LocalEngineConfig = {
  ...DEFAULT_LOCAL_ENGINE,
  args: DEFAULT_LOCAL_STT_ARGS,
};

/**
 * Host-level voice defaults.
 *
 * `web_speech` is the default for TTS because it is the only provider that works with no
 * key, no download and no endpoint; the two alternatives are strictly opt-in.
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  tts: {
    provider: 'web_speech',
    web_speech: {
      lang: 'zh-CN',
      rate: 1.08,
      pitch: 1.05,
      voice: '',
    },
    http: {
      api_url: 'https://api.openai.com/v1/audio/speech',
      api_key: '',
      model: 'tts-1',
      voice: 'alloy',
      format: 'mp3',
      speed: 1.0,
    },
    local: DEFAULT_TTS_LOCAL,
  },
  stt: {
    provider: 'none',
    auto_send: false,
    web_speech: {
      lang: 'zh-CN',
      interim: false,
      max_ms: 15_000,
    },
    http: {
      api_url: 'https://api.openai.com/v1/audio/transcriptions',
      api_key: '',
      model: 'whisper-1',
      language: 'zh',
      prompt: '',
    },
    local: DEFAULT_STT_LOCAL,
  },
};

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  host: {
    ws_port_range: [9527, 9537],
    heartbeat_timeout_sec: 45,
    default_pet: 'aether_mecha_core',
  },
  render: {
    idle_fps: 24,
    active_fps: 60,
    idle_timeout_ms: 5000,
    high_dpi: true,
  },
  behavior: {
    enable_autonomous_fsm: true,
    enable_window_climbing: true,
    enable_fullscreen_edge_peek: true,
    wander_interval_sec: 25,
    sleep_after_idle_sec: 180,
    gravity_acceleration: 1400,
    enable_health_reminders: true,
    hydration_interval_min: 45,
    posture_interval_min: 60,
  },
  audio: {
    enable_lip_sync: true,
    rms_smoothing: 0.75,
    rms_gain: 3.2,
    enable_tts: false,
    ...structuredClone(DEFAULT_VOICE_SETTINGS),
  },
};

export const FALLBACK_PET_MANIFEST: PetManifest = {
  id: 'aether_mecha_core',
  name: 'AETHER-VII 战术浮游核心',
  version: '2.0.0',
  type: 'sprite',
  description: '搭载双轨陀螺仪星环、等离子追踪视觉与反重力浮游翼的战术机甲核心',
  model: {
    entry: 'idle.svg',
    scale: 1.0,
    offset: { x: 0, y: 0 },
    fps: 60,
    animations: {
      idle: { file: 'idle.svg', loop: true },
      happy: { file: 'idle.svg', loop: false, duration_ms: 2400 },
      pat: { file: 'idle.svg', loop: false, duration_ms: 1900 },
      feed: { file: 'idle.svg', loop: false, duration_ms: 2600 },
      drag: { file: 'idle.svg', loop: true },
      climb: { file: 'idle.svg', loop: true },
      sleep: { file: 'idle.svg', loop: true },
    },
  },
  expressions: {
    neutral: { tint: 0xffffff },
    smile: { tint: 0xa5f3fc },
    surprised: { tint: 0xfda4af },
    sleepy: { tint: 0x94a3b8 },
  },
  hit_areas: [
    {
      name: 'head',
      label: '头部传感器',
      rect: { x: 80, y: 28, w: 160, h: 118 },
      motion: 'pat',
      expression: 'smile',
      texts: ['光学传感器校准完毕，随时准备接管外部进程流。'],
    },
    {
      name: 'body',
      label: '核心反应堆',
      rect: { x: 84, y: 148, w: 152, h: 125 },
      motion: 'happy',
      expression: 'surprised',
      texts: ['核心反应堆运转正常！右键展开战术星盘下达指令。'],
    },
  ],
  drop_handlers: [],
  menus: [],
};

const THEME_COLOR_KEYS = [
  'id',
  'name',
  'primary',
  'accent',
  'glow',
  'surface',
  'border',
  'text',
  'subtext',
  'particleColor',
] as const;

/**
 * Pull the optional per-pet palette out of a manifest. Only the known keys are
 * taken and only when they arrive as strings, so a typo or a stray number in the
 * YAML degrades to "use the host palette" instead of painting the UI `undefined`.
 */
function parsePetThemeYaml(rawTheme: unknown): PetManifest['theme'] {
  if (!rawTheme || typeof rawTheme !== 'object' || Array.isArray(rawTheme)) return undefined;
  const source = rawTheme as Record<string, unknown>;
  const picked: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) picked[key] = value.trim();
  }
  return Object.keys(picked).length > 0 ? (picked as PetManifest['theme']) : undefined;
}

const PERSONA_LIST_KEYS = ['traits'] as const;

/**
 * Pull the optional personality block out of a manifest.
 *
 * Same defensive shape as the theme: only known keys, only strings, blank values
 * dropped. A malformed persona must never take the pet down — it just falls back to the
 * neutral host prompt.
 */
function parsePetPersonaYaml(rawPersona: unknown): PetManifest['persona'] {
  if (!rawPersona || typeof rawPersona !== 'object' || Array.isArray(rawPersona)) return undefined;
  const source = rawPersona as Record<string, unknown>;
  const picked: Record<string, unknown> = {};

  for (const key of ['identity', 'style_notes', 'system_prompt'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) picked[key] = value.trim();
  }
  for (const key of PERSONA_LIST_KEYS) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    const list = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    if (list.length > 0) picked[key] = list;
  }

  return Object.keys(picked).length > 0 ? (picked as PetManifest['persona']) : undefined;
}

export function parsePetManifestYaml(rawText: string, fallbackId = 'aether_mecha_core'): PetManifest {
  try {
    const raw = (yaml.load(rawText) || {}) as Record<string, unknown>;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId;
    const rawModel = (raw.model || {}) as Record<string, unknown>;
    const rawOffset = (rawModel.offset || {}) as Record<string, unknown>;
    const typeVal = (raw.type || raw.adapter || 'sprite') as AdapterType;
    const validTypes: AdapterType[] = ['sprite', 'live2d', 'spine', 'vrm'];

    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : FALLBACK_PET_MANIFEST.name,
      version: typeof raw.version === 'string' ? raw.version : '2.0.0',
      type: validTypes.includes(typeVal) ? typeVal : 'sprite',
      description: typeof raw.description === 'string' ? raw.description : '',
      persona: parsePetPersonaYaml(raw.persona),
      voice: normalizePetVoiceDef(raw.voice),
      model: {
        entry: typeof rawModel.entry === 'string' ? rawModel.entry : 'idle.svg',
        scale:
          typeof rawModel.scale === 'number' && !Number.isNaN(rawModel.scale)
            ? Math.min(5.0, Math.max(0.1, rawModel.scale))
            : 1.0,
        offset: {
          x: typeof rawOffset.x === 'number' ? rawOffset.x : 0,
          y: typeof rawOffset.y === 'number' ? rawOffset.y : 0,
        },
        fps: typeof rawModel.fps === 'number' ? rawModel.fps : 60,
        animations:
          (rawModel.animations as PetManifest['model']['animations']) ||
          FALLBACK_PET_MANIFEST.model.animations,
      },
      expressions:
        (raw.expressions as PetManifest['expressions']) || FALLBACK_PET_MANIFEST.expressions,
      theme: parsePetThemeYaml(raw.theme),
      // A pet that omits this key has none of its own. Inheriting another pet's areas
      // would answer clicks with the wrong labels and run the wrong actions.
      hit_areas: Array.isArray(raw.hit_areas)
        ? (raw.hit_areas as PetManifest['hit_areas'])
        : [],
      drop_handlers: Array.isArray(raw.drop_handlers)
        ? (raw.drop_handlers as PetManifest['drop_handlers'])
        : [],
      menus: Array.isArray(raw.menus) ? (raw.menus as PetManifest['menus']) : [],
    };
  } catch {
    return { ...structuredClone(FALLBACK_PET_MANIFEST), id: fallbackId };
  }
}

export function serializePetManifestYaml(manifest: PetManifest): string {
  const { basePath: _, ...cleanCopy } = manifest;
  return yaml.dump(cleanCopy, { indent: 2, lineWidth: 100, noRefs: true });
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : fallback;
}

const VOICE_PROVIDER_IDS: readonly VoiceProviderId[] = [
  'none',
  'web_speech',
  'openai_compatible',
  'local_engine',
];

/** Unknown or misspelled ids keep the base value instead of throwing; chat must not break. */
function pickProvider(value: unknown, fallback: VoiceProviderId): VoiceProviderId {
  return typeof value === 'string' && (VOICE_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as VoiceProviderId)
    : fallback;
}

function normalizeLocalEngine(raw: unknown, base: LocalEngineConfig): LocalEngineConfig {
  const record = asRecord(raw);
  return {
    exe: pickString(record.exe, base.exe),
    model_dir: pickString(record.model_dir, base.model_dir),
    // An explicit `args: []` is honoured: a template nobody can satisfy should fail
    // validation with a message, not silently reappear as the built-in one.
    args: pickStringArray(record.args, base.args),
    timeout_ms: pickNumber(record.timeout_ms, base.timeout_ms),
    extra_args: pickStringArray(record.extra_args, base.extra_args),
    speaker_id: pickNumber(record.speaker_id, base.speaker_id),
    speed: pickNumber(record.speed, base.speed),
    num_threads: pickNumber(record.num_threads, base.num_threads),
    input_path: pickString(record.input_path, base.input_path),
    output_extension: pickString(record.output_extension, base.output_extension),
  };
}

/**
 * Fill in every voice field, taking whatever `raw` leaves out from `base`.
 *
 * The same function serves two callers on purpose: reading `settings.yaml` (base = the
 * shipped defaults) and applying a pet's `voice:` block (base = the resolved host
 * settings, so a pet only has to state what it wants to be different). Leaving one of
 * them to a plain spread would have made `{ tts: { provider: 'local_engine' } }` erase
 * the argv template it depends on.
 */
export function normalizeVoiceSettings(
  raw: unknown,
  base: VoiceSettings = DEFAULT_VOICE_SETTINGS
): VoiceSettings {
  const root = asRecord(raw);
  const tts = asRecord(root.tts);
  const stt = asRecord(root.stt);
  const ttsWeb = asRecord(tts.web_speech);
  const ttsHttp = asRecord(tts.http);
  const sttWeb = asRecord(stt.web_speech);
  const sttHttp = asRecord(stt.http);

  return {
    tts: {
      provider: pickProvider(tts.provider, base.tts.provider),
      web_speech: {
        lang: pickString(ttsWeb.lang, base.tts.web_speech.lang),
        rate: pickNumber(ttsWeb.rate, base.tts.web_speech.rate),
        pitch: pickNumber(ttsWeb.pitch, base.tts.web_speech.pitch),
        voice: pickString(ttsWeb.voice, base.tts.web_speech.voice),
      },
      http: {
        api_url: pickString(ttsHttp.api_url, base.tts.http.api_url),
        api_key: pickString(ttsHttp.api_key, base.tts.http.api_key),
        model: pickString(ttsHttp.model, base.tts.http.model),
        voice: pickString(ttsHttp.voice, base.tts.http.voice),
        format: pickString(ttsHttp.format, base.tts.http.format),
        speed: pickNumber(ttsHttp.speed, base.tts.http.speed),
      },
      local: normalizeLocalEngine(tts.local, base.tts.local),
    },
    stt: {
      provider: pickProvider(stt.provider, base.stt.provider),
      auto_send: pickBoolean(stt.auto_send, base.stt.auto_send),
      web_speech: {
        lang: pickString(sttWeb.lang, base.stt.web_speech.lang),
        interim: pickBoolean(sttWeb.interim, base.stt.web_speech.interim),
        max_ms: pickNumber(sttWeb.max_ms, base.stt.web_speech.max_ms),
      },
      http: {
        api_url: pickString(sttHttp.api_url, base.stt.http.api_url),
        api_key: pickString(sttHttp.api_key, base.stt.http.api_key),
        model: pickString(sttHttp.model, base.stt.http.model),
        language: pickString(sttHttp.language, base.stt.http.language),
        prompt: pickString(sttHttp.prompt, base.stt.http.prompt),
      },
      local: normalizeLocalEngine(stt.local, base.stt.local),
    },
  };
}

/**
 * A pet's `voice:` block, kept partial.
 *
 * Deliberately not filled in here: the block is a patch resolved against the host settings
 * at synthesis time, and filling defaults now would freeze this pet to today's values. The
 * cast is safe because the consumer re-validates every field it reads.
 */
function normalizePetVoiceDef(raw: unknown): PetVoiceDef | undefined {
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) return undefined;
  return record as unknown as PetVoiceDef;
}

export function parseHostSettingsYaml(rawText: string): HostSettings {
  try {
    const raw = (yaml.load(rawText) || {}) as Partial<HostSettings>;
    return {
      host: { ...DEFAULT_HOST_SETTINGS.host, ...(raw.host || {}) },
      render: { ...DEFAULT_HOST_SETTINGS.render, ...(raw.render || {}) },
      behavior: { ...DEFAULT_HOST_SETTINGS.behavior, ...(raw.behavior || {}) },
      audio: {
        ...DEFAULT_HOST_SETTINGS.audio,
        ...(raw.audio || {}),
        ...normalizeVoiceSettings(raw.audio, DEFAULT_VOICE_SETTINGS),
      },
    };
  } catch {
    return structuredClone(DEFAULT_HOST_SETTINGS);
  }
}

/**
 * Header kept at the top of every written `settings.yaml`.
 *
 * The UI round-trips this file through `yaml.dump`, which drops the explanatory comments
 * the repository version carries. Without a pointer, a user who edits one field in the
 * interface is left with a file of bare keys and no way back to the documentation.
 */
const SETTINGS_HEADER = [
  '# AI-Pets 宿主设置',
  '# 本文件由界面改写，详细字段说明见 docs/使用说明书.md「语音与模型接入」一节。',
  '',
].join('\n');

export function serializeHostSettingsYaml(settings: HostSettings): string {
  return (
    SETTINGS_HEADER + yaml.dump(settings, { indent: 2, lineWidth: 100, noRefs: true })
  );
}

export function parseGlobalMenuYaml(rawText: string): GlobalMenuConfig {
  try {
    const raw = (yaml.load(rawText) || {}) as Partial<GlobalMenuConfig>;
    return { menus: Array.isArray(raw.menus) ? raw.menus : [] };
  } catch {
    return { menus: [] };
  }
}

export async function fetchWebFallbackBundle(): Promise<{
  settings: HostSettings;
  globalMenus: MenuItemSchema[];
  pets: PetManifest[];
}> {
  let settings = structuredClone(DEFAULT_HOST_SETTINGS);
  let globalMenus: MenuItemSchema[] = [];

  try {
    const [settingsRes, menuRes] = await Promise.all([
      fetch('/config/settings.yaml'),
      fetch('/config/global_menu.yaml'),
    ]);
    if (settingsRes.ok) settings = parseHostSettingsYaml(await settingsRes.text());
    if (menuRes.ok) globalMenus = parseGlobalMenuYaml(await menuRes.text()).menus;
  } catch {
    // Use defaults
  }

  const pets: PetManifest[] = [];
  for (const pid of BUILTIN_PET_IDS) {
    try {
      const res = await fetch(`/pets/${pid}/pet.yaml`);
      if (res.ok) pets.push(parsePetManifestYaml(await res.text(), pid));
    } catch {
      // Skip unreachable
    }
  }
  if (pets.length === 0) pets.push(structuredClone(FALLBACK_PET_MANIFEST));

  return { settings, globalMenus, pets };
}
