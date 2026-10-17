<template>
  <transition name="visor-glitch">
    <div
      v-if="fullText"
      class="holo-speech-visor interactive-ui"
      :style="petStore.activeThemeCssVars"
      title="点击立即显示全文或关闭气泡"
      @mouseenter="petStore.markUserActivity()"
      @click.stop="handleBubbleClick"
    >
      <!-- Top Telemetry & Voice Equalizer Header -->
      <div class="visor-header">
        <div class="visor-id">
          <span class="priority-tag" :class="`prio-${activePriority.toLowerCase()}`">
            {{ activePriority }}
          </span>
          <span class="callsign">{{ petStore.currentPet?.name || 'CORE' }}</span>
        </div>

        <div class="visor-right">
          <!-- 12-Bar Live Audio RMS Spectrum Visualizer -->
          <div class="voice-spectrum">
            <span
              v-for="n in 12"
              :key="n"
              class="spec-bar"
              :style="getSpectrumBarStyle(n)"
            ></span>
          </div>
          <button
            class="visor-close-btn"
            title="关闭气泡 (Esc)"
            @click.stop="petStore.dismissCurrentBubble()"
          >
            ×
          </button>
        </div>
      </div>

      <!-- Main Typewriter Projection Area -->
      <div class="visor-body">
        <span class="typewriter-text">{{ displayedText }}</span>
        <span v-if="isTyping" class="cyber-caret">▮</span>
      </div>

      <div v-if="voiceNotice" class="visor-voice-notice">{{ voiceNotice }}</div>

      <!-- Chamfered Tactical Quick-Reply Chips -->
      <div v-if="quickReplies.length > 0 && !isTyping" class="visor-actions">
        <button
          v-for="(btn, idx) in quickReplies"
          :key="idx"
          class="tactical-chip interactive-ui"
          @click.stop="handleQuickReply(btn.action)"
        >
          <span class="chip-index">0{{ idx + 1 }}</span>
          <span>{{ btn.label }}</span>
        </button>
      </div>

      <!-- Holographic Corner Brackets & Pointer Vector -->
      <span class="visor-corner tl"></span>
      <span class="visor-corner br"></span>
      <div class="visor-beam-pointer"></div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { usePetStore } from '@/store/petStore';
import { globalLipSync } from '@/utils/audioLipSync';
import { synthesizeSpeech } from '@/utils/voiceEngine';
import { normalizeVoiceSettings } from '@/utils/yamlLoader';
import type { PetActionConfig, VoiceSettings } from '@/types/pet';
import {
  TYPEWRITER_BUDGET_MS_PER_CHAR,
  TYPEWRITER_MAX_MS,
  TYPEWRITER_MIN_MS,
  TYPEWRITER_MS_PER_CHAR,
} from '@/constants/timing';

const petStore = usePetStore();

const displayedText = ref<string>('');
const isTyping = ref<boolean>(false);
const voiceNotice = ref<string>('');
let typewriterTimer: number | null = null;

const fullText = computed(() => petStore.bubbleText);
const quickReplies = computed(() => petStore.bubbleQuickReplies);
const activePriority = computed(() => petStore.currentAction?.priority || 'P2');

function getSpectrumBarStyle(index: number): Record<string, string> {
  const rms = petStore.mouthOpenY;
  const bands = petStore.lipSync.bands;
  if (rms <= 0.02 && !isTyping.value) {
    return { height: '2px', opacity: '0.35' };
  }
  const bandVal =
    bands && bands.length > 0 ? bands[index % bands.length] : rms;
  const activeLevel = Math.max(bandVal, rms, isTyping.value ? 0.45 : 0.05);
  const harmonic = Math.abs(
    Math.sin(index * 1.3 + displayedText.value.length * 0.6)
  );
  const h = Math.max(
    2,
    Math.min(12, Math.round(activeLevel * 12 * (0.4 + harmonic * 0.6)))
  );
  return {
    height: `${h}px`,
    opacity: String(0.55 + activeLevel * 0.45),
  };
}

function handleBubbleClick(): void {
  if (isTyping.value) {
    stopTypewriter();
    displayedText.value = fullText.value;
    isTyping.value = false;
  } else {
    petStore.dismissCurrentBubble();
  }
}

function startTypewriter(text: string): void {
  stopTypewriter();
  if (!text) {
    displayedText.value = '';
    isTyping.value = false;
    globalLipSync.stop((frame) => {
      petStore.broadcastLipSync(frame);
    });
    return;
  }

  displayedText.value = '';
  isTyping.value = true;
  let index = 0;
  const chars = Array.from(text);

  const activeTask = petStore.currentAction;
  if (activeTask?.audioUrl) {
    void globalLipSync.playAudioWithLipSync(activeTask.audioUrl, (frame) => {
      petStore.broadcastLipSync(frame);
    });
  } else {
    void speakWithConfiguredVoice(text, chars.length);
  }

  const step = () => {
    if (index < chars.length) {
      displayedText.value += chars[index];
      index++;
      typewriterTimer = window.setTimeout(step, TYPEWRITER_MS_PER_CHAR);
    } else {
      isTyping.value = false;
      typewriterTimer = null;
    }
  };

  step();
}

function stopTypewriter(): void {
  if (typewriterTimer !== null) {
    clearTimeout(typewriterTimer);
    typewriterTimer = null;
  }
}

/**
 * Voice settings for the pet currently on stage: the host's, with the pet's own overrides.
 *
 * Resolved per utterance rather than cached, so switching pets switches voice without a
 * reload and an edit to either file takes effect on the next sentence.
 */
