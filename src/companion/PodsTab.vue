<template>
  <main class="spatial-pods-stream">
    <div
      v-for="(widget, idx) in widgets"
      :key="widget.id"
      class="spatial-pod-card"
      :class="[
        idx % 2 === 0 ? 'align-left' : 'align-right',
        { collapsed: collapsedPods[widget.id] }
      ]"
      :style="{ transform: `translateX(${podOffsets[widget.id] || 0}px)` }"
    >
      <div class="pod-meta-bar" @dblclick="togglePodCollapse(widget.id)">
        <span class="pod-code">POD-0{{ idx + 1 }} // {{ widget.type.toUpperCase() }}</span>
        <div class="pod-bar-actions">
          <button
            class="nudge-btn"
            title="左移微调"
            @click.stop="emit('nudge-pod', widget.id, -POD_NUDGE_STEP_PX)"
          >
            ◂
          </button>
          <button
            class="nudge-btn"
            title="右移微调"
            @click.stop="emit('nudge-pod', widget.id, POD_NUDGE_STEP_PX)"
          >
            ▸
          </button>
          <button
            class="nudge-btn"
            :title="collapsedPods[widget.id] ? '展开模块' : '折叠模块'"
            @click.stop="togglePodCollapse(widget.id)"
          >
            {{ collapsedPods[widget.id] ? '+' : '−' }}
          </button>
        </div>
      </div>

      <div v-show="!collapsedPods[widget.id]" class="pod-content">
        <!--
          The card chrome (numbering, nudge, collapse) belongs to the top level. What a
          control *is* lives in SduiWidgetView, which renders itself for the children of a
          `container`, so a nested widget is the same component one level down rather than
          a second copy of every branch.
        -->
        <SduiWidgetView :widget="widget" :app-id="schema.app_id" @log="(l) => emit('log', l)" />
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import SduiWidgetView from './SduiWidgetView.vue';
import type { SduiSchema, SduiWidget } from '@/types/pet';
import { POD_NUDGE_STEP_PX } from '@/constants/timing';

const props = defineProps<{
  schema: SduiSchema;
  podOffsets: Record<string, number>;
}>();

const emit = defineEmits<{
  (e: 'nudge-pod', id: string, delta: number): void;
  (e: 'log', line: string): void;
}>();

const collapsedPods = reactive<Record<string, boolean>>({});

// The schema arrives through a prop but is driven by a remote host over the bus, so the
// view works on its own deep copy. Editing in place would otherwise mutate a prop and
// corrupt the state the companion emits back to the stage.
const widgets = ref<SduiWidget[]>(structuredClone(props.schema.widgets));

watch(
  () => props.schema.widgets,
  (next) => {
    widgets.value = structuredClone(next);
  },
  { deep: true }
);

function togglePodCollapse(id: string): void {
  collapsedPods[id] = !collapsedPods[id];
}
</script>
