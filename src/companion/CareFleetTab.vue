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
        <span class="pod-code">
          PERSONA FLEET // 机体编队 · {{ filteredPets.length }} / {{ petStore.availablePets.length }}
        </span>
        <span v-if="activeCluster" class="pomo-badge" @click="activeCluster = ''">
          {{ activeCluster }} ✕
        </span>
      </div>

      <input
        v-model="query"
        class="fleet-search"
        type="search"
        placeholder="搜索名字 / 别名 / 简介"
        spellcheck="false"
      />

      <div class="fleet-cluster-row">
        <button
          class="fleet-cluster-chip"
          :class="{ active: activeCluster === '' }"
          @click="activeCluster = ''"
        >
          全部 {{ petStore.availablePets.length }}
        </button>
        <button
          v-for="cluster in clusters"
          :key="cluster.name"
          class="fleet-cluster-chip"
          :class="{ active: activeCluster === cluster.name }"
          @click="activeCluster = cluster.name"
        >
          {{ cluster.name }} {{ cluster.count }}
        </button>
      </div>

      <div v-for="group in groups" :key="group.name" class="fleet-group">
        <div class="fleet-group-head">
          <span class="fleet-group-name">{{ group.name }}</span>
          <span class="fleet-group-count">{{ group.pets.length }}</span>
        </div>
        <div class="persona-grid">
          <div
            v-for="pet in group.pets"
            :key="pet.id"
            class="persona-card"
            :class="{ active: petStore.active_pet_id === pet.id }"
            @click="petStore.switchPetById(pet.id)"
          >
            <div class="persona-card-head">
              <span class="persona-name">{{ pet.name }}</span>
              <span class="persona-type">{{ pet.alias || pet.type.toUpperCase() }}</span>
            </div>
            <p class="persona-desc">{{ pet.description }}</p>
          </div>
        </div>
      </div>

      <p v-if="!groups.length" class="fleet-empty">没有匹配的机体。</p>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { usePetStore } from '@/store/petStore';
import type { PetManifest } from '@/types/pet';

const emit = defineEmits<{
  (e: 'log', line: string): void;
}>();

const petStore = usePetStore();

/** The shelf a pet is filed under, or a neutral label for the ones that declare none. */
const UNFILED = '未分组';

const query = ref('');
const activeCluster = ref('');

const clusters = computed(() => {
  const counts = new Map<string, number>();
  for (const pet of petStore.availablePets) {
    const key = pet.cluster?.trim() || UNFILED;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
});

const filteredPets = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return petStore.availablePets.filter((pet) => {
    if (activeCluster.value && (pet.cluster?.trim() || UNFILED) !== activeCluster.value) {
      return false;
    }
    if (!needle) return true;
    return [pet.name, pet.alias ?? '', pet.description ?? '', pet.cluster ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
});

/** Grouped in the same order as the chips, so the list and the filter agree. */
const groups = computed(() => {
  const order = new Map(clusters.value.map((cluster, index) => [cluster.name, index]));
  const buckets = new Map<string, PetManifest[]>();
  for (const pet of filteredPets.value) {
    const key = pet.cluster?.trim() || UNFILED;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(pet);
    else buckets.set(key, [pet]);
  }
  return [...buckets.entries()]
    .map(([name, pets]) => ({ name, pets }))
    .sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
});

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
