<template>
  <transition name="astrolabe-expand">
    <div
      v-if="petStore.radialMenuOpen"
      class="tactical-astrolabe-layer interactive-ui"
      :style="petStore.activeThemeCssVars"
      @click.self="closeMenu"
    >
      <!-- SVG Counter-Rotating Gyroscopic Astrolabe & Laser Leader Lines -->
      <svg class="astrolabe-svg" :viewBox="stageViewBox">
        <defs>
          <radialGradient id="coreHubGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" :stop-color="petStore.activeTheme.primary" stop-opacity="0.35" />
            <stop offset="100%" :stop-color="petStore.activeTheme.primary" stop-opacity="0" />
          </radialGradient>
        </defs>

        <circle :cx="stageCenterX" :cy="RADIAL_MENU_CENTER_Y_PX" r="135" fill="url(#coreHubGlow)" />

        <!-- Outer CW Rotating Degree Ring -->
        <g class="orbit-ring-cw" :transform-origin="hubOrigin">
          <circle
            :cx="stageCenterX"
            :cy="RADIAL_MENU_CENTER_Y_PX"
            :r="RADIAL_MENU_RADIUS_X_PX"
            fill="none"
            :stroke="petStore.activeTheme.primary"
            stroke-width="1.2"
            stroke-dasharray="22 10 4 10"
            opacity="0.65"
          />
        </g>

        <!-- Inner CCW Rotating Tactical Ring -->
        <g class="orbit-ring-ccw" :transform-origin="hubOrigin">
          <circle
            :cx="stageCenterX"
            :cy="RADIAL_MENU_CENTER_Y_PX"
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
            :x1="stageCenterX"
            :y1="RADIAL_MENU_CENTER_Y_PX"
            :x2="stageCenterX + coord.x"
            :y2="RADIAL_MENU_CENTER_Y_PX + coord.y"
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
            :cx="stageCenterX + coord.x * 0.55"
            :cy="RADIAL_MENU_CENTER_Y_PX + coord.y * 0.55"
            r="2.2"
            :fill="petStore.activeTheme.primary"
          />
        </g>
      </svg>

      <!-- Orbital Chamfered Tactical Wing Nodes -->
      <div class="orbital-hub" :style="hubStyle">
        <button
          v-for="(item, idx) in primaryItems"
          :key="item.id"
          class="tactical-wing-node interactive-ui"
          :class="{
            active: activePrimaryId === item.id,
            external: !!item.app_id,
          }"
          :style="getNodeTransformStyle(idx)"
          @click.stop="handleNodeGesture(item, 'click')"
          @dblclick.stop="handleNodeGesture(item, 'double_click')"
          @pointerdown="startPress(item)"
          @pointerup="cancelPress()"
          @pointerleave="cancelPress()"
          @pointercancel="cancelPress()"
          @mouseenter="startHoverIntent(item)"
          @mouseleave="cancelHoverIntent()"
        >
          <span class="wing-index">0{{ idx + 1 }}</span>
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

        <!-- The astrolabe is a shape, not an instruction. This says what to do with it. -->
        <span class="hub-hint">点击节点展开二级菜单 · Esc 关闭</span>
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
              :class="{ badged: !!sub.badge }"
              @click.stop="handleNodeGesture(sub, 'click')"
              @dblclick.stop="handleNodeGesture(sub, 'double_click')"
              @pointerdown="startPress(sub)"
              @pointerup="cancelPress()"
              @pointerleave="cancelPress()"
              @pointercancel="cancelPress()"
              @mouseenter="startHoverIntent(sub)"
              @mouseleave="cancelHoverIntent()"
            >
              <span class="blade-num">#{{ sIdx + 1 }}</span>
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
import {
  RADIAL_MENU_CENTER_Y_PX,
  RADIAL_MENU_RADIUS_X_PX,
  RADIAL_MENU_RADIUS_Y_PX,
  RADIAL_MENU_START_ANGLE_RAD,
  STAGE_HEIGHT_PX,
  STAGE_WIDTH_PX,
} from '@/constants/timing';
import type { MenuGesture, MenuInteractionDef, MenuItemSchema } from '@/types/pet';
import { longPressConsumesPress, planMenuGesture, resolveMenuInteraction } from '@/utils/menuInteraction';

const petStore = usePetStore();
const activePrimaryId = ref<string | null>(null);

