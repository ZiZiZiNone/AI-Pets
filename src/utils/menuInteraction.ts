import type {
  MenuGesture,
  MenuInteractionDef,
  MenuItemSchema,
  PetManifest,
} from '@/types/pet';

/**
 * The menu feel a pet gets when it says nothing about it.
 *
 * Identical to the hardwired behaviour this replaces — a single click runs a leaf's action
 * and opens a branch's children — so adding the configuration did not change any pet that
 * already existed.
 */
export const DEFAULT_MENU_INTERACTION: Required<MenuInteractionDef> = {
  trigger: 'click',
  expand: 'click',
  long_press_ms: 500,
  hover_intent_ms: 400,
  auto_expand_first: true,
};

/**
 * Bounds on a press long enough to be deliberate but short enough to feel intentional.
 *
 * Below the floor a `long_press` is indistinguishable from a click whose pointer-up was
 * late; above the ceiling the menu feels broken rather than patient.
 */
const MENU_LONG_PRESS_MIN_MS = 150;
const MENU_LONG_PRESS_MAX_MS = 3000;

/**
 * Bounds on the hover delay. Zero is allowed: a pet whose items are far apart may genuinely
 * want "expand as soon as the pointer is over it".
 */
const MENU_HOVER_INTENT_MIN_MS = 0;
const MENU_HOVER_INTENT_MAX_MS = 3000;

const GESTURES: readonly MenuGesture[] = ['click', 'double_click', 'long_press', 'hover'];

function isMenuGesture(value: unknown): value is MenuGesture {
  return typeof value === 'string' && (GESTURES as readonly string[]).includes(value);
}

/** What a gesture should do to one item. */
type MenuGestureOutcome = 'expand' | 'run_action' | 'ignore';

/**
 * Read a config block into a complete one.
 *
 * Every field is optional in the schema and every field has a working default here, so a
 * pet can set one of them without having to restate the rest. Values that are not gestures
 * or are out of range fall back to the default rather than being carried into the renderer,
 * where an unusable gesture would mean an item that cannot be used at all.
 */
export function normalizeMenuInteraction(raw: unknown): Required<MenuInteractionDef> {
  return { ...DEFAULT_MENU_INTERACTION, ...readIncoming(raw) };
}

/**
 * Only the fields the author actually wrote, so a layer above does not overwrite a layer
 * below with a default the author never asked for.
 *
 * This is the single reader for the block, used both by `normalizeMenuInteraction` and by
 * the layer merge: two readers would be two places for a field to be silently dropped.
 */
function readIncoming(raw: unknown): Partial<MenuInteractionDef> {
  const source = (raw && typeof raw === 'object' ? raw : {}) as MenuInteractionDef;
  const out: Partial<MenuInteractionDef> = {};
  if (isMenuGesture(source.trigger)) out.trigger = source.trigger;
  if (isMenuGesture(source.expand)) out.expand = source.expand;
  if (typeof source.long_press_ms === 'number') {
    out.long_press_ms = clampInteger(
      source.long_press_ms,
      DEFAULT_MENU_INTERACTION.long_press_ms,
      MENU_LONG_PRESS_MIN_MS,
      MENU_LONG_PRESS_MAX_MS
    );
  }
  if (typeof source.hover_intent_ms === 'number') {
    out.hover_intent_ms = clampInteger(
      source.hover_intent_ms,
      DEFAULT_MENU_INTERACTION.hover_intent_ms,
      MENU_HOVER_INTENT_MIN_MS,
      MENU_HOVER_INTENT_MAX_MS
    );
  }
  if (typeof source.auto_expand_first === 'boolean') {
    out.auto_expand_first = source.auto_expand_first;
  }
  return out;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The interaction every item in the tree inherits: the pet's own block over the global one
 * over the built-in.
 */
export function resolveMenuDefaults(
  petDefault?: MenuInteractionDef,
  globalDefault?: MenuInteractionDef
): Required<MenuInteractionDef> {
  return {
    ...DEFAULT_MENU_INTERACTION,
    ...readIncoming(globalDefault),
    ...readIncoming(petDefault),
  };
}

/**
 * Resolve the interaction for one item: its own block, else its pet's, else the global
 * default, else the built-in.
 *
 * Field by field rather than block by block: a pet that sets only `long_press_ms` should
 * keep the global default for everything else instead of losing it.
 */
export function resolveMenuInteraction(
  item: MenuItemSchema,
  petDefault?: MenuInteractionDef,
  globalDefault?: MenuInteractionDef
): Required<MenuInteractionDef> {
  return {
    ...resolveMenuDefaults(petDefault, globalDefault),
    ...readIncoming(item.interaction),
  };
}

/**
 * Decide what a gesture does to an item.
 *
 * An item may both carry an action and have children, and that is the case the old
 * hardwired behaviour could not express: a click always opened the submenu, so such an
 * item's own action was unreachable. Two separate gestures resolve it — each one does its
 * own job, and the one it is not bound to does nothing.
 */
export function planMenuGesture(
  hasChildren: boolean,
  interaction: Required<MenuInteractionDef>,
  gesture: MenuGesture
): MenuGestureOutcome {
  if (hasChildren && gesture === interaction.expand) return 'expand';
  if (gesture === interaction.trigger) return 'run_action';
  return 'ignore';
}

/**
 * A configuration that cannot do what it looks like it does, in words fit for a log.
 *
 * The overlap is the whole trap: `trigger` and `expand` on the same gesture means the item
 * opens its submenu and its action never runs. Nothing breaks and nothing appears in the
 * interface, so a warning is the only way the author finds out.
 */
function menuInteractionWarning(
  item: MenuItemSchema,
  interaction: Required<MenuInteractionDef>
): string | null {
  const hasChildren = Array.isArray(item.children) && item.children.length > 0;
  if (!hasChildren) return null;
  if (interaction.trigger !== interaction.expand) return null;
  return (
    `菜单项 [${item.id}] 的 trigger 与 expand 都是 ${interaction.trigger}：` +
    `它有子菜单，所以这个手势只会展开子菜单，item.action 永远不会触发。` +
    `想两者都要，就把其中一个换成别的（click / double_click / long_press / hover）。`
  );
}

/**
 * Collect the warnings for a whole menu tree, depth first.
 *
 * Deduplicated by item id so a tree that shares a node does not warn twice.
 */
export function collectMenuInteractionWarnings(
  items: MenuItemSchema[],
  pet?: PetManifest,
  globalDefault?: MenuInteractionDef,
  seen: Set<string> = new Set()
): string[] {
  const warnings: string[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      const warning = menuInteractionWarning(
        item,
        resolveMenuInteraction(item, pet?.menu_interaction, globalDefault)
      );
      if (warning) warnings.push(warning);
    }
    if (item.children?.length) {
      warnings.push(
        ...collectMenuInteractionWarnings(item.children, pet, globalDefault, seen)
      );
    }
  }
  return warnings;
}
