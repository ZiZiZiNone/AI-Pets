import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePetStore } from '@/store/petStore';
import { STAGE_MESSAGES } from '@/constants/messages';
import type { PetManifest, ScheduledPetTask } from '@/types/pet';

function task(overrides: Partial<ScheduledPetTask> = {}): ScheduledPetTask {
  return { priority: 'P2', text: 'x', durationMs: 1000, ...overrides };
}

describe('petStore action queue', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  it('runs the first action immediately', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'A', motion: 'happy' }));
    expect(store.currentAction?.text).toBe('A');
    expect(store.activeMotion).toBe('happy');
    expect(store.bubbleText).toBe('A');
    expect(store.actionQueue).toHaveLength(0);
  });

  it('assigns an id and applies the default duration', () => {
    const store = usePetStore();
    store.scheduleAction({ priority: 'P2', text: 'A' });
    expect(store.currentAction?.id).toMatch(/^act_/);
    expect(store.currentAction?.durationMs).toBe(3800);
  });

  it('queues a lower priority action instead of interrupting', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'run', priority: 'P1' }));
    store.scheduleAction(task({ text: 'wait', priority: 'P3' }));

    expect(store.currentAction?.text).toBe('run');
    expect(store.actionQueue).toHaveLength(1);
    expect(store.actionQueue[0].text).toBe('wait');
  });

  it('interrupts on an equal or higher priority', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'run', priority: 'P2' }));
    store.scheduleAction(task({ text: 'urgent', priority: 'P2' }));
    expect(store.currentAction?.text).toBe('urgent');
  });

  it('sorts the queue by descending priority', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'running', priority: 'P0' }));
    store.scheduleAction(task({ text: 'low', priority: 'P3' }));
    store.scheduleAction(task({ text: 'mid', priority: 'P1' }));
    store.scheduleAction(task({ text: 'lowest', priority: 'P3' }));

    expect(store.actionQueue.map((t) => t.priority)).toEqual(['P1', 'P3', 'P3']);
  });

  it('resumes an interrupted action ahead of the backlog, without resuming twice', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'resume-me', priority: 'P1', resumeAfterInterrupt: true }));
    store.scheduleAction(task({ text: 'interrupt', priority: 'P0' }));

    expect(store.currentAction?.text).toBe('interrupt');
    expect(store.actionQueue[0].text).toBe('resume-me');
    expect(store.actionQueue[0].resumeAfterInterrupt).toBe(false);
  });

  it('does not requeue an action that did not ask to resume', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'dropped', priority: 'P1' }));
    store.scheduleAction(task({ text: 'interrupt', priority: 'P0' }));
    expect(store.actionQueue).toHaveLength(0);
  });

  it('advances to the next queued action when the timer expires', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'first', durationMs: 1000 }));
    store.scheduleAction(task({ text: 'second', priority: 'P3', durationMs: 1000 }));

    vi.advanceTimersByTime(1000);
    expect(store.currentAction?.text).toBe('second');

    vi.advanceTimersByTime(1000);
    expect(store.currentAction).toBeNull();
    expect(store.bubbleText).toBe('');
    expect(store.activeMotion).toBe('idle');
  });

  it('never schedules a shorter bubble than the floor', () => {
    const store = usePetStore();
    store.scheduleAction(task({ durationMs: 10 }));
    vi.advanceTimersByTime(799);
    expect(store.currentAction).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.currentAction).toBeNull();
  });

  it('dismisses the bubble on demand', () => {
    const store = usePetStore();
    store.scheduleAction(task({ text: 'bye', durationMs: 9000 }));
    store.dismissCurrentBubble();
    expect(store.currentAction).toBeNull();
    expect(store.bubbleText).toBe('');
  });

  it('restores the climb motion when the queue drains on a window', () => {
    const store = usePetStore();
    store.isClimbedOnWindow = true;
    store.scheduleAction(task({ text: 'climb', durationMs: 1000 }));
    vi.advanceTimersByTime(1000);
    expect(store.activeMotion).toBe('climb');
  });

  it('drops P3 actions while do-not-disturb is on', () => {
    const store = usePetStore();
    store.dnd_mode = true;
    store.scheduleAction(task({ priority: 'P3', text: 'quiet' }));
    expect(store.currentAction).toBeNull();

    store.scheduleAction(task({ priority: 'P2', text: 'urgent' }));
    expect(store.currentAction?.text).toBe('urgent');
  });
});

