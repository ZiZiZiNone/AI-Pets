<template>
  <main class="spatial-pods-stream">
    <div class="spatial-pod-card full-width">
      <div class="pod-meta-bar">
        <span class="pod-code">PLUGIN BAY // 已安装插件与权限批准</span>
        <div class="llm-top-actions">
          <span class="pomo-badge">{{ manifests.length }} 个插件</span>
          <button class="clear-btn" title="重新扫描 plugins 目录" @click="emit('refresh')">
            重新扫描
          </button>
        </div>
      </div>

      <p class="plugin-hint">
        生效权限 = 清单声明 ∩ 你的批准。声明了但没批准的权限不会生效，总线也会拒绝它。
      </p>

      <div v-for="plugin in manifests" :key="plugin.id" class="plugin-card">
        <div class="plugin-head">
          <span class="plugin-name">{{ plugin.name }}</span>
          <span class="pod-code">{{ plugin.id }} · v{{ plugin.version }}</span>
        </div>
        <p v-if="plugin.description" class="pod-desc">{{ plugin.description }}</p>

        <div
          v-for="permission in orderedPermissions(plugin)"
          :key="permission"
          class="plugin-perm-row"
        >
          <div class="plugin-perm-text">
            <span class="pod-label">{{ permission }}</span>
            <span class="pod-desc">{{ permissionLabel(permission) }}</span>
          </div>
          <span class="plugin-perm-state" :class="{ effective: isEffective(plugin.id, permission) }">
            {{ isEffective(plugin.id, permission) ? '已生效' : '未生效' }}
          </span>
          <button
            class="cyber-switch"
            :class="{ active: isApproved(plugin.id, permission) }"
            :title="isApproved(plugin.id, permission) ? '点击撤销批准' : '点击批准'"
            @click="emit('toggle', plugin.id, permission)"
          >
            <span class="switch-blade"></span>
            <span class="switch-state">{{ isApproved(plugin.id, permission) ? 'ON' : 'OFF' }}</span>
          </button>
        </div>

        <p class="plugin-summary">
          已生效 {{ effectiveCount(plugin.id) }} / {{ plugin.permissions.length }} 项
        </p>
      </div>

      <p v-if="!manifests.length" class="term-empty">
        还没有装上插件。把插件目录放进仓库的 plugins 目录即可，宿主会自动发现。
      </p>
    </div>

    <div v-if="issues.length" class="spatial-pod-card full-width">
      <div class="pod-meta-bar">
        <span class="pod-code">MANIFEST ISSUES // 清单异常</span>
        <span class="pomo-badge">{{ issues.length }} 条</span>
      </div>
      <div v-for="(issue, index) in issues" :key="index" class="plugin-issue-row">
        <span class="plugin-issue-plugin">{{ issue.pluginId }}</span>
        <span class="plugin-issue-field">{{ issue.field }}</span>
        <span class="pod-desc">{{ issue.message }}</span>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import {
  PLUGIN_PERMISSIONS,
  type PluginManifest,
  type PluginManifestIssue,
  type PluginPermission,
} from '@/utils/pluginManifest';

/**
 * The plugin sheet.
 *
 * It renders two tables and decides nothing: what a plugin wants is what its manifest
 * declares, what it gets is what the user approved, and the host hands the intersection
 * to the bus. Both halves are shown side by side, because "the plugin asked for it" and
 * "the user allowed it" are two different statements and only the second one is a
 * decision the user made.
 */
const props = defineProps<{
  /** The manifests that parsed cleanly. */
  manifests: PluginManifest[];
  /** What is wrong with the ones that did not. */
  issues: PluginManifestIssue[];
  /** The user's decisions: plugin id → approved permission names. */
  approvals: Record<string, string[]>;
  /** What the bus was handed: plugin id → effective permission names. */
  effective: Record<string, string[]>;
}>();

const emit = defineEmits<{
  (e: 'toggle', pluginId: string, permission: PluginPermission): void;
  (e: 'refresh'): void;
}>();

/** What each permission means, so the user knows what they are saying yes to. */
const PERMISSION_LABELS: Partial<Record<PluginPermission, string>> = {
  'pet:act': '让桌宠演一段动作并说话',
  'pet:speak': '让桌宠弹一条语音气泡',
  'pet:driver': '接管桌宠的角色决定权',
  'menu:register': '在星盘菜单里注册自己的菜单项',
  'panel:open': '在伴生舱里打开自己的面板',
  'hud:draw': '在全屏 HUD 上画标注',
};

/**
 * The host's own order of the permissions, used for the list.
 *
 * The manifest decides what a plugin wants, not the order the sheet reads best in, and
 * every plugin showing the same order makes the six known capabilities comparable
 * across plugins at a glance.
 */
const permissionOrder = new Map(
  PLUGIN_PERMISSIONS.map((permission, index) => [permission, index])
);

function orderedPermissions(manifest: PluginManifest): PluginPermission[] {
  return [...manifest.permissions].sort(
    (a, b) => (permissionOrder.get(a) ?? 99) - (permissionOrder.get(b) ?? 99)
  );
}

function isApproved(pluginId: string, permission: PluginPermission): boolean {
  return (props.approvals[pluginId] ?? []).includes(permission);
}

/**
 * Whether the permission is one the bus was actually handed.
 *
 * Read from the table rather than from the approvals: the sheet has to show what is in
 * force, not what was wished for. The two differ only when something went wrong
 * between the approval and the table, and that is exactly when the user needs to see it.
 */
function isEffective(pluginId: string, permission: PluginPermission): boolean {
  return (props.effective[pluginId] ?? []).includes(permission);
}

function effectiveCount(pluginId: string): number {
  return (props.effective[pluginId] ?? []).length;
}

function permissionLabel(permission: PluginPermission): string {
  return PERMISSION_LABELS[permission] ?? '插件申请的能力';
}
</script>

<style scoped>
.plugin-hint {
  margin: 0 0 7px;
  font-size: 10px;
  line-height: 1.45;
  color: #94a3b8;
}

.plugin-card {
  padding: 6px 8px;
  margin-bottom: 6px;
  background: rgba(2, 6, 23, 0.75);
  border: 1px solid rgba(148, 163, 184, 0.22);
}

.plugin-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.plugin-name {
  font-size: 11.5px;
  font-weight: 800;
  color: #f8fafc;
}

.plugin-perm-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}

.plugin-perm-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.plugin-perm-state {
  padding: 1px 4px;
  border: 1px solid rgba(244, 63, 94, 0.5);
  color: #fda4af;
  font-size: 9px;
  font-weight: 800;
  font-family: "JetBrains Mono", Consolas, monospace;
  white-space: nowrap;
}

.plugin-perm-state.effective {
  border-color: rgba(16, 185, 129, 0.6);
  color: #6ee7b7;
}

.plugin-summary {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 9.5px;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.plugin-issue-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 0;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
  font-size: 10px;
}

.plugin-issue-plugin {
  color: #fda4af;
  font-weight: 800;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.plugin-issue-field {
  color: #fbbf24;
  font-family: "JetBrains Mono", Consolas, monospace;
}
</style>
