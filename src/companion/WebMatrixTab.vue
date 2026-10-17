<template>
  <main class="holo-matrix-container">
    <div class="llm-config-box">
      <div class="pod-meta-bar">
        <span class="pod-code">
          AI NEURAL BRIDGE // 外部大模型对话网关 (OpenAI / DeepSeek / Ollama)
        </span>
        <div class="llm-top-actions">
          <button class="clear-btn" @click="testLlmGateway">
            {{ testStatusText }}
          </button>
          <label class="llm-enable-toggle">
            <input
              v-model="petStore.llmConfig.enabled"
              type="checkbox"
              @change="petStore.saveLlmConfig({})"
            />
            <span>启用远程 LLM</span>
          </label>
        </div>
      </div>
      <div class="llm-inputs-grid">
        <select
          v-model="petStore.llmConfig.provider"
          class="matrix-url-input llm-provider-select"
          @focus="emit('input-focus')"
          @blur="onConfigBlur"
        >
          <option v-for="p in providers" :key="p.id" :value="p.id">
            {{ p.label }}{{ p.requiresApiKey ? '' : '（无需 Key）' }}
          </option>
        </select>
        <input
          v-model="petStore.llmConfig.apiUrl"
          type="text"
          class="matrix-url-input"
          :placeholder="apiUrlPlaceholder"
          @focus="emit('input-focus')"
          @blur="onConfigBlur"
        />
        <div class="llm-row-2">
          <input
            v-model="petStore.llmConfig.model"
            type="text"
            class="matrix-url-input"
            placeholder="模型名称 (如 gpt-4o-mini / deepseek-chat)"
            @focus="emit('input-focus')"
            @blur="onConfigBlur"
          />
          <input
            v-model="petStore.llmConfig.apiKey"
            type="password"
            class="matrix-url-input"
            :placeholder="apiKeyPlaceholder"
            @focus="emit('input-focus')"
            @blur="onConfigBlur"
          />
        </div>
        <input
          v-model="petStore.llmConfig.customSystemPrompt"
          type="text"
          class="matrix-url-input"
          placeholder="可选自定义人设 Prompt (留空则自动根据当前宠物生成)..."
          @focus="emit('input-focus')"
          @blur="onConfigBlur"
        />
        <div class="llm-row-2">
          <input
            v-model.number="petStore.llmConfig.historyTurns"
            type="number"
            min="0"
            :max="LLM_HISTORY_MAX_TURNS"
            step="1"
            class="matrix-url-input"
            :placeholder="`记忆轮数 0~${LLM_HISTORY_MAX_TURNS}（0 = 不记忆）`"
            @focus="emit('input-focus')"
            @blur="onConfigBlur"
          />
          <label class="llm-enable-toggle">
            <input
              v-model="petStore.llmConfig.stream"
              type="checkbox"
              @change="petStore.saveLlmConfig({})"
            />
            <span>逐字流式上屏</span>
          </label>
        </div>
        <div class="llm-row-2">
          <span class="llm-memory-hint">{{ memoryHint }}</span>
          <button class="clear-btn" @click="clearMemory">清空当前宠物记忆</button>
        </div>
      </div>
    </div>

    <VoiceBridgePanel />

    <div class="matrix-address-bar">
      <span class="matrix-tag">URI //</span>
      <input
        v-model="urlInput"
        type="text"
        class="matrix-url-input"
        placeholder="输入任意外部应用地址或本地 Web 工具..."
        @focus="emit('input-focus')"
        @blur="emit('input-blur')"
        @keyup.enter="mountUrl"
      />
      <button class="matrix-go-btn" @click="mountUrl">MOUNT</button>
    </div>

    <div class="matrix-frame-wrapper">
      <iframe
        v-if="mountedUrl"
        :src="mountedUrl"
        class="matrix-iframe"
        sandbox="allow-scripts allow-forms allow-popups"
      ></iframe>
      <div v-else class="matrix-placeholder">
        <p>💠 空间网页投射矩阵已就绪</p>
        <span>
          任何挂载网页均可直接调用
          <code>window.PetBridge.act / say / system.exec</code>
        </span>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { usePetStore } from '@/store/petStore';
