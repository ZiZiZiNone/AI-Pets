import type { LlmBridgeConfig, PetManifest, PetStatsState } from '@/types/pet';
import type { usePetStore } from '@/store/petStore';
import { inspectSystemTelemetry, projectTacticalHudScan } from './stageRuntime';
import {
  CARE_MESSAGES,
  COMMAND_MESSAGES,
  DEFAULT_BREAK_LABEL,
  DEFAULT_FOCUS_LABEL,
  DEFAULT_PERSONA_ID,
  DEFAULT_PET_NAME,
  FORTUNE_POOL,
  LLM_DEFAULT_MODEL,
  LLM_DEFAULT_SYSTEM_PROMPT,
  LLM_MAX_TOKENS,
  PERSONA_MESSAGES,
  PERSONA_POOLS,
  PET_ALIASES,
} from '@/constants/messages';
import {
  LIPSYNC_MAX_MS,
  LIPSYNC_MIN_MS,
  LIPSYNC_DURATION_MS_PER_CHAR,
  POMODORO_BREAK_MINUTES,
  POMODORO_DEFAULT_MINUTES,
} from '@/constants/timing';

type PetStore = ReturnType<typeof usePetStore>;

const CALC_RESULT_MS = 4500;
const CALC_ERROR_MS = 3600;
const HELP_MS = 6500;
const TODO_ADDED_MS = 3800;
const ARITHMETIC_TOKENS = /\d+(?:\.\d+)?|\*\*|[+\-*/%()]/g;
const NUMBER_LITERAL = /^\d+(?:\.\d+)?$/;
const RESULT_PRECISION = 6;

export { SLASH_COMMAND_HINTS } from '@/constants/messages';

export function pickDailyFortune(): string {
  return FORTUNE_POOL[Math.floor(Math.random() * FORTUNE_POOL.length)];
}

/**
 * Recursive-descent evaluator for the `/calc` command.
 *
 * Accepts only digits, the five arithmetic operators, unary sign and parentheses, so it
 * cannot reach the host runtime. Every token is consumed before a result is returned.
 */
export function evaluateSafeMathExpression(expr: string): number {
  const matched = expr.match(ARITHMETIC_TOKENS);
  if (!matched || matched.join('') !== expr.replace(/\s+/g, '')) {
    throw new Error('Invalid characters in arithmetic expression');
  }
  const tokens: string[] = matched;

  let pos = 0;
  const peek = (): string | undefined => tokens[pos];

  function parseExpression(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++];
      const right = parseTerm();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = tokens[pos++];
      const right = parsePower();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero');
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  function parsePower(): number {
    const base = parseUnary();
    if (peek() === '**') {
      pos++;
      return Math.pow(base, parsePower());
    }
    return base;
  }

  function parseUnary(): number {
    if (peek() === '+') {
      pos++;
      return parseUnary();
    }
    if (peek() === '-') {
      pos++;
      return -parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const token = tokens[pos];
    if (token === '(') {
      pos++;
      const value = parseExpression();
      if (tokens[pos] !== ')') throw new Error('Mismatched parentheses');
      pos++;
      return value;
    }
    if (token !== undefined && NUMBER_LITERAL.test(token)) {
      pos++;
      return Number(token);
    }
    throw new Error('Unexpected token');
  }

  const result = parseExpression();
  if (pos !== tokens.length || !Number.isFinite(result)) {
    throw new Error('Incomplete or non-finite expression');
  }
  return Number(result.toFixed(RESULT_PRECISION));
}

function fillTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, String(value)),
    template
  );
}

function pickFromPool(pool: readonly string[], input: string, affinity: number): string {
  const template = pool[Math.floor(Math.random() * pool.length)];
  return fillTemplate(template, { input, affinity });
}

export function generatePersonaDialogue(
  input: string,
  pet: PetManifest | null,
  stats: PetStatsState
): string {
  const lower = input.toLowerCase();
  const petId = pet?.id || DEFAULT_PERSONA_ID;
  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (lower.includes('时间') || lower.includes('几点') || lower.includes('time')) {
    return PERSONA_MESSAGES.clock(
      nowStr,
      stats.level,
      stats.energy,
      stats.completedPomodoros
    );
  }
  if (
    lower.includes('累') ||
    lower.includes('困') ||
    lower.includes('休息') ||
    lower.includes('tired')
  ) {
    return PERSONA_MESSAGES.tired;
  }
  if (lower.includes('bug') || lower.includes('报错') || lower.includes('调试')) {
    return PERSONA_MESSAGES.bugHint(petId);
  }

  return pickFromPool(PERSONA_POOLS[petId] || PERSONA_POOLS[DEFAULT_PERSONA_ID], input, stats.affinity);
}

