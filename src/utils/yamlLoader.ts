import yaml from 'js-yaml';
import type {
  AdapterType,
  GlobalMenuConfig,
  HostSettings,
  MenuItemSchema,
  PetManifest,
} from '@/types/pet';

export const BUILTIN_PET_IDS = [
  'aether_mecha_core',
  'nyx_abyssal_familiar',
  'pulse_glitch_phantom',
  'demo_sprite_pet',
] as const;

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
      hit_areas: Array.isArray(raw.hit_areas)
        ? (raw.hit_areas as PetManifest['hit_areas'])
        : FALLBACK_PET_MANIFEST.hit_areas,
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

export function parseHostSettingsYaml(rawText: string): HostSettings {
  try {
    const raw = (yaml.load(rawText) || {}) as Partial<HostSettings>;
    return {
      host: { ...DEFAULT_HOST_SETTINGS.host, ...(raw.host || {}) },
      render: { ...DEFAULT_HOST_SETTINGS.render, ...(raw.render || {}) },
      behavior: { ...DEFAULT_HOST_SETTINGS.behavior, ...(raw.behavior || {}) },
      audio: { ...DEFAULT_HOST_SETTINGS.audio, ...(raw.audio || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_HOST_SETTINGS);
  }
}

export function serializeHostSettingsYaml(settings: HostSettings): string {
  return yaml.dump(settings, { indent: 2, lineWidth: 100, noRefs: true });
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
