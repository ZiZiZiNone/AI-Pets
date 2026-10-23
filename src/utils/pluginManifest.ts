import yaml from 'js-yaml';

/**
 * Every capability a plugin may ask for.
 *
 * This list is the whole requestable surface of the plugin system: a manifest can only
 * name these, and what a plugin actually gets is the intersection of what it declared and
 * what the user approved. A capability that is not listed here cannot be requested at all,
 * so a typo cannot turn into a capability the host never heard of.
 */
export const PLUGIN_PERMISSIONS = [
  'pet:act',
  'pet:speak',
  'pet:driver',
  'menu:register',
  'panel:open',
  'hud:draw',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** A plugin's own declaration, once it has been validated. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: PluginPermission[];
}

/**
 * One thing wrong with one manifest.
 *
 * Issues are reported per field and never thrown: a broken third-party plugin has to be
 * skipped without taking the rest of the plugins, or the host, down with it.
 */
export interface PluginManifestIssue {
  /** 出问题的插件 id（连 id 都不合法的插件用目录名兜底） */
  pluginId: string;
  /** 出问题的字段，'id' 表示清单本身不可用 */
  field: string;
  message: string;
}

/** The id a plugin must use: lowercase, digits, underscore, dash; 2 to 64 characters. */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** `1.2.3`, optionally with a prerelease suffix such as `-beta.1`. */
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const PLUGIN_NAME_MAX_LENGTH = 64;

/** The fields the host understands; anything else in a manifest is a typo to report. */
const KNOWN_MANIFEST_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'version',
  'description',
  'permissions',
]);

function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

/** Render an arbitrary value for an issue message without ever throwing on it. */
function renderValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * Pull the human-readable reason out of a YAML error.
 *
 * js-yaml's `message` carries the source snippet as well, which is noise in a one-line
 * issue list; `reason` is the part that says what is actually wrong.
 */
