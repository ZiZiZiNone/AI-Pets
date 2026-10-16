<template>
  <div
    class="pet-stage-root"
    :style="petStore.activeThemeCssVars"
    @mousedown="handleStageMouseDown"
    @mousemove="handleStageLocalMouseMove"
    @mouseenter="isCursorHoveringPet = true"
    @contextmenu.prevent="toggleRadialMenu"
  >
    <PetCanvasStage ref="stageRef" />
    <SpeechBubble />
    <RadialMenu />
    <StudioOverlay :on-transform-change="handleStudioTransform" />
    <StageHudDock
      :is-cursor-hovering-pet="isCursorHoveringPet"
      :is-drag-over="isDragOver"
      @toggle-radial="toggleRadialMenu"
    />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import PetCanvasStage from '@/components/PetCanvasStage.vue';
import SpeechBubble from '@/components/SpeechBubble.vue';
import RadialMenu from '@/components/RadialMenu.vue';
import StudioOverlay from '@/components/StudioOverlay.vue';
import StageHudDock from '@/components/StageHudDock.vue';
import { usePetStore } from '@/store/petStore';
import { globalLipSync } from '@/utils/audioLipSync';
import type {
  ActionPriority,
  DesktopWindowState,
  HitAreaDef,
  MenuItemSchema,
  PetActionConfig,
} from '@/types/pet';

const petStore = usePetStore();
const stageRef = ref<InstanceType<typeof PetCanvasStage> | null>(null);

const isCursorHoveringPet = ref<boolean>(true);
const isDragOver = ref<boolean>(false);
const lastHitArea = ref<HitAreaDef | undefined>(undefined);
const unlistenFns: UnlistenFn[] = [];

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
    isCursorHoveringPet.value = true;
  }
}

function handleGlobalKeyDown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    petStore.markUserActivity();
    petStore.quickChatOpen = !petStore.quickChatOpen;
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleRadialMenu();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    void petStore.dispatchPatch({ is_click_through: !petStore.is_click_through });
    return;
  }
  if (e.key === 'Escape') {
    if (petStore.radialMenuOpen) petStore.radialMenuOpen = false;
    else if (petStore.quickChatOpen) petStore.quickChatOpen = false;
    else if (petStore.studioOpen) petStore.studioOpen = false;
    else if (petStore.bubbleText) petStore.dismissCurrentBubble();
  }
}

