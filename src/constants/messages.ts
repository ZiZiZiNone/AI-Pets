import type { SlashCommandHint } from '@/types/pet';

/**
 * Single source of truth for every string the host shows a user.
 *
 * These lived inline across store actions, stage runtime and the command engine, which
 * duplicated copy, mixed presentation with logic and made localisation impossible.
 */

/**
 * Renders a memory reading, or `未知` when the platform query failed.
 *
 * The host reports `null` rather than a placeholder so an unavailable reading is never
 * shown as a real number.
 */
export function formatMemoryMb(value: number | null): string {
  return value === null ? '未知' : `${value}MB`;
}

export const SLASH_COMMAND_HINTS: SlashCommandHint[] = [
  { command: '/focus', usage: '/focus [分钟] [任务]', description: '开启番茄专注冲刺（默认 25m）', icon: '🍅' },
  { command: '/break', usage: '/break [分钟]', description: '开启护眼休息倒计时（默认 5m）', icon: '🍵' },
  { command: '/stop', usage: '/stop', description: '停止并重置当前番茄计时器', icon: '⏹️' },
  { command: '/todo', usage: '/todo <任务内容>', description: '快速添加一条高优待办事项', icon: '📝' },
  { command: '/feed', usage: '/feed', description: '投喂量子高能晶块（+25%⚡ / +30 EXP）', icon: '🍬' },
  { command: '/fortune', usage: '/fortune', description: '占卜今日代码编译与发版运势', icon: '🔮' },
  { command: '/sys', usage: '/sys', description: '巡检系统 CPU、内存与 WebSocket 状态', icon: '💻' },
  { command: '/scan', usage: '/scan', description: '投射全屏 AR 战术雷达标注层', icon: '🎯' },
  { command: '/calc', usage: '/calc <算式>', description: '安全算术求值（支持 + - * / % ** 括号）', icon: '🧮' },
  { command: '/pet', usage: '/pet <宠物 id>', description: '按 id 切换任意宠物（含自己放入的目录）', icon: '🧬' },
  { command: '/reset', usage: '/reset', description: '清空当前宠物的多轮对话记忆', icon: '🧠' },
  { command: '/help', usage: '/help', description: '查看快捷斜杠指令列表', icon: '💡' },
];

export const FORTUNE_POOL: readonly string[] = [
  '🌟【大吉 · 零警告编译】今日代码气运爆棚！复杂重构一次跑通，宜发版、宜合入主干 ✨',
  '⚡【中吉 · 灵感涌现】下午将攻克最棘手的架构难题，忌熬夜硬刚，宜开启 25m 番茄钟稳步推进！',
  '🔮【吉 · 性能跃升】今日优化过的算法帧率与吞吐量翻倍，摸摸宠物头部可叠加无 Bug 护盾~',
  '🍀【上上签 · 极速联调】前后端协议一次对齐，WebSocket 零丢包，宜联调热插拔组件！',
];

export const DEFAULT_PET_NAME = 'AETHER-VII';
export const DEFAULT_CARE_ITEM = '全息数据糖果';
export const FEDIBLE_QUANTUM_CRYSTAL = '量子高能晶块';
export const DEFAULT_FOCUS_LABEL = '深度代码冲刺';
export const DEFAULT_BREAK_LABEL = '护眼补水小憩';
export const EXTERNAL_POMODORO_LABEL = '外部联调专注冲刺';

export const FALLBACK_HIT_AREA_TEXT = (label: string): string => `触发了 ${label}~`;