function describeYamlError(error: unknown): string {
  if (error && typeof error === 'object' && 'reason' in error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason) return reason;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse one `plugin.yaml`.
 *
 * Never throws: a malformed manifest comes back as `manifest: null` plus the issues that
 * explain why. `fallbackId` is the directory the manifest was found in — it identifies the
 * plugin in issues even when the manifest itself does not say who it is, and it is what the
 * id has to match.
 */
export function parsePluginManifest(
  raw: string,
  fallbackId: string
): { manifest: PluginManifest | null; issues: PluginManifestIssue[] } {
  const issues: PluginManifestIssue[] = [];
  const dirName = fallbackId || 'unknown_plugin';

  let loaded: unknown;
  try {
    loaded = yaml.load(raw);
  } catch (error) {
    issues.push({
      pluginId: dirName,
      field: 'id',
      message: `清单不是合法的 YAML：${describeYamlError(error)}`,
    });
    return { manifest: null, issues };
  }

  if (loaded === undefined || loaded === null) {
    issues.push({ pluginId: dirName, field: 'id', message: '清单是空的' });
    return { manifest: null, issues };
  }
  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    issues.push({ pluginId: dirName, field: 'id', message: '清单必须是一个键值映射' });
    return { manifest: null, issues };
  }

  const source = loaded as Record<string, unknown>;

  const rawId = typeof source.id === 'string' ? source.id.trim() : '';
  const idShapeValid = PLUGIN_ID_PATTERN.test(rawId);
  // An id that is not even shaped like one cannot be used to name the plugin, so the
  // directory it was found in takes its place in every issue below.
  const pluginId = idShapeValid ? rawId : dirName;
  let fatal = false;

  if (!rawId) {
    issues.push({ pluginId, field: 'id', message: '清单缺少 id' });
    fatal = true;
  } else if (!idShapeValid) {
    issues.push({
      pluginId,
      field: 'id',
      message: 'id 必须以小写字母或数字开头，只能包含小写字母、数字、下划线和连字符，长度 2~64',
    });
    fatal = true;
  } else if (rawId !== dirName) {
    // The directory is what the user installed and what the approval table is keyed by.
    // A manifest that names a different plugin would let a renamed folder keep the
    // permissions of the plugin it used to be.
    issues.push({
      pluginId,
      field: 'id',
      message: `id 与目录名 ${dirName} 不一致`,
    });
    fatal = true;
  }

  const rawName = typeof source.name === 'string' ? source.name.trim() : '';
  if (source.name === undefined || source.name === null) {
    issues.push({ pluginId, field: 'name', message: '清单缺少 name' });
    fatal = true;
  } else if (!rawName) {
    issues.push({ pluginId, field: 'name', message: 'name 必须是非空字符串' });
    fatal = true;
  } else if (rawName.length > PLUGIN_NAME_MAX_LENGTH) {
    issues.push({
      pluginId,
      field: 'name',
      message: `name 不能超过 ${PLUGIN_NAME_MAX_LENGTH} 个字符`,
    });
    fatal = true;
  }

  const rawVersion = typeof source.version === 'string' ? source.version.trim() : '';
  if (source.version === undefined || source.version === null) {
    issues.push({ pluginId, field: 'version', message: '清单缺少 version' });
    fatal = true;
  } else if (!PLUGIN_VERSION_PATTERN.test(rawVersion)) {
    issues.push({
      pluginId,
      field: 'version',
      message: 'version 必须是 1.2.3 这样的三段数字，可带 -beta.1 这样的预发布后缀',
    });
    fatal = true;
  }

  let description = '';
  if (source.description !== undefined && source.description !== null) {
    if (typeof source.description === 'string') {
      description = source.description.trim();
    } else {
      issues.push({ pluginId, field: 'description', message: 'description 必须是字符串，已忽略' });
    }
  }

  const permissions: PluginPermission[] = [];
  const rawPermissions = source.permissions;
  if (rawPermissions !== undefined && rawPermissions !== null) {
    if (!Array.isArray(rawPermissions)) {
      issues.push({ pluginId, field: 'permissions', message: 'permissions 必须是数组' });
      fatal = true;
    } else {
      for (const entry of rawPermissions) {
        if (typeof entry !== 'string') {
          issues.push({
            pluginId,
            field: 'permissions',
            message: `permissions 里出现了非字符串项：${renderValue(entry)}`,
          });
          fatal = true;
          continue;
        }
        if (!isPluginPermission(entry)) {
          // An unknown permission invalidates the whole manifest on purpose. Dropping it
          // silently would show the user a shorter permission list than the plugin asked
          // for, so the approval they give would describe a different plugin than the one
          // that runs — and the plugin would then fail at the moment it uses the capability
          // it was written for. Refusing the manifest keeps the request and the approval
          // talking about the same set of capabilities.
          issues.push({ pluginId, field: 'permissions', message: `未知权限：${entry}` });
          fatal = true;
          continue;
        }
        if (!permissions.includes(entry)) permissions.push(entry);
      }
    }
  }

  for (const key of Object.keys(source)) {
    if (KNOWN_MANIFEST_FIELDS.has(key)) continue;
    // An unknown field is a typo in the manifest, not a broken one: the plugin still works
    // without it, but the author is asking for something the host silently ignores.
    issues.push({ pluginId, field: key, message: `未知字段 ${key}，已忽略` });
  }

  if (fatal) return { manifest: null, issues };

  // Built field by field from primitives, never cloned from the parsed object: a manifest
  // can reach this function through a reactive proxy, and cloning a proxy throws
  // DataCloneError, which would take the whole page down instead of skipping one plugin.
  const manifest: PluginManifest = {
    id: rawId,
    name: rawName,
    version: rawVersion,
    description,
    permissions,
  };
  return { manifest, issues };
}

/**
 * Parse every plugin in a directory tree, one subdirectory per plugin.
 *
 * A broken plugin is skipped and reported, the others are unaffected: one third-party
 * manifest with a typo must not cost the user the plugins that are fine.
 */
export function parsePluginDirectory(
  entries: Array<{ dirName: string; yaml: string }>
): { manifests: PluginManifest[]; issues: PluginManifestIssue[] } {
  const manifests: PluginManifest[] = [];
  const issues: PluginManifestIssue[] = [];
  for (const entry of entries) {
    const parsed = parsePluginManifest(entry.yaml, entry.dirName);
    if (parsed.manifest) manifests.push(parsed.manifest);
    issues.push(...parsed.issues);
  }
  return { manifests, issues };
}

/**
 * What a plugin is actually allowed to do: what it declared, intersected with what the
 * user approved.
 *
 * The approval table is keyed by plugin id and can carry entries the manifest never asked
 * for — an approval given to an older version of the plugin, or a capability the host no
 * longer knows. Those are ignored: the manifest is the ceiling, approval can only lower
 * it. The result follows the manifest's own order so the permission sheet reads the same
 * way every time.
 */
export function effectivePermissions(
  manifest: PluginManifest,
  approved: readonly string[]
): PluginPermission[] {
  const granted = new Set(approved);
  const effective: PluginPermission[] = [];
  for (const permission of manifest.permissions) {
    if (granted.has(permission) && !effective.includes(permission)) effective.push(permission);
  }
  return effective;
}
