<template>
  <div
    class="pet-stage-root"
    :style="petStore.activeThemeCssVars"
    @mousedown="handleStageMouseDown"
    @mousemove="handleStageLocalMouseMove"
    @mouseenter="keepHudAlive"
    @mouseleave="releaseHudSoon"
    @contextmenu.prevent="toggleRadialMenu"
  >
    <PetCanvasStage ref="stageRef" />
    <div class="pet-ui-frame">
      <SpeechBubble />
      <RadialMenu />
      <StudioOverlay :on-transform-change="handleStudioTransform" />
      <StageHudDock
        :is-cursor-hovering-pet="isCursorHoveringPet"
        :is-drag-over="isDragOver"
        @toggle-radial="toggleRadialMenu"
        @hud-hover="handleHudHoverChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import PetCanvasStage from '@/components/PetCanvasStage.vue';
import SpeechBubble from '@/components/SpeechBubble.vue';
import RadialMenu from '@/components/RadialMenu.vue';
import StudioOverlay from '@/components/StudioOverlay.vue';
import StageHudDock from '@/components/StageHudDock.vue';
import { usePetStore } from '@/store/petStore';
import { globalLipSync } from '@/utils/audioLipSync';
import { applyStageWindowSize } from '@/utils/stageWindow';
import type {
  ActionPriority,
  DesktopWindowState,
  HitAreaDef,
  MenuItemSchema,
} from '@/types/pet';
import { CLICK_DRAG_THRESHOLD_PX, HUD_HOVER_GRACE_MS, STAGE_HEIGHT_PX, STAGE_WIDTH_PX } from '@/constants/timing';
import { FALLBACK_HIT_AREA_TEXT, STAGE_MESSAGES } from '@/constants/messages';

const petStore = usePetStore();
const stageRef = ref<InstanceType<typeof PetCanvasStage> | null>(null);

const isCursorHoveringPet = ref<boolean>(true);
const isCursorOverHud = ref<boolean>(false);
let hoverGraceTimer: number | null = null;
const isDragOver = ref<boolean>(false);
const lastHitArea = ref<HitAreaDef | undefined>(undefined);
const unlistenFns: UnlistenFn[] = [];

const STAGE_CENTER_X = STAGE_WIDTH_PX / 2;
const STAGE_CENTER_Y = STAGE_HEIGHT_PX / 2;

const XP_PER_TAP = 5;
const XP_PER_DROPPED_FILE = 25;
const TAP_BUBBLE_MS = 3600;
const IDLE_BUBBLE_MS = 3400;
const DRAG_BUBBLE_MS = 2200;
const LOAD_BUBBLE_MS = 4800;
const DROPPED_BUBBLE_MS = 4200;

// The Win32 poller emits cursor events at 33 Hz. Re-issuing an identical click-through
// command each time costs an IPC round-trip and a forced layout for no benefit, so the
// command is only sent on an actual transition.
let appliedClickThrough: boolean | null = null;
let releaseDragListeners: (() => void) | null = null;

async function applyClickThrough(ignore: boolean): Promise<void> {
  if (appliedClickThrough === ignore) return;
  appliedClickThrough = ignore;
  try {
    await invoke('set_stage_click_through', { ignore });
  } catch {
    appliedClickThrough = null;
  }
}

function isPanelOpen(): boolean {
  return petStore.studioOpen || petStore.radialMenuOpen || petStore.quickChatOpen;
}

/**
 * Pin the HUD open and keep the window interactive.
 *
 * Visibility and click-through have to move together. `set_stage_click_through` is a
 * whole-window flag, so any state where the dock is on screen must also be a state where
 * the webview still receives mouse events, otherwise the controls render but cannot be
 * pressed.
 */
function keepHudAlive(): void {
  // A user who enabled click-through from the tray means it; never quietly undo that.
  if (petStore.is_click_through) return;
  if (hoverGraceTimer !== null) {
    window.clearTimeout(hoverGraceTimer);
    hoverGraceTimer = null;
  }
  isCursorHoveringPet.value = true;
  void applyClickThrough(false);
}

