import type { LlmBridgeConfig, PetManifest, PetStatsState } from '@/types/pet';
import type { usePetStore } from '@/store/petStore';
import { inspectSystemTelemetry, projectTacticalHudScan } from './stageRuntime';
import {
  CARE_MESSAGES,
  COMMAND_MESSAGES,
  DEFAULT_BREAK_LABEL,
  DEFAULT_FOCUS_LABEL,
  DEFAULT_PERSONA_ID,
  FORTUNE_POOL,
  PERSONA_MESSAGES,
  PERSONA_POOLS,
  PET_ALIASES,
} from '@/constants/messages';
import { buildPetSystemPrompt } from '@/utils/petPersona';
import {
  isLlmConfigUsable,
  sendLlmChat,
  sendLlmChatStream,
  type LlmChatMessage,
  type LlmProviderConfig,
} from '@/utils/llmProviders';
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
const HISTORY_CLEARED_MS = 4200;
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

/**
 * How much conversation the model is shown by default.
 *
 * Bounded rather than unlimited because every turn is re-sent with each request: an
 * unbounded history makes each reply slower and more expensive than the last, and a pet
 * that has been running for days would eventually exceed the model's own window. Eight
 * messages is four exchanges, which is enough for pronouns and follow-ups to resolve.
 */
export const LLM_HISTORY_MAX_MESSAGES = 8;

/** Longest single turn kept verbatim; pasted logs are truncated rather than re-sent whole. */
export const LLM_HISTORY_MAX_CHARS = 500;

/** Default exchange window, in turns, for a config that has never been edited. */
export const LLM_HISTORY_DEFAULT_TURNS = LLM_HISTORY_MAX_MESSAGES / 2;

/** Ceiling for the user-configurable window, so a typo cannot re-send a whole session. */
export const LLM_HISTORY_MAX_TURNS = 20;

/**
 * Turn a configured exchange count into a message count.
 *
 * Anything unusable — missing (a config saved before the field existed), negative, NaN —
 * resolves to the default rather than to "unbounded", because `slice(-NaN)` and `slice(-0)`
 * both mean `slice(0)`: the bug would not be an error, it would be silently re-sending the
 * entire conversation on every request.
 */
export function resolveLlmHistoryMessages(turns?: number): number {
  if (typeof turns !== 'number' || !Number.isFinite(turns)) return LLM_HISTORY_MAX_MESSAGES;
  const whole = Math.floor(turns);
  if (whole <= 0) return 0;
  return Math.min(whole, LLM_HISTORY_MAX_TURNS) * 2;
}

/** The last `maxMessages` entries, each capped in length. `0` means no memory at all. */
function tailOf(history: readonly LlmChatMessage[], maxMessages: number): LlmChatMessage[] {
  if (maxMessages <= 0) return [];
  return history.slice(-maxMessages).map((message) => ({
    role: message.role,
    content:
      message.content.length > LLM_HISTORY_MAX_CHARS
        ? message.content.slice(0, LLM_HISTORY_MAX_CHARS)
        : message.content,
  }));
}

export function trimLlmHistory(
  history: readonly LlmChatMessage[],
  maxMessages: number = LLM_HISTORY_MAX_MESSAGES
): LlmChatMessage[] {
  return tailOf(history, maxMessages);
}

/** Append one exchange, dropping the oldest turns so the window stays bounded. */
export function appendLlmTurn(
  history: readonly LlmChatMessage[],
  userInput: string,
  reply: string,
  maxMessages: number = LLM_HISTORY_MAX_MESSAGES
): LlmChatMessage[] {
  return tailOf(
    [
      ...history,
      { role: 'user', content: userInput },
      { role: 'assistant', content: reply },
    ],
    maxMessages
  );
}

/** Compose the request: character brief first, then the remembered turns, then input. */
export function buildLlmMessages(
  systemPrompt: string,
  history: readonly LlmChatMessage[],
  userInput: string,
  maxMessages: number = LLM_HISTORY_MAX_MESSAGES
): LlmChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...tailOf(history, maxMessages),
    { role: 'user', content: userInput },
  ];
}

/** The provider-facing view of the bridge config, shared by the buffered and streamed paths. */
function toProviderConfig(llmConfig: LlmBridgeConfig): LlmProviderConfig {
  return {
    provider: llmConfig.provider,
    apiUrl: llmConfig.apiUrl,
    apiKey: llmConfig.apiKey,
    model: llmConfig.model,
    temperature: llmConfig.temperature,
    maxTokens: llmConfig.maxTokens,
  };
}

export async function requestLlmCompletion(
  input: string,
  pet: PetManifest | null,
  llmConfig: LlmBridgeConfig,
  history: readonly LlmChatMessage[] = []
): Promise<string | null> {
  const providerConfig = toProviderConfig(llmConfig);
  if (!isLlmConfigUsable(providerConfig)) return null;

  return sendLlmChat(
    buildLlmMessages(
      buildPetSystemPrompt(pet, llmConfig.customSystemPrompt),
      history,
      input,
      resolveLlmHistoryMessages(llmConfig.historyTurns)
    ),
    providerConfig
  );
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

    case 'reset': {
      const cleared = petStore.clearLlmHistory(petStore.currentPet?.id ?? '');
      petStore.scheduleAction({
        priority: 'P1',
        motion: 'happy',
        expression: 'smile',
        text: COMMAND_MESSAGES.historyCleared(cleared),
        durationMs: HISTORY_CLEARED_MS,
      });
      return true;
    }

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
  const petId = petStore.currentPet?.id ?? '';
  const history = petStore.llmHistoryFor(petId);
  const maxMessages = resolveLlmHistoryMessages(petStore.llmConfig.historyTurns);

  // Only the stage window streams into a bubble. The companion window owns no bubble of its
  // own — its reply is relayed to the stage as one piece — so streaming there would mean
  // pushing half-sentences across the bus for no visible gain.
  const streamId =
    petStore.windowRole === 'main' && petStore.llmConfig.stream
      ? petStore.beginStreamedReply()
      : null;
  let streamed = '';

  let llmReply: string | null;
  if (streamId) {
    llmReply = await sendLlmChatStream(
      buildLlmMessages(
        buildPetSystemPrompt(petStore.currentPet, petStore.llmConfig.customSystemPrompt),
        history,
        input,
        maxMessages
      ),
      toProviderConfig(petStore.llmConfig),
      (delta) => {
        streamed += delta;
        petStore.pushStreamedText(streamId, streamed);
      }
    );
  } else {
    llmReply = await requestLlmCompletion(
      input,
      petStore.currentPet,
      petStore.llmConfig,
      history
    );
  }

  if (llmReply) {
    // Only real model turns are remembered. Recording the offline fallbacks as well would
    // feed canned lines back to the model as if the pet had written them, and the next
    // reply would start imitating the template instead of the persona.
    petStore.recordLlmTurn(petId, input, llmReply);
  }
  const reply =
    llmReply || generatePersonaDialogue(input, petStore.currentPet, petStore.stats);
  const durationMs = bubbleMsForText(reply);

  if (streamId) {
    // The last fragment already put this text on screen, so ending here neither re-types the
    // sentence nor leaves the bubble without a deadline.
    petStore.endStreamedReply(streamId, reply, durationMs);
    return;
  }
  petStore.scheduleAction({
    priority: 'P1',
    motion: 'happy',
    expression: 'smile',
    text: reply,
    durationMs,
  });
}
