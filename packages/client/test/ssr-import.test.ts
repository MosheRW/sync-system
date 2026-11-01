import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * AC7: importing the package without window, document or a global WebSocket
 * has no side effects. Nothing is pre-loaded: the import covers the whole
 * graph, including @sync-system/protocol and zod (whose eval probe reads
 * `navigator` and calls `new Function` unless the schemas are built jitless).
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

    // Creating a client (as SSR code might) touches nothing either.
    const client = new mod.SyncClient({
      url: 'wss://sync.example.com/ws',
      apiKey: 'test-api-key-ssr-0123456789-0123456789',
      appVersion: '1.0.0',
    });
    expect(client.getState()).toEqual({ status: 'idle' });
    expect(touched).toEqual([]);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The built package, imported by plain Node in a fresh process (no Vitest
 * transforms, default export conditions, so protocol's dist and the real
 * zod are loaded). Recording getters stand in for browser globals and for
 * `Function` and `eval`, so any read or eval probe shows up.
 */
const IMPORT_SCRIPT = `
const names = ['window', 'document', 'navigator', 'location', 'localStorage', 'WebSocket', 'self', 'Function', 'eval'];
const touched = [];
for (const name of names) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      touched.push(name);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    },
  });
}
const mod = await import(process.argv[1]);
process.stdout.write(JSON.stringify({ touched, hasClient: typeof mod.SyncClient === 'function' }));
`;

const require = createRequire(import.meta.url);
const clientDir = fileURLToPath(new URL('..', import.meta.url));
const protocolDir = fileURLToPath(new URL('../../protocol', import.meta.url));

function build(projectDir: string): void {
  execFileSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
    {
      cwd: projectDir,
      stdio: 'pipe',
    },
  );
}

describe('SSR-safe import of the built package (AC7)', () => {
  beforeAll(() => {
    // Always rebuild, so the test never checks a stale dist.
    build(protocolDir);
    build(clientDir);
  }, 120_000);

  it('dist/index.js reads no browser global and never touches Function or eval', () => {
    const entry = pathToFileURL(`${clientDir}/dist/index.js`).href;
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', IMPORT_SCRIPT, entry],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual({ touched: [], hasClient: true });
  });
});
