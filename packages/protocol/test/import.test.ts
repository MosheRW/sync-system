import { afterEach, describe, expect, it } from 'vitest';

/**
 * Importing the protocol package reads no browser global and never evals
 * (#3 AC7): zod's eval probe (`typeof navigator`, `new Function("")`) runs
 * when the first z.object is built unless `jitless` is on.
 */
const TRAPPED = ['window', 'document', 'navigator', 'location', 'localStorage', 'Function', 'eval'];

const saved = new Map<string, PropertyDescriptor | undefined>();
const touched: string[] = [];

function installTraps(): void {
  for (const name of TRAPPED) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    saved.set(name, descriptor);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        // Hand back the real value so a probe cannot fail and hide the read.
        return descriptor && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
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
});

describe('import side effects', () => {
  it('builds the schemas without reading browser globals or calling Function/eval', async () => {
    installTraps();
    const mod = await import('../src/index.js');
    removeTraps();

    expect(touched).toEqual([]);
    expect(mod.parseServerMessage({ type: 'position.ack', reqId: 'c1' }).ok).toBe(true);
    expect(mod.parseClientMessage({ type: 'position.ack' }).ok).toBe(false);
  });

  it('puts back the previous zod jitless setting after building the schemas', async () => {
    await import('../src/index.js');
    const { z } = await import('zod');
    expect(z.config().jitless).toBeUndefined();
  });
});