/**
 * The menu as it stands right now.
 *
 * Rebuilt when the astrolabe opens rather than kept for the whole session: a program
 * registers, replaces and drops its items while the menu is closed, and an open menu
 * has to show the registration state of the moment it was opened.
 */
const menuTree = ref<MenuItemSchema[]>([]);

const stageCenterX = STAGE_WIDTH_PX / 2;
const stageViewBox = `0 0 ${STAGE_WIDTH_PX} ${STAGE_HEIGHT_PX}`;
const hubOrigin = `${stageCenterX} ${RADIAL_MENU_CENTER_Y_PX}`;
const hubStyle = {
  top: `${RADIAL_MENU_CENTER_Y_PX}px`,
  left: `${stageCenterX}px`,
};

const primaryItems = computed<MenuItemSchema[]>(() => menuTree.value);

/**
 * Rebuild the menu from the registration state of the moment.
 *
 * Called when the astrolabe opens and whenever the registry changes while it is open,
 * so a program that refreshes its items is seen without waiting for the next open.
 */
function rebuildMenu(): void {
  const tree = petStore.buildMenuTree();
  menuTree.value = tree;
  // The expanded item may have been withdrawn by the program that registered it; holding
  // on to its id would leave the second level panel pointing at nothing.
  if (activePrimaryId.value && !tree.some((item) => item.id === activePrimaryId.value)) {
    activePrimaryId.value = null;
  }
}

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

  return primaryItems.value.map((_, index) => {
    const angle =
      RADIAL_MENU_START_ANGLE_RAD + (index / total) * Math.PI * 2;
    return {
      x: Math.round(Math.cos(angle) * RADIAL_MENU_RADIUS_X_PX),
      y: Math.round(Math.sin(angle) * RADIAL_MENU_RADIUS_Y_PX),
    };
  });
});

function getNodeTransformStyle(index: number): Record<string, string> {
  const coord = nodeCoordinates.value[index] || { x: 0, y: 0 };
  return {
    transform: `translate(calc(-50% + ${coord.x}px), calc(-50% + ${coord.y}px))`,
  };
}

async function handleNodeGesture(item: MenuItemSchema, gesture: MenuGesture): Promise<void> {
  petStore.markUserActivity();
  if (gesture === 'click' && suppressNextClick) {
    // The pointer-up that ends a long press also produces a click. Acting on it would make
    // one press do the item's long-press job *and* its click job, which the author asked
    // for as two separate things.
    suppressNextClick = false;
    return;
  }
  const interaction = interactionFor(item);
  const hasChildren = Array.isArray(item.children) && item.children.length > 0;

  switch (planMenuGesture(hasChildren, interaction, gesture)) {
    case 'expand':
      activePrimaryId.value = activePrimaryId.value === item.id ? null : item.id;
      return;
    case 'run_action':
      if (!item.action) return;
      await petStore.dispatchPetAction(item.action);
      closeMenu();
      return;
    case 'ignore':
      // A gesture this item is not bound to does nothing at all. Falling back to "open the
      // submenu" is what made a single click the only gesture anything could respond to.
      return;
  }
}

/**
 * Gestures that need a duration are driven from here rather than from the template.
 *
 * Both timers are keyed to the item they started on, so moving the pointer off cancels the
 * pending gesture instead of letting it fire on whatever the pointer reached next.
 */
let pressTimer: number | null = null;
let hoverTimer: number | null = null;
let suppressNextClick = false;

function interactionFor(item: MenuItemSchema): Required<MenuInteractionDef> {
  return resolveMenuInteraction(
    item,
    petStore.currentPet?.menu_interaction,
    petStore.globalMenuInteraction
  );
}

function startPress(item: MenuItemSchema): void {
  cancelPress();
  // Clear it here rather than in `cancelPress`: pointer-up runs before the click it
  // produces, so clearing on pointer-up would drop the suppression the long press just set.
  // A new press cannot start before the previous press's click has been delivered.
  suppressNextClick = false;
  const interaction = interactionFor(item);
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    const hasChildren = Array.isArray(item.children) && item.children.length > 0;
    // Only a long press that actually did something may eat the release's click. Suppressing
    // it unconditionally made every slightly slow click a no-op (the shipped defaults bind
    // `long_press` to nothing), which is invisible until someone presses a little too long.
    suppressNextClick = longPressConsumesPress(hasChildren, interaction);
    void handleNodeGesture(item, 'long_press');
  }, interaction.long_press_ms);
}

