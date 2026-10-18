import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MENU_INTERACTION,
  collectMenuInteractionWarnings,
  longPressConsumesPress,
  normalizeMenuInteraction,
  planMenuGesture,
  resolveMenuDefaults,
  resolveMenuInteraction,
} from '@/utils/menuInteraction';
import type { MenuItemSchema } from '@/types/pet';

function item(overrides: Partial<MenuItemSchema> = {}): MenuItemSchema {
  return { id: 'm1', label: '菜单项', ...overrides };
}

const branch = item({
  id: 'branch',
  children: [item({ id: 'child' })],
});

describe('menu interaction configuration', () => {
  it('reproduces the hardwired behaviour when nothing is configured', () => {
    // Adding configuration must not change any pet that already exists: a single click ran
    // a leaf's action and opened a branch's children, and that is still the default.
    const interaction = normalizeMenuInteraction(undefined);
    expect(interaction).toEqual(DEFAULT_MENU_INTERACTION);
    expect(planMenuGesture(false, interaction, 'click')).toBe('run_action');
    expect(planMenuGesture(true, interaction, 'click')).toBe('expand');
    expect(interaction.auto_expand_first).toBe(true);
  });

  it('accepts each gesture on either job', () => {
    for (const gesture of ['click', 'double_click', 'long_press', 'hover'] as const) {
      const interaction = normalizeMenuInteraction({ trigger: gesture, expand: gesture });
      expect(interaction.trigger).toBe(gesture);
      expect(interaction.expand).toBe(gesture);
    }
  });

  it('falls back rather than forwarding a value the renderer cannot use', () => {
    // An unusable gesture would be an item that cannot be used at all, which is worse than
    // an item that behaves the documented way.
    const interaction = normalizeMenuInteraction({
      trigger: 'triple_click',
      expand: 42,
      long_press_ms: 'soon',
      hover_intent_ms: null,
      auto_expand_first: 'yes',
    });
    expect(interaction).toEqual(DEFAULT_MENU_INTERACTION);
  });

  it('clamps the two delays to the range that makes sense', () => {
    expect(normalizeMenuInteraction({ long_press_ms: 10 }).long_press_ms).toBe(150);
    expect(normalizeMenuInteraction({ long_press_ms: 99999 }).long_press_ms).toBe(3000);
    expect(normalizeMenuInteraction({ long_press_ms: 250.4 }).long_press_ms).toBe(250);
    // Zero is legal for hover: an explicitly twitchy menu is a choice, not a mistake.
    expect(normalizeMenuInteraction({ hover_intent_ms: 0 }).hover_intent_ms).toBe(0);
    expect(normalizeMenuInteraction({ hover_intent_ms: -5 }).hover_intent_ms).toBe(0);
    expect(normalizeMenuInteraction({ hover_intent_ms: 99999 }).hover_intent_ms).toBe(3000);
  });

  it('resolves pet over global over built-in, field by field', () => {
    const global = { trigger: 'double_click', long_press_ms: 900 } as const;
    const pet = { expand: 'hover' } as const;

    expect(resolveMenuDefaults(undefined, undefined)).toEqual(DEFAULT_MENU_INTERACTION);
    expect(resolveMenuDefaults(undefined, global)).toMatchObject({
      trigger: 'double_click',
      long_press_ms: 900,
      expand: DEFAULT_MENU_INTERACTION.expand,
    });
    // The pet sets only `expand`, so it keeps the global trigger and long press rather
    // than dropping back to the built-in defaults for everything it did not mention.
    expect(resolveMenuDefaults(pet, global)).toMatchObject({
      trigger: 'double_click',
      long_press_ms: 900,
      expand: 'hover',
    });
  });

  it("lets one item override its pet without restating the rest", () => {
    const pet = { trigger: 'double_click', hover_intent_ms: 700 } as const;
    const resolved = resolveMenuInteraction(item({ interaction: { expand: 'hover' } }), pet);
    expect(resolved).toMatchObject({
      trigger: 'double_click',
      hover_intent_ms: 700,
      expand: 'hover',
    });
  });

  it('keeps an item with both a submenu and an action usable by splitting the gestures', () => {
    // The case the hardwired renderer could not express: a click always opened the
    // submenu, so such an item's own action was unreachable.
    const interaction = normalizeMenuInteraction({ trigger: 'double_click', expand: 'click' });
    expect(planMenuGesture(true, interaction, 'click')).toBe('expand');
    expect(planMenuGesture(true, interaction, 'double_click')).toBe('run_action');
  });

  it('ignores a gesture an item is not bound to', () => {
    const interaction = normalizeMenuInteraction({ trigger: 'long_press' });
    expect(planMenuGesture(false, interaction, 'click')).toBe('ignore');
    expect(planMenuGesture(false, interaction, 'double_click')).toBe('ignore');
    expect(planMenuGesture(false, interaction, 'hover')).toBe('ignore');
    expect(planMenuGesture(false, interaction, 'long_press')).toBe('run_action');
  });

  it('ignores expand on an item that has no children', () => {
    const interaction = normalizeMenuInteraction({ expand: 'hover', trigger: 'click' });
    expect(planMenuGesture(false, interaction, 'hover')).toBe('ignore');
    expect(planMenuGesture(false, interaction, 'click')).toBe('run_action');
  });

  it('only lets a long press eat the release click when long_press does something', () => {
    // The shipped defaults bind `long_press` to nothing. Suppressing the click anyway turned
    // every slightly slow click into a no-op, measured in the built application: click on the
    // item acted, press 650ms then release did nothing at all, click on it acted again.
    const shipped = normalizeMenuInteraction({});
    expect(longPressConsumesPress(false, shipped)).toBe(false);
    expect(longPressConsumesPress(true, shipped)).toBe(false);

    expect(longPressConsumesPress(true, normalizeMenuInteraction({ expand: 'long_press' }))).toBe(true);
    expect(longPressConsumesPress(false, normalizeMenuInteraction({ trigger: 'long_press' }))).toBe(true);
    // A parent whose long press runs the action still must not let the release click expand.
    expect(
      longPressConsumesPress(
        true,
        normalizeMenuInteraction({ trigger: 'long_press', expand: 'click' })
      )
    ).toBe(true);
  });

  it('warns when an item cannot both expand and run its action', () => {
    const interaction = normalizeMenuInteraction({});
    const warnings = collectMenuInteractionWarnings([branch], undefined, undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('branch');
    expect(warnings[0]).toContain('item.action 永远不会触发');
    // And the plan really does drop the action, which is why the warning is worth having.
    expect(planMenuGesture(true, interaction, 'click')).toBe('expand');
  });

  it('stays quiet when the gestures differ or the item is a leaf', () => {
    const split: MenuItemSchema = {
      id: 'split',
      label: 'split',
      interaction: { trigger: 'double_click', expand: 'click' },
      children: [item({ id: 'leaf' })],
    };
    expect(collectMenuInteractionWarnings([split])).toEqual([]);
    expect(collectMenuInteractionWarnings([item({ id: 'leaf' })])).toEqual([]);
  });

  it('finds a collision nested anywhere in the tree, once per item', () => {
    const tree: MenuItemSchema[] = [
      item({
        id: 'outer',
        children: [
          item({ id: 'inner', children: [item({ id: 'grandchild' })] }),
          item({ id: 'shared', children: [item({ id: 'x' })] }),
        ],
      }),
      item({ id: 'shared', children: [item({ id: 'y' })] }),
    ];
    const warnings = collectMenuInteractionWarnings(tree);
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('outer');
    expect(warnings.join('\n')).toContain('inner');
    // Two nodes share the id, so the message is emitted once rather than twice.
    expect(warnings.filter((w) => w.includes('[shared]'))).toHaveLength(1);
  });

  it('applies the pet-level default to the tree it came from', () => {
    const ok = collectMenuInteractionWarnings([branch], {
      id: 'p',
      name: 'p',
      version: '1',
      type: 'sprite',
      model: { entry: 'x.svg', scale: 1, offset: { x: 0, y: 0 } },
      menu_interaction: { trigger: 'double_click', expand: 'click' },
    });
    expect(ok).toEqual([]);
  });
});
