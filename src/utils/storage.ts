/**
 * Typed, failure-tolerant `localStorage` access.
 *
 * Two identical copies of this helper existed in the stage and care stores. Private
 * browsing, quota exhaustion and corrupted payloads all resolve to the supplied
 * fallback rather than throwing into a render path.
 */

export function loadStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return Array.isArray(fallback)
      ? (Array.isArray(parsed) ? (parsed as T) : fallback)
      : ({ ...fallback, ...(parsed as object) } as T);
  } catch {
    return fallback;
  }
}

export function saveStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private-mode failure is non-fatal: state stays in memory.
  }
}
