<template>
  <div
    ref="stageContainerRef"
    class="pet-canvas-stage"
    @mousemove="handleLocalMouseMove"
  >
    <canvas
      v-if="canvasMode === '2d'"
      ref="canvas2dRef"
      class="stage-canvas"
      :data-high-dpi="petStore.settings.render.high_dpi ? '1' : '0'"
    ></canvas>
    <canvas
      v-else
      ref="canvas3dRef"
      class="stage-canvas"
      :data-high-dpi="petStore.settings.render.high_dpi ? '1' : '0'"
    ></canvas>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AdapterFactory } from '@/adapters/AdapterFactory';
import type { HitTestResult, IPetAdapter } from '@/adapters/IPetAdapter';
import { usePetStore } from '@/store/petStore';
import type { PetManifest } from '@/types/pet';

const petStore = usePetStore();

const stageContainerRef = ref<HTMLElement | null>(null);
const canvas2dRef = ref<HTMLCanvasElement | null>(null);
const canvas3dRef = ref<HTMLCanvasElement | null>(null);
const canvasMode = ref<'2d' | '3d'>('2d');

let adapter: IPetAdapter | null = null;
let rafId: number | null = null;
let lastFrameTime = performance.now();

async function mountManifest(manifest: PetManifest | null): Promise<void> {
  if (!manifest) return;

  if (adapter) {
    adapter.dispose();
    adapter = null;
  }

  canvasMode.value = manifest.type === 'vrm' ? '3d' : '2d';
  await nextTick();

  const targetCanvas =
    canvasMode.value === '3d' ? canvas3dRef.value : canvas2dRef.value;
  if (!targetCanvas) return;

  try {
    adapter = await AdapterFactory.createAdapter(manifest.type);
    await adapter.load(manifest, targetCanvas);
    adapter.setGravityAcceleration?.(
      petStore.settings.behavior.gravity_acceleration || 1400
    );
    adapter.playMotion(petStore.activeMotion || 'idle');
    adapter.setExpression(petStore.activeExpression || 'neutral');
  } catch (err) {
    console.warn(
      `[PetCanvasStage] Failed to load ${manifest.type} adapter for ${manifest.id}, falling back to SpriteAdapter:`,
      err
    );
    canvasMode.value = '2d';
    await nextTick();
    if (canvas2dRef.value) {
      adapter = await AdapterFactory.createAdapter('sprite');
      await adapter.load({ ...manifest, type: 'sprite' }, canvas2dRef.value);
      adapter.setGravityAcceleration?.(
        petStore.settings.behavior.gravity_acceleration || 1400
      );
    }
  }
}

function startRenderLoop(): void {
  const step = (now: number) => {
    rafId = requestAnimationFrame(step);
    if (!adapter) return;

    const targetFps = petStore.effectiveTargetFps;
    if (targetFps <= 0) return;

    const minInterval = 1000 / targetFps;
    const elapsedMs = now - lastFrameTime;
    if (elapsedMs < minInterval) return;

    const deltaSec = Math.min(0.1, elapsedMs / 1000);
    lastFrameTime = now;

    adapter.setMouthOpen(petStore.mouthOpenY, petStore.lipSync.mouthFormX);
    adapter.renderFrame(deltaSec);
  };

  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(step);
}

function handleLocalMouseMove(e: MouseEvent): void {
  if (!stageContainerRef.value) return;
  const rect = stageContainerRef.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  adapter?.lookAt(x, y);
}

function performHitTest(x: number, y: number): HitTestResult {
  if (!adapter) {
    return { hit: false };
  }
  return adapter.hitTest(x, y);
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

defineExpose({
  performHitTest,
  lookAtCursor,
  applyLiveTransform,
  spawnInteractionBurst,
});

watch(
  [() => petStore.currentPet?.id, () => petStore.settings.render.high_dpi],
  async () => {
    await mountManifest(petStore.currentPet);
  }
);

watch(
  () => petStore.settings.behavior.gravity_acceleration,
  (accel) => {
    if (typeof accel === 'number') {
      adapter?.setGravityAcceleration?.(accel);
    }
  }
);

watch(
  () => petStore.activeMotion,
  (motion) => {
    if (motion) {
      adapter?.playMotion(motion);
    }
  }
);

watch(
  () => petStore.activeExpression,
  (exp) => {
    if (exp) {
      adapter?.setExpression(exp);
    }
  }
);

watch(
  () => petStore.mouthOpenY,
  (val) => {
    adapter?.setMouthOpen(val, petStore.lipSync.mouthFormX);
  }
);

onMounted(async () => {
  await mountManifest(petStore.currentPet);
  startRenderLoop();
});

onBeforeUnmount(() => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  adapter?.dispose();
  adapter = null;
});
</script>

<style scoped>
.pet-canvas-stage {
  position: absolute;
  inset: 0;
  width: 360px;
  height: 420px;
  overflow: hidden;
  user-select: none;
}

.stage-canvas {
  width: 360px;
  height: 420px;
  display: block;
}
</style>