import VoiceBridgePanel from './VoiceBridgePanel.vue';
import { requestLlmCompletion } from '@/utils/commandEngine';
import { LLM_HISTORY_MAX_TURNS, resolveLlmHistoryMessages } from '@/utils/commandEngine';
import { listLlmProviders, resolveLlmProvider } from '@/utils/llmProviders';
import type { LlmBridgeConfig } from '@/types/pet';
import { COMPANION_STATUS_RESET_MS, LLM_REPLY_BUBBLE_MS } from '@/constants/timing';
import { COMMAND_MESSAGES, UI_TONE_LABELS } from '@/constants/messages';

const LLM_API_URL_PLACEHOLDERS: Record<string, string> = {
  openai_compatible: 'API 地址 (如 https://api.deepseek.com/v1/chat/completions)',
  anthropic: 'API 地址 (如 https://api.anthropic.com/v1/messages)',
  ollama: '本地地址 (如 http://localhost:11434/api/chat)',
};

const providers = listLlmProviders();
const apiUrlPlaceholder = computed(
  () =>
    LLM_API_URL_PLACEHOLDERS[resolveLlmProvider(petStore.llmConfig.provider).id] ??
    'API 地址'
);
const apiKeyPlaceholder = computed(() =>
  resolveLlmProvider(petStore.llmConfig.provider).requiresApiKey
    ? 'API Key (留空则使用内置离线性格脑)'
    : '本地模型无需 Key'
);

/** How much of this pet's conversation is actually being replayed, in plain numbers. */
const memoryHint = computed(() => {
  const turns = Math.floor(petStore.llmHistoryFor(petStore.currentPet?.id ?? '').length / 2);
  const window = resolveLlmHistoryMessages(petStore.llmConfig.historyTurns) / 2;
  if (window <= 0) return `记忆已关闭（已存 ${turns} 轮不会被发送）`;
  return `当前宠物已记 ${turns} 轮，每次发送最近 ${Math.min(turns, window)} 轮`;
});

function clearMemory(): void {
  const cleared = petStore.clearLlmHistory(petStore.currentPet?.id ?? '');
  emit('log', COMMAND_MESSAGES.historyCleared(cleared));
}

const props = defineProps<{
  initialUrl?: string;
}>();

const emit = defineEmits<{
  (e: 'input-focus'): void;
  (e: 'input-blur'): void;
  (e: 'log', line: string): void;
}>();

const petStore = usePetStore();
const urlInput = ref<string>(props.initialUrl || 'https://example.com');
const mountedUrl = ref<string>(props.initialUrl || '');
const testStatusText = ref<string>(UI_TONE_LABELS.idle);
let statusResetTimer: number | null = null;

watch(
  () => props.initialUrl,
  (u) => {
    if (u) {
      urlInput.value = u;
      mountedUrl.value = u;
    }
  }
);

function mountUrl(): void {
  mountedUrl.value = urlInput.value.trim();
}

function onConfigBlur(): void {
  petStore.saveLlmConfig({});
  emit('input-blur');
}

function resetStatusLater(text: string, delayMs: number): void {
  if (statusResetTimer !== null) window.clearTimeout(statusResetTimer);
  statusResetTimer = window.setTimeout(() => {
    testStatusText.value = text;
    statusResetTimer = null;
  }, delayMs);
}

async function testLlmGateway(): Promise<void> {
  // Probe with a throwaway config. Flipping the persisted `enabled` flag here meant a
  // connectivity check silently switched remote LLM on for the user.
  const probe: LlmBridgeConfig = { ...petStore.llmConfig, enabled: true };
  if (!probe.apiKey || !probe.apiUrl) {
    testStatusText.value = UI_TONE_LABELS.missingKey;
    resetStatusLater(UI_TONE_LABELS.idle, COMPANION_STATUS_RESET_MS);
    return;
  }

  testStatusText.value = UI_TONE_LABELS.pending;
  const reply = await requestLlmCompletion(
    '请用一句话向主人打个招呼',
    petStore.currentPet,
    probe
  );

  if (reply) {
    testStatusText.value = UI_TONE_LABELS.success;
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: reply,
      durationMs: LLM_REPLY_BUBBLE_MS,
    });
    emit('log', `[LLM OK] ${reply}`);
  } else {
    testStatusText.value = UI_TONE_LABELS.failure;
    emit('log', '[LLM ERR] Failed to reach endpoint');
  }
  resetStatusLater(UI_TONE_LABELS.idle, COMPANION_STATUS_RESET_MS);
}

onBeforeUnmount(() => {
  if (statusResetTimer !== null) window.clearTimeout(statusResetTimer);
});
</script>
