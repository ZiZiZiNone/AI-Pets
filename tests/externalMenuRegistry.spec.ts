import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { usePetStore } from '@/store/petStore';
import RadialMenu from '@/components/RadialMenu.vue';
import type { MenuItemSchema } from '@/types/pet';

/**
 * The astrolabe's menu, as external programs contribute to it.
 *
 * The rules under test are the ones a program on the other side of the bus has to be
 * able to rely on: re-registering an id replaces the item, the order on the ring comes
 * from `priority` rather than from the order of registration, one program cannot take
 * the whole ring, and an item that would run a command never reaches the menu.
 */
describe('外部菜单注册表', () => {
  let pinia: Pinia;

  beforeEach(() => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一个 id 再注册一次就换掉旧条目，标题与处理器一起换', () => {
    const store = usePetStore();

    store.registerExternalMenu({
      app_id: 'ext',
      item: {
        id: 'focus_toggle',
        label: '暂停专注',
        action: { type: 'emit', event: 'pomodoro.pause' },
      },
    });
    store.registerExternalMenu({
      app_id: 'ext',
      item: {
        id: 'focus_toggle',
        label: '继续专注',
        action: { type: 'emit', event: 'pomodoro.resume' },
      },
    });

    expect(store.externalMenusByApp.ext).toHaveLength(1);
    expect(store.externalMenusByApp.ext[0].label).toBe('继续专注');
    expect(store.externalMenusByApp.ext[0].action?.event).toBe('pomodoro.resume');
  });

  it('替换的条目留在原来的位置上，不跳来跳去', () => {
    const store = usePetStore();
    store.registerExternalMenu({ app_id: 'ext', item: { id: 'a', label: '甲' } });
    store.registerExternalMenu({ app_id: 'ext', item: { id: 'b', label: '乙' } });

    store.registerExternalMenu({ app_id: 'ext', item: { id: 'a', label: '甲改' } });

    expect(store.buildMenuTree().map((m) => m.id)).toEqual(['a', 'b']);
    expect(store.buildMenuTree()[0].label).toBe('甲改');
  });

  it('一个程序最多留 8 条，超出的按优先级最低淘汰', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = usePetStore();

    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'keep', label: '保留', priority: 10 },
    });
    for (let i = 0; i < 8; i += 1) {
      store.registerExternalMenu({
        app_id: 'ext',
        item: { id: `low_${i}`, label: `低${i}`, priority: 1 },
      });
    }

    const ids = store.externalMenusByApp.ext.map((m) => m.id);
    expect(ids).toHaveLength(8);
    expect(ids).toContain('keep');
    // 同级里最早注册的那条先让位。
    expect(ids).not.toContain('low_0');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('low_0');
    warn.mockRestore();
  });

  it('按 priority 降序排列，同 priority 按注册顺序', () => {
    const store = usePetStore();
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'low', label: '低', priority: 1 },
    });
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'high', label: '高', priority: 5 },
    });
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'mid', label: '中', priority: 1 },
    });

    expect(store.buildMenuTree().map((m) => m.id)).toEqual(['high', 'low', 'mid']);
  });

  it('不显示声明了 exec 的条目，并记一条警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = usePetStore();

    store.registerExternalMenu({
      app_id: 'ext',
      item: {
        id: 'run_calc',
        label: '算一下',
        action: { type: 'exec', command: 'calc.exe' },
      },
    });

    expect(store.externalMenusByApp.ext).toBeUndefined();
    expect(store.buildMenuTree()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('exec');
    warn.mockRestore();
  });

  it('子菜单里声明了 exec 的条目同样被拦下，其余条目照常显示', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = usePetStore();

    store.registerExternalMenu({
      app_id: 'ext',
      item: {
        id: 'tools',
        label: '工具',
        children: [
          { id: 'ok', label: '好的' },
          { id: 'bad', label: '坏的', action: { type: 'exec', command: 'cmd.exe' } },
        ],
      },
    });

    const children = store.externalMenusByApp.ext[0].children ?? [];
    expect(children.map((c) => c.id)).toEqual(['ok']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('菜单每次打开都按当前注册状态重建', () => {
    const store = usePetStore();
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'first', label: '第一' },
    });
    expect(store.buildMenuTree().map((m) => m.id)).toEqual(['first']);

    // 菜单开着的时候插件又注册了一条：重建后的菜单要能看到它。
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'second', label: '第二' },
    });
    expect(store.buildMenuTree().map((m) => m.id)).toEqual(['first', 'second']);

    // 插件改了标题：重建后的菜单要显示新标题，而不是两份旧的。
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'first', label: '第一改' },
    });
    expect(store.buildMenuTree().map((m) => m.id)).toEqual(['first', 'second']);
    expect(store.buildMenuTree()[0].label).toBe('第一改');

    // 插件注销了：重建后的菜单里不能再有它的条目。
    store.unregisterExternalMenu('ext');
    expect(store.buildMenuTree()).toHaveLength(0);
    expect(store.mergedMenuTree).toHaveLength(0);
  });

  it('内置菜单排在前面，外部条目按自己的顺序跟在后面', () => {
    const store = usePetStore();
    store.currentPet = {
      ...(store.currentPet as never),
      menus: [{ id: 'pet', label: '宠物' }],
    };
    store.globalMenus = [{ id: 'global', label: '全局' }];

    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'ext_low', label: '外部低', priority: 1 },
    });
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'ext_high', label: '外部高', priority: 9 },
    });

    expect(store.buildMenuTree().map((m) => m.id)).toEqual([
      'pet',
      'global',
      'ext_high',
      'ext_low',
    ]);
  });

  it('外部条目的子菜单与交互配置原样保留', () => {
    const store = usePetStore();
    const children: MenuItemSchema[] = [
      { id: 'child', label: '子', interaction: { trigger: 'double_click' } },
    ];

    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'parent', label: '父', children },
    });

    const registered = store.externalMenusByApp.ext[0];
    expect(registered.children?.[0].id).toBe('child');
    expect(registered.children?.[0].interaction?.trigger).toBe('double_click');
    expect(registered.app_id).toBe('ext');
  });
});

/**
 * The astrolabe itself.
 *
 * The menu is built when it opens and rebuilt when the registry changes under it, so a
 * program that registers or replaces its items is seen without reopening the menu.
 */
describe('星盘菜单的重建', () => {
  let pinia: Pinia;
  let host: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  function labels(): string[] {
    return [...host.querySelectorAll('.wing-label')].map((node) => node.textContent ?? '');
  }

  it('打开时显示当前注册的条目，菜单开着时新增的条目也会立刻出现', async () => {
    const store = usePetStore();
    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'ext_item', label: '外部条目' },
    });

    const app = createApp(RadialMenu);
    app.use(pinia);
    app.mount(host);

    store.radialMenuOpen = true;
    await nextTick();
    expect(labels()).toContain('外部条目');

    store.registerExternalMenu({
      app_id: 'ext',
      item: { id: 'ext_item_two', label: '外部条目二' },
    });
    await nextTick();
    expect(labels()).toContain('外部条目二');

    app.unmount();
  });
});
