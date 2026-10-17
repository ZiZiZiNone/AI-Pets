import { createPinia, setActivePinia } from 'pinia';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import PodsTab from '@/companion/PodsTab.vue';
import type { SduiSchema, SduiWidget } from '@/types/pet';
import { SDUI_MAX_NESTING_DEPTH } from '@/constants/timing';

/**
 * Renders the companion's SDUI surface for real rather than asserting on the type union.
 *
 * "Every widget type can be pushed by a third-party app" is the claim, and a union member
 * that no template branch handles would satisfy the types while rendering nothing. SSR is
 * used because it needs no new dev dependency and still runs the component's setup and
 * template — what it cannot cover is user interaction, which is asserted separately where
 * the logic lives.
 */
async function renderWidgets(widgets: SduiWidget[]): Promise<string> {
  const schema: SduiSchema = { app_id: 'test_app', title: 'test', widgets };
  const app = createSSRApp(PodsTab, { schema, podOffsets: {} });
  const pinia = createPinia();
  app.use(pinia);
  setActivePinia(pinia);
  return await renderToString(app);
}

describe('SDUI widget surface', () => {
  it('renders every widget type the schema allows', async () => {
    const widgets: SduiWidget[] = [
      { id: 'w1', type: 'status_badge', label: '总线状态', value: 'ONLINE', tone: 'success' },
      { id: 'w2', type: 'switch', label: '攀爬开关', description: '说明文字', value: true },
      {
        id: 'w3',
        type: 'select',
        label: '帧率策略',
        value: 'dynamic',
        options: [{ label: '动态', value: 'dynamic' }],
      },
      { id: 'w4', type: 'slider', label: '同步增益', value: 80, min: 10, max: 200, unit: '%' },
      {
        id: 'w5',
        type: 'button_group',
        label: '指令矩阵',
        buttons: [{ id: 'b1', label: '播报', variant: 'primary' }],
      },
      { id: 'w6', type: 'log_viewer', label: '遥测流', lines: ['[Kernel] ready'] },
      {
        id: 'w7',
        type: 'text_input',
        label: '接口地址',
        value: 'https://example.com/v1',
        placeholder: '输入地址',
        description: '文本控件说明',
      },
    ];

    const html = await renderWidgets(widgets);
    expect(html).toContain('总线状态');
    expect(html).toContain('ONLINE');
    expect(html).toContain('攀爬开关');
    expect(html).toContain('说明文字');
    expect(html).toContain('帧率策略');
    expect(html).toContain('动态');
    expect(html).toContain('同步增益');
    expect(html).toContain('指令矩阵');
    expect(html).toContain('播报');
    expect(html).toContain('遥测流');
    expect(html).toContain('[Kernel] ready');
    // The text widget is the newest member of the union; if its branch were missing the
    // types would still compile and this label would never reach the DOM.
    expect(html).toContain('接口地址');
    expect(html).toContain('https://example.com/v1');
    expect(html).toContain('输入地址');
    expect(html).toContain('文本控件说明');
  });

  it('renders a text widget as a single-line input by default', async () => {
    const html = await renderWidgets([
      { id: 'w1', type: 'text_input', label: '单行', value: 'v' },
    ]);
    expect(html).toContain('<input');
    expect(html).not.toContain('<textarea');
  });

  it('renders a multi-line text widget as a textarea', async () => {
    const html = await renderWidgets([
      { id: 'w1', type: 'text_input', label: '多行', value: 'v1\nv2', multiline: true },
    ]);
    expect(html).toContain('<textarea');
  });

  it('adds a submit button only when the schema asks for one', async () => {
    const withButton = await renderWidgets([
      { id: 'w1', type: 'text_input', label: 'x', value: '', submit_label: '提交' },
    ]);
    const withoutButton = await renderWidgets([
      { id: 'w1', type: 'text_input', label: 'x', value: '' },
    ]);
    expect(withButton).toContain('提交');
    expect(withoutButton).not.toContain('提交');
  });

  it('renders a schema with no widgets without failing', async () => {
    const html = await renderWidgets([]);
    expect(html).toContain('spatial-pods-stream');
  });

  it('says so when a widget type is one the host does not render', async () => {
    // A schema is data, so `type` can be any string a panel author typed. Before this the
    // card rendered empty: a panel could tell a host that is too old from one that never
    // received the value only by guessing.
    const html = await renderWidgets([
      { id: 'w1', type: 'holo_orb' } as unknown as SduiWidget,
    ]);
    expect(html).toContain('未知控件类型');
    expect(html).toContain('holo_orb');
    // The notice has to name the supported set, otherwise the author is left with the
    // problem and no next step.
    expect(html).toContain('text_input');
  });

  it('carries a declared effect through to the rendered control', async () => {
    // The effect is what replaced the renderer's id list, so a control is only usable by a
    // third-party panel if the field survives rendering alongside it.
    const html = await renderWidgets([
      {
        id: 'anything',
        type: 'switch',
        label: '语音播报',
        value: true,
        effect: { kind: 'setting', setting: 'tts' },
      },
    ]);
    expect(html).toContain('语音播报');
    expect(html).toContain('cyber-switch');
  });

  it('renders the children of a container, not just the container', async () => {
    // A container that renders its own label and drops `children` would satisfy the type
    // union and still lose whatever the panel put inside it.
    const html = await renderWidgets([
      {
        id: 'group',
        type: 'container',
        label: '语音设置',
        children: [
          { id: 'c1', type: 'switch', label: '朗读气泡', value: true },
          { id: 'c2', type: 'slider', label: '音量', value: 3, min: 1, max: 5 },
        ],
      },
    ]);
    expect(html).toContain('语音设置');
    expect(html).toContain('朗读气泡');
    expect(html).toContain('音量');
    expect(html).toContain('sdui-container');
  });

  it('nests a container inside a container', async () => {
    const html = await renderWidgets([
      {
        id: 'outer',
        type: 'container',
        layout: 'row',
        children: [
          {
            id: 'inner',
            type: 'container',
            label: '内层分组',
            children: [{ id: 'deep', type: 'status_badge', label: '深层状态', value: 'OK' }],
          },
        ],
      },
    ]);
    expect(html).toContain('内层分组');
    expect(html).toContain('深层状态');
    expect(html).toContain('layout-row');
  });

  it('renders up to the nesting ceiling and explains the level past it', async () => {
    // A schema is data, so it can describe a container inside itself. Without a ceiling the
    // renderer recurses until the stack runs out; with one, the level past it has to explain
    // itself rather than render an empty box. The leaf sits one level below the innermost
    // container, so it is reachable exactly when that container is still rendered.
    const nest = (levels: number): SduiWidget => {
      let widget: SduiWidget = { id: 'leaf', type: 'status_badge', label: '最深处', value: 'X' };
      for (let i = 0; i < levels; i += 1) {
        widget = { id: `n${i}`, type: 'container', children: [widget] };
      }
      return widget;
    };

    const withinCeiling = await renderWidgets([nest(SDUI_MAX_NESTING_DEPTH)]);
    expect(withinCeiling).toContain('最深处');
    expect(withinCeiling).not.toContain('嵌套层数超过');

    const pastCeiling = await renderWidgets([nest(SDUI_MAX_NESTING_DEPTH + 1)]);
    expect(pastCeiling).toContain(`嵌套层数超过 ${SDUI_MAX_NESTING_DEPTH} 层`);
    expect(pastCeiling).not.toContain('最深处');
  });
});
