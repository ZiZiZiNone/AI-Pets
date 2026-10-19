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
  /**
   * How many frames the file holds, laid out as one horizontal strip.
   *
   * A strip is the only animation format the host can rely on: a browser draws the
   * first frame of an animated GIF or APNG into a canvas and never advances it, so a
   * pet that wants to move has to bring its frames with it. A file with no `frames`
   * is a still picture, as before.
   */
  frames?: number;
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

/** Pointer gesture that can be bound to a menu item. */
export type MenuGesture = 'click' | 'double_click' | 'long_press' | 'hover';

/**
 * Which gesture does what on one menu item.
 *
 * The two jobs a menu item has — running its action and opening its children — were both
 * hardwired to a single click, so the only way to get a different feel was to edit the
 * renderer. They are separate fields now, which is what lets one pet expand on hover and
 * another ask for a double click, from `pet.yaml` alone.
 *
 * `hover` is the one to be careful with: see `hover_intent_ms`.
 */
export interface MenuInteractionDef {
  /** Gesture that runs the item's `action`. */
  trigger?: MenuGesture;
  /** Gesture that opens the item's `children`. Ignored by an item that has none. */
  expand?: MenuGesture;
  /** How long a press must be held for `long_press` to count. */
  long_press_ms?: number;
  /**
   * How long the pointer must rest on an item before `hover` counts.
   *
   * A bare hover would fire while the pointer is only passing over an item on its way to
   * somewhere else, which for a menu is the same as a mis-click. The delay is what makes
   * "hover to expand" usable rather than twitchy.
   */
  hover_intent_ms?: number;
  /** Open the first item that has children when the menu appears. Default `true`. */
  auto_expand_first?: boolean;
}

export interface MenuItemSchema {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  app_id?: string;
  action?: PetActionConfig;
  children?: MenuItemSchema[];
  /** Overrides the pet-level `menu_interaction` for this item alone. */
  interaction?: MenuInteractionDef;
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
  /**
   * The phrase this character reaches for. One short line, used often enough to be
   * recognised and rarely enough to stay a line.
   */
  catchphrase?: string;
  /**
   * What this pet says when no language model is connected.
   *
   * The host picks one at random and fills `{input}` (what the user said) and `{affinity}`
   * (the bond level) into it. Without this the pet would answer in the host's generic
   * voice, and a hundred pets would sound like one.
   */
  lines?: string[];
  /** This pet's own way of saying "this is broken". Falls back to the host's line. */
  bug_hint?: string;
}

/**
 * What this pet plays for one moment the host reacts to on its own.
 *
 * Both fields are optional so a pet can map only the moments it wants to differ on; the
 * host falls back to the name it would otherwise have used.
 */
interface PetMomentDef {
  motion?: string;
  expression?: string;
}

/**
 * Per-pet behaviour and the motions it uses to express it.
 *
 * The host has its own autonomous moments — falling asleep, a hydration reminder, a posture
 * nudge, an idle thought — and each had a motion name compiled into the loop. A pet whose
 * clips are named differently could therefore only take part by renaming its artwork. This
 * is that mapping as data: which clip means "asleep" for *this* character.
 *
 * It travels in the package rather than in host settings because it is a fact about the
 * character, not about the machine — which is also what lets a driver read the same
 * vocabulary and ask for a moment by name instead of guessing at clip names.
 */
interface PetDynamicsDef {
  moments?: Record<string, PetMomentDef>;
  /**
   * Idle life for a character drawn from one still image: a breath and a slow lean.
   *
   * Opt-in, because it is a claim about the artwork. A sprite with its own frame animation,
   * or one whose pose is already mid-motion, is not improved by being made to breathe — and
   * a package that says nothing must keep the exact look it had before this existed.
   */
  motion?: {
    breathing?: { period_ms?: number; amount?: number };
    sway?: { period_ms?: number; amount?: number };
  };
  behaviors?: {
    /** `false` opts this pet out of the host's hydration/posture reminders. */
    health_reminders?: boolean;
  };
}

