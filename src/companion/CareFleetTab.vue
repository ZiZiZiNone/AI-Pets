<template>
  <main class="spatial-pods-stream">
    <div class="spatial-pod-card full-width">
      <div class="pod-meta-bar">
        <span class="pod-code">RPG CORE TELEMETRY // 机体羁绊与能量矩阵</span>
        <span class="pomo-badge">Lv.{{ petStore.stats.level }}</span>
      </div>

      <div class="rpg-bars-grid">
        <div class="rpg-bar-item">
          <div class="slider-top">
            <span class="pod-label">✨ 晋升经验 (EXP)</span>
            <span class="slider-readout">
              {{ petStore.stats.xp }} / {{ petStore.stats.xpToNext }}
            </span>
          </div>
          <div class="cyber-slider-track">
            <div
              class="cyber-slider-fill"
              :style="{ width: `${petStore.xpProgressPercent}%` }"
            ></div>
          </div>
        </div>

        <div class="rpg-bar-item">
          <div class="slider-top">
            <span class="pod-label">❤️ 神经同步好感度</span>
            <span class="slider-readout">{{ petStore.stats.affinity }}%</span>
          </div>
          <div class="cyber-slider-track">
            <div
              class="cyber-slider-fill"
              :style="{ width: `${petStore.stats.affinity}%` }"
            ></div>
          </div>
        </div>

        <div class="rpg-bar-item">
          <div class="slider-top">
            <span class="pod-label">⚡ 核心反应堆能量</span>
            <span class="slider-readout">{{ petStore.stats.energy }}%</span>
          </div>
          <div class="cyber-slider-track">
            <div
              class="cyber-slider-fill"
              :style="{ width: `${petStore.stats.energy}%` }"
            ></div>
          </div>
        </div>
      </div>

      <div class="cyber-btn-matrix" style="margin-top: 8px">
        <button
          class="cyber-action-btn primary"
          @click="petStore.feedPetCareItem('全息数据糖果', 20, 8, 25)"
        >
          🍬 投喂数据糖果 (+20⚡)
        </button>
        <button
          class="cyber-action-btn"
          @click="petStore.feedPetCareItem('反重力高能晶块', 45, 12, 45)"
        >
          ⚡ 注入高能晶块 (+45⚡)
        </button>
        <button
          class="cyber-action-btn"
          @click="petStore.triggerFortuneDivination()"
        >
          🔮 每日代码占卜
        </button>
      </div>
    </div>

    <div class="spatial-pod-card full-width">
      <div class="pod-meta-bar">
        <span class="pod-code">KINEMATICS MATRIX // 实时姿态与光谱表情调试台</span>
      </div>
      <div class="cyber-btn-matrix">
        <button
          v-for="m in motionPreviews"
          :key="m.id"
          class="cyber-action-btn"
          @click="triggerMotionPreview(m.id, m.exp, m.label)"
        >
          {{ m.icon }} {{ m.label }}
        </button>
      </div>
    </div>

    <div class="spatial-pod-card full-width">
      <div class="pod-meta-bar">
        <span class="pod-code">PERSONA FLEET // 四大内置旗舰动态机体切换</span>
      </div>
      <div class="persona-grid">
        <div
          v-for="pet in petStore.availablePets"
          :key="pet.id"
          class="persona-card"
          :class="{ active: petStore.active_pet_id === pet.id }"
          @click="petStore.switchPetById(pet.id)"
        >
          <div class="persona-card-head">
            <span class="persona-name">{{ pet.name }}</span>
            <span class="persona-type">{{ pet.type.toUpperCase() }}</span>
          </div>
          <p class="persona-desc">{{ pet.description }}</p>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { usePetStore } from '@/store/petStore';

const emit = defineEmits<{
  (e: 'log', line: string): void;
}>();

const petStore = usePetStore();

const motionPreviews = [
  { id: 'happy', exp: 'smile', icon: '⚡', label: '脉冲跃迁' },
  { id: 'pat', exp: 'smile', icon: '👋', label: '触觉共鸣' },
  { id: 'feed', exp: 'surprised', icon: '🍬', label: '能量吞噬' },
  { id: 'climb', exp: 'smile', icon: '🧗', label: '磁吸攀爬' },
  { id: 'sleep', exp: 'sleepy', icon: '💤', label: '休眠巡航' },
  { id: 'idle', exp: 'neutral', icon: '💠', label: '标准待机' },
];

function triggerMotionPreview(motion: string, expression: string, label: string): void {
  petStore.scheduleAction({
    priority: 'P1',
    motion,
    expression,
    text: `🎛️ 伴生舱姿态指令已同步：【${label}】(${motion} / ${expression})`,
    durationMs: 3600,
  });
  emit('log', `[MOTION] ${motion} (${expression})`);
}
</script>
