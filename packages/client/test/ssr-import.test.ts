import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * AC7: importing the package without window, document or a global WebSocket
 * has no side effects. Throwing getters catch any read of a browser global.
 */
const BROWSER_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'WebSocket',
];

const saved = new Map<string, PropertyDescriptor | undefined>();
const touched: string[] = [];

function installTraps(): void {
  for (const name of BROWSER_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        throw new Error(`global ${name} read`);
      },
    });
  }
}

function removeTraps(): void {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
}

afterEach(() => {
  removeTraps();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SSR-safe import (AC7)', () => {
  it('imports without reading browser globals, starting timers or throwing', async () => {
    // The protocol package is evaluated first: zod (its dependency) probes
    // `typeof navigator` once when its first schema is built, which a throwing
    // trap would turn into a failure. This test covers this package's own code.
    await import('@sync-system/protocol');
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const microtaskSpy = vi.spyOn(globalThis, 'queueMicrotask');
    installTraps();

    const mod = await import('../src/index.js');

    expect(mod).toBeDefined();
    expect(touched).toEqual([]);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(microtaskSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