/**
 * Retract the HUD once the pointer has settled away from it.
 *
 * The timer is re-armed on every cursor event rather than only on the transition, so a
 * pointer in flight keeps the dock mounted while it crosses the gap; only a pointer that
 * stops outside both sprite and HUD retires it.
 */
function releaseHudSoon(): void {
  if (isCursorOverHud.value || isPanelOpen() || petStore.quickChatOpen) return;
  if (hoverGraceTimer !== null) window.clearTimeout(hoverGraceTimer);
  hoverGraceTimer = window.setTimeout(() => {
    hoverGraceTimer = null;
    if (isCursorOverHud.value || isPanelOpen() || petStore.quickChatOpen) return;
    isCursorHoveringPet.value = false;
    void applyClickThrough(true);
  }, HUD_HOVER_GRACE_MS);
}

function handleHudHoverChange(over: boolean): void {
  isCursorOverHud.value = over;
  if (over) {
    keepHudAlive();
  } else {
    releaseHudSoon();
  }
}

// A pet that ships with its own `model.scale` must not arrive inside a window sized for
// the previous one, or it would be cropped until the user happened to touch the zoom.
watch(
  () => petStore.currentPet?.model.scale,
  (scale) => {
    if (typeof scale === 'number') void applyStageWindowSize(scale);
  },
  { immediate: true }
);

function toggleRadialMenu(): void {
  petStore.markUserActivity();
  petStore.radialMenuOpen = !petStore.radialMenuOpen;
}

function handleStudioTransform(scale: number, offsetX: number, offsetY: number): void {
  stageRef.value?.applyLiveTransform(scale, offsetX, offsetY);
}

function handleStageLocalMouseMove(e: MouseEvent): void {
  const hitRes = stageRef.value?.performHitTest(e.clientX, e.clientY);
  if (hitRes?.hit) {
    lastHitArea.value = hitRes.area;
    keepHudAlive();
  }
}

function handleGlobalKeyDown(e: KeyboardEvent): void {
  const key = e.key.toLowerCase();
  const withCommand = e.ctrlKey || e.metaKey;

  if (withCommand && key === 'k') {
    e.preventDefault();
    petStore.markUserActivity();
    petStore.quickChatOpen = !petStore.quickChatOpen;
    return;
  }
  if (withCommand && key === 'm') {
    e.preventDefault();
    toggleRadialMenu();
    return;
  }
  if (withCommand && e.shiftKey && key === 't') {
    e.preventDefault();
    appliedClickThrough = null;
    void petStore.dispatchPatch({ is_click_through: !petStore.is_click_through });
    return;
  }
  if (e.key !== 'Escape') return;

  if (petStore.radialMenuOpen) petStore.radialMenuOpen = false;
  else if (petStore.quickChatOpen) petStore.quickChatOpen = false;
  else if (petStore.studioOpen) petStore.studioOpen = false;
  else if (petStore.bubbleText) petStore.dismissCurrentBubble();
}

