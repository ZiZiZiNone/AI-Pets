<template>
  <transition name="astrolabe-expand">
    <div
      v-if="petStore.radialMenuOpen"
      class="tactical-astrolabe-layer interactive-ui"
      :style="petStore.activeThemeCssVars"
      @click.self="closeMenu"
    >
      <!-- SVG Counter-Rotating Gyroscopic Astrolabe & Laser Leader Lines -->
      <svg class="astrolabe-svg" viewBox="0 0 360 420">
        <defs>
          <radialGradient id="coreHubGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" :stop-color="petStore.activeTheme.primary" stop-opacity="0.35" />
            <stop offset="100%" :stop-color="petStore.activeTheme.primary" stop-opacity="0" />
          </radialGradient>
        </defs>

        <circle cx="180" cy="218" r="135" fill="url(#coreHubGlow)" />

        <!-- Outer CW Rotating Degree Ring -->
        <g class="orbit-ring-cw" transform-origin="180 218">
          <circle
            cx="180"
            cy="218"
            r="122"
            fill="none"
            :stroke="petStore.activeTheme.primary"
            stroke-width="1.2"
            stroke-dasharray="22 10 4 10"
            opacity="0.65"
          />
        </g>

        <!-- Inner CCW Rotating Tactical Ring -->
        <g class="orbit-ring-ccw" transform-origin="180 218">
          <circle
            cx="180"
            cy="218"
            r="96"
            fill="none"
            :stroke="petStore.activeTheme.accent"
            stroke-width="1"
            stroke-dasharray="8 14"
            opacity="0.6"
          />
        </g>

        <!-- Laser Vector Leader Lines from Core to Each Wing Node -->
        <g v-for="(coord, idx) in nodeCoordinates" :key="'line_' + idx">
          <line
            x1="180"
            y1="218"
            :x2="180 + coord.x"
            :y2="218 + coord.y"
            :stroke="
              activePrimaryId === primaryItems[idx]?.id
                ? petStore.activeTheme.accent
                : petStore.activeTheme.primary
            "
            stroke-width="1.4"
            stroke-dasharray="3 3"
            opacity="0.55"
          />
          <circle
            :cx="180 + coord.x * 0.55"
            :cy="218 + coord.y * 0.55"
            r="2.2"
            :fill="petStore.activeTheme.primary"
          />
        </g>
      </svg>

      <!-- Orbital Chamfered Tactical Wing Nodes -->
      <div class="orbital-hub">
        <button
          v-for="(item, idx) in primaryItems"
          :key="item.id"
          class="tactical-wing-node interactive-ui"
          :class="{
            active: activePrimaryId === item.id,
            external: !!item.app_id,
          }"
          :style="getNodeTransformStyle(idx)"
          @click.stop="handlePrimaryClick(item)"
        >
          <span class="wing-index">0{{ idx + 1 }}</span>
          <span class="wing-icon">{{ item.icon || '💠' }}</span>
          <span class="wing-label">{{ item.label }}</span>
          <span v-if="item.app_id" class="hotplug-beacon" title="外部热插拔应用菜单"></span>
        </button>

        <!-- Center Core Lock / Close Button -->
        <button
          class="core-lock-btn interactive-ui"
          title="收起战术星盘 (右键 / Esc)"
          @click.stop="closeMenu"
        >
          <span>✕</span>
        </button>
      </div>

      <!-- Secondary Holographic Blade Deck -->
      <transition name="blade-slide">
        <div
          v-if="activeSecondaryItems.length > 0"
          class="holo-subdeck interactive-ui"
        >
          <div class="subdeck-header">
            <span class="subdeck-tag">SECTOR // {{ activePrimaryLabel }}</span>
            <span class="subdeck-count">{{ activeSecondaryItems.length }} MODULES</span>
          </div>

          <div class="subdeck-grid">
            <button
              v-for="(sub, sIdx) in activeSecondaryItems"
              :key="sub.id"
              class="subdeck-blade interactive-ui"
              @click.stop="handleSubItemClick(sub)"
            >
              <span class="blade-num">#{{ sIdx + 1 }}</span>
              <span class="blade-icon">{{ sub.icon || '▸' }}</span>
              <span class="blade-text">{{ sub.label }}</span>
              <span v-if="sub.badge" class="blade-badge">{{ sub.badge }}</span>
            </button>
          </div>
        </div>
      </transition>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { usePetStore } from '@/store/petStore';
import type { MenuItemSchema } from '@/types/pet';

const petStore = usePetStore();
const activePrimaryId = ref<string | null>(null);

const primaryItems = computed<MenuItemSchema[]>(() => petStore.mergedMenuTree);

const activePrimaryItem = computed<MenuItemSchema | undefined>(() =>
  primaryItems.value.find((item) => item.id === activePrimaryId.value)
);

const activePrimaryLabel = computed<string>(
  () => activePrimaryItem.value?.label || 'TACTICAL'
);

const activeSecondaryItems = computed<MenuItemSchema[]>(
  () => activePrimaryItem.value?.children || []
);

const nodeCoordinates = computed<Array<{ x: number; y: number }>>(() => {
  const total = Math.max(1, primaryItems.value.length);
  const radiusX = 122;
  const radiusY = 114;
  const startAngle = -Math.PI / 2;

  return primaryItems.value.map((_, index) => {
    const angle = startAngle + (index / total) * Math.PI * 2;
    return {
      x: Math.round(Math.cos(angle) * radiusX),
      y: Math.round(Math.sin(angle) * radiusY),
    };
  });
});