export const STAGE_MESSAGES = {
  petLoaded: (name: string) =>
    `💠 [${name}] 已激活！右键展开陀螺仪战术翼，或点击 💬/🧬 体验养成与四大机体切换。`,
  petSwitched: (name: string, themeName: string) =>
    `🧬 机体跃迁完成：已装载【${name}】// 主题切换至 ${themeName}！`,
  petNotInstalled: (petId: string) =>
    `❗ 无法切换到【${petId}】：pets/ 下没有这个宠物包（需要 ${petId}/pet.yaml），已保持当前宠物。`,
  petSwitchWithoutId: '❗ 无法切换宠物：这次请求里没有带宠物 id。',
  petManifestPersisted: (petId: string) => `💾 蓝图校准已持久化写入 pets/${petId}/pet.yaml！`,
  petManifestLiveOnly: (scale: number) => `💾 蓝图参数已实时生效（Scale: ${scale}x）！`,
  externalMenuMounted: (appId: string) => `🔌 外部应用 [${appId}] 已挂载战术菜单！右键星盘即可调用。`,
  dragStart: '⚡ 反重力牵引中！靠近任何窗口顶栏松手即可磁吸驻留~',
  idleHint: '神经突触在线！右键召唤【双轨陀螺仪星盘】或点击 💬 开启智能对话 ✨',
  payloadCaptured: (fileName: string) => `⚡ 引力场已捕获外部载荷：${fileName}`,
  companionWoken: '🎛️ 伴生神经突触控制中心已唤醒！',
  localCommandDone: (label: string) => `⚡ 本地指令执行完成 (${label})`,
  asleep: '💤 检测到周围静默，已切入 24FPS 低功耗休眠巡航模式...',
  hydration: '💧 贴心健康提醒：连续专注很久啦，喝口水补充一下水分吧！',
  hydrationAck: '💧 已喝水 (+15 XP)',
  hydrationPayload: { item: '健康补水打卡', energy: 10, affinity: 4, xp: 15 },
  posture: '🧘 护眼与坐姿提醒：久坐容易肩颈疲劳，起身活动 2 分钟、远眺窗外吧！',
  postureAck: '🧘 已舒展肩颈 (+15 XP)',
  posturePayload: { item: '舒展肩颈打卡', energy: 12, affinity: 5, xp: 15 },
  snappedToWindow: (title: string) => `🧲 已磁吸驻留在窗口【${title}】顶栏~`,
  climbEnabled: '🧗 反重力攀爬已激活！拖拽靠近任何窗口标题栏即可磁吸锁定。',
  climbDisabled: '⚓ 已解除窗口顶栏磁吸锁定，恢复自由悬浮姿态。',
  edgePeekOn: '👀 已进入【贴边探头 Edge-Peek】姿态，全屏时绝不遮挡视野~',
  edgePeekOff: '✨ 已从屏幕边缘回归主工作区！',
  tacticalScan: '🎯 全屏战术 AR 雷达扫描已投射！标注层具备 100% 物理鼠标穿透能力。',
  telemetryNative: (t: {
    os_name: string;
    arch: string;
    cpu_cores: number;
    memory_usage_mb: number | null;
    ws_port: number;
    connected_clients: number;
    driver_app_id?: string | null;
  }) =>
    `💻 系统巡检：${t.os_name} (${t.arch}) | CPU ${t.cpu_cores} 核 | 运存 ${formatMemoryMb(
      t.memory_usage_mb
    )} | WS :${t.ws_port} 在线 ${t.connected_clients} 客户端${
      t.driver_app_id ? ` | 受 ${t.driver_app_id} 驱动` : ''
    }`,
  telemetryBrowser: (cores: number, fps: number, level: number) =>
    `💻 系统巡检：逻辑核心 ${cores} Threads | 渲染帧率 ${fps} FPS | 等级 Lv.${level}`,
  emotionSwitched: (emotion: string) => `⚡ 已响应外部指令切换状态：[${emotion.toUpperCase()}]`,
  externalGreeting: (name: string) => `👋 外部神经链路握手成功！我是 ${name}。`,
  docsOpened: '🌐 已为您在浏览器打开官方文档！',
  ambientThoughts: (name: string, affinity: number) =>
    [
      `✨ [${name}] 正在守护你的工作区（好感度 ${affinity}%）~`,
      '💡 按 Ctrl+K 或点击 💬 可唤出快捷指令栏，输入 `/focus 25` 开启番茄冲刺！',
      '⚡ 拖入任意代码文件即可统计行数与字节载荷。',
    ] as const,
} as const;

