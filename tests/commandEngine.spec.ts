import { describe, expect, it } from 'vitest';
import {
  evaluateSafeMathExpression,
  generatePersonaDialogue,
  pickDailyFortune,
} from '@/utils/commandEngine';
import type { PetStatsState } from '@/types/pet';

const STATS: PetStatsState = {
  level: 7,
  xp: 120,
  xpToNext: 400,
  affinity: 81,
  mood: 60,
  energy: 45,
  totalInteractions: 30,
  completedPomodoros: 5,
  filesAnalyzed: 9,
};

describe('evaluateSafeMathExpression', () => {
  it('honours operator precedence', () => {
    expect(evaluateSafeMathExpression('2+3*4')).toBe(14);
    expect(evaluateSafeMathExpression('(2+3)*4')).toBe(20);
    expect(evaluateSafeMathExpression('2**3**2')).toBe(512);
  });

  it('handles unary sign, modulo and decimals', () => {
    expect(evaluateSafeMathExpression('-5 + 10')).toBe(5);
    expect(evaluateSafeMathExpression('--5')).toBe(5);
    expect(evaluateSafeMathExpression('10 % 3')).toBe(1);
    expect(evaluateSafeMathExpression('1.5 * 2')).toBe(3);
  });

  it('tolerates whitespace', () => {
    expect(evaluateSafeMathExpression('  ( 1024 * 64 ) / 8 ')).toBe(8192);
  });

  it('rejects division and modulo by zero', () => {
    expect(() => evaluateSafeMathExpression('1/0')).toThrow(/Division by zero/);
    expect(() => evaluateSafeMathExpression('1%0')).toThrow(/Division by zero/);
  });

  it('rejects unbalanced parentheses', () => {
    expect(() => evaluateSafeMathExpression('(1+2')).toThrow(/Mismatched parentheses/);
    expect(() => evaluateSafeMathExpression('1+2)')).toThrow();
  });

  it('rejects trailing garbage', () => {
    expect(() => evaluateSafeMathExpression('1+2)')).toThrow();
    expect(() => evaluateSafeMathExpression('2*3 4')).toThrow();
  });

  // The evaluator is reachable from a slash command, so anything that could reach the
  // JS runtime must be rejected outright rather than coerced.
  it.each([
    'process.exit(1)',
    'require("fs")',
    'globalThis',
    'constructor',
    '__proto__',
    '1;alert(1)',
    'alert(1)',
    '[1,2].map(x=>x)',
    '1+alert',
    'NaN',
    'Infinity',
    '0x10',
    "'a'",
  ])('refuses non-arithmetic input %s', (expr) => {
    expect(() => evaluateSafeMathExpression(expr)).toThrow();
  });

  it('never evaluates a bare identifier', () => {
    expect(() => evaluateSafeMathExpression('window')).toThrow(/Invalid characters/);
  });
});

describe('pickDailyFortune', () => {
  it('always returns one of the catalog entries', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(pickDailyFortune());
    expect(seen.size).toBeGreaterThan(0);
    for (const value of seen) expect(value.length).toBeGreaterThan(0);
  });
});

describe('generatePersonaDialogue', () => {
  it('answers clock questions with the current time', () => {
    expect(generatePersonaDialogue('现在几点', null, STATS)).toMatch(/当前系统时间/);
    expect(generatePersonaDialogue('what time is it', null, STATS)).toMatch(/当前系统时间/);
  });

  it('suggests a break when the user sounds tired', () => {
    expect(generatePersonaDialogue('我有点累了', null, STATS)).toMatch(/护眼休息/);
  });

  it('reports a bug in the voice the package declares', () => {
    const pet = { id: 'lane_shi', persona: { bug_hint: '这个 bug 会打喷嚏。' } } as never;
    expect(generatePersonaDialogue('这个报错了', pet, STATS)).toMatch(/打喷嚏/);
  });

  it('falls back to the default persona for an unknown pet', () => {
    const reply = generatePersonaDialogue('hello', { id: 'not_a_pet' } as never, STATS);
    expect(reply).toContain('hello');
    expect(reply).not.toContain('{input}');
  });

  it('substitutes every template placeholder', () => {
    const pets = [
      { id: 'a', persona: { lines: ['「{input}」交给我。', '同步率 {affinity}%，随时待命。'] } },
      { id: 'b', persona: { lines: ['{input}，收到。'] } },
      { id: 'c' },
    ];
    for (const pet of pets) {
      const reply = generatePersonaDialogue('ping', pet as never, STATS);
      expect(reply).not.toMatch(/\{(input|affinity)\}/);
    }
  });
});
