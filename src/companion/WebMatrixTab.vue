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
        sandbox="allow-scripts allow-same-origin allow-forms"
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
import { ref, watch } from 'vue';
import { usePetStore } from '@/store/petStore';
import { requestLlmCompletion } from '@/utils/commandEngine';

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
const testStatusText = ref<string>('⚡ 测试连接');

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

async function testLlmGateway(): Promise<void> {
  petStore.saveLlmConfig({ enabled: true });
  if (!petStore.llmConfig.apiKey || !petStore.llmConfig.apiUrl) {
    testStatusText.value = '⚠️ 需填 Key';
    setTimeout(() => (testStatusText.value = '⚡ 测试连接'), 2000);
    return;
  }
  testStatusText.value = '⏳ 请求中...';
  const reply = await requestLlmCompletion(
    '请用一句话向主人打个招呼',
    petStore.currentPet,
    petStore.llmConfig
  );
  if (reply) {
    testStatusText.value = '✓ 连通正常';
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: reply,
      durationMs: 4500,
    });
    emit('log', `[LLM OK] ${reply}`);
  } else {
    testStatusText.value = '✕ 连接失败';
    emit('log', '[LLM ERR] Failed to reach endpoint');
  }
  setTimeout(() => (testStatusText.value = '⚡ 测试连接'), 2400);
}
</script>
