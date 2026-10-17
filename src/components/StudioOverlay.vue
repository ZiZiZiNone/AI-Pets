<template>
  <div
    v-if="petStore.studioOpen && petStore.currentPet"
    ref="overlayRootRef"
    class="blueprint-studio-overlay interactive-ui"
    @wheel.prevent="handleWheelZoom"
    @pointerdown="handleCanvasPointerDown"
    @pointermove="handleCanvasMouseMove"
    @pointerup="handleCanvasPointerUp"
    @pointercancel="handleCanvasPointerUp"
  >
    <div class="cad-grid-backdrop"></div>
    <div class="cad-crosshair-h"></div>
    <div class="cad-crosshair-v"></div>

    <div
      v-for="(area, idx) in hitAreas"
      :key="area.name + idx"
      class="vector-hit-box"
      :style="getHitAreaScreenStyle(area.rect)"
    >
      <span class="vector-tag">ZONE // {{ area.label }} ({{ area.name }})</span>
      <button
        class="vector-del interactive-ui"
        title="移除该碰撞感应区"
        @click.stop="removeHitArea(idx)"
      >
        ×
      </button>
    </div>

    <div
      v-if="isDrawingBox && drawRect"
      class="vector-hit-box drawing"
      :style="{
        left: `${drawRect.x}px`,
        top: `${drawRect.y}px`,
        width: `${drawRect.w}px`,
        height: `${drawRect.h}px`,
      }"
    >
      <span class="vector-tag">NEW ZONE: {{ newAreaName }}</span>
    </div>

    <div class="blueprint-deck interactive-ui" @mousedown.stop>
      <div class="deck-header">
        <span class="deck-title">📐 CAD 全息蓝图微调舱 // {{ petStore.currentPet.id }}</span>
        <button class="deck-close" @click="petStore.studioOpen = false">✕</button>
      </div>

      <div class="deck-row">
        <label>机体</label>
        <div class="persona-pills">
          <button
            v-for="pet in petStore.availablePets"
            :key="pet.id"
            :class="{ active: pet.id === petStore.currentPet.id }"
            @click="petStore.switchPetById(pet.id)"
          >
            {{ pet.name.split(' ')[0] }}
          </button>
        </div>
      </div>

      <div class="deck-row">
        <label>校准</label>
        <div class="mode-tabs">
          <button
            :class="{ active: editMode === 'transform' }"
            @click="editMode = 'transform'"
          >
            ✥ 滚轮缩放 / 拖拽位移
          </button>
          <button
            :class="{ active: editMode === 'hitarea' }"
            @click="editMode = 'hitarea'"
          >
            ⬚ 框选定义 HitArea
          </button>
        </div>
      </div>

      <div v-if="editMode === 'transform'" class="deck-row telemetry">
        <span>SCALE: {{ currentScale.toFixed(2) }}x</span>
        <span>OFFSET: [{{ Math.round(currentOffset.x) }}, {{ Math.round(currentOffset.y) }}]</span>
        <button class="deck-mini-btn" @click="resetTransform">归零</button>
      </div>

      <div v-else class="deck-row">
        <label>感应区</label>
        <select v-model="newAreaName" class="deck-select">
          <option value="head">head (头部传感器)</option>
          <option value="body">body (核心反应堆)</option>
          <option value="hand">hand (侧翼挂载点)</option>
        </select>
      </div>

      <div class="deck-row">
        <label>动作</label>
        <select v-model="previewMotion" class="deck-select" @change="applyPreviewMotion">
          <option value="idle">idle (巡航)</option>
          <option value="happy">happy (脉冲跃迁)</option>
          <option value="pat">pat (触觉反馈)</option>
          <option value="feed">feed (能量吞噬)</option>
          <option value="drag">drag (反重力提起)</option>
          <option value="climb">climb (磁吸攀爬)</option>
          <option value="sleep">sleep (低功耗隐匿)</option>
        </select>
        <label>光谱</label>
        <select v-model="previewExp" class="deck-select" @change="applyPreviewExpression">
          <option value="neutral">neutral</option>
          <option value="smile">smile</option>
          <option value="surprised">surprised</option>
          <option value="sleepy">sleepy</option>
        </select>
      </div>

      <div class="deck-action-row">
        <button class="deck-copy-btn" @click="handleCopyYaml">
          {{ copiedFlag ? '✓ 已复制 YAML' : '📋 复制 YAML' }}
        </button>
        <button class="deck-save-btn" @click="handleExportSave">
          💾 持久化写入 pet.yaml
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { usePetStore } from '@/store/petStore';
import { serializePetManifestYaml } from '@/utils/yamlLoader';
import type { RectDef } from '@/types/pet';
import {
  HIT_AREA_ORIGIN_X,
  HIT_AREA_ORIGIN_Y,
  COPY_FEEDBACK_MS,
  STUDIO_MIN_BOX_SIZE_PX,
  STUDIO_ZOOM_STEP,
  STAGE_HEIGHT_PX,
  STAGE_WIDTH_PX,
} from '@/constants/timing';
import { applyStageWindowSize, clampStageScale } from '@/utils/stageWindow';

