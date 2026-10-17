/**
 * Every duration, interval and timing ratio used by the host.
 *
 * These values previously lived as bare literals inside stage logic, store actions and
 * components, which made it impossible to keep the speech-bubble, lip-sync and command
 * engines in agreement. Centralising them is what keeps those three subsystems coherent.
 */

/** Canonical stage viewport; also the Tauri window size and the radial-menu viewBox. */
export const STAGE_WIDTH_PX = 360;
export const STAGE_HEIGHT_PX = 420;

/** Origin of the authored sprite space that `hit_areas` rects are expressed in. */
export const HIT_AREA_ORIGIN_X = 160;
export const HIT_AREA_ORIGIN_Y = 170;

/** Vertical anchor of the sprite relative to the stage centre. */
export const SPRITE_GROUND_OFFSET_PX = 132;
export const SPRITE_CENTER_Y_RATIO = 0.52;
/** Vertical anchor of the Spine skeleton relative to the stage height. */
export const SPINE_ANCHOR_Y_RATIO = 0.82;

/** Sprite draw box and the fallback silhouette radius. */
export const SPRITE_DRAW_WIDTH_PX = 280;
export const SPRITE_DRAW_HEIGHT_PX = 298;
export const SPRITE_FALLBACK_RADIUS_PX = 88;

/** Physics. */
export const DEFAULT_GRAVITY_PX_S2 = 1400;
export const GRAVITY_MIN_PX_S2 = 200;
export const GRAVITY_MAX_PX_S2 = 4000;
export const BOUNCE_DAMPING = 0.32;
export const BOUNCE_MIN_IMPACT_SPEED = 90;
export const BOUNCE_SPEED_DIVISOR = 2800;
export const MAX_LANDING_SQUASH = 0.12;
export const SQUASH_DECAY_PER_SEC = 9;

/** Gesture thresholds. */
export const CLICK_DRAG_THRESHOLD_PX = 6;
export const LOOK_SMOOTHING_PER_SEC = 8;
export const MAX_FRAME_DELTA_SEC = 0.1;

/** Alpha-mask sampling used for pixel-accurate click-through on the sprite adapter. */
export const ALPHA_MASK_SIZE = 64;
export const ALPHA_MASK_ALPHA_THRESHOLD = 28;
export const ALPHA_MASK_REBUILD_FRAMES = 15;

/** Action queue behaviour. */
export const DEFAULT_ACTION_DURATION_MS = 3800;
export const MIN_ACTION_DURATION_MS = 800;

/** Speech bubble typewriter. */
export const TYPEWRITER_MS_PER_CHAR = 24;
export const TYPEWRITER_MAX_MS = 3600;
export const TYPEWRITER_MIN_MS = 900;
export const TYPEWRITER_BUDGET_MS_PER_CHAR = 45;
export const LIPSYNC_DURATION_MS_PER_CHAR = 85;
export const LIPSYNC_MIN_MS = 3800;
export const LIPSYNC_MAX_MS = 6800;

/** Autonomous loop cadence. */
export const AUTONOMOUS_TICK_MS = 5000;
export const MIN_WANDER_INTERVAL_SEC = 25;
export const AMBIENT_THINK_CHANCE = 0.35;

/** Lip-sync analyser configuration. */
export const LIPSYNC_FFT_SIZE = 1024;
export const LIPSYNC_FALLBACK_DURATION_MS = 2200;
export const LIPSYNC_SYNTH_TICK_MS = 32;

/** Voice-gain slider expressed as a percentage of the raw RMS signal. */
export const VOICE_GAIN_PERCENT_SCALE = 25;
export const VOICE_GAIN_DIVISOR = 75;
/** Pomodoro bounds. */
export const POMODORO_DEFAULT_MINUTES = 25;
export const POMODORO_BREAK_MINUTES = 5;
export const POMODORO_MIN_MINUTES = 1;
export const POMODORO_MAX_MINUTES = 180;
export const POMODORO_TICK_MS = 1000;

/** Local-storage keys and retention limits. */
export const COMMAND_HISTORY_KEY = 'desktop_pet_cmd_history_v2';
export const COMMAND_HISTORY_LIMIT = 25;
export const ACTION_ID_PREFIX = 'act_';
export const TODO_ID_PREFIX = 'todo_';

/** HUD annotation layer. */
export const HUD_COUNTDOWN_TICK_MS = 1000;
export const HUD_EXPIRY_THRESHOLD = 1;
export const HUD_DEFAULT_ARROW_DX = 120;
export const HUD_DEFAULT_ARROW_DY = 80;
export const HUD_ANIMATION_BOX = {
  x: 240,
  y: 160,
  w: 340,
  h: 190,
  countdownSec: 15,
} as const;

/** Studio blueprint tuning. */
export const STUDIO_ZOOM_STEP = 0.08;
export const STUDIO_MIN_SCALE = 0.35;
export const STUDIO_MAX_SCALE = 2.5;
export const STUDIO_MIN_BOX_SIZE_PX = 16;
export const COPY_FEEDBACK_MS = 1800;

/** Companion pod nudge geometry. */
export const POD_NUDGE_STEP_PX = 8;
export const POD_NUDGE_LIMIT_PX = 24;
export const COMPANION_LOG_LIMIT = 80;

/** Fallback notice lifetime used by the matrix tab status line. */
export const COMPANION_STATUS_RESET_MS = 2000;

/** Display window for a reply surfaced by the LLM connectivity probe. */
export const LLM_REPLY_BUBBLE_MS = 4500;

/** Radial menu geometry. */
export const RADIAL_MENU_RADIUS_X_PX = 122;
export const RADIAL_MENU_RADIUS_Y_PX = 114;
export const RADIAL_MENU_CENTER_Y_PX = 218;
export const RADIAL_MENU_START_ANGLE_RAD = -Math.PI / 2;