describe('petStore snapshots', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('ignores a snapshot that is not newer than the current revision', () => {
    const store = usePetStore();
    store.applySnapshot({
      revision: 5,
      active_pet_id: 'sakura_rin',
      emotion: 'happy',
      is_click_through: true,
      volume: 0.5,
      studio_mode: false,
      inline_hud: true,
      dnd_mode: false,
    });
    expect(store.revision).toBe(5);
    expect(store.volume).toBe(0.5);

    store.applySnapshot({
      revision: 5,
      active_pet_id: 'sakura_rin',
      emotion: 'idle',
      is_click_through: false,
      volume: 0.9,
      studio_mode: false,
      inline_hud: true,
      dnd_mode: false,
    });
    expect(store.volume).toBe(0.5);
  });

  it('adopts a newer snapshot and switches the pet', () => {
    const store = usePetStore();
    store.availablePets = [
      { id: 'sakura_rin', name: 'A', version: '1', type: 'sprite', model: { entry: 'a.svg', scale: 1, offset: { x: 0, y: 0 } } },
      { id: 'qilin_ling', name: 'P', version: '1', type: 'sprite', model: { entry: 'p.svg', scale: 1, offset: { x: 0, y: 0 } } },
    ];
    store.applySnapshot({
      revision: 9,
      active_pet_id: 'qilin_ling',
      emotion: 'happy',
      is_click_through: false,
      volume: 0.7,
      studio_mode: false,
      inline_hud: true,
      dnd_mode: true,
    });
    expect(store.active_pet_id).toBe('qilin_ling');
    expect(store.currentPet?.id).toBe('qilin_ling');
    expect(store.dnd_mode).toBe(true);
  });

  it('leaves the current pet alone when the snapshot names an unknown one', () => {
    const store = usePetStore();
    store.applySnapshot({
      revision: 2,
      active_pet_id: 'ghost_pet',
      emotion: 'idle',
      is_click_through: false,
      volume: 0.8,
      studio_mode: false,
      inline_hud: true,
      dnd_mode: false,
    });
    expect(store.active_pet_id).toBe('ghost_pet');
    expect(store.currentPet?.id).toBe(FALLBACK_ID);
  });
});

