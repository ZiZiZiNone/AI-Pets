import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  parseHostSettingsYaml,
  serializeHostSettingsYaml,
} from '@/utils/yamlLoader';

/**
 * The approval table is the user's record of what each plugin is allowed to do.
 *
 * It lives in `settings.yaml` rather than in a file of its own so that one save writes
 * the whole host configuration, and so that the file the user edits by hand is the same
 * file the interface writes back.
 */
describe('host.plugin_approvals', () => {
  it('defaults to an empty table', () => {
    expect(DEFAULT_HOST_SETTINGS.host.plugin_approvals).toEqual({});
    expect(parseHostSettingsYaml('host:\n  default_pet: demo\n').host.plugin_approvals).toEqual(
      {}
    );
  });

  it('reads the approved permissions of every plugin', () => {
    const settings = parseHostSettingsYaml(`
host:
  plugin_approvals:
    demo_external:
      - pet:speak
      - hud:draw
    star_chart:
      - menu:register
`);
    expect(settings.host.plugin_approvals).toEqual({
      demo_external: ['pet:speak', 'hud:draw'],
      star_chart: ['menu:register'],
    });
  });

  it('drops an approval that is not a list of names', () => {
    // A malformed entry must never widen what a plugin may do, so it is dropped
    // rather than carried into the table the bus reads.
    const settings = parseHostSettingsYaml(`
host:
  plugin_approvals:
    broken: "pet:speak"
    mixed:
      - pet:speak
      - 42
`);
    expect(settings.host.plugin_approvals).toEqual({ mixed: ['pet:speak'] });
  });

  it('survives a save and a reload', () => {
    const original = structuredClone(DEFAULT_HOST_SETTINGS);
    original.host.plugin_approvals = { demo_external: ['pet:speak'] };

    const reloaded = parseHostSettingsYaml(serializeHostSettingsYaml(original));
    expect(reloaded.host.plugin_approvals).toEqual({ demo_external: ['pet:speak'] });
  });

  it('gives every read its own table', () => {
    // The default lives in a module-level object; a caller that edits the table it got
    // must not edit it for everyone else.
    const first = parseHostSettingsYaml('host:\n  default_pet: demo\n');
    first.host.plugin_approvals!.demo_external = ['pet:speak'];

    const second = parseHostSettingsYaml('host:\n  default_pet: demo\n');
    expect(second.host.plugin_approvals).toEqual({});
    expect(DEFAULT_HOST_SETTINGS.host.plugin_approvals).toEqual({});
  });
});

describe('host.plugins_dirs', () => {
  it('defaults to no extra directory', () => {
    expect(DEFAULT_HOST_SETTINGS.host.plugins_dirs).toEqual([]);
    expect(parseHostSettingsYaml('host:\n  default_pet: demo\n').host.plugins_dirs).toEqual([]);
  });

  it('reads the configured directories', () => {
    const settings = parseHostSettingsYaml(`
host:
  plugins_dirs:
    - "E:/packs/one"
    - E:/packs/two
`);
    expect(settings.host.plugins_dirs).toEqual(['E:/packs/one', 'E:/packs/two']);
  });

  it('ignores a directory list that is not a list of paths', () => {
    expect(parseHostSettingsYaml('host:\n  plugins_dirs: nope\n').host.plugins_dirs).toEqual([]);
  });
});
