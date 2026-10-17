<template>
  <div class="llm-config-box voice-bridge-box">
    <div class="pod-meta-bar">
      <span class="pod-code">VOICE BRIDGE // 语音合成与语音识别</span>
      <div class="llm-top-actions">
        <button class="clear-btn" @click="testTts">{{ ttsButtonLabel }}</button>
        <button class="clear-btn" @click="toggleRecording">{{ sttButtonLabel }}</button>
      </div>
    </div>

    <div class="voice-section">
      <span class="voice-section-title">合成 TTS</span>
      <select
        v-model="tts.provider"
        class="matrix-url-input"
        @change="persist()"
      >
        <option v-for="entry in ttsProviders" :key="entry.id" :value="entry.id">
          {{ entry.label }}
        </option>
      </select>
      <span class="voice-hint">{{ ttsHint }}</span>
    </div>

    <div v-if="tts.provider === 'web_speech'" class="llm-inputs-grid">
      <div class="llm-row-2">
        <input v-model="tts.web_speech.lang" class="matrix-url-input" placeholder="语言 (zh-CN)" @blur="persist()" />
        <input v-model="tts.web_speech.voice" class="matrix-url-input" placeholder="音色名称（留空=系统默认）" @blur="persist()" />
      </div>
      <div class="llm-row-2">
        <input v-model.number="tts.web_speech.rate" type="number" step="0.05" min="0.5" max="3" class="matrix-url-input" placeholder="语速 1.0" @blur="persist()" />
        <input v-model.number="tts.web_speech.pitch" type="number" step="0.05" min="0" max="2" class="matrix-url-input" placeholder="音高 1.0" @blur="persist()" />
      </div>
    </div>

    <div v-else-if="tts.provider === 'openai_compatible'" class="llm-inputs-grid">
      <input v-model="tts.http.api_url" class="matrix-url-input" placeholder="接口地址 …/v1/audio/speech" @blur="persist()" />
      <div class="llm-row-2">
        <input v-model="tts.http.model" class="matrix-url-input" placeholder="模型 tts-1" @blur="persist()" />
        <input v-model="tts.http.voice" class="matrix-url-input" placeholder="音色 alloy" @blur="persist()" />
      </div>
      <div class="llm-row-2">
        <input v-model="tts.http.api_key" type="password" class="matrix-url-input" placeholder="API Key（本地服务可留空）" @blur="persist()" />
        <input v-model="tts.http.format" class="matrix-url-input" placeholder="音频格式 mp3" @blur="persist()" />
      </div>
    </div>

    <div v-else-if="tts.provider === 'local_engine'" class="llm-inputs-grid">
      <input v-model="tts.local.exe" class="matrix-url-input" placeholder="引擎可执行文件绝对路径" @blur="persist()" />
      <input v-model="tts.local.model_dir" class="matrix-url-input" placeholder="模型目录（代入 {model_dir}）" @blur="persist()" />
      <div class="llm-row-2">
        <input v-model.number="tts.local.speed" type="number" step="0.05" min="0.5" max="2" class="matrix-url-input" placeholder="语速 1.0" @blur="persist()" />
        <input v-model.number="tts.local.num_threads" type="number" min="1" max="16" class="matrix-url-input" placeholder="线程数 2" @blur="persist()" />
      </div>
      <span class="voice-hint">参数模板可在 config/settings.yaml 的 audio.tts.local.args 中修改</span>
    </div>

    <div class="voice-section">
      <span class="voice-section-title">识别 STT</span>
      <select v-model="stt.provider" class="matrix-url-input" @change="persist()">
        <option v-for="entry in sttProviders" :key="entry.id" :value="entry.id">
          {{ entry.label }}
        </option>
      </select>
      <span class="voice-hint">{{ sttHint }}</span>
    </div>

    <div v-if="stt.provider === 'web_speech'" class="llm-inputs-grid">
      <div class="llm-row-2">
        <input v-model="stt.web_speech.lang" class="matrix-url-input" placeholder="语言 zh-CN" @blur="persist()" />
        <input v-model.number="stt.web_speech.max_ms" type="number" min="1000" class="matrix-url-input" placeholder="最长录音毫秒" @blur="persist()" />
      </div>
    </div>

    <div v-else-if="stt.provider === 'openai_compatible'" class="llm-inputs-grid">
      <input v-model="stt.http.api_url" class="matrix-url-input" placeholder="接口地址 …/v1/audio/transcriptions" @blur="persist()" />
      <div class="llm-row-2">
        <input v-model="stt.http.model" class="matrix-url-input" placeholder="模型 whisper-1" @blur="persist()" />
        <input v-model="stt.http.api_key" type="password" class="matrix-url-input" placeholder="API Key" @blur="persist()" />
      </div>
      <div class="llm-row-2">
        <input v-model="stt.http.language" class="matrix-url-input" placeholder="语言 zh（留空自动）" @blur="persist()" />
        <input v-model="stt.http.prompt" class="matrix-url-input" placeholder="提示词（可选，专有名词）" @blur="persist()" />
      </div>
    </div>

    <div v-else-if="stt.provider === 'local_engine'" class="llm-inputs-grid">
      <input v-model="stt.local.exe" class="matrix-url-input" placeholder="引擎可执行文件绝对路径" @blur="persist()" />
      <input v-model="stt.local.model_dir" class="matrix-url-input" placeholder="模型目录（代入 {model_dir}）" @blur="persist()" />
      <input
        v-model="stt.local.input_path"
        class="matrix-url-input"
        placeholder="可选：直接转写一个 wav 文件（无麦克风时验证链路）"
        @blur="persist()"
      />
      <button class="clear-btn" @click="transcribeFile">转写该文件</button>
    </div>

    <label class="llm-enable-toggle voice-auto-send">
      <input v-model="stt.auto_send" type="checkbox" @change="persist()" />
      <span>识别完成后自动发送给宠物</span>
    </label>

    <div v-if="lastTranscript" class="voice-transcript">
      <input v-model="lastTranscript" class="matrix-url-input" placeholder="识别结果" />
      <button class="clear-btn" @click="sendTranscript">发送</button>
    </div>

    <div v-if="voiceLevel > 0 || isRecording" class="voice-meter">
      <span class="voice-meter-fill" :style="{ width: `${Math.round(voiceLevel * 100)}%` }"></span>
    </div>

    <div v-if="statusText" class="voice-status">{{ statusText }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { usePetStore } from '@/store/petStore';
import {
  describeMicrophoneFailure,
  hasMicrophoneSupport,
  listenWithWebSpeechRecognition,
  recordWavFromMicrophone,
} from '@/utils/audioCapture';
import {
  describeSttReadiness,
  describeTtsReadiness,
  listSttProviders,
  listTtsProviders,
  sttProviderInfo,
  ttsProviderInfo,
} from '@/utils/voiceProviders';
import { synthesizeSpeech, transcribeAudio } from '@/utils/voiceEngine';
import { globalLipSync } from '@/utils/audioLipSync';

const petStore = usePetStore();
const ttsProviders = listTtsProviders();
const sttProviders = listSttProviders();

const tts = computed(() => petStore.settings.audio.tts);
const stt = computed(() => petStore.settings.audio.stt);

const statusText = ref<string>('');
const lastTranscript = ref<string>('');
const isRecording = ref<boolean>(false);
const voiceLevel = ref<number>(0);
const ttsBusy = ref<boolean>(false);
let recorderAbort: AbortController | null = null;

/** What the selected mode talks to, plus why it cannot run when it cannot. */
const ttsHint = computed(() => {
  const info = ttsProviderInfo(tts.value.provider);
  const readiness = describeTtsReadiness(tts.value);
  return readiness.usable ? info.hint : `${info.hint}｜未就绪：${readiness.reason}`;
});

const sttHint = computed(() => {
  const info = sttProviderInfo(stt.value.provider);
  const readiness = describeSttReadiness(stt.value);
  if (!readiness.usable) return `${info.hint}｜未就绪：${readiness.reason}`;
  return hasMicrophoneSupport()
    ? info.hint
    : `${info.hint}｜提示：当前环境不支持录音，可用“转写该文件”验证链路`;
});

const ttsButtonLabel = computed(() => (ttsBusy.value ? '朗读中…' : '测试朗读'));
const sttButtonLabel = computed(() => (isRecording.value ? '停止识别' : '开始识别'));

function persist(): void {
  void petStore.saveHostSettings();
}

function report(message: string): void {
  statusText.value = message;
}

async function testTts(): Promise<void> {
  const sample = '你好，我是你的桌面宠物，现在正在朗读这句话。';
  ttsBusy.value = true;
  report('正在合成…');
  try {
    const outcome = await synthesizeSpeech(sample, tts.value);
    if (outcome.kind === 'system_voice') {
      globalLipSync.speakWithWebSpeechTts(sample, petStore.volume, outcome);
      report('已交给系统语音朗读');
    } else if (outcome.kind === 'audio') {
      await globalLipSync.playAudioWithLipSync(outcome.blob, (frame) => {
        petStore.broadcastLipSync(frame);
      });
      report(`合成成功，音频 ${(outcome.blob.size / 1024).toFixed(0)} KB`);
    } else {
      report(outcome.reason);
    }
  } finally {
    ttsBusy.value = false;
  }
}

async function toggleRecording(): Promise<void> {
  if (isRecording.value) {
    recorderAbort?.abort();
    return;
  }
  if (stt.value.provider === 'none') {
    report('请先选择一种识别方式');
    return;
  }
  isRecording.value = true;
  voiceLevel.value = 0;
  report('正在识别…');
  try {
    if (stt.value.provider === 'web_speech') {
      const text = await listenWithWebSpeechRecognition(stt.value.web_speech);
      handleTranscript(text);
      return;
    }

    recorderAbort = new AbortController();
    const recorded = await recordWavFromMicrophone({
      maxMs: stt.value.web_speech.max_ms,
      signal: recorderAbort.signal,
      onLevel: (level) => {
        voiceLevel.value = level;
      },
    });
    report(`录到 ${(recorded.durationMs / 1000).toFixed(1)} 秒，正在转写…`);
    const outcome = await transcribeAudio(recorded.bytes, stt.value);
    if (!outcome.ok) {
      report(outcome.reason);
      return;
    }
    handleTranscript(outcome.text);
  } catch (error) {
    // Permission problems are reported by name and location, never as a bare code.
    report(error instanceof Error ? error.message : describeMicrophoneFailure(error));
  } finally {
    isRecording.value = false;
    voiceLevel.value = 0;
    recorderAbort = null;
  }
}

async function transcribeFile(): Promise<void> {
  const path = stt.value.local.input_path.trim();
  if (!path) {
    report('请先填写要转写的 wav 文件绝对路径');
    return;
  }
  report('正在转写文件…');
  const outcome = await transcribeAudio(null, stt.value);
  if (!outcome.ok) {
    report(outcome.reason);
    return;
  }
  handleTranscript(outcome.text);
}

function handleTranscript(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    report('没有识别到内容，可以再试一次或改用键盘输入');
    return;
  }
  lastTranscript.value = trimmed;
  report(`识别完成：${trimmed}`);
  if (stt.value.auto_send && !petStore.dnd_mode) {
    void petStore.submitUserChatCommand(trimmed);
    report(`已发送给宠物：${trimmed}`);
  }
}

function sendTranscript(): void {
  const text = lastTranscript.value.trim();
  if (!text) return;
  void petStore.submitUserChatCommand(text);
  report(`已发送给宠物：${text}`);
}

onBeforeUnmount(() => {
  recorderAbort?.abort();
});
</script>

<style scoped>
.voice-bridge-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.voice-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-section-title {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.5px;
  color: var(--pod-primary, #38bdf8);
  font-family: "JetBrains Mono", Consolas, monospace;
}

.voice-hint {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.4;
}

.voice-auto-send {
  margin-top: 2px;
}

.voice-transcript {
  display: flex;
  align-items: center;
  gap: 5px;
}

.voice-meter {
  height: 4px;
  background: rgba(2, 6, 23, 0.9);
  border: 1px solid rgba(56, 189, 248, 0.35);
  overflow: hidden;
}

.voice-meter-fill {
  display: block;
  height: 100%;
  background: var(--pod-primary, #38bdf8);
  transition: width 0.08s linear;
}

.voice-status {
  padding: 4px 6px;
  border-top: 1px dashed rgba(148, 163, 184, 0.3);
  font-size: 10px;
  line-height: 1.45;
  color: #bae6fd;
  word-break: break-word;
}
</style>
