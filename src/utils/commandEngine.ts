import type {
  LlmBridgeConfig,
  PetManifest,
  PetStatsState,
  SlashCommandHint,
} from '@/types/pet';
import type { usePetStore } from '@/store/petStore';
import { inspectSystemTelemetry, projectTacticalHudScan } from './stageRuntime';

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
  { command: '/pet', usage: '/pet <aether|nyx|pulse|nova>', description: '快速切换四大内置机体', icon: '🧬' },
  { command: '/help', usage: '/help', description: '查看快捷斜杠指令列表', icon: '💡' },
];

const FORTUNE_POOL = [
  '🌟【大吉 · 零警告编译】今日代码气运爆棚！复杂重构一次跑通，宜发版、宜合入主干 ✨',
  '⚡【中吉 · 灵感涌现】下午将攻克最棘手的架构难题，忌熬夜硬刚，宜开启 25m 番茄钟稳步推进！',
  '🔮【吉 · 性能跃升】今日优化过的算法帧率与吞吐量翻倍，摸摸宠物头部可叠加无 Bug 护盾~',
  '🍀【上上签 · 极速联调】前后端协议一次对齐，WebSocket 零丢包，宜联调热插拔组件！',
];

export function pickDailyFortune(): string {
  return FORTUNE_POOL[Math.floor(Math.random() * FORTUNE_POOL.length)];
}

export function evaluateSafeMathExpression(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?|\*\*|[+\-*/%()]/g);
  if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) {
    throw new Error('Invalid characters in arithmetic expression');
  }

  let pos = 0;

  function parseExpression(): number {
    let val = parseTerm();
    while (pos < tokens!.length && (tokens![pos] === '+' || tokens![pos] === '-')) {
      const op = tokens![pos++];
      const right = parseTerm();
      val = op === '+' ? val + right : val - right;
    }
    return val;
  }

  function parseTerm(): number {
    let val = parsePower();
    while (
      pos < tokens!.length &&
      (tokens![pos] === '*' || tokens![pos] === '/' || tokens![pos] === '%')
    ) {
      const op = tokens![pos++];
      const right = parsePower();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero');
      val = op === '*' ? val * right : op === '/' ? val / right : val % right;
    }
    return val;
  }

  function parsePower(): number {
    const base = parseUnary();
    if (pos < tokens!.length && tokens![pos] === '**') {
      pos++;
      return Math.pow(base, parsePower());
    }
    return base;
  }

  function parseUnary(): number {
    if (tokens![pos] === '+') {
      pos++;
      return parseUnary();
    }
    if (tokens![pos] === '-') {
      pos++;
      return -parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const tok = tokens![pos];
    if (tok === '(') {
      pos++;
      const val = parseExpression();
      if (tokens![pos] !== ')') throw new Error('Mismatched parentheses');
      pos++;
      return val;
    }
    if (tok !== undefined && /^\d+(?:\.\d+)?$/.test(tok)) {
      pos++;
      return Number(tok);
    }
    throw new Error('Unexpected token');
  }

  const result = parseExpression();
  if (pos !== tokens.length || !Number.isFinite(result)) {
    throw new Error('Incomplete or non-finite expression');
  }
  return Number(result.toFixed(6));
}

export function generatePersonaDialogue(
  input: string,
  pet: PetManifest | null,
  stats: PetStatsState
): string {
  const lower = input.toLowerCase();
  const petId = pet?.id || 'aether_mecha_core';
  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (lower.includes('时间') || lower.includes('几点') || lower.includes('time')) {
    return `🕒 当前系统时间 ${nowStr} | 等级 Lv.${stats.level} (能量 ${stats.energy}%)，已完成 ${stats.completedPomodoros} 个番茄钟！`;
  }
  if (lower.includes('累') || lower.includes('困') || lower.includes('休息') || lower.includes('tired')) {
    return '🍵 检测到精力下降，建议输入 `/break 5` 开启 5 分钟护眼休息，起身活动一下肩颈吧~';
  }
  if (lower.includes('bug') || lower.includes('报错') || lower.includes('调试')) {
    if (petId === 'nyx_abyssal_familiar') {
      return '✦ 星盘显示这个 Bug 藏在异步状态或边界条件里，把文件拖给我解析吧！';
    }
    if (petId === 'pulse_glitch_phantom') {
      return '💥 BUG DETECTED! 把源码直接拖进窗口，我们一起拆解它！';
    }
    return '⚡ 战术雷达已锁定异常区！建议检查类型边界与异步竞态，或将文件拖入窗口直接解析。';
  }

  const personaPool: Record<string, string[]> = {
    aether_mecha_core: [
      `[AETHER-VII] 已接收指令「${input}」——同步率 ${stats.affinity}%，随时待命！（输入 /help 查看指令）`,
      `⚡ 反重力核心共鸣中！收到「${input}」，需要开启 25 分钟番茄冲刺（/focus 25）吗？`,
    ],
    nyx_abyssal_familiar: [
      `✦ 喵呜~ 夜蚀星盘听到了「${input}」，星轨正为你汇聚今日的灵感与吉兆！`,
      `🔮 契约者，关于「${input}」，不妨先喝口水，再用 /fortune 占卜今日运势哦~`,
    ],
    pulse_glitch_phantom: [
      `💥 YO! 收到信号「${input}」！RGB 故障通道全开，今天也要写出最酷的代码！`,
      `🎸 DROP THE BEAT // 「${input}」已写入脉冲流，需要投射全屏 AR 雷达（/scan）吗？`,
    ],
    demo_sprite_pet: [
      `🌟 收到啦！「${input}」~ 星奈一直在这里陪着你，摸摸头或投喂糖果（/feed）会更有干劲哦！`,
      `✨ 听到你说「${input}」，今天也要元气满满地完成待办任务呀！`,
    ],
  };

  const list = personaPool[petId] || personaPool.aether_mecha_core;
  return list[Math.floor(Math.random() * list.length)];
}