function handleStageMouseDown(e: MouseEvent): void {
  if (e.button !== 0 || petStore.studioOpen) return;
  if ((e.target as HTMLElement | null)?.closest('.interactive-ui')) return;

  releaseDragListeners?.();
  petStore.markUserActivity();

  const startX = e.screenX;
  const startY = e.screenY;
  let dragged = false;

  const onMouseMove = (moveEvt: MouseEvent): void => {
    if (dragged) return;
    const dist = Math.hypot(moveEvt.screenX - startX, moveEvt.screenY - startY);
    if (dist <= CLICK_DRAG_THRESHOLD_PX) return;

    dragged = true;
    releaseDragListeners?.();
    petStore.isDraggingWindow = true;
    petStore.scheduleAction({
      priority: 'P0',
      motion: 'drag',
      expression: 'surprised',
      text: STAGE_MESSAGES.dragStart,
      durationMs: DRAG_BUBBLE_MS,
    });
    void finishWindowDrag();
  };

  const onMouseUp = (): void => {
    releaseDragListeners?.();
    if (!dragged) void handleStageTap(e);
  };

  releaseDragListeners = () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    releaseDragListeners = null;
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

async function finishWindowDrag(): Promise<void> {
  try {
    await getCurrentWebviewWindow().startDragging();
  } catch {
    // Browser preview cannot move the native window.
  } finally {
    petStore.isDraggingWindow = false;
    await petStore.evaluatePostDragSnap();
  }
}

async function handleStageTap(e: MouseEvent): Promise<void> {
  if (!petStore.dnd_mode) globalLipSync.playUiFeedbackTone('pat', petStore.volume);
  petStore.addXpAndAffinity(XP_PER_TAP, 2, 2);

  const hitRes = stageRef.value?.performHitTest(e.clientX, e.clientY);
  const area = hitRes?.area || lastHitArea.value;
  stageRef.value?.spawnInteractionBurst(
    e.clientX,
    e.clientY,
    area ? '+5 EXP ♥' : '+5 EXP'
  );

  if (!area) {
    petStore.scheduleAction({
      priority: 'P2',
      motion: 'happy',
      expression: 'smile',
      text: STAGE_MESSAGES.idleHint,
      durationMs: IDLE_BUBBLE_MS,
    });
    return;
  }

  const texts = area.texts?.length ? area.texts : [FALLBACK_HIT_AREA_TEXT(area.label)];
  petStore.scheduleAction({
    priority: 'P2',
    motion: area.motion || 'pat',
    expression: area.expression || 'smile',
    text: texts[Math.floor(Math.random() * texts.length)],
    durationMs: TAP_BUBBLE_MS,
  });
  if (area.action) await petStore.dispatchPetAction(area.action);
}

async function handleFilesDropped(paths: string[]): Promise<void> {
  isDragOver.value = false;
  const manifest = petStore.currentPet;
  if (!paths?.length || !manifest) return;

  if (!petStore.dnd_mode) globalLipSync.playUiFeedbackTone('feed', petStore.volume);
  petStore.addXpAndAffinity(XP_PER_DROPPED_FILE, 5, 4);
  stageRef.value?.spawnInteractionBurst(STAGE_CENTER_X, STAGE_CENTER_Y, '+25 EXP ⚡');

  const fileName = paths[0].split(/[/\\]/).pop() || paths[0];
  const dotIdx = fileName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '';

  const handlers = manifest.drop_handlers || [];
  const matched =
    handlers.find((h) => h.extensions.some((r) => r.toLowerCase() === ext)) ||
    handlers.find((h) => h.extensions.includes('*'));

  petStore.scheduleAction({
    priority: 'P2',
    motion: matched?.motion || 'feed',
    expression: matched?.expression || 'smile',
    text: matched?.bubble_template
      ? matched.bubble_template.replace('{filename}', fileName)
      : STAGE_MESSAGES.payloadCaptured(fileName),
    durationMs: DROPPED_BUBBLE_MS,
  });

  const action = matched?.action;
  if (!action) return;

  if (action.type === 'emit') {
    await petStore.dispatchPetAction({
      ...action,
      payload: { ...(action.payload || {}), files: paths, filename: fileName },
    });
    return;
  }
  await petStore.dispatchPetAction(action, paths);
}

function handleCursorEvent(x: number, y: number): void {
  stageRef.value?.lookAtCursor(x, y);
  if (petStore.is_click_through) return;

  if (isPanelOpen()) {
    keepHudAlive();
    return;
  }

  const hit = stageRef.value?.performHitTest(x, y) ?? { hit: false, area: undefined };
  lastHitArea.value = hit.area;
  if (hit.hit) {
    keepHudAlive();
  } else {
    releaseHudSoon();
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeyDown);
  await petStore.initializeHost('main');

  petStore.scheduleAction({
    priority: 'P2',
    motion: 'happy',
    expression: 'smile',
    text: STAGE_MESSAGES.petLoaded(petStore.currentPet?.name || ''),
    durationMs: LOAD_BUBBLE_MS,
  });

  try {
    unlistenFns.push(
      await listen<{ x: number; y: number }>('cursor-in-window', (event) =>
        void handleCursorEvent(event.payload.x, event.payload.y)
      )
    );
    unlistenFns.push(
      await listen<DesktopWindowState>('desktop-window-state', (ev) =>
        void petStore.handleDesktopWindowState(ev.payload)
      )
    );
    unlistenFns.push(await listen('tauri://drag-enter', () => (isDragOver.value = true)));
    unlistenFns.push(await listen('tauri://drag-leave', () => (isDragOver.value = false)));
    unlistenFns.push(
      await listen<{ paths: string[] }>('tauri://drag-drop', (ev) =>
        void handleFilesDropped(ev.payload.paths || [])
      )
    );
    unlistenFns.push(
      await listen<{ text: string; duration_ms: number; priority: ActionPriority }>(
        'pet-speech-bubble',
        (ev) =>
          petStore.scheduleAction({
            priority: ev.payload.priority || 'P2',
            motion: 'happy',
            expression: 'smile',
            text: ev.payload.text,
            durationMs: ev.payload.duration_ms || 4200,
          })
      )
    );
    unlistenFns.push(
      await listen<{
        motion?: string;
        expression?: string;
        text?: string;
        audio?: string;
        priority?: ActionPriority;
        duration_ms?: number;
        resume_after_interrupt?: boolean;
      }>('ws-pet-act', (ev) => {
        const p = ev.payload;
        petStore.scheduleAction({
          priority: p.priority || 'P1',
          motion: p.motion,
          expression: p.expression,
          text: p.text,
          audioUrl: p.audio,
          durationMs: p.duration_ms || 4500,
          resumeAfterInterrupt: p.resume_after_interrupt ?? true,
        });
      })
    );
    unlistenFns.push(
      await listen<{ app_id: string; menus?: MenuItemSchema[]; item?: MenuItemSchema }>(
        'ws-menu-register',
        (ev) => petStore.registerExternalMenu(ev.payload)
      )
    );
    unlistenFns.push(
      await listen<{ app_id: string }>('ws-menu-unregister', (ev) =>
        petStore.unregisterExternalMenu(ev.payload.app_id)
      )
    );
    unlistenFns.push(
      await listen<{ event: string; payload: Record<string, unknown> }>(
        'internal-menu-action',
        (ev) => void petStore.handleInternalEvent(ev.payload.event, ev.payload.payload || {})
      )
    );
    unlistenFns.push(
      await listen('config-hot-reload', () => void petStore.initializeHost('main'))
    );
    unlistenFns.push(
      await listen('companion-ready', () => {
        const payload = petStore.takeCompanionLoad();
        if (payload) void emit('companion-load', payload);
      })
    );
  } catch {
    // Browser preview mode has no native events.
  }
});

onBeforeUnmount(() => {
  releaseDragListeners?.();
  window.removeEventListener('keydown', handleGlobalKeyDown);
  for (const off of unlistenFns) off();
  petStore.disposeStage();
});
</script>

<style scoped>
.pet-stage-root {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: transparent;
}

/**
 * The chrome stays at its authored size while the sprite scales.
 *
 * The stage window grows with the pet's zoom, and this frame keeps the dock, pill,
 * astrolabe and studio laid out around a fixed 360x420 box centred on the sprite. Without
 * it every one of those is positioned against the window corners and would slide out to
 * the far edge of a zoomed window, away from the pet they belong to. The frame itself
 * must not swallow clicks in the gaps around the UI.
 */
.pet-ui-frame {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 360px;
  height: 420px;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
</style>