describe('petStore derived state', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('honours an explicit fps override', () => {
    const store = usePetStore();
    expect(store.effectiveTargetFps).toBe(store.settings.render.active_fps);
    store.setFpsOverride('30');
    expect(store.effectiveTargetFps).toBe(30);
    store.setFpsOverride('60');
    expect(store.effectiveTargetFps).toBe(60);
    store.setFpsOverride('dynamic');
    expect(store.effectiveTargetFps).toBe(store.settings.render.active_fps);
  });

  it('drops to the idle frame rate once the user goes quiet', () => {
    const store = usePetStore();
    store.lastUserActivityAt = Date.now() - (store.settings.render.idle_timeout_ms + 1000);
    expect(store.effectiveTargetFps).toBe(store.settings.render.idle_fps);
  });

  it('stays at the active frame rate while a bubble is on screen', () => {
    const store = usePetStore();
    store.lastUserActivityAt = Date.now() - (store.settings.render.idle_timeout_ms + 1000);
    store.scheduleAction(task({ durationMs: 9000 }));
    expect(store.effectiveTargetFps).toBe(store.settings.render.active_fps);
  });

  it('swaps the theme with the active pet', () => {
    const store = usePetStore();
    const first = manifest('sakura_rin', 'A', 'cyber_tactical');
    const second = manifest('guanlan', 'N', 'arcane_astrolabe');
    store.availablePets = [first, second];
    store.currentPet = first;
    expect(store.activeTheme.id).toBe('cyber_tactical');
    store.switchPetById('guanlan');
    expect(store.activeTheme.id).toBe('arcane_astrolabe');
  });

  it('refuses a pet that is not installed, and names it on the bubble', () => {
    // This used to be "ignores switching to a pet that is not installed": the store returned
    // early and every caller read the silence as success. A menu entry naming a pet that is
    // not on disk looked like a dead item, and an external switch request was acknowledged
    // with `status: "ok"` while nothing happened.
    const store = usePetStore();
    store.availablePets = [manifest('sakura_rin', 'cyber_tactical')];
    const before = store.currentPet?.id;

    const outcome = store.switchPetById('not_installed');

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('not_installed') });
    expect(store.currentPet?.id).toBe(before);
    expect(store.bubbleText).toContain('not_installed');
  });

  it('reports a switch request that carries no pet id at all', () => {
    const store = usePetStore();

    const outcome = store.switchPetById('');

    expect(outcome.ok).toBe(false);
    expect(store.bubbleText).toBe(STAGE_MESSAGES.petSwitchWithoutId);
  });

  it('announces a successful switch to an installed pet', () => {
    const store = usePetStore();
    store.availablePets = [
      manifest('sakura_rin', 'cyber_tactical'),
      manifest('guanlan', 'arcane_astrolabe'),
    ];

    const outcome = store.switchPetById('guanlan');

    expect(outcome).toEqual({ ok: true });
    expect(store.currentPet?.id).toBe('guanlan');
    expect(store.bubbleText).not.toContain('无法切换');
  });

  it('leaves an already-switched pet in place when a later switch is refused', () => {
    const store = usePetStore();
    store.availablePets = [
      manifest('sakura_rin', 'A'),
      manifest('guanlan', 'N'),
    ];
    store.switchPetById('guanlan');

    store.switchPetById('ghost_pet');

    expect(store.active_pet_id).toBe('guanlan');
    expect(store.currentPet?.id).toBe('guanlan');
  });

  it('merges pet, global and external menus into one tree', () => {
    const store = usePetStore();
    store.currentPet = { ...(store.currentPet as never), menus: [{ id: 'pet', label: 'P' }] };
    store.globalMenus = [{ id: 'global', label: 'G' }];
    store.registerExternalMenu({ app_id: 'ext', menus: [{ id: 'ext', label: 'E' }] });

    expect(store.mergedMenuTree.map((m) => m.id)).toEqual(['pet', 'global', 'ext']);
    expect(store.externalMenusByApp.ext[0].app_id).toBe('ext');
  });

  it('replaces a single external menu item and drops the app on unregister', () => {
    const store = usePetStore();
    store.registerExternalMenu({ app_id: 'ext', item: { id: 'a', label: 'first' } });
    store.registerExternalMenu({ app_id: 'ext', item: { id: 'a', label: 'second' } });

    expect(store.externalMenusByApp.ext).toHaveLength(1);
    expect(store.externalMenusByApp.ext[0].label).toBe('second');

    store.unregisterExternalMenu('ext');
    expect(store.externalMenusByApp.ext).toBeUndefined();
  });

  it('parks and consumes a companion panel request exactly once', () => {
    const store = usePetStore();
    store.requestCompanionLoad({ mode: 'schema', title: '面板' });

    expect(store.takeCompanionLoad()?.title).toBe('面板');
    expect(store.takeCompanionLoad()).toBeNull();
  });

  it('keeps the command history unique, newest first and bounded', () => {
    const store = usePetStore();
    for (let i = 0; i < 30; i += 1) {
      store.commandHistory = [cmd(i), ...store.commandHistory];
    }
    store.commandHistory = ['/focus 25', ...store.commandHistory].slice(0, 25);

    expect(store.commandHistory[0]).toBe('/focus 25');
    expect(store.commandHistory).toHaveLength(25);
    expect(new Set(store.commandHistory).size).toBe(25);
  });
});

// The placeholder the host falls back to when no package could be read. It is a
// neutral id, not one of the shipped pets: a fallback that named a real pet would
// claim that pet's identity while showing a different picture.
const FALLBACK_ID = 'fallback_pet';
const cmd = (i: number) => `/cmd-${i}`;

function manifest(id: string, name: string, themeId?: string): PetManifest {
  return {
    id,
    name,
    version: '1.0.0',
    type: 'sprite',
    model: { entry: `${id}.svg`, scale: 1, offset: { x: 0, y: 0 } },
    // A palette belongs to the package: the host has no per-pet registry to look it up in.
    ...(themeId
      ? { theme: { id: themeId, name: themeId, primary: '#38bdf8', accent: '#f43f5e' } }
      : {}),
  };
}
