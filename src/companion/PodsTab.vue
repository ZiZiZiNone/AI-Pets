<template>
  <main class="spatial-pods-stream">
    <div
      v-for="(widget, idx) in schema.widgets"
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
import { reactive } from 'vue';
import SduiWidgetView from './SduiWidgetView.vue';
import type { SduiSchema } from '@/types/pet';
import { POD_NUDGE_STEP_PX } from '@/constants/timing';

/**
 * The pods render the schema's own widgets, not a copy of them.
 *
 * A copy was the wrong shape: the companion replaces the whole schema when a remote host
 * sends a new one, so the copy was replaced with it anyway — but in between, every live
 * sync of the host's state refreshed the copy from the schema and threw away what the
 * user had just toggled. A switch would light up, the sync would run, and the switch
 * would go back to what it said before. The schema is the companion's own state and the
 * place the host's values are read back into, so it is also the place a local change
 * belongs.
 */

defineProps<{
  schema: SduiSchema;
  podOffsets: Record<string, number>;
}>();

const emit = defineEmits<{
  (e: 'nudge-pod', id: string, delta: number): void;
  (e: 'log', line: string): void;
}>();

const collapsedPods = reactive<Record<string, boolean>>({});

function togglePodCollapse(id: string): void {
  collapsedPods[id] = !collapsedPods[id];
}
</script>
