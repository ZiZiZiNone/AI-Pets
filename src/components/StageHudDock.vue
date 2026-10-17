<template>
  <div>
    <transition name="fade-slide">
      <div
        v-if="
          (isCursorHoveringPet || petStore.pomodoro.running || petStore.quickChatOpen) &&
          !petStore.studioOpen &&
          !petStore.bubbleText
        "
        class="holo-status-pill interactive-ui"
        @mouseenter="emit('hud-hover', true)"
        @mouseleave="emit('hud-hover', false)"
      >
        <span
          class="pill-level"
          :title="`等级 Lv.${petStore.stats.level} (${petStore.stats.xp}/${petStore.stats.xpToNext} EXP)`"
        >
          Lv.{{ petStore.stats.level }}
        </span>
        <span class="pill-stat" title="好感度 Affinity">好感 {{ petStore.stats.affinity }}%</span>
        <span class="pill-stat" title="核心能量 Energy">能量 {{ petStore.stats.energy }}%</span>
        <button
          class="pill-pomo interactive-ui"
          :class="{ running: petStore.pomodoro.running }"
          title="点击切换番茄专注计时 (25m)"
          @click.stop="handlePomodoroPillClick"
        >
          专注 {{ petStore.formattedPomodoroTime }}
        </button>
        <button
          class="pill-dnd interactive-ui"
          :class="{ active: petStore.dnd_mode }"
          :title="petStore.dnd_mode ? '勿扰模式已开启 (点击关闭)' : '开启勿扰模式'"
          @click.stop="toggleDndMode"
        >
          {{ petStore.dnd_mode ? '免打扰' : '勿扰关' }}
        </button>
        <div class="pill-xp-track">
          <div class="pill-xp-fill" :style="{ width: `${petStore.xpProgressPercent}%` }"></div>
        </div>
      </div>
    </transition>

    <div
      v-if="(isCursorHoveringPet || petStore.quickChatOpen) && !petStore.studioOpen"
      class="tactical-dock interactive-ui"
      @mouseenter="emit('hud-hover', true)"
      @mouseleave="emit('hud-hover', false)"
    >
      <button
        class="tactical-dock-btn interactive-ui"
        :class="{ active: petStore.radialMenuOpen }"
        title="展开双轨战术星盘 (右键 / Ctrl+M)"
        @click.stop="emit('toggle-radial')"
      >
        菜单
      </button>
      <button
        class="tactical-dock-btn interactive-ui"
        :class="{ active: petStore.quickChatOpen }"
        title="唤出内联智能对话与指令舱 (Ctrl+K)"
        @click.stop="toggleQuickChat"
      >
        对话
      </button>
      <button
        class="tactical-dock-btn interactive-ui"
        title="投喂全息数据糖果 (+20 能量 / +8 好感)"
        @click.stop="petStore.feedPetCareItem('全息数据糖果', 20, 8, 25)"
      >
        投喂
      </button>
      <button
        class="tactical-dock-btn interactive-ui"
        title="打开空间神经突触伴生舱"
        @click.stop="openCompanionCenter"
      >
        伴生舱
      </button>
      <button
        class="tactical-dock-btn interactive-ui"
        title="切换下一机体模型"
        @click.stop="cycleNextPet"
      >
        换宠物
      </button>
      <button
        class="tactical-dock-btn interactive-ui"
        title="CAD 全息蓝图校准工坊"
        @click.stop="petStore.studioOpen = !petStore.studioOpen"
      >
        校准
      </button>
    </div>

    <transition name="fade-slide">
      <div
        v-if="petStore.quickChatOpen && !petStore.studioOpen"
        class="inline-chat-bar interactive-ui"
        @mousedown.stop
      >
        <div v-if="matchingSlashHints.length > 0" class="slash-hint-popup">
          <button
            v-for="hint in matchingSlashHints"
            :key="hint.command"
            class="slash-hint-item"
            @click.stop="applySlashHint(hint.command)"
          >
            <span class="hint-cmd">{{ hint.usage }}</span>
            <span class="hint-desc">{{ hint.description }}</span>
          </button>
        </div>

        <div class="chat-quick-tags">
          <button @click.stop="runQuickCmd('/focus 25')">25m 专注</button>
          <button @click.stop="runQuickCmd('/fortune')">今日运势</button>
          <button @click.stop="runQuickCmd('/feed')">投喂充能</button>
          <button @click.stop="runQuickCmd('/sys')">系统巡检</button>
        </div>
        <div class="chat-input-row">
          <input
            ref="chatInputRef"
            v-model="chatInputText"
            type="text"
            class="chat-input"
            placeholder="对话或输入 / 呼出指令补全 (↑↓ 历史记录)..."
            @keydown.up.prevent="navigateHistory(-1)"
            @keydown.down.prevent="navigateHistory(1)"
            @keydown.tab.prevent="completeFirstSlashHint"
            @keyup.enter="submitChat"
            @keyup.esc="petStore.quickChatOpen = false"
          />
          <button class="chat-send-btn" @click.stop="submitChat">发送</button>
        </div>
      </div>
    </transition>

    <transition name="vortex-fade">
      <div v-if="isDragOver" class="quantum-drop-portal">
        <div class="vortex-ring"></div>
        <div class="portal-text">
          <span class="portal-tag">QUANTUM INGESTION GATEWAY</span>
          <span>⚡ 释放鼠标将文件注入 {{ petStore.currentPet?.name || '核心' }}</span>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { usePetStore } from '@/store/petStore';