export interface PetManifest {
  id: string;
  name: string;
  version: string;
  type: AdapterType;
  description?: string;
  /**
   * The short name this pet answers to, typed as `/pet <alias>`.
   *
   * Declared by the package rather than by the host: a hundred pets each need their own
   * short name, and a table of them kept in source would have to be edited for every new
   * pet that ships.
   */
  alias?: string;
  /**
   * Which shelf this pet sits on, as the package calls it.
   *
   * A hundred pets need a way to be listed that is not one long column, and the shelf
   * belongs to the character rather than to the host: a roster that groups by theme has
   * to know each pet's theme, and that fact travels with the package.
   */
  cluster?: string;
  persona?: PetPersonaDef;
  /** Optional voice override; anything left out is inherited from `settings.yaml`. */
  voice?: PetVoiceDef;
  /**
   * Menu feel for this pet's whole tree: which gesture runs an action, which opens a
   * submenu. Individual items may override it.
   */
  menu_interaction?: MenuInteractionDef;
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
  /** Which clip means what to this character's own autonomous moments. */
  dynamics?: PetDynamicsDef;
  /**
   * Top-level keys this host does not interpret, kept verbatim.
   *
   * The manifest parser builds a known shape and the studio writes that shape back out, so
   * without this a save from the interface would delete every field the host has no use for
   * — which is exactly the content meant for whoever else reads the same package. Round
   * tripping them keeps a package editable here without making this host the only reader
   * that can preserve it.
   */
  extensions?: Record<string, unknown>;
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

/**
 * Result of asking the store to switch pets.
 *
 * A refusal has to be observable: the id may come from a menu entry or from an external
 * client, and neither should be told the switch happened when no such pet is installed.
 */
export type PetSwitchOutcome = { ok: true } | { ok: false; reason: string };

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

/**
 * Stage frame-rate override, as a value rather than a number so `dynamic` can be spelled.
 *
 * Shared rather than declared where it is used because a panel can set it from a schema and
 * the store applies it, and both sides have to agree on the three legal strings.
 */
export type PetFpsOverride = 'dynamic' | '60' | '30';

/** Host settings a panel may write through a widget's own value. */
export type SduiSettingEffect =
  | 'window_climbing'
  | 'click_through'
  | 'tts'
  | 'fps_mode'
  | 'voice_gain';

/**
 * Something the host should do when a panel control is used.
 *
 * Declared in the schema rather than inferred from the widget's id. The renderer used to
 * compare ids against a list compiled into it, which meant a panel shipped by anyone else
 * had controls that looked live and did nothing, with no way to find out why.
 *
 * The set is closed on purpose: a panel is data from outside the app, so "run this arbitrary
 * thing on the host" would be a capability, not an extension point.
 */
export type SduiEffect =
  /** Write the control's value into the named host setting. */
  | { kind: 'setting'; setting: SduiSettingEffect }
  /** Show a bubble on the stage; without `text`, the control's own string value is used. */
  | { kind: 'say'; text?: string; durationMs?: number }
  /** Draw these annotations on the HUD overlay. */
  | { kind: 'hud_draw'; annotations: HudAnnotation[] }
  /** Clear every annotation on the HUD overlay. */
  | { kind: 'hud_clear' };

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
      effect?: SduiEffect;
    }
  | {
      id: string;
      type: 'select';
      label: string;
      value: string;
      options: Array<{ label: string; value: string }>;
      effect?: SduiEffect;
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
      effect?: SduiEffect;
    }
  | {
      id: string;
      type: 'button_group';
      label: string;
      buttons: Array<{
        id: string;
        label: string;
        variant?: 'primary' | 'secondary' | 'danger';
        effect?: SduiEffect;
      }>;
    }
  | {
      id: string;
      type: 'log_viewer';
      label: string;
      lines: string[];
    }
  | {
      /**
       * Free text entry.
       *
       * The other widgets can only choose between values the host already knows; this is
       * the one that lets a third-party panel ask for something new (a token, a path, a
       * prompt) without the host shipping a field for it.
       */
      id: string;
      type: 'text_input';
      label: string;
      value: string;
      placeholder?: string;
      description?: string;
      /** Multi-line entry, which commits with Ctrl+Enter instead of Enter. */
      multiline?: boolean;
      /** Adds a button that raises `panel.text_submitted` in addition to `panel.state_changed`. */
      submit_label?: string;
      effect?: SduiEffect;
    }
  | {
      /**
       * A card that holds other widgets.
       *
       * Nesting is what makes a schema a layout rather than a list: a panel that wants a
       * caption above two related controls, or a row of buttons under a readout, previously
       * had to flatten that into separate flat cards. Children are ordinary widgets, so a
       * container can hold a container.
       */
      id: string;
      type: 'container';
      label?: string;
      description?: string;
      children: SduiWidget[];
      /** `stack` (default) puts children in a column, `row` puts them side by side. */
      layout?: 'stack' | 'row';
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
    /**
     * Extra directories that may hold `<id>/pet.yaml` packages.
     *
     * Empty by default, and that default is what matters: the host has to run with no
     * configuration at all and find exactly the pets it was built with. Declared here
     * because the settings file is round-tripped through this type — a key it does not
     * carry is a key that disappears the next time a setting is saved from the interface.
     *
     * A directory is only ever a place to read from, so the same folder may be produced by
     * this project's tooling or by another pet host; nothing here depends on whose it is.
     */
    pets_dirs?: string[];
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
  /** Fallback menu feel for every pet; a pet's own `menu_interaction` wins over it. */
  interaction?: MenuInteractionDef;
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
  /**
   * Exchanges of conversation replayed to the model. `0` disables memory.
   *
   * Lives here rather than in `settings.yaml` on purpose: the bridge config is already the
   * single home of everything the gateway needs, and splitting the window size into a
   * second file would give the two sources a way to disagree.
   */
  historyTurns?: number;
  /** Ask for the reply incrementally. Gateways that refuse `stream` are retried buffered. */
  stream?: boolean;
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
  /** Which external client currently owns the character, if one has claimed it. */
  driver_app_id?: string | null;
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
    open(options: {
      mode?: 'schema' | 'url';
      title?: string;
      url?: string;
      schema?: SduiSchema;
    }): Promise<string>;
  };
}

declare global {
  interface Window {
    PetBridge: PetBridgeSDK;
  }
}
