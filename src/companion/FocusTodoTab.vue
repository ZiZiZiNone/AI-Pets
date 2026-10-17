<template>
  <main class="spatial-pods-stream">
    <div class="spatial-pod-card full-width">
      <div class="pod-meta-bar">
        <span class="pod-code">POMODORO // QUANTUM CHRONO WORKSTATION</span>
        <span class="pomo-badge">{{ careStore.pomodoro.mode.toUpperCase() }}</span>
      </div>
      <div class="pomo-display-row">
        <div class="pomo-clock">{{ careStore.formattedPomodoroTime }}</div>
        <div class="pomo-meta">
          <div class="pomo-input-group">
            <input
              :value="careStore.pomodoro.taskLabel"
              type="text"
              class="pomo-task-input"
              placeholder="当前专注目标..."
              @input="handleTaskLabelInput(($event.target as HTMLInputElement).value)"
              @focus="emit('input-focus')"
              @blur="emit('input-blur')"
            />
            <input
              v-model.number="customMinutes"
              type="number"
              min="1"
              max="180"
              class="pomo-min-input"
              title="自定义分钟数 (1~180m)"
              @focus="emit('input-focus')"
              @blur="emit('input-blur')"            />
          </div>
          <div class="cyber-slider-track" style="height: 5px">
            <div
              class="cyber-slider-fill"
              :style="{ width: `${careStore.pomoProgressPercent}%` }"
            ></div>
          </div>
          <div class="pomo-btn-row">
            <button
              class="cyber-action-btn primary"
              @click="petStore.startPomodoro(customMinutes || POMODORO_DEFAULT_MINUTES, 'focus', careStore.pomodoro.taskLabel)"
            >
              🔥 {{ customMinutes || POMODORO_DEFAULT_MINUTES }}m 专注
            </button>
            <button
              class="cyber-action-btn"
              @click="petStore.startPomodoro(45, 'focus', careStore.pomodoro.taskLabel)"
            >
              ⚡ 45m 深度
            </button>
            <button
              class="cyber-action-btn"
              @click="petStore.startPomodoro(5, 'short_break', '护眼补水休息')"
            >
              🍵 5m 小憩
            </button>
            <button class="cyber-action-btn" @click="petStore.togglePomodoroPause()">
              {{ careStore.pomodoro.running ? '⏸ 暂停' : '▶ 继续' }}
            </button>
            <button class="cyber-action-btn danger" @click="petStore.stopPomodoro()">
              ⏹ 重置
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="spatial-pod-card full-width">
      <div class="pod-meta-bar">
        <span class="pod-code">MISSION MATRIX // 待办任务清单 (完成奖励 +20 EXP)</span>
        <div class="todo-meta-right">
          <span class="pod-code">
            {{ careStore.todos.filter((t) => t.done).length }}/{{ careStore.todos.length }} DONE
          </span>
          <button
            v-if="careStore.todos.some((t) => t.done)"
            class="clear-btn"
            @click="petStore.clearCompletedTodos()"
          >
            清理已完成
          </button>
        </div>
      </div>

      <div class="todo-add-row">
        <select v-model="newTodoPriority" class="todo-prio-select">
          <option value="high">🔥 高优</option>
          <option value="normal">💠 常规</option>
          <option value="low">🌱 低优</option>
        </select>
        <input
          v-model="newTodoText"
          type="text"
          class="matrix-url-input"
          placeholder="输入新的开发任务或待办事项，按回车添加..."
          @focus="emit('input-focus')"
          @blur="emit('input-blur')"
          @keyup.enter="handleAddTodo"
        />
        <button class="matrix-go-btn" @click="handleAddTodo">+ 添加</button>
      </div>

      <div class="todo-list">
        <div
          v-for="item in careStore.todos"
          :key="item.id"
          class="todo-item"
          :class="{ done: item.done }"
        >
          <input
            type="checkbox"
            :checked="item.done"
            @change="petStore.toggleTodo(item.id)"
          />
          <span class="prio-pill" :class="`prio-${item.priority || 'normal'}`">
            {{ item.priority === 'high' ? 'HIGH' : item.priority === 'low' ? 'LOW' : 'NORM' }}
          </span>
          <span class="todo-text" @click="petStore.toggleTodo(item.id)">
            {{ item.text }}
          </span>
          <button class="todo-del" @click="petStore.removeTodo(item.id)">✕</button>
        </div>
        <div v-if="careStore.todos.length === 0" class="term-empty">
          暂无待办事项，享受无 Bug 的轻松时刻吧 ✨
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { usePetStore } from '@/store/petStore';
import { useCareStore } from '@/store/careStore';
import { POMODORO_DEFAULT_MINUTES } from '@/constants/timing';

const emit = defineEmits<{
  (e: 'input-focus'): void;
  (e: 'input-blur'): void;
  (e: 'log', line: string): void;
}>();

const petStore = usePetStore();
const careStore = useCareStore();

const customMinutes = ref<number>(POMODORO_DEFAULT_MINUTES);
const newTodoText = ref<string>('');
const newTodoPriority = ref<'high' | 'normal' | 'low'>('normal');

// Writing the label straight into store state would skip the cross-window broadcast,
// so the companion commits it through the store action instead of binding v-model.
function handleTaskLabelInput(value: string): void {
  careStore.setPomodoroTaskLabel(value);
}

function handleAddTodo(): void {
  const clean = newTodoText.value.trim();
  if (!clean) return;
  petStore.addTodo(clean, newTodoPriority.value);
  emit('log', `[TODO:${newTodoPriority.value.toUpperCase()}] ${clean}`);
  newTodoText.value = '';
}
</script>