export async function requestLlmCompletion(
  input: string,
  pet: PetManifest | null,
  llmConfig: LlmBridgeConfig
): Promise<string | null> {
  if (!llmConfig.enabled || !llmConfig.apiKey || !llmConfig.apiUrl) return null;

  try {
    const res = await fetch(llmConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model || LLM_DEFAULT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              llmConfig.customSystemPrompt ||
              LLM_DEFAULT_SYSTEM_PROMPT(
                pet?.name || DEFAULT_PET_NAME,
                pet?.description || ''
              ),
          },
          { role: 'user', content: input },
        ],
        max_tokens: LLM_MAX_TOKENS,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  } catch {
    return null;
  }
}

function bubbleMsForText(text: string): number {
  return Math.min(
    LIPSYNC_MAX_MS,
    Math.max(LIPSYNC_MIN_MS, text.length * LIPSYNC_DURATION_MS_PER_CHAR)
  );
}

export async function executeChatOrSlashCommand(
  petStore: PetStore,
  input: string
): Promise<void> {
  const slash = parseSlashCommand(input);
  if (!slash) {
    await respondWithPersona(petStore, input);
    return;
  }

  const handled = await runSlashCommand(petStore, slash.command, slash.args, slash.argString);
  if (handled) return;
  await respondWithPersona(petStore, input);
}

interface SlashCommand {
  command: string;
  args: string[];
  argString: string;
}

function parseSlashCommand(input: string): SlashCommand | null {
  if (!input.startsWith('/')) return null;
  const [command, ...args] = input.slice(1).split(/\s+/);
  return {
    command: command.toLowerCase(),
    args,
    argString: args.join(' ').trim(),
  };
}

async function runSlashCommand(
  petStore: PetStore,
  command: string,
  args: string[],
  argString: string
): Promise<boolean> {
  const firstNumber = Number(args[0]);

  switch (command) {
    case 'help':
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: COMMAND_MESSAGES.help,
        durationMs: HELP_MS,
      });
      return true;

    case 'focus':
      petStore.startPomodoro(
        firstNumber || POMODORO_DEFAULT_MINUTES,
        'focus',
        args.slice(1).join(' ') || DEFAULT_FOCUS_LABEL
      );
      return true;

    case 'break':
      petStore.startPomodoro(
        firstNumber || POMODORO_BREAK_MINUTES,
        'short_break',
        DEFAULT_BREAK_LABEL
      );
      return true;

    case 'stop':
      petStore.stopPomodoro();
      return true;

    case 'todo':
      if (!argString) return true;
      petStore.addTodo(argString, 'high');
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: CARE_MESSAGES.todoAdded(
          argString,
          petStore.todos.filter((t) => !t.done).length
        ),
        durationMs: TODO_ADDED_MS,
      });
      return true;

    case 'feed':
      petStore.feedQuantumCrystal();
      return true;

    case 'sys':
      await inspectSystemTelemetry(petStore);
      return true;

    case 'fortune':
      petStore.triggerFortuneDivination();
      return true;

    case 'scan':
      await projectTacticalHudScan(petStore);
      return true;

    case 'calc':
      if (argString) announceCalc(petStore, argString);
      return true;

    case 'pet':
      petStore.switchPetById(PET_ALIASES[argString.toLowerCase()] || argString);
      return true;

    default:
      return false;
  }
}

function announceCalc(petStore: PetStore, expression: string): void {
  try {
    petStore.scheduleAction({
      priority: 'P1',
      motion: 'happy',
      expression: 'smile',
      text: COMMAND_MESSAGES.calcResult(expression, evaluateSafeMathExpression(expression)),
      durationMs: CALC_RESULT_MS,
    });
  } catch {
    petStore.scheduleAction({
      priority: 'P2',
      motion: 'pat',
      expression: 'surprised',
      text: `${COMMAND_MESSAGES.calcError} 例如 \`/calc ${COMMAND_MESSAGES.calcErrorExample}\``,
      durationMs: CALC_ERROR_MS,
    });
  }
}

async function respondWithPersona(petStore: PetStore, input: string): Promise<void> {
  const llmReply = await requestLlmCompletion(input, petStore.currentPet, petStore.llmConfig);
  const reply =
    llmReply || generatePersonaDialogue(input, petStore.currentPet, petStore.stats);
  petStore.scheduleAction({
    priority: 'P1',
    motion: 'happy',
    expression: 'smile',
    text: reply,
    durationMs: bubbleMsForText(reply),
  });
}