import { SLASH_COMMAND_HINTS } from '@/utils/commandEngine';
import type { SlashCommandHint } from '@/types/pet';

defineProps<{
  isCursorHoveringPet: boolean;
  isDragOver: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-radial'): void;
  /**
   * Reports whether the pointer is resting on host chrome. The stage cannot decide
   * this from the sprite silhouette alone, so the dock has to say so; without it the
   * pointer crossing the gap between sprite and dock looks like leaving the pet.
   */
  (e: 'hud-hover', over: boolean): void;
}>();

const petStore = usePetStore();
const chatInputRef = ref<HTMLInputElement | null>(null);
const chatInputText = ref<string>('');
const historyCursor = ref<number>(-1);

const matchingSlashHints = computed<SlashCommandHint[]>(() => {
  const trimmed = chatInputText.value.trim();
  if (!trimmed.startsWith('/') || trimmed.includes(' ')) return [];
  const token = trimmed.toLowerCase();
  return SLASH_COMMAND_HINTS.filter((h) => h.command.startsWith(token)).slice(0, 5);
});

watch(
  () => petStore.quickChatOpen,
  (open) => {
    if (open) {
      historyCursor.value = -1;
      void nextTick(() => chatInputRef.value?.focus());
    }
  }
);

function toggleQuickChat(): void {
  petStore.markUserActivity();
  petStore.quickChatOpen = !petStore.quickChatOpen;
}

function applySlashHint(cmd: string): void {
  const needsArg = ['/focus', '/break', '/todo', '/calc', '/pet'].includes(cmd);
  chatInputText.value = needsArg ? `${cmd} ` : cmd;
  void nextTick(() => chatInputRef.value?.focus());
}

function completeFirstSlashHint(): void {
  if (matchingSlashHints.value.length > 0) {
    applySlashHint(matchingSlashHints.value[0].command);
  }
}

function navigateHistory(direction: -1 | 1): void {
  const history = petStore.commandHistory;
  if (history.length === 0) return;

  if (direction === -1) {
    historyCursor.value = Math.min(history.length - 1, historyCursor.value + 1);
    chatInputText.value = history[historyCursor.value] || '';
  } else if (historyCursor.value > 0) {
    historyCursor.value -= 1;
    chatInputText.value = history[historyCursor.value] || '';
  } else {
    historyCursor.value = -1;
    chatInputText.value = '';
  }
}

