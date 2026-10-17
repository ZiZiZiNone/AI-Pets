import { beforeEach, describe, expect, it } from 'vitest';
import { loadStorage, saveStorage } from '@/utils/storage';

describe('storage helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the fallback when nothing is stored', () => {
    expect(loadStorage('missing', { a: 1 })).toEqual({ a: 1 });
    expect(loadStorage('missing', ['x'])).toEqual(['x']);
  });

  it('round-trips objects and arrays', () => {
    saveStorage('obj', { a: 1, b: 'two' });
    expect(loadStorage('obj', { a: 0 })).toEqual({ a: 1, b: 'two' });

    saveStorage('arr', [1, 2, 3]);
    expect(loadStorage('arr', [] as number[])).toEqual([1, 2, 3]);
  });

  it('merges missing object keys from the fallback', () => {
    saveStorage('partial', { a: 9 });
    expect(loadStorage('partial', { a: 0, b: 0 })).toEqual({ a: 9, b: 0 });
  });

  it('falls back when the stored array is the wrong shape', () => {
    saveStorage('shape', { not: 'an array' });
    expect(loadStorage('shape', ['fallback'])).toEqual(['fallback']);
  });

  it('falls back on malformed JSON instead of throwing', () => {
    localStorage.setItem('broken', '{not json');
    expect(loadStorage('broken', { safe: true })).toEqual({ safe: true });
  });

  it('falls back when the stored primitive is the wrong shape', () => {
    saveStorage('scalar', 42);
    expect(loadStorage('scalar', { safe: true })).toEqual({ safe: true });
  });

  it('survives a storage backend that throws on write', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => saveStorage('quota', { a: 1 })).not.toThrow();
    Storage.prototype.setItem = original;
  });
});
