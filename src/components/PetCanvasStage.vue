<template>
  <div
    ref="stageContainerRef"
    class="pet-canvas-stage"
    :style="stageStyle"
    @mousemove="handleLocalMouseMove"
  >
    <canvas
      v-if="canvasMode === '2d'"
      ref="canvas2dRef"
      class="stage-canvas"
      :data-high-dpi="highDpi ? '1' : '0'"
    ></canvas>
    <canvas v-else ref="canvas3dRef" class="stage-canvas" :data-high-dpi="highDpi ? '1' : '0'"></canvas>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AdapterFactory } from '@/adapters/AdapterFactory';
import type { HitTestResult, IPetAdapter } from '@/adapters/IPetAdapter';
import { usePetStore } from '@/store/petStore';
import type { AdapterType, PetManifest } from '@/types/pet';
import {
  DEFAULT_GRAVITY_PX_S2,
  MAX_FRAME_DELTA_SEC,
} from '@/constants/timing';

const petStore = usePetStore();

const stageContainerRef = ref<HTMLElement | null>(null);
const canvas2dRef = ref<HTMLCanvasElement | null>(null);
const canvas3dRef = ref<HTMLCanvasElement | null>(null);
const canvasMode = ref<'2d' | '3d'>('2d');

/**
 * The stage fills the window instead of holding the authored size.
 *
 * The window grows when the pet is zoomed, and the drawing surface has to grow with it:
 * a canvas that stays at 360x420 crops everything the zoom brought closer, which is
 * exactly the "the pet is cut in half" complaint. The chrome keeps its own fixed box
 * (`.pet-ui-frame`), so only the picture follows the window.
 */
const stageStyle = {
  width: '100%',
  height: '100%',
};

const highDpi = computed(() => petStore.settings.render.high_dpi);

let adapter: IPetAdapter | null = null;
let rafId: number | null = null;
let loopRunning = false;
let lastFrameTime = performance.now();
let mountToken = 0;
let resizeObserver: ResizeObserver | null = null;

function disposeAdapter(): void {
  adapter?.dispose();
  adapter = null;
}

/**
 * Adapters arrive asynchronously and loading a model can take hundreds of
 * milliseconds, so every mount carries a token. A mount whose token is stale by the
 * time its asset resolves disposes what it built instead of orphaning a renderer.
 */
async function buildAdapter(
  type: AdapterType,
  manifest: PetManifest,
  canvas: HTMLCanvasElement,
  token: number
): Promise<IPetAdapter | null> {
  const created = await AdapterFactory.createAdapter(type);
  if (token !== mountToken) {
    created.dispose();
    return null;
  }
  await created.load(manifest, canvas);
  if (token !== mountToken) {
    created.dispose();
    return null;
  }
  created.setGravityAcceleration?.(
    petStore.settings.behavior.gravity_acceleration || DEFAULT_GRAVITY_PX_S2
  );
  created.playMotion(petStore.activeMotion || 'idle');
  created.setExpression(petStore.activeExpression || 'neutral');
  return created;
}

async function mountManifest(manifest: PetManifest | null): Promise<void> {
  if (!manifest) return;
  const token = ++mountToken;
  disposeAdapter();

  canvasMode.value = manifest.type === 'vrm' ? '3d' : '2d';
  await nextTick();
  if (token !== mountToken) return;

  const primaryCanvas = canvasMode.value === '3d' ? canvas3dRef.value : canvas2dRef.value;
  if (!primaryCanvas) return;

  watchCanvasSize(primaryCanvas);

  try {
    const built = await buildAdapter(manifest.type, manifest, primaryCanvas, token);
    if (!built) return;
    adapter = built;
    ensureRenderLoop();
    return;
  } catch (err) {
    console.warn(`[stage] ${manifest.type} adapter failed for ${manifest.id}`, err);
  }

  if (token !== mountToken) return;
  canvasMode.value = '2d';
  await nextTick();
  if (token !== mountToken) return;

  const fallbackCanvas = canvas2dRef.value;
  if (!fallbackCanvas) return;

  watchCanvasSize(fallbackCanvas);

  try {
    const fallback = await buildAdapter('sprite', { ...manifest, type: 'sprite' }, fallbackCanvas, token);
    if (!fallback) return;
    adapter = fallback;
    ensureRenderLoop();
  } catch (err) {
    console.error(`[stage] sprite fallback also failed for ${manifest.id}`, err);
  }
}

