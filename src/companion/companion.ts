import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import CompanionApp from './CompanionApp.vue';
import './companion.css';
import type { ActionPriority, MenuItemSchema, PetBridgeSDK } from '@/types/pet';

const eventListeners = new Set<(event: string, payload: unknown) => void>();

function isTrustedLocalOrigin(origin: string): boolean {
  if (!origin || origin === 'null') return false;
  return (
    origin === window.location.origin ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('tauri://localhost') ||
    origin.startsWith('https://tauri.localhost')
  );
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
    await emit('pet-speech-bubble', {
      text,
      duration_ms: durationMs,
      priority,
    });
  },

  async updateMenuItem(appId: string, item: MenuItemSchema) {
    await emit('ws-menu-register', {
      app_id: appId,
      item,
    });
  },

  onEvent(callback: (event: string, payload: unknown) => void) {
    eventListeners.add(callback);
    return () => {
      eventListeners.delete(callback);
    };
  },

  system: {
    async exec(command: string, args: string[] = [], cwd?: string): Promise<string> {
      return await invoke<string>('execute_pet_action', {
        action: { type: 'exec', command, args, cwd },
        extraArgs: null,
      });
    },
  },

  panel: {
    async minimize() {
      await getCurrentWebviewWindow().hide();
    },
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

  switch (data.method) {
    case 'act':
      await petBridge.act(data.params || {});
      break;
    case 'say':
      await petBridge.say(data.params?.text || '', data.params?.durationMs, data.params?.priority);
      break;
    case 'updateMenuItem':
      if (isTrustedLocalOrigin(msgEvt.origin) && data.params?.appId && data.params?.item) {
        await petBridge.updateMenuItem(data.params.appId, data.params.item);
      }
      break;
    case 'exec':
      if (isTrustedLocalOrigin(msgEvt.origin) && data.params?.command) {
        await petBridge.system.exec(data.params.command, data.params.args, data.params.cwd);
      }
      break;
    case 'close':
      await petBridge.panel.close();
      break;
  }
});

const app = createApp(CompanionApp);
app.use(createPinia());
app.mount('#companion-app');