function cancelPress(): void {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function startHoverIntent(item: MenuItemSchema): void {
  cancelHoverIntent();
  const { hover_intent_ms: delay } = interactionFor(item);
  hoverTimer = window.setTimeout(() => {
    hoverTimer = null;
    void handleNodeGesture(item, 'hover');
  }, delay);
}

function cancelHoverIntent(): void {
  if (hoverTimer !== null) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

function closeMenu(): void {
  cancelPress();
  cancelHoverIntent();
  activePrimaryId.value = null;
  petStore.radialMenuOpen = false;
}

/**
 * Report a menu whose two gestures collide, once per item.
 *
 * The mistake is invisible in the interface — the item opens its submenu and its action
 * never runs — so a console line is the only place the author can find out.
 */
const warnedInteractionIds = new Set<string>();

function reportInteractionWarnings(): void {
  for (const warning of petStore.menuInteractionWarnings) {
    if (warnedInteractionIds.has(warning)) continue;
    warnedInteractionIds.add(warning);
    console.warn(`[menu_interaction] ${warning}`);
  }
}

watch(
  () => petStore.radialMenuOpen,
  (isOpen) => {
    if (!isOpen) {
      activePrimaryId.value = null;
      menuTree.value = [];
      return;
    }
    rebuildMenu();
    reportInteractionWarnings();
    if (
      petStore.menuInteraction.auto_expand_first &&
      primaryItems.value.length > 0 &&
      !activePrimaryId.value
    ) {
      const firstWithChildren = primaryItems.value.find(
        (m) => m.children && m.children.length > 0
      );
      if (firstWithChildren) {
        activePrimaryId.value = firstWithChildren.id;
      }
    }
  }
);

/**
 * The registry can also change while the menu is open: a program that refreshes its
 * items after its own state changed has to be seen at once, not at the next open.
 */
watch(
  () => petStore.mergedMenuTree,
  () => {
    if (petStore.radialMenuOpen) rebuildMenu();
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

/**
 * The hub is the only thing that sits at the menu centre. It used to inherit the
 * `top/left` offset that positions it, but that binding was on the layer itself, where
 * it overrode `inset: 0` and clipped the whole astrolabe to the bottom-right quadrant.
 * The blade deck was then laid out in half the stage width, which is what made its
 * labels unreadable. The offset now lives here, where it belongs.
 */
.orbital-hub {
  position: absolute;
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

/**
 * One line under the hub that says what the ring is for.
 *
 * The nodes are arranged on an ellipse and the leader lines point at the core, which
 * reads as an instrument rather than as something to press. Without a sentence, the
 * only way to find out that a node opens a submenu is to press it.
 */
.hub-hint {
  position: absolute;
  top: 24px;
  left: 0;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--theme-subtext, #94a3b8);
  text-shadow: 0 1px 4px rgba(2, 6, 23, 0.95);
  pointer-events: none;
}

.holo-subdeck {
  position: absolute;
  bottom: 8px;
  left: 10px;
  /* 右侧让出状态坞的宽度，否则展开的子面板会盖住那六个按钮 */
  right: 76px;
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
  flex-wrap: wrap;
  align-items: flex-start;
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
  line-height: 1.5;
  font-family: "JetBrains Mono", Consolas, monospace;
}

/**
 * Wrap instead of ellipsing, and never squeeze the label below six characters.
 *
 * The deck is two columns inside a 360px stage, so a single-line label had roughly
 * 110px to work with and any real menu name was cut mid-character. Letting the label
 * wrap keeps every declared action readable instead of hiding it behind a "…". The
 * `min-width` floor matters because CJK can break between any two characters: without
 * it a flex item happily collapses to one glyph per line.
 */
.blade-text {
  flex: 1 1 auto;
  min-width: 6em;
  line-height: 1.45;
  overflow-wrap: break-word;
}

/**
 * A tag such as OVERDRIVE shares the row but drops to its own line rather than
 * narrowing the label next to it.
 */
.blade-badge {
  flex: 0 0 auto;
  padding: 1px 4px;
  font-size: 8px;
  font-weight: 800;
  background: var(--theme-accent, #f43f5e);
  color: #ffffff;
  border-radius: 2px;
  white-space: nowrap;
}
</style>
