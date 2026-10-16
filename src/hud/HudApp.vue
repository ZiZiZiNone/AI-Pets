<template>
  <div class="hud-canvas-overlay">
    <svg class="hud-svg-layer" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker
          id="hudArrowHead"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L9,3 z" fill="context-stroke" />
        </marker>
      </defs>

      <g v-for="item in arrowAnnotations" :key="item.id">
        <line
          :x1="item.x"
          :y1="item.y"
          :x2="item.targetX ?? item.x + 120"
          :y2="item.targetY ?? item.y + 80"
          :stroke="item.color || '#38bdf8'"
          stroke-width="2.5"
          stroke-dasharray="8 4"
          marker-end="url(#hudArrowHead)"
        />
        <circle :cx="item.x" :cy="item.y" r="4" :fill="item.color || '#38bdf8'" />
      </g>
    </svg>

    <div
      v-for="item in annotations"
      :key="item.id"
      class="hud-item"
      :class="`hud-type-${item.type}`"
      :style="getHudItemStyle(item)"
    >
      <template v-if="item.type === 'box'">
        <span class="corner tl"></span>
        <span class="corner tr"></span>
        <span class="corner bl"></span>
        <span class="corner br"></span>
        <div class="scan-laser-line"></div>
        <div class="center-reticle"></div>
      </template>

      <div v-if="item.label || item.countdownSec !== undefined" class="hud-badge">
        <span class="hud-dot"></span>
        <span v-if="item.label" class="hud-title">{{ item.label }}</span>
        <span
          v-if="item.countdownSec !== undefined && item.countdownSec > 0"
          class="hud-timer"
        >
          T-{{ item.countdownSec }}s
        </span>
      </div>

      <div v-if="item.sublabel" class="hud-sublabel">
        {{ item.sublabel }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { HudAnnotation } from '@/types/pet';

const annotations = ref<HudAnnotation[]>([]);
const unlistenFns: UnlistenFn[] = [];
let countdownInterval: number | null = null;

const arrowAnnotations = computed(() =>
  annotations.value.filter((a) => a.type === 'arrow')
);

function getHudItemStyle(item: HudAnnotation): Record<string, string> {
  const borderColor = item.color || '#38bdf8';
  return {
    left: `${item.x}px`,
    top: `${item.y}px`,
    width: item.w ? `${item.w}px` : 'auto',
    height: item.h ? `${item.h}px` : 'auto',
    '--hud-color': borderColor,
  };
}

function upsertAnnotations(incoming: HudAnnotation[]): void {
  const now = Date.now();
  for (const raw of incoming) {
    const item: HudAnnotation = {
      ...raw,
      id: raw.id || `hud_${now}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: now,
    };
    const idx = annotations.value.findIndex((a) => a.id === item.id);
    if (idx >= 0) {
      annotations.value[idx] = item;
    } else {
      annotations.value.push(item);
    }
  }
}

onMounted(async () => {
  unlistenFns.push(
    await listen<{
      annotation?: HudAnnotation;
      annotations?: HudAnnotation[];
    }>('hud-draw', (evt) => {
      const p = evt.payload;
      if (Array.isArray(p.annotations)) {
        upsertAnnotations(p.annotations);
      } else if (p.annotation) {
        upsertAnnotations([p.annotation]);
      } else if ('x' in p && 'y' in p) {
        upsertAnnotations([p as unknown as HudAnnotation]);
      }
    })
  );

  unlistenFns.push(
    await listen<{ id?: string; app_id?: string }>('hud-clear', (evt) => {
      const { id, app_id } = evt.payload || {};
      if (id) {
        annotations.value = annotations.value.filter((a) => a.id !== id);
      } else if (app_id) {
        annotations.value = annotations.value.filter((a) => a.app_id !== app_id);
      } else {
        annotations.value = [];
      }
    })
  );

  countdownInterval = window.setInterval(() => {
    const now = Date.now();
    annotations.value = annotations.value.filter((item) => {
      if (item.ttlMs && item.createdAt && now - item.createdAt >= item.ttlMs) {
        return false;
      }
      if (typeof item.countdownSec === 'number') {
        if (item.countdownSec <= 1) {
          return false;
        }
        item.countdownSec -= 1;
      }
      return true;
    });
  }, 1000);
});

onBeforeUnmount(() => {
  for (const fn of unlistenFns) {
    fn();
  }
  if (countdownInterval !== null) {
    clearInterval(countdownInterval);
  }
});
</script>

<style scoped>
.hud-canvas-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  user-select: none;
  overflow: hidden;
}

.hud-svg-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.hud-item {
  position: absolute;
  pointer-events: none;
  box-sizing: border-box;
}

.hud-type-box {
  border: 1.5px solid var(--hud-color, #38bdf8);
  background: rgba(56, 189, 248, 0.06);
  box-shadow: 0 0 24px rgba(56, 189, 248, 0.3),
    inset 0 0 16px rgba(56, 189, 248, 0.14);
  overflow: hidden;
}

.scan-laser-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--hud-color, #38bdf8), transparent);
  animation: hud-scan 2.4s ease-in-out infinite;
}

.center-reticle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
  border: 1px dashed var(--hud-color, #38bdf8);
  border-radius: 50%;
  opacity: 0.55;
}

@keyframes hud-scan {
  0% { top: 0%; opacity: 0.3; }
  50% { top: 98%; opacity: 0.95; }
  100% { top: 0%; opacity: 0.3; }
}

.corner {
  position: absolute;
  width: 12px;
  height: 12px;
  border-color: #ffffff;
  border-style: solid;
}

.corner.tl {
  top: 0;
  left: 0;
  border-width: 3px 0 0 3px;
}

.corner.tr {
  top: 0;
  right: 0;
  border-width: 3px 3px 0 0;
}

.corner.bl {
  bottom: 0;
  left: 0;
  border-width: 0 0 3px 3px;
}

.corner.br {
  bottom: 0;
  right: 0;
  border-width: 0 3px 3px 0;
}

.hud-badge {
  position: absolute;
  top: -28px;
  left: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 10px;
  background: rgba(9, 13, 24, 0.92);
  border: 1px solid var(--hud-color, #38bdf8);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: #f8fafc;
  font-size: 11px;
  font-weight: 800;
  font-family: "JetBrains Mono", Consolas, monospace;
  white-space: nowrap;
}

.hud-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hud-color, #38bdf8);
  box-shadow: 0 0 8px var(--hud-color, #38bdf8);
}

.hud-timer {
  padding: 1px 6px;
  background: #f43f5e;
  color: #ffffff;
  font-size: 10px;
}

.hud-sublabel {
  position: absolute;
  bottom: -24px;
  left: 0;
  padding: 2px 8px;
  background: rgba(9, 13, 24, 0.85);
  border-left: 2px solid var(--hud-color, #38bdf8);
  color: #bae6fd;
  font-size: 10px;
  font-family: "JetBrains Mono", Consolas, monospace;
  white-space: nowrap;
}
</style>
