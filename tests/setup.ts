import { vi } from 'vitest';

/**
 * The host modules import Tauri APIs at module scope. Outside a Tauri shell these
 * would reject, so every test run swaps in inert doubles. Each store path that touches
 * the shell is expected to degrade gracefully rather than throw.
 */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('no host');
  }),
  convertFileSrc: (path: string) => path,
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    setPosition: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    startDragging: vi.fn(async () => {}),
  }),
  WebviewWindow: {
    getByLabel: vi.fn(async () => null),
  },
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
}));
