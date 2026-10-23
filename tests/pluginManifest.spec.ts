import { describe, expect, it } from 'vitest';
import {
  PLUGIN_PERMISSIONS,
  effectivePermissions,
  parsePluginDirectory,
  parsePluginManifest,
} from '@/utils/pluginManifest';
import type { PluginManifest, PluginManifestIssue, PluginPermission } from '@/utils/pluginManifest';

/** A manifest that is valid in every respect, so a test can break one field at a time.
 *
 * A field set to `undefined` is left out of the YAML entirely, which is how a test asks
 * for "the author did not write this key" rather than "the author wrote nonsense".
 */
function manifestYaml(overrides: Record<string, unknown> = {}): string {
  const fields: Record<string, unknown> = {
    id: 'demo_plugin',
    name: '演示插件',
    version: '1.2.3',
    description: '一个用来验证解析的插件',
    permissions: ['pet:speak'],
    ...overrides,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key}:\n${value.map((entry) => `  - ${entry}`).join('\n')}`
        : `${key}: ${value}`
    )
    .join('\n');
}

/** The fields the issues blame, in the order they were reported. */
function blamedFields(issues: PluginManifestIssue[]): string[] {
  return issues.map((issue) => issue.field);
}

function manifestOf(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'demo_plugin',
    name: '演示插件',
    version: '1.2.3',
    description: '',
    permissions: [],
    ...overrides,
  };
}

describe('plugin manifest parsing', () => {
  it('accepts a well-formed manifest', () => {
    const { manifest, issues } = parsePluginManifest(manifestYaml(), 'demo_plugin');
    expect(issues).toEqual([]);
    expect(manifest).toEqual({
      id: 'demo_plugin',
      name: '演示插件',
      version: '1.2.3',
      description: '一个用来验证解析的插件',
      permissions: ['pet:speak'],
    });
  });

  it('accepts every permission the host knows', () => {
    const all: PluginPermission[] = [...PLUGIN_PERMISSIONS];
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ permissions: all }),
      'demo_plugin'
    );
    expect(issues).toEqual([]);
    expect(manifest?.permissions).toEqual(all);
  });

  it('accepts a prerelease version', () => {
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ version: '1.2.3-beta.1' }),
      'demo_plugin'
    );
    expect(issues).toEqual([]);
    expect(manifest?.version).toBe('1.2.3-beta.1');
  });

  it('rejects an id that is not a valid plugin id', () => {
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ id: 'Demo Plugin!' }),
      'demo_plugin'
    );
    expect(manifest).toBeNull();
    expect(blamedFields(issues)).toContain('id');
    // The id is unusable, so the directory it was found in is what names the plugin.
    expect(issues[0].pluginId).toBe('demo_plugin');
  });

  it('rejects a missing id', () => {
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ id: undefined }),
      'demo_plugin'
    );
    expect(manifest).toBeNull();
    expect(blamedFields(issues)).toContain('id');
  });

  it('rejects an id that does not match the directory it lives in', () => {
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ id: 'other_plugin' }),
      'demo_plugin'
    );
    expect(manifest).toBeNull();
    expect(issues.some((issue) => issue.field === 'id')).toBe(true);
    expect(issues.some((issue) => issue.message.includes('demo_plugin'))).toBe(true);
  });

  it('rejects a version that is not three numeric parts', () => {
    for (const version of ['1.2', 'v1.2.3', '1.2.3.4', 'latest']) {
      const { manifest, issues } = parsePluginManifest(
        manifestYaml({ version }),
        'demo_plugin'
      );
      expect(manifest).toBeNull();
      expect(blamedFields(issues)).toContain('version');
    }
  });

  it('rejects a missing name', () => {
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ name: undefined }),
      'demo_plugin'
    );
    expect(manifest).toBeNull();
    expect(blamedFields(issues)).toContain('name');
  });

  it('rejects an unknown permission by invalidating the whole manifest', () => {
    // Silently dropping the unknown name would show the user a shorter permission list
    // than the plugin asked for, so the approval would not describe the running plugin.
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ permissions: ['pet:speak', 'pet:fly'] }),
      'demo_plugin'
    );
    expect(manifest).toBeNull();
    expect(issues.some((issue) => issue.field === 'permissions')).toBe(true);
    expect(issues.some((issue) => issue.message.includes('pet:fly'))).toBe(true);
  });

  it('reports an unknown field without invalidating the manifest', () => {
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ author: 'someone' }),
      'demo_plugin'
    );
    expect(manifest).not.toBeNull();
    expect(blamedFields(issues)).toContain('author');
    expect(blamedFields(issues)).not.toContain('id');
  });

  it('treats omitted permissions as no permissions at all', () => {
    const { manifest, issues } = parsePluginManifest(
      manifestYaml({ permissions: undefined }),
      'demo_plugin'
    );
    expect(issues).toEqual([]);
    expect(manifest?.permissions).toEqual([]);
  });

  it('reports broken YAML instead of throwing', () => {
    const { manifest, issues } = parsePluginManifest('id: [unclosed\n', 'demo_plugin');
    expect(manifest).toBeNull();
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].pluginId).toBe('demo_plugin');
  });

  it('rejects a manifest that is not a mapping', () => {
    const { manifest, issues } = parsePluginManifest('just a string', 'demo_plugin');
    expect(manifest).toBeNull();
    expect(blamedFields(issues)).toContain('id');
  });
});

describe('plugin directory parsing', () => {
  it('keeps the good plugins and reports the broken ones', () => {
    const { manifests, issues } = parsePluginDirectory([
      { dirName: 'good_plugin', yaml: manifestYaml({ id: 'good_plugin' }) },
      { dirName: 'bad_plugin', yaml: manifestYaml({ id: 'bad_plugin', version: '1.2' }) },
      { dirName: 'other_good', yaml: manifestYaml({ id: 'other_good' }) },
    ]);
    expect(manifests.map((manifest) => manifest.id)).toEqual(['good_plugin', 'other_good']);
    expect(issues.some((issue) => issue.pluginId === 'bad_plugin')).toBe(true);
  });
});

describe('effective permissions', () => {
  it('grants only what the manifest declared and the user approved', () => {
    const manifest = manifestOf({ permissions: ['pet:speak', 'pet:act'] });
    expect(effectivePermissions(manifest, ['pet:speak'])).toEqual(['pet:speak']);
    expect(effectivePermissions(manifest, ['pet:speak', 'pet:act'])).toEqual([
      'pet:speak',
      'pet:act',
    ]);
    expect(effectivePermissions(manifest, [])).toEqual([]);
  });

  it('ignores approvals the manifest never asked for', () => {
    // The manifest is the ceiling: an approval left over from another plugin, or from an
    // older version of this one, cannot hand out a capability that was not requested.
    const manifest = manifestOf({ permissions: ['pet:speak'] });
    expect(effectivePermissions(manifest, ['pet:speak', 'pet:driver', 'menu:register'])).toEqual([
      'pet:speak',
    ]);
  });

  it('grants nothing when the manifest declares nothing', () => {
    const manifest = manifestOf({ permissions: [] });
    expect(effectivePermissions(manifest, [...PLUGIN_PERMISSIONS])).toEqual([]);
  });
});