function getNodeTransformStyle(index: number): Record<string, string> {
  const coord = nodeCoordinates.value[index] || { x: 0, y: 0 };
  return {
    transform: `translate(calc(-50% + ${coord.x}px), calc(-50% + ${coord.y}px))`,
  };
}

async function handlePrimaryClick(item: MenuItemSchema): Promise<void> {
  petStore.markUserActivity();
  if (item.children && item.children.length > 0) {
    activePrimaryId.value = activePrimaryId.value === item.id ? null : item.id;
    return;
  }

  if (item.action) {
    await petStore.dispatchPetAction(item.action);
    closeMenu();
  }
}

async function handleSubItemClick(sub: MenuItemSchema): Promise<void> {
  petStore.markUserActivity();
  if (sub.action) {
    await petStore.dispatchPetAction(sub.action);
    closeMenu();
  }
}

function closeMenu(): void {
  activePrimaryId.value = null;
  petStore.radialMenuOpen = false;
}

watch(
  () => petStore.radialMenuOpen,
  (isOpen) => {
    if (!isOpen) {
      activePrimaryId.value = null;
    } else if (primaryItems.value.length > 0 && !activePrimaryId.value) {
      const firstWithChildren = primaryItems.value.find(
        (m) => m.children && m.children.length > 0
      );
      if (firstWithChildren) {
        activePrimaryId.value = firstWithChildren.id;
      }
    }
  }
);
</script>

<style scoped>
.tactical-astrolabe-layer {
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: auto;
}

.astrolabe-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.orbit-ring-cw {
  animation: spin-cw 26s linear infinite;
}

.orbit-ring-ccw {
  animation: spin-ccw 18s linear infinite;
}

@keyframes spin-cw {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes spin-ccw {
  from { transform: rotate(360deg); }
  to { transform: rotate(0deg); }
}

.orbital-hub {
  position: absolute;
  top: 218px;
  left: 180px;
  width: 0;
  height: 0;
  pointer-events: none;
}

.tactical-wing-node {
  position: absolute;
  top: 0;
  left: 0;
  min-width: 86px;
  height: 36px;
  padding: 0 12px;
  background: var(--theme-surface, rgba(9, 13, 24, 0.9));
  backdrop-filter: blur(12px);
  border: 1px solid var(--theme-border, rgba(56, 189, 248, 0.55));
  clip-path: polygon(
    10px 0,
    calc(100% - 10px) 0,
    100% 50%,
    calc(100% - 10px) 100%,
    10px 100%,
    0 50%
  );
  box-shadow: 0 6px 18px rgba(2, 6, 23, 0.55);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: var(--theme-text, #f8fafc);
  cursor: pointer;
  pointer-events: auto;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.tactical-wing-node:hover,
.tactical-wing-node.active {
  background: var(--theme-primary, #38bdf8);
  color: #020617;
  border-color: #ffffff;
  box-shadow: 0 0 20px var(--theme-glow, rgba(56, 189, 248, 0.65));
}

.tactical-wing-node.external {
  border-color: #10b981;
}

.wing-index {
  font-size: 9px;
  font-weight: 800;
  opacity: 0.65;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.wing-icon {
  font-size: 14px;
  line-height: 1;
}

.wing-label {
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.hotplug-beacon {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 8px #10b981;
}

.core-lock-btn {
  position: absolute;
  top: 0;
  left: 0;
  transform: translate(-50%, -50%);
  width: 34px;
  height: 34px;
  background: rgba(15, 23, 42, 0.88);
  border: 1.5px solid var(--theme-accent, #f43f5e);
  clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
  color: #ffffff;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  pointer-events: auto;
  transition: transform 0.18s ease, background 0.18s ease;
}

.core-lock-btn:hover {
  transform: translate(-50%, -50%) rotate(90deg) scale(1.12);
  background: var(--theme-accent, #f43f5e);
}

.holo-subdeck {
  position: absolute;
  bottom: 8px;
  left: 10px;
  right: 10px;
  padding: 8px 10px;
  background: var(--theme-surface, rgba(9, 13, 24, 0.94));
  backdrop-filter: blur(16px);
  border: 1px solid var(--theme-border, rgba(56, 189, 248, 0.6));
  clip-path: polygon(
    10px 0,
    100% 0,
    100% calc(100% - 10px),
    calc(100% - 10px) 100%,
    0 100%,
    0 10px
  );
  box-shadow: 0 14px 32px rgba(2, 6, 23, 0.65);
  pointer-events: auto;
}

.subdeck-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 5px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
  font-family: "JetBrains Mono", Consolas, monospace;
}

.subdeck-tag {
  font-size: 10px;
  font-weight: 800;
  color: var(--theme-primary, #38bdf8);
  letter-spacing: 0.5px;
}

.subdeck-count {
  font-size: 9px;
  color: var(--theme-subtext, #94a3b8);
}

.subdeck-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.subdeck-blade {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(148, 163, 184, 0.25);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: var(--theme-text, #f8fafc);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.subdeck-blade:hover {
  background: var(--theme-primary, #38bdf8);
  color: #020617;
  border-color: #ffffff;
}

.blade-num {
  font-size: 9px;
  opacity: 0.6;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.blade-icon {
  font-size: 13px;
}

.blade-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blade-badge {
  padding: 1px 4px;
  font-size: 8px;
  font-weight: 800;
  background: var(--theme-accent, #f43f5e);
  color: #ffffff;
  border-radius: 2px;
}
</style>