const STAGE_CENTER_X = STAGE_WIDTH_PX / 2;
const STAGE_CENTER_Y = STAGE_HEIGHT_PX / 2;

const props = defineProps<{
  onTransformChange: (scale: number, offsetX: number, offsetY: number) => void;
}>();

const petStore = usePetStore();

const overlayRootRef = ref<HTMLElement | null>(null);
const editMode = ref<'transform' | 'hitarea'>('transform');
const newAreaName = ref<string>('head');
const previewMotion = ref<string>('idle');
const previewExp = ref<string>('neutral');
const copiedFlag = ref<boolean>(false);
let copiedResetTimer: number | null = null;

const isDraggingOffset = ref<boolean>(false);
const dragStart = ref({ x: 0, y: 0, origX: 0, origY: 0 });

const isDrawingBox = ref<boolean>(false);
const drawStart = ref({ x: 0, y: 0 });
const drawRect = ref<RectDef | null>(null);

const currentScale = computed(() => petStore.currentPet?.model.scale ?? 1.0);
const currentOffset = computed(
  () => petStore.currentPet?.model.offset ?? { x: 0, y: 0 }
);
const hitAreas = computed(() => petStore.currentPet?.hit_areas ?? []);

watch(
  () => petStore.studioOpen,
  (open) => {
    if (open) {
      previewMotion.value = petStore.activeMotion || 'idle';
      previewExp.value = petStore.activeExpression || 'neutral';
    }
  }
);

function getRelativeOverlayPoint(e: MouseEvent): { x: number; y: number } {
  const el = overlayRootRef.value || (e.currentTarget as HTMLElement | null);
  if (!el) return { x: e.clientX, y: e.clientY };
  const rect = el.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
  };
}