/**
 * Keep the drawing surface in step with the element it is drawn on.
 *
 * The window is resized by the host when the pet is zoomed, and the canvas follows the
 * window. The adapter only learns about that through its element, so the observer is what
 * re-fits the backing store; without it the picture would be cropped by the element or
 * stretched by the browser.
 */
function watchCanvasSize(canvas: HTMLCanvasElement): void {
  resizeObserver?.disconnect();
  if (typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    adapter?.resizeCanvas?.();
  });
  resizeObserver.observe(canvas);
}

/**
 * The loop parks itself when no adapter is mounted and is restarted by the next
 * successful mount, so it can never spin forever rendering nothing.
 */
function ensureRenderLoop(): void {
  if (loopRunning) return;
  loopRunning = true;

  const step = (now: number): void => {
    const active = adapter;
    if (!active) {
      loopRunning = false;
      rafId = null;
      return;
    }

    const targetFps = petStore.effectiveTargetFps;
    if (targetFps > 0) {
      const elapsedMs = now - lastFrameTime;
      if (elapsedMs >= 1000 / targetFps) {
        lastFrameTime = now;
        active.setMouthOpen(petStore.mouthOpenY, petStore.lipSync.mouthFormX);
        active.renderFrame(Math.min(MAX_FRAME_DELTA_SEC, elapsedMs / 1000));
      }
    }
    rafId = requestAnimationFrame(step);
  };

  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(step);
}

function handleLocalMouseMove(e: MouseEvent): void {
  const rect = stageContainerRef.value?.getBoundingClientRect();
  if (!rect) return;
  adapter?.lookAt(e.clientX - rect.left, e.clientY - rect.top);
}

function performHitTest(x: number, y: number): HitTestResult {
  return adapter?.hitTest(x, y) ?? { hit: false, area: undefined };
}

function lookAtCursor(x: number, y: number): void {
  adapter?.lookAt(x, y);
}

function applyLiveTransform(scale: number, offsetX: number, offsetY: number): void {
  adapter?.applyTransform(scale, offsetX, offsetY);
}

function spawnInteractionBurst(x: number, y: number, text = '+5 EXP'): void {
  adapter?.spawnInteractionBurst?.(x, y, text);
}

defineExpose({ performHitTest, lookAtCursor, applyLiveTransform, spawnInteractionBurst });

watch(
  [() => petStore.currentPet?.id, highDpi],
  () => void mountManifest(petStore.currentPet)
);

watch(
  () => petStore.settings.behavior.gravity_acceleration,
  (accel) => {
    if (typeof accel === 'number') adapter?.setGravityAcceleration?.(accel);
  }
);

watch(
  () => petStore.activeMotion,
  (motion) => motion && adapter?.playMotion(motion)
);

watch(
  () => petStore.activeExpression,
  (expression) => expression && adapter?.setExpression(expression)
);

watch(
  () => petStore.mouthOpenY,
  (value) => adapter?.setMouthOpen(value, petStore.lipSync.mouthFormX)
);

onMounted(() => void mountManifest(petStore.currentPet));

onBeforeUnmount(() => {
  mountToken++;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  loopRunning = false;
  resizeObserver?.disconnect();
  resizeObserver = null;
  disposeAdapter();
});
</script>

<style scoped>
.pet-canvas-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  user-select: none;
}

.stage-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