async function submitChat(): Promise<void> {
  const txt = chatInputText.value.trim();
  if (!txt) return;
  chatInputText.value = '';
  historyCursor.value = -1;
  await petStore.submitUserChatCommand(txt);
}

async function runQuickCmd(cmd: string): Promise<void> {
  await petStore.submitUserChatCommand(cmd);
}

async function openCompanionCenter(): Promise<void> {
  await petStore.dispatchPetAction({
    type: 'panel',
    mode: 'schema',
    title: '桌面宠物宿主控制中心',
  });
}

function handlePomodoroPillClick(): void {
  if (petStore.pomodoro.running) {
    petStore.togglePomodoroPause();
  } else {
    petStore.startPomodoro(25, 'focus', '深度代码冲刺');
  }
}

function toggleDndMode(): void {
  petStore.dnd_mode = !petStore.dnd_mode;
  void petStore.dispatchPatch({ dnd_mode: petStore.dnd_mode });
  petStore.scheduleAction({
    priority: 'P1',
    motion: petStore.dnd_mode ? 'sleep' : 'happy',
    expression: petStore.dnd_mode ? 'sleepy' : 'smile',
    text: petStore.dnd_mode
      ? '🔕 勿扰模式已开启：我将保持安静陪伴，不再主动弹出闲聊气泡。'
      : '🔔 勿扰模式已解除：全息语音与健康提醒已恢复工作！',
    durationMs: 3200,
  });
}

function cycleNextPet(): void {
  const list = petStore.availablePets;
  if (list.length <= 1 || !petStore.currentPet) return;
  const idx = list.findIndex((p) => p.id === petStore.currentPet?.id);
  const next = list[(idx + 1) % list.length];
  petStore.switchPetById(next.id);
}
</script>

<style scoped>
.holo-status-pill {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px 6px;
  background: var(--theme-surface, rgba(9, 13, 24, 0.9));
  backdrop-filter: blur(12px);
  border: 1px solid var(--theme-border, rgba(56, 189, 248, 0.55));
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
  box-shadow: 0 6px 18px rgba(2, 6, 23, 0.5);
  color: #f8fafc;
  font-size: 10px;
  font-weight: 700;
  font-family: "JetBrains Mono", Consolas, monospace;
  white-space: nowrap;
  z-index: 30;
}