export const CARE_MESSAGES = {
  levelUp: (petName: string, level: number) =>
    `🎉 羁绊突破！[${petName}] 升至 Lv.${level}！能量已满载 ✨`,
  fed: (item: string, energyGain: number, energy: number, affinity: number, xpGain: number) =>
    `🍬 已吸收【${item}】！能量 +${energyGain}% (当前 ${energy}%) · 好感度 ${affinity}% · EXP +${xpGain} ✨`,
  focusStarted: (minutes: number, label: string) =>
    `🍅 番茄专注已启动（${minutes} 分钟：${label}）！我会安静陪伴你冲刺~`,
  breakStarted: (minutes: number) =>
    `🍵 护眼休息已启动（${minutes} 分钟），起身喝口水、远眺放松一下吧！`,
  stopped: '⏹️ 当前番茄计时已重置，随时准备开启下一轮专注！',
  focusCompleted: (label: string) =>
    `🏆 专注冲刺达成！【${label}】圆满完成，获得 +60 EXP！现在休息 5 分钟吧？`,
  breakCompleted: '⚡ 休息结束！精力已恢复满格，准备好开启下一轮专注了吗？',
  todoDone: (text: string) => `✅ 任务达成：【${text}】！奖励 +20 EXP ✨`,
  todoAdded: (text: string, openCount: number) =>
    `📝 已写入待办矩阵：【${text}】（未完成 ${openCount} 项）`,
  breakQuickReply: '🍵 开启5m休息',
  focusQuickReply: '🔥 再战25m',
  nextFocusQuickReply: '🔥 开启25m专注',
  breakQuickReplyPayload: {
    minutes: 5,
    mode: 'short_break',
    label: '护眼补水休息',
  },
} as const;

export const COMMAND_MESSAGES = {
  help:
    '💡 快捷指令：/focus [分] | /break [分] | /stop | /todo <事项> | /feed | /sys | /fortune | /scan | /calc <算式> | /pet <宠物 id> | /reset',
  calcResult: (expression: string, result: number) =>
    `🧮 算力核心结果：${expression} = ${result}`,
  calcError: '⚠️ 算式格式无法解析，示例：`/calc (1024 * 64) / 8`',
  calcErrorExample: '(1024 * 64) / 8',
  historyCleared: (turns: number) =>
    turns > 0
      ? `🧠 已清空 ${turns} 轮对话记忆，接下来是一段全新的对话。`
      : '🧠 当前宠物还没有对话记忆可以清空。',
} as const;

export const PERSONA_MESSAGES = {
  clock: (now: string, level: number, energy: number, pomodoros: number) =>
    `🕒 当前系统时间 ${now} | 等级 Lv.${level} (能量 ${energy}%)，已完成 ${pomodoros} 个番茄钟！`,
  tired: '🍵 检测到精力下降，建议输入 `/break 5` 开启 5 分钟护眼休息，起身活动一下肩颈吧~',
  /**
   * The answer to "this is broken".
   *
   * A pet that has its own way of saying it declares `persona.bug_hint` in its package;
   * the host line below is the characterless fallback, so a hundred pets do not all
   * report a bug in the same voice.
   */
  bugHint: (custom?: string) =>
    custom ||
    '⚡ 已定位到异常区！建议检查类型边界与异步竞态，或把文件拖进窗口直接解析。',
} as const;

/**
 * The lines a pet answers with when it declares none of its own.
 *
 * Deliberately characterless: a pet that has something to say says it in `persona.lines`
 * inside its own package. Keeping the spoken lines next to the character that says them
 * is what lets a hundred pets live side by side without sharing one voice.
 */
export const GENERIC_PERSONA_POOL: readonly string[] = [
  '收到「{input}」，同步率 {affinity}%。要一起把它理清楚吗？',
  '「{input}」记下了。要不要先开个 25 分钟专注，再回来收拾它？',
];

/**
 * System prompt assembly, split into a headline / traits / tail so a pet's persona can
 * supply the middle without having to restate the output contract at both ends.
 */
export const LLM_SYSTEM_PROMPT_HEADLINE = (name: string, description: string) =>
  description
    ? `你是桌面伴侣 ${name}（${description}）。`
    : `你是桌面伴侣 ${name}。`;

export const LLM_SYSTEM_PROMPT_TRAITS = (traits: string[]) =>
  `你的性格：${traits.join('、')}。`;

export const LLM_SYSTEM_PROMPT_TAIL =
  '回复要求：用简短有性格的中文，通常不超过 60 字；只依据当前画面与对话作答，看不清或不确定就直说，不编造。';

export const LLM_MAX_TOKENS = 140;
export const LLM_DEFAULT_MODEL = 'gpt-4o-mini';

/** LLM gateway probe states surfaced on the matrix tab status line. */
export const UI_TONE_LABELS = {
  idle: '⚡ 测试连接',
  missingKey: '⚠️ 需填 Key',
  pending: '⏳ 请求中...',
  success: '✓ 连通正常',
  failure: '✕ 连接失败',
} as const;