export async function requestLlmCompletion(
  input: string,
  pet: PetManifest | null,
  llmConfig: LlmBridgeConfig
): Promise<string | null> {
  if (!llmConfig.enabled || !llmConfig.apiKey || !llmConfig.apiUrl) return null;

  try {
    const personaPrompt =
      llmConfig.customSystemPrompt ||
      `你是桌面伴侣 ${pet?.name || 'AETHER-VII'}（${pet?.description || ''}）。请用简短有性格的中文（不超过60字）回复。`;
    const res = await fetch(llmConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: personaPrompt },
          { role: 'user', content: input },
        ],
        max_tokens: 140,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

export async function executeChatOrSlashCommand(
  petStore: ReturnType<typeof usePetStore>,
  input: string
): Promise<void> {
  if (input.startsWith('/')) {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    const argStr = rest.join(' ').trim();
    const lower = cmd.toLowerCase();

    if (lower === 'help') {
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: '💡 快捷指令：/focus [分] | /break [分] | /todo <事项> | /feed | /sys | /fortune | /calc <算式> | /pet <aether|nyx|pulse|nova>',
        durationMs: 6500,
      });
      return;
    }
    if (lower === 'focus') {
      petStore.startPomodoro(Number(rest[0]) || 25, 'focus', rest.slice(1).join(' ') || '深度代码冲刺');
      return;
    }
    if (lower === 'break') {
      petStore.startPomodoro(Number(rest[0]) || 5, 'short_break', '护眼补水小憩');
      return;
    }
    if (lower === 'stop') {
      petStore.stopPomodoro();
      return;
    }
    if (lower === 'todo' && argStr) {
      petStore.addTodo(argStr, 'high');
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: `📝 已写入待办矩阵：【${argStr}】（未完成 ${petStore.todos.filter((t) => !t.done).length} 项）`,
        durationMs: 3800,
      });
      return;
    }
    if (lower === 'feed') {
      petStore.feedPetCareItem('量子高能晶块', 25, 8, 30);
      return;
    }
    if (lower === 'sys') {
      await inspectSystemTelemetry(petStore);
      return;
    }
    if (lower === 'fortune') {
      petStore.triggerFortuneDivination();
      return;
    }
    if (lower === 'scan') {
      await projectTacticalHudScan(petStore);
      return;
    }
    if (lower === 'calc' && argStr) {
      try {
        const res = evaluateSafeMathExpression(argStr);
        petStore.scheduleAction({
          priority: 'P1',
          motion: 'happy',
          expression: 'smile',
          text: `🧮 算力核心结果：${argStr} = ${res}`,
          durationMs: 4500,
        });
      } catch {
        petStore.scheduleAction({
          priority: 'P2',
          motion: 'pat',
          expression: 'surprised',
          text: '⚠️ 算式格式无法解析，示例：`/calc (1024 * 64) / 8`',
          durationMs: 3600,
        });
      }
      return;
    }
    if (lower === 'pet') {
      const map: Record<string, string> = {
        aether: 'aether_mecha_core',
        nyx: 'nyx_abyssal_familiar',
        pulse: 'pulse_glitch_phantom',
        nova: 'demo_sprite_pet',
      };
      petStore.switchPetById(map[argStr.toLowerCase()] || argStr);
      return;
    }
  }

  const llmReply = await requestLlmCompletion(input, petStore.currentPet, petStore.llmConfig);
  const reply = llmReply || generatePersonaDialogue(input, petStore.currentPet, petStore.stats);
  petStore.scheduleAction({
    priority: 'P1',
    motion: 'happy',
    expression: 'smile',
    text: reply,
    durationMs: Math.min(6800, Math.max(3800, reply.length * 85)),
  });
}