.pill-level {
  padding: 1px 5px;
  background: var(--theme-primary, #38bdf8);
  color: #020617;
  font-weight: 800;
  border-radius: 2px;
}

.pill-stat {
  color: #e2e8f0;
}

.pill-pomo {
  padding: 1px 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #f8fafc;
  font-size: 9.5px;
  font-weight: 800;
  font-family: inherit;
  cursor: pointer;
  border-radius: 2px;
}

.pill-pomo.running {
  background: rgba(244, 63, 94, 0.25);
  border-color: #f43f5e;
  color: #fda4af;
}

.pill-dnd {
  border: none;
  background: transparent;
  font-size: 9.5px;
  font-weight: 700;
  cursor: pointer;
  padding: 0 2px;
  white-space: nowrap;
  color: #cbd5e1;
}

.pill-dnd.active {
  color: var(--theme-accent, #f43f5e);
}

.pill-xp-track {
  position: absolute;
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  background: rgba(148, 163, 184, 0.2);
  overflow: hidden;
}

.pill-xp-fill {
  height: 100%;
  background: var(--theme-primary, #38bdf8);
  transition: width 0.3s ease;
}

.tactical-dock {
  position: absolute;
  bottom: 14px;
  right: 6px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  z-index: 35;
}

/**
 * Text chips rather than glyph buttons.
 *
 * These used to be single emoji in a 32px box. Two problems: the glyphs were rendered
 * by whatever fallback font the machine had, so the set looked incoherent, and they
 * were hardcoded in this component, which made restyling the dock a source edit. A
 * short text label states the action outright, never truncates, and moves the whole
 * dock into a range a person can aim at.
 */
.tactical-dock-btn {
  width: 66px;
  height: 22px;
  background: var(--theme-surface, rgba(9, 13, 24, 0.92));
  border: 1px solid var(--theme-border, rgba(56, 189, 248, 0.6));
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: #f8fafc;
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  white-space: nowrap;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 16px rgba(2, 6, 23, 0.5);
  transition: all 0.16s ease;
}

.tactical-dock-btn:hover,
.tactical-dock-btn.active {
  transform: translateX(-3px) scale(1.08);
  background: var(--theme-primary, #38bdf8);
  color: #020617;
}

.inline-chat-bar {
  position: absolute;
  bottom: 10px;
  left: 10px;
  right: 48px;
  padding: 7px 9px;
  background: var(--theme-surface, rgba(9, 13, 24, 0.95));
  backdrop-filter: blur(16px);
  border: 1px solid var(--theme-border, rgba(56, 189, 248, 0.65));
  clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.65);
  display: flex;
  flex-direction: column;
  gap: 5px;
  z-index: 36;
}

.slash-hint-popup {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 4px;
  border-bottom: 1px dashed rgba(148, 163, 184, 0.25);
}

.slash-hint-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid transparent;
  color: #e2e8f0;
  font-size: 10px;
  text-align: left;
  cursor: pointer;
  border-radius: 2px;
}

.slash-hint-item:hover {
  border-color: var(--theme-primary, #38bdf8);
  background: rgba(56, 189, 248, 0.12);
}

.hint-cmd {
  font-weight: 800;
  color: var(--theme-primary, #38bdf8);
  font-family: "JetBrains Mono", Consolas, monospace;
}

.hint-desc {
  color: #94a3b8;
  font-size: 9.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-quick-tags {
  display: flex;
  gap: 4px;
  overflow-x: auto;
}

.chat-quick-tags button {
  padding: 2px 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #cbd5e1;
  font-size: 9.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 2px;
}

.chat-quick-tags button:hover {
  border-color: var(--theme-primary, #38bdf8);
  color: var(--theme-primary, #38bdf8);
}

.chat-input-row {
  display: flex;
  gap: 5px;
}

.chat-input {
  flex: 1;
  min-width: 0;
  padding: 4px 7px;
  background: rgba(2, 6, 23, 0.85);
  border: 1px solid rgba(56, 189, 248, 0.4);
  color: #f8fafc;
  font-size: 11px;
  outline: none;
}

.chat-send-btn {
  padding: 4px 9px;
  background: var(--theme-primary, #38bdf8);
  border: none;
  clip-path: polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
  color: #020617;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
}

.quantum-drop-portal {
  position: absolute;
  inset: 14px;
  background: rgba(9, 13, 24, 0.78);
  backdrop-filter: blur(8px);
  border: 2px dashed var(--theme-primary, #38bdf8);
  clip-path: polygon(18px 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%, 0 18px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  pointer-events: none;
  z-index: 48;
}

.vortex-ring {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  border: 3px dashed var(--theme-primary, #38bdf8);
  box-shadow: 0 0 28px var(--theme-glow, rgba(56, 189, 248, 0.6));
  animation: portal-spin 4s linear infinite;
}

@keyframes portal-spin {
  from { transform: rotate(0deg) scale(0.95); }
  50% { transform: rotate(180deg) scale(1.06); }
  to { transform: rotate(360deg) scale(0.95); }
}

.portal-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: #f8fafc;
  font-size: 12px;
  font-weight: 700;
}

.portal-tag {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--theme-primary, #38bdf8);
  font-family: "JetBrains Mono", Consolas, monospace;
}

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.18s ease;
}

.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
