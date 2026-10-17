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

export interface PetManifest {
  id: string;
  name: string;
  version: string;
  type: AdapterType;
  description?: string;
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
  };
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
  apiUrl: string;
  apiKey: string;
  model: string;
  customSystemPrompt: string;
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