function effectiveVoice(): VoiceSettings {
  return normalizeVoiceSettings(petStore.currentPet?.voice, petStore.settings.audio);
}

/** The mouth still has to move when there is no audio, so the fallback is never skipped. */
function runSyntheticLipSync(charCount: number): void {
  if (!petStore.settings.audio.enable_lip_sync) return;
  // The synthetic mouth must finish with the typewriter, so it is budgeted off the
  // same per-character cost rather than the bubble's longer display window.
  const syncDuration = Math.min(
    TYPEWRITER_MAX_MS,
    Math.max(TYPEWRITER_MIN_MS, charCount * TYPEWRITER_BUDGET_MS_PER_CHAR)
  );
  globalLipSync.startSyntheticLipSync(syncDuration, (frame) => {
    petStore.broadcastLipSync(frame);
  });
}

async function speakWithConfiguredVoice(text: string, charCount: number): Promise<void> {
  voiceNotice.value = '';
  if (petStore.dnd_mode || !petStore.settings.audio.enable_tts) {
    runSyntheticLipSync(charCount);
    return;
  }

  const outcome = await synthesizeSpeech(text, effectiveVoice().tts);
  if (outcome.kind === 'system_voice') {
    globalLipSync.speakWithWebSpeechTts(text, petStore.volume, outcome);
    runSyntheticLipSync(charCount);
    return;
  }
  if (outcome.kind === 'audio') {
    // The analyser drives the mouth from the real waveform, so no synthetic pass here.
    void globalLipSync.playAudioWithLipSync(outcome.blob, (frame) => {
      petStore.broadcastLipSync(frame);
    });
    return;
  }

  // Reported in the bubble instead of a log: a pet that silently stops speaking looks
  // like a broken feature, and the reason is usually a one-field config fix.
  voiceNotice.value = outcome.reason;
  runSyntheticLipSync(charCount);
}

async function handleQuickReply(action: PetActionConfig): Promise<void> {
  await petStore.dispatchPetAction(action);
}

watch(
  fullText,
  (newVal) => {
    startTypewriter(newVal);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  stopTypewriter();
});
</script>

<style scoped>
.holo-speech-visor {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: 316px;
  padding: 9px 13px 11px;
  background: var(--theme-surface, rgba(9, 13, 24, 0.9));
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--theme-border, rgba(56, 189, 248, 0.55));
  clip-path: polygon(
    12px 0,
    100% 0,
    100% calc(100% - 12px),
    calc(100% - 12px) 100%,
    0 100%,
    0 12px
  );
  box-shadow: 0 12px 28px rgba(2, 6, 23, 0.55),
    inset 0 0 18px var(--theme-glow, rgba(56, 189, 248, 0.2));
  color: var(--theme-text, #f8fafc);
  z-index: 32;
  pointer-events: auto;
  cursor: pointer;
}

.visor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 5px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.22);
}

.visor-id {
  display: flex;
  align-items: center;
  gap: 6px;
}

.visor-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.visor-close-btn {
  border: none;
  background: transparent;
  color: var(--theme-subtext, #94a3b8);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
}

.visor-close-btn:hover {
  color: var(--theme-accent, #f43f5e);
}

.priority-tag {
  padding: 1px 5px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.5px;
  border-radius: 2px;
  background: var(--theme-primary, #38bdf8);
  color: #020617;
}

.priority-tag.prio-p0,
.priority-tag.prio-p1 {
  background: var(--theme-accent, #f43f5e);
  color: #ffffff;
}

.callsign {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.6px;
  color: var(--theme-subtext, #94a3b8);
  text-transform: uppercase;
  max-width: 155px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-spectrum {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}

.spec-bar {
  width: 2.5px;
  background: var(--theme-primary, #38bdf8);
  border-radius: 1px;
  transition: height 0.06s ease;
}

.spec-bar:nth-child(even) {
  background: var(--theme-accent, #f43f5e);
}

.visor-body {
  font-size: 12.5px;
  line-height: 1.5;
  font-weight: 500;
  word-break: break-word;
  letter-spacing: 0.2px;
}

.cyber-caret {
  display: inline-block;
  margin-left: 3px;
  color: var(--theme-primary, #38bdf8);
  animation: pulse-caret 0.6s steps(2, start) infinite;
}

.visor-voice-notice {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px dashed rgba(244, 63, 94, 0.4);
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--theme-accent, #f43f5e);
  word-break: break-word;
}

.visor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed rgba(148, 163, 184, 0.25);
}

.tactical-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--theme-border, rgba(56, 189, 248, 0.5));
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: var(--theme-text, #f8fafc);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tactical-chip:hover {
  background: var(--theme-primary, #38bdf8);
  color: #020617;
}

.chip-index {
  font-size: 9px;
  opacity: 0.75;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.visor-corner {
  position: absolute;
  width: 8px;
  height: 8px;
  border-color: var(--theme-primary, #38bdf8);
  border-style: solid;
  pointer-events: none;
}

.visor-corner.tl {
  top: 2px;
  left: 12px;
  border-width: 2px 0 0 2px;
}

.visor-corner.br {
  bottom: 2px;
  right: 12px;
  border-width: 0 2px 2px 0;
}

.visor-beam-pointer {
  position: absolute;
  bottom: -6px;
  left: 50%;
  transform: translateX(-50%);
  width: 28px;
  height: 3px;
  background: var(--theme-primary, #38bdf8);
  box-shadow: 0 0 10px var(--theme-primary, #38bdf8);
}

@keyframes pulse-caret {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.visor-glitch-enter-active,
.visor-glitch-leave-active {
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.visor-glitch-enter-from,
.visor-glitch-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px) scale(0.95);
}
</style>
