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
        <input
          v-model="petStore.llmConfig.apiUrl"
          type="text"
          class="matrix-url-input"
          placeholder="API 地址 (如 https://api.openai.com/v1/chat/completions)"
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
            placeholder="API Key (留空则使用内置离线性格脑)"
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
      </div>
    </div>

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
import { onBeforeUnmount, ref, watch } from 'vue';
import { usePetStore } from '@/store/petStore';
import { requestLlmCompletion } from '@/utils/commandEngine';
import type { LlmBridgeConfig } from '@/types/pet';
import { COMPANION_STATUS_RESET_MS, LLM_REPLY_BUBBLE_MS } from '@/constants/timing';
import { UI_TONE_LABELS } from '@/constants/messages';

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