function getHitAreaScreenStyle(rect: RectDef): Record<string, string> {
  const scale = currentScale.value;
  const offX = currentOffset.value.x;
  const offY = currentOffset.value.y;
  const left = (rect.x - HIT_AREA_ORIGIN_X) * scale + STAGE_CENTER_X + offX;
  const top = (rect.y - HIT_AREA_ORIGIN_Y) * scale + STAGE_CENTER_Y + offY;
  return {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${Math.round(rect.w * scale)}px`,
    height: `${Math.round(rect.h * scale)}px`,
  };
}

/**
 * Zoom no longer stops where the sprite would overflow the window: the window is resized
 * to follow, and only a floor and a desktop-sized ceiling bound it.
 */
function handleWheelZoom(e: WheelEvent): void {
  if (!petStore.currentPet) return;
  const delta = e.deltaY < 0 ? STUDIO_ZOOM_STEP : -STUDIO_ZOOM_STEP;
  const nextScale = clampStageScale(Number((currentScale.value + delta).toFixed(2)));
  petStore.currentPet.model.scale = nextScale;
  props.onTransformChange(nextScale, currentOffset.value.x, currentOffset.value.y);
  void applyStageWindowSize(nextScale);
}

/**
 * Pointer capture keeps the drag bound to this element even when the cursor leaves the
 * overlay. Without it a release outside the window leaves the drag flags latched and
 * every later move keeps translating the pet.
 */
function handleCanvasPointerDown(e: PointerEvent): void {
  if (!petStore.currentPet) return;
  if ((e.target as HTMLElement | null)?.closest('.interactive-ui')) return;
  overlayRootRef.value?.setPointerCapture(e.pointerId);
  handleCanvasMouseDown(e);
}

function handleCanvasPointerUp(e: PointerEvent): void {
  if (overlayRootRef.value?.hasPointerCapture(e.pointerId)) {
    overlayRootRef.value.releasePointerCapture(e.pointerId);
  }
  handleCanvasMouseUp();
}

function handleCanvasMouseDown(e: MouseEvent): void {
  if (!petStore.currentPet) return;
  if (editMode.value === 'transform') {
    isDraggingOffset.value = true;
    dragStart.value = {
      x: e.clientX,
      y: e.clientY,
      origX: currentOffset.value.x,
      origY: currentOffset.value.y,
    };
  } else {
    const pt = getRelativeOverlayPoint(e);
    isDrawingBox.value = true;
    drawStart.value = pt;
    drawRect.value = { x: pt.x, y: pt.y, w: 2, h: 2 };
  }
}

function handleCanvasMouseMove(e: MouseEvent): void {
  if (!petStore.currentPet) return;
  if (isDraggingOffset.value) {
    const nx = dragStart.value.origX + (e.clientX - dragStart.value.x);
    const ny = dragStart.value.origY + (e.clientY - dragStart.value.y);
    petStore.currentPet.model.offset = { x: nx, y: ny };
    props.onTransformChange(currentScale.value, nx, ny);
  } else if (isDrawingBox.value && drawRect.value) {
    const pt = getRelativeOverlayPoint(e);
    const x = Math.min(drawStart.value.x, pt.x);
    const y = Math.min(drawStart.value.y, pt.y);
    const w = Math.abs(pt.x - drawStart.value.x);
    const h = Math.abs(pt.y - drawStart.value.y);
    drawRect.value = { x, y, w, h };
  }
}

function handleCanvasMouseUp(): void {
  if (isDraggingOffset.value) {
    isDraggingOffset.value = false;
  }
  if (isDrawingBox.value && drawRect.value && petStore.currentPet) {
    isDrawingBox.value = false;
    if (drawRect.value.w > STUDIO_MIN_BOX_SIZE_PX && drawRect.value.h > STUDIO_MIN_BOX_SIZE_PX) {
      const scale = currentScale.value;
      const offX = currentOffset.value.x;
      const offY = currentOffset.value.y;

      const localX = Math.round(
        (drawRect.value.x - STAGE_CENTER_X - offX) / scale + HIT_AREA_ORIGIN_X
      );
      const localY = Math.round(
        (drawRect.value.y - STAGE_CENTER_Y - offY) / scale + HIT_AREA_ORIGIN_Y
      );
      const localW = Math.round(drawRect.value.w / scale);
      const localH = Math.round(drawRect.value.h / scale);

      const labelMap: Record<string, string> = {
        head: '头部传感器',
        body: '核心反应堆',
        hand: '侧翼挂载点',
      };

      if (!petStore.currentPet.hit_areas) {
        petStore.currentPet.hit_areas = [];
      }

      const existingIdx = petStore.currentPet.hit_areas.findIndex(
        (a) => a.name === newAreaName.value
      );
      const newDef = {
        name: newAreaName.value,
        label: labelMap[newAreaName.value] || newAreaName.value,
        rect: { x: localX, y: localY, w: localW, h: localH },
        motion: newAreaName.value === 'head' ? 'pat' : 'happy',
        expression: 'smile',
        texts: [`[传感器激活] 已触发 ${labelMap[newAreaName.value] || newAreaName.value} 区域！⚡`],
      };

      if (existingIdx >= 0) {
        petStore.currentPet.hit_areas[existingIdx] = newDef;
      } else {
        petStore.currentPet.hit_areas.push(newDef);
      }
    }
    drawRect.value = null;
  }
}

function removeHitArea(idx: number): void {
  petStore.currentPet?.hit_areas?.splice(idx, 1);
}

function resetTransform(): void {
  if (!petStore.currentPet) return;
  petStore.currentPet.model.scale = 1.0;
  petStore.currentPet.model.offset = { x: 0, y: 0 };
  props.onTransformChange(1.0, 0, 0);
  void applyStageWindowSize(1.0);
}

function applyPreviewMotion(): void {
  petStore.activeMotion = previewMotion.value;
}

function applyPreviewExpression(): void {
  petStore.activeExpression = previewExp.value;
}

async function handleCopyYaml(): Promise<void> {
  if (!petStore.currentPet) return;
  const yamlText = serializePetManifestYaml(petStore.currentPet);
  try {
    await navigator.clipboard.writeText(yamlText);
    copiedFlag.value = true;
    if (copiedResetTimer !== null) window.clearTimeout(copiedResetTimer);
    copiedResetTimer = window.setTimeout(() => {
      copiedFlag.value = false;
      copiedResetTimer = null;
    }, COPY_FEEDBACK_MS);
  } catch {
    // Clipboard permission denied: leave the button untouched.
  }
}

async function handleExportSave(): Promise<void> {
  await petStore.saveCurrentPetManifest();
}
</script>

<style scoped>
.blueprint-studio-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  border: 1.5px solid rgba(56, 189, 248, 0.75);
  background: rgba(2, 6, 23, 0.28);
  cursor: crosshair;
  pointer-events: auto;
  overflow: hidden;
}

.cad-grid-backdrop {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(rgba(56, 189, 248, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(56, 189, 248, 0.12) 1px, transparent 1px);
  background-size: 20px 20px;
  pointer-events: none;
}

.cad-crosshair-h {
  position: absolute;
  top: 210px;
  left: 0;
  right: 0;
  height: 1px;
  background: rgba(56, 189, 248, 0.35);
  pointer-events: none;
}

.cad-crosshair-v {
  position: absolute;
  left: 180px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(56, 189, 248, 0.35);
  pointer-events: none;
}

.vector-hit-box {
  position: absolute;
  border: 1.5px dashed #10b981;
  background: rgba(16, 185, 129, 0.14);
  pointer-events: none;
}

.vector-hit-box.drawing {
  border-color: #facc15;
  background: rgba(250, 204, 21, 0.18);
}

.vector-tag {
  position: absolute;
  top: -17px;
  left: 0;
  padding: 1px 6px;
  background: #10b981;
  color: #020617;
  font-size: 9px;
  font-weight: 800;
  font-family: "JetBrains Mono", Consolas, monospace;
  white-space: nowrap;
}

.vector-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 15px;
  height: 15px;
  border: none;
  background: #f43f5e;
  color: #ffffff;
  font-size: 10px;
  cursor: pointer;
  pointer-events: auto;
}

.blueprint-deck {
  position: absolute;
  bottom: 6px;
  left: 6px;
  right: 6px;
  padding: 9px 11px;
  background: rgba(9, 13, 24, 0.95);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(56, 189, 248, 0.65);
  clip-path: polygon(
    10px 0,
    100% 0,
    100% calc(100% - 10px),
    calc(100% - 10px) 100%,
    0 100%,
    0 10px
  );
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: #f8fafc;
  cursor: default;
}

.deck-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 3px;
  border-bottom: 1px solid rgba(56, 189, 248, 0.25);
}

.deck-title {
  font-size: 10px;
  font-weight: 800;
  color: #38bdf8;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.deck-close {
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
}

.deck-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: #cbd5e1;
}

.deck-row.telemetry {
  justify-content: space-between;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 10px;
  color: #38bdf8;
}

.persona-pills,
.mode-tabs {
  display: flex;
  gap: 4px;
  flex: 1;
}

.persona-pills button,
.mode-tabs button {
  flex: 1;
  padding: 3px 5px;
  background: rgba(15, 23, 42, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #94a3b8;
  font-size: 9.5px;
  font-weight: 700;
  cursor: pointer;
}

.persona-pills button.active,
.mode-tabs button.active {
  background: #38bdf8;
  color: #020617;
  border-color: #ffffff;
}

.deck-select {
  flex: 1;
  padding: 2px 5px;
  background: rgba(2, 6, 23, 0.9);
  border: 1px solid rgba(56, 189, 248, 0.45);
  color: #f8fafc;
  font-size: 10px;
}

.deck-mini-btn {
  padding: 1px 7px;
  background: rgba(56, 189, 248, 0.15);
  border: 1px solid #38bdf8;
  color: #38bdf8;
  font-size: 9px;
  cursor: pointer;
}

.deck-action-row {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

.deck-copy-btn {
  padding: 5px 9px;
  background: rgba(56, 189, 248, 0.15);
  border: 1px solid #38bdf8;
  clip-path: polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
  color: #38bdf8;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
}

.deck-save-btn {
  flex: 1;
  padding: 5px 10px;
  background: linear-gradient(90deg, #38bdf8, #818cf8);
  border: none;
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: #020617;
  font-size: 10.5px;
  font-weight: 800;
  cursor: pointer;
}
</style>
