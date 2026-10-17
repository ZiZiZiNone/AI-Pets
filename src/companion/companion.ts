import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import CompanionApp from './CompanionApp.vue';
import './companion.css';
import type { ActionPriority, MenuItemSchema, PetBridgeSDK } from '@/types/pet';

const eventListeners = new Set<(event: string, payload: unknown) => void>();
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);
const TAURI_ORIGINS = new Set(['tauri://localhost', 'https://tauri.localhost']);

/**
 * Origin policy for the `postMessage` bridge.
 *
 * The companion renders user-supplied pages in a sandboxed iframe, so an unauthenticated
 * handler would let any of those pages drive the pet. Hostname matching is done against
 * the parsed URL rather than a string prefix, otherwise `https://localhost.attacker.test`
 * would pass the check.
 */
function isTrustedLocalOrigin(origin: string): boolean {
  if (!origin || origin === 'null') return false;
  if (origin === window.location.origin) return true;
  if (TAURI_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

const petBridge: PetBridgeSDK = {
  async act(options) {
    await emit('ws-pet-act', {
      motion: options.motion || 'happy',
      expression: options.expression || 'smile',
      text: options.text,
      audio: options.audio,
      priority: options.priority || ('P1' as ActionPriority),
      duration_ms: options.durationMs || 4200,
      resume_after_interrupt: options.resumeAfterInterrupt ?? true,
    });
  },

  async say(text: string, durationMs = 4000, priority: ActionPriority = 'P2') {
    await emit('pet-speech-bubble', { text, duration_ms: durationMs, priority });
  },

  async updateMenuItem(appId: string, item: MenuItemSchema) {
    await emit('ws-menu-register', { app_id: appId, item });
  },

  onEvent(callback: (event: string, payload: unknown) => void) {
    eventListeners.add(callback);
    return () => {
      eventListeners.delete(callback);
    };
  },

  system: {
    async exec(command: string, args: string[] = [], cwd?: string): Promise<string> {
      return invoke<string>('execute_pet_action', {
        action: { type: 'exec', command, args, cwd },
        extraArgs: null,
      });
    },
  },

  panel: {
    async close() {
      await getCurrentWebviewWindow().hide();
    },
  },
};

window.PetBridge = petBridge;

void listen<{ event: string; payload: unknown }>('internal-menu-action', (evt) => {
  for (const cb of eventListeners) {
    cb(evt.payload.event, evt.payload.payload);
  }
});

window.addEventListener('message', async (msgEvt: MessageEvent) => {
  const data = msgEvt.data;
  if (!data || typeof data !== 'object' || data.channel !== 'PetBridge') return;
  if (!isTrustedLocalOrigin(msgEvt.origin)) return;

  // Arbitrary local pages may drive the pet, but spawning processes is reserved for the
  // host's own document, which a remote page can never claim as its origin.
  if (data.method === 'exec' && msgEvt.origin !== window.location.origin) return;

  switch (data.method) {
    case 'act':
      await petBridge.act(data.params || {});
      return;
    case 'say':
      await petBridge.say(
        data.params?.text || '',
        data.params?.durationMs,
        data.params?.priority
      );
      return;
    case 'updateMenuItem':
      if (data.params?.appId && data.params?.item) {
        await petBridge.updateMenuItem(data.params.appId, data.params.item);
      }
      return;
    case 'exec':
      if (data.params?.command) {
        await petBridge.system.exec(data.params.command, data.params.args, data.params.cwd);
      }
      return;
    case 'close':
      await petBridge.panel.close();
      return;
    default:
      return;
  }
});

const app = createApp(CompanionApp);
app.use(createPinia());
app.mount('#companion-app');

// The stage resolves `open_companion_window` long before this document finishes
// booting, so announce readiness and let the stage replay any parked panel request.
void emit('companion-ready');
