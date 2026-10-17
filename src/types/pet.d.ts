export type AdapterType = 'sprite' | 'live2d' | 'spine' | 'vrm';

export type ActionPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface RectDef {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PetThemePalette {
  id: string;
  name: string;
  primary: string;
  accent: string;
  glow: string;
  surface: string;
  border: string;
  text: string;
  subtext: string;
  particleColor: string;
}

interface PetAnimationClipDef {
  file: string;
  loop?: boolean;
  duration_ms?: number;
  fps?: number;
}

interface PetExpressionDef {
  tint?: number;
  file?: string;
  blendshape?: Record<string, number>;
}

export interface PetActionConfig {
  type: 'emit' | 'exec' | 'panel' | 'open' | 'url';
  app_id?: string;
  event?: string;
  payload?: Record<string, unknown>;
  command?: string;
  args?: string[];
  cwd?: string;
  mode?: 'schema' | 'url';
  title?: string;
  url?: string;
  target?: string;
  schema?: SduiSchema;
}

export interface HitAreaDef {
  name: string;
  label: string;
  rect: RectDef;
  motion?: string;
  expression?: string;
  texts?: string[];
  action?: PetActionConfig;
}

interface DropHandlerDef {
  extensions: string[];
  motion?: string;
  expression?: string;
  bubble_template?: string;
  action?: PetActionConfig;
}

export interface MenuItemSchema {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  app_id?: string;
  action?: PetActionConfig;
  children?: MenuItemSchema[];
}

/**
 * Per-pet personality, used to build the LLM system prompt.
 *
 * This is the field that lets a pet shipped as a folder have its own voice without any
 * code change: the host composes the prompt from `traits` and `style_notes`, and lets
 * `system_prompt` replace the whole thing when a pet needs a hard character brief.
 */
export interface PetPersonaDef {
  /** Short identity line prepended to the prompt. */
  identity?: string;
  /** Adjectives/behaviours folded into the prompt as traits. */
  traits?: string[];
  /** Free-form instructions: tone, taboos, how to address the user, verbosity. */
  style_notes?: string;
  /** Overrides everything above with a complete prompt of your own. */
  system_prompt?: string;
}

export interface PetManifest {
  id: string;
  name: string;
  version: string;
  type: AdapterType;
  description?: string;
  persona?: PetPersonaDef;
  /** Optional voice override; anything left out is inherited from `settings.yaml`. */
  voice?: PetVoiceDef;
  basePath?: string;
  model: {
    entry: string;
    scale: number;
    offset: {
      x: number;
      y: number;
    };
    fps?: number;
    animations?: Record<string, PetAnimationClipDef>;
  };
  expressions?: Record<string, PetExpressionDef>;
  /**
   * Per-pet colour scheme. Declaring it here is what lets a third-party pet
   * ship with its own look by dropping a folder into `pets/` — without it the
   * host falls back to the built-in palette registry in `store/themes.ts`.
   */
  theme?: Partial<PetThemePalette>;
  hit_areas?: HitAreaDef[];
  drop_handlers?: DropHandlerDef[];
  menus?: MenuItemSchema[];
}

export interface CanonicalPetState {
  revision: number;
  active_pet_id: string;
  emotion: string;
  is_click_through: boolean;
  volume: number;
  studio_mode: boolean;
  inline_hud: boolean;
  dnd_mode?: boolean;
}

export interface LipSyncFrame {
  mouthOpenY: number;
  mouthFormX: number;
  rms: number;
  bands?: number[];
}

export interface QuickReplyChip {
  label: string;
  action: PetActionConfig;
}

export interface ScheduledPetTask {
  id?: string;
  priority: ActionPriority;
  motion?: string;
  expression?: string;
  text?: string;
  audioUrl?: string;
  durationMs?: number;
  resumeAfterInterrupt?: boolean;
  quickReplies?: QuickReplyChip[];
}

export interface DesktopWindowState {
  has_foreground_window: boolean;
  is_fullscreen: boolean;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  screen_width: number;
  screen_height: number;
}

export interface HudAnnotation {
  id: string;
  app_id?: string;
  type: 'box' | 'arrow';
  x: number;
  y: number;
  w?: number;
  h?: number;
  targetX?: number;
  targetY?: number;
  color?: string;
  label?: string;
  sublabel?: string;
  countdownSec?: number;
  ttlMs?: number;
  createdAt?: number;
}

export type SduiWidget =
  | {
      id: string;
      type: 'status_badge';
      label: string;
      value: string;
      tone?: 'success' | 'info' | 'warning' | 'danger';
    }
  | {
      id: string;
      type: 'switch';
      label: string;
      description?: string;
      value: boolean;
    }
  | {
      id: string;
      type: 'select';
      label: string;
      value: string;
      options: Array<{ label: string; value: string }>;
    }
  | {
      id: string;
      type: 'slider';
      label: string;
      value: number;
      min: number;
      max: number;
      step?: number;
      unit?: string;
    }
  | {
      id: string;
      type: 'button_group';
      label: string;
      buttons: Array<{
        id: string;
        label: string;
        variant?: 'primary' | 'secondary' | 'danger';
      }>;
    }
  | {
      id: string;
      type: 'log_viewer';
      label: string;
      lines: string[];
    };

export interface SduiSchema {
  app_id: string;
  title: string;
  subtitle?: string;
  widgets: SduiWidget[];
}

/**
 * Payload the stage hands to the companion window once it reports readiness.
 *
 * The companion webview finishes booting well after `open_companion_window` resolves,
 * so the request is parked on the store and replayed on a `companion-ready` handshake
 * rather than being pushed at a guessed delay.
 */
export interface CompanionLoadPayload {
  mode: 'schema' | 'url';
  title: string;
  url?: string;
  schema?: SduiSchema;
}

/**
 * Transport used by one voice capability.
 *
 * `none` is a real value rather than an empty string so a config can turn a capability off
 * explicitly instead of relying on a falsy field.
 */
export type VoiceProviderId = 'none' | 'web_speech' | 'openai_compatible' | 'local_engine';

/** Parameters handed to the browser's own `SpeechSynthesis`. */
interface WebSpeechTtsConfig {
  /** BCP-47 tag; decides which installed system voice is picked. */
  lang: string;
  rate: number;
  pitch: number;
  /** Preferred system voice name; empty means "whatever the OS defaults to". */
  voice: string;
}

/** Any endpoint speaking the OpenAI `/v1/audio/speech` shape. */
interface HttpTtsConfig {
  api_url: string;
  api_key: string;
  model: string;
  voice: string;
  /** Container requested from the endpoint; also the type used to wrap the bytes. */
  format: string;
  speed: number;
}

/**
 * A local command-line speech engine.
 *
 * `args` is the whole contract with the process, which is what keeps a new engine — or a
 * new release of the current one — a config edit instead of a code change. Every entry is
 * passed as one argv element, never through a shell.
 *
 * Placeholders: `{model_dir}` and `{text}` are filled in by the host, `{input}` and
 * `{output}` by the Rust runner (they refer to temp files it owns). A `*` inside an
 * argument containing a path separator matches the first file by name, so a model folder
 * can be pointed at without pinning the release's exact weight filename.
 */
export interface LocalEngineConfig {
  /** Absolute path to the executable. */
  exe: string;
  /** Substituted into `{model_dir}`. */
  model_dir: string;
  args: string[];
  timeout_ms: number;
  /**
   * Extra argv appended after `args`, so a user can add a flag (`--sid=3`) without
   * rewriting a template they would otherwise have to keep in sync with upgrades.
   */
  extra_args: string[];
  /** Voice selection for multi-speaker models; ignored by single-speaker ones. */
  speaker_id: number;
  /** Speaking rate, where the engine supports one. */
  speed: number;
  num_threads: number;
  /**
   * Optional existing audio file used as `{input}` instead of a fresh recording.
   *
   * Exists so the local recognition chain can be exercised — and a future problem
   * diagnosed — on a machine with no microphone, which is otherwise the only way in.
   */
  input_path: string;
  /**
   * Container the engine writes into `{output}`.
   *
   * Declared rather than sniffed: it names the temp file and becomes the `Blob` type the
   * audio element is handed, and an engine writing mp3 into a `.wav` would otherwise be
   * mislabelled by a guess.
   */
  output_extension: string;
}

/** Parameters for the browser's own `SpeechRecognition`. */
export interface WebSpeechSttConfig {
  lang: string;
  interim: boolean;
  /** Upper bound on one utterance, so a stalled recogniser cannot listen forever. */
  max_ms: number;
}

/** Any endpoint speaking the OpenAI `/v1/audio/transcriptions` shape. */
interface HttpSttConfig {
  api_url: string;
  api_key: string;
  model: string;
  /** ISO-639-1 hint; empty lets the server detect the language. */
  language: string;
  /** Domain hint (names, jargon) forwarded as the multipart `prompt` field. */
  prompt: string;
}

/** How a capability is configured on this machine. */
export interface VoiceSettings {
  tts: {
    provider: VoiceProviderId;
    web_speech: WebSpeechTtsConfig;
    http: HttpTtsConfig;
    local: LocalEngineConfig;
  };
  stt: {
    provider: VoiceProviderId;
    /** Send a finished transcript to the pet as if it had been typed. */
    auto_send: boolean;
    web_speech: WebSpeechSttConfig;
    http: HttpSttConfig;
    local: LocalEngineConfig;
  };
}

/**
 * Per-pet voice override.
 *
 * An absent block inherits the host setting, so a pet only states what it wants to be
 * different — one pet can speak with a local engine while the host default stays on the
 * system voice.
 */
export interface PetVoiceDef {
  tts?: Partial<VoiceSettings['tts']>;
  stt?: Partial<VoiceSettings['stt']>;
}

export interface HostSettings {
  host: {
    ws_port_range: [number, number];
    heartbeat_timeout_sec: number;
    default_pet: string;
  };
  render: {
    idle_fps: number;
    active_fps: number;
    idle_timeout_ms: number;
    high_dpi: boolean;
  };
  behavior: {
    enable_autonomous_fsm: boolean;
    enable_window_climbing: boolean;
    enable_fullscreen_edge_peek: boolean;
    wander_interval_sec: number;
    sleep_after_idle_sec: number;
    gravity_acceleration: number;
    enable_health_reminders: boolean;
    hydration_interval_min: number;
    posture_interval_min: number;
  };
  audio: {
    enable_lip_sync: boolean;
    rms_smoothing: number;
    rms_gain: number;
    enable_tts: boolean;
  } & VoiceSettings;
}

export interface GlobalMenuConfig {
  menus: MenuItemSchema[];
}

export interface PetStatsState {
  level: number;
  xp: number;
  xpToNext: number;
  affinity: number;
  mood: number;
  energy: number;
  totalInteractions: number;
  completedPomodoros: number;
  filesAnalyzed: number;
}

export interface PomodoroState {
  running: boolean;
  mode: 'focus' | 'short_break' | 'long_break';
  remainingSec: number;
  totalSec: number;
  taskLabel: string;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  priority: 'high' | 'normal' | 'low';
}

export interface LlmBridgeConfig {
  enabled: boolean;
  /** Transport id; unknown values fall back to `openai_compatible`. */
  provider?: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  customSystemPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SystemTelemetry {
  os_name: string;
  os_version: string;
  arch: string;
  cpu_cores: number;
  memory_usage_mb: number | null;
  uptime_sec: number;
  ws_port: number;
  connected_clients: number;
}

export interface SlashCommandHint {
  command: string;
  usage: string;
  description: string;
  icon: string;
}

export interface PetBridgeSDK {
  act(options: {
    motion?: string;
    expression?: string;
    text?: string;
    audio?: string;
    priority?: ActionPriority;
    durationMs?: number;
    resumeAfterInterrupt?: boolean;
  }): Promise<void>;
  say(text: string, durationMs?: number, priority?: ActionPriority): Promise<void>;
  updateMenuItem(appId: string, item: MenuItemSchema): Promise<void>;
  onEvent(callback: (event: string, payload: unknown) => void): () => void;
  system: {
    exec(command: string, args?: string[], cwd?: string): Promise<string>;
  };
  panel: {
    close(): Promise<void>;
  };
}

declare global {
  interface Window {
    PetBridge: PetBridgeSDK;
  }
}