async function handleStageMouseDown(e: MouseEvent): Promise<void> {
  if (e.button !== 0 || petStore.studioOpen) return;
  if ((e.target as HTMLElement | null)?.closest('.interactive-ui')) return;

  petStore.markUserActivity();
  const startX = e.screenX;
  const startY = e.screenY;
  let dragged = false;

  const cleanupDragListeners = () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = async (moveEvt: MouseEvent) => {
    const dist = Math.hypot(moveEvt.screenX - startX, moveEvt.screenY - startY);
    if (dist > 6 && !dragged) {
      dragged = true;
      cleanupDragListeners();
      petStore.isDraggingWindow = true;
      petStore.scheduleAction({
        priority: 'P0',
        motion: 'drag',
        expression: 'surprised',
        text: '⚡ 反重力牵引中！靠近任何窗口顶栏松手即可磁吸驻留~',
        durationMs: 2200,
      });
      try {
        await getCurrentWebviewWindow().startDragging();
      } catch {
        // Browser preview fallback
      } finally {
        petStore.isDraggingWindow = false;
        await petStore.evaluatePostDragSnap();
      }
    }
  };

  const onMouseUp = async () => {
    cleanupDragListeners();
    if (dragged) return;

    if (!petStore.dnd_mode) {
      globalLipSync.playUiFeedbackTone('pat', petStore.volume);
    }
    petStore.addXpAndAffinity(5, 2, 2);
    const hitRes = stageRef.value?.performHitTest(e.clientX, e.clientY);
    const area = hitRes?.area || lastHitArea.value;
    stageRef.value?.spawnInteractionBurst(e.clientX, e.clientY, area ? '+5 EXP ♥' : '+5 EXP');

    if (area) {
      const texts = area.texts || [`触发了 ${area.label}~`];
      petStore.scheduleAction({
        priority: 'P2',
        motion: area.motion || 'pat',
        expression: area.expression || 'smile',
        text: texts[Math.floor(Math.random() * texts.length)],
        durationMs: 3600,
      });
      if (area.action) await petStore.dispatchPetAction(area.action);
    } else {
      petStore.scheduleAction({
        priority: 'P2',
        motion: 'happy',
        expression: 'smile',
        text: '神经突触在线！右键召唤【双轨陀螺仪星盘】或点击 💬 开启智能对话 ✨',
        durationMs: 3400,
      });
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

async function handleFilesDropped(paths: string[]): Promise<void> {
  isDragOver.value = false;
  if (!paths?.length || !petStore.currentPet) return;

  if (!petStore.dnd_mode) {
    globalLipSync.playUiFeedbackTone('feed', petStore.volume);
  }
  petStore.addXpAndAffinity(25, 5, 4);
  stageRef.value?.spawnInteractionBurst(180, 210, '+25 EXP ⚡');

  const firstPath = paths[0];
  const fileName = firstPath.split(/[/\\]/).pop() || firstPath;
  const dotIdx = fileName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '';

  const handlers = petStore.currentPet.drop_handlers || [];
  const matched =
    handlers.find((h) => h.extensions.some((r) => r.toLowerCase() === ext)) ||
    handlers.find((h) => h.extensions.includes('*'));

  const bubbleMsg = matched?.bubble_template
    ? matched.bubble_template.replace('{filename}', fileName)
    : `⚡ 引力场已捕获外部载荷：${fileName}`;

  petStore.scheduleAction({
    priority: 'P2',
    motion: matched?.motion || 'feed',
    expression: matched?.expression || 'smile',
    text: bubbleMsg,
    durationMs: 4200,
  });

  if (matched?.action) {
    if (matched.action.type === 'emit') {
      const actionCopy: PetActionConfig = {
        ...matched.action,
        payload: { ...(matched.action.payload || {}), files: paths, filename: fileName },
      };
      await petStore.dispatchPetAction(actionCopy);
    } else {
      await petStore.dispatchPetAction(matched.action, paths);
    }
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeyDown);
  await petStore.initializeHost('main');

  petStore.scheduleAction({
    priority: 'P2',
    motion: 'happy',
    expression: 'smile',
    text: `💠 [${petStore.currentPet?.name || 'AETHER-VII'}] 已激活！右键展开陀螺仪战术翼，或点击 💬/🧬 体验养成与四大机体切换。`,
    durationMs: 4800,
  });

  try {
    unlistenFns.push(
      await listen<{ x: number; y: number }>('cursor-in-window', async (event) => {
        const { x, y } = event.payload;
        stageRef.value?.lookAtCursor(x, y);
        if (petStore.is_click_through) return;

        const hitsUi = !!document.elementFromPoint(x, y)?.closest('.interactive-ui');
        if (
          hitsUi ||
          petStore.studioOpen ||
          petStore.radialMenuOpen ||
          petStore.quickChatOpen
        ) {
          isCursorHoveringPet.value = true;
          await invoke('set_stage_click_through', { ignore: false });
          return;
        }

        const hitResult = stageRef.value?.performHitTest(x, y) ?? { hit: false };
        lastHitArea.value = hitResult.area;
        isCursorHoveringPet.value = hitResult.hit;
        await invoke('set_stage_click_through', { ignore: !hitResult.hit });
      })
    );

    unlistenFns.push(
      await listen<DesktopWindowState>('desktop-window-state', async (ev) => {
        await petStore.handleDesktopWindowState(ev.payload);
      })
    );
    unlistenFns.push(await listen('tauri://drag-enter', () => (isDragOver.value = true)));
    unlistenFns.push(await listen('tauri://drag-leave', () => (isDragOver.value = false)));
    unlistenFns.push(
      await listen<{ paths: string[] }>('tauri://drag-drop', async (ev) => {
        await handleFilesDropped(ev.payload.paths || []);
      })
    );
    unlistenFns.push(
      await listen<{ text: string; duration_ms: number; priority: ActionPriority }>(
        'pet-speech-bubble',
        (ev) => {
          petStore.scheduleAction({
            priority: ev.payload.priority || 'P2',
            motion: 'happy',
            expression: 'smile',
            text: ev.payload.text,
            durationMs: ev.payload.duration_ms || 4200,
          });
        }
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
        async (ev) => {
          await petStore.handleInternalEvent(ev.payload.event, ev.payload.payload || {});
        }
      )
    );
    unlistenFns.push(
      await listen('config-hot-reload', async () => {
        await petStore.initializeHost('main');
      })
    );
  } catch {
    // Browser preview mode
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeyDown);
  for (const fn of unlistenFns) fn();
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
</style>
