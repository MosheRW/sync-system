// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * AC12: importing the package in Node (no DOM) has no side effects: no
 * browser global read, no timer, no microtask.
 */
const BROWSER_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
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

describe('side-effect-free import (AC12)', () => {
  it('imports src without reading browser globals or starting timers', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const microtaskSpy = vi.spyOn(globalThis, 'queueMicrotask');
    installTraps();

    const mod = await import('../src/index.js');

    expect(mod.SyncProvider).toBeTypeOf('function');
    expect(touched).toEqual([]);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(microtaskSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The built package, imported by plain Node in a fresh process (default
 * export conditions: the client's and protocol's dist and the real React).
 * Recording getters stand in for browser globals, `Function` and `eval`.
 */
const IMPORT_SCRIPT = `
const names = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'WebSocket', 'self', 'Function', 'eval'];
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
let timers = 0;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { timers += 1; return realSetTimeout(...args); };
const mod = await import(process.argv[1]);
process.stdout.write(JSON.stringify({ touched, timers, hasProvider: typeof mod.SyncProvider === 'function' }));
`;

const require = createRequire(import.meta.url);
const reactDir = fileURLToPath(new URL('..', import.meta.url));
const clientDir = fileURLToPath(new URL('../../client', import.meta.url));
const protocolDir = fileURLToPath(new URL('../../protocol', import.meta.url));

function build(projectDir: string): void {
  execFileSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
    { cwd: projectDir, stdio: 'pipe' },
  );
}

describe('side-effect-free import of the built package (AC12)', () => {
  beforeAll(() => {
    // Always rebuild, so the test never checks a stale dist.
    build(protocolDir);
    build(clientDir);
    build(reactDir);
  }, 120_000);

  it('dist/index.js reads no browser global, starts no timer, never touches Function or eval', () => {
    const entry = pathToFileURL(`${reactDir}/dist/index.js`).href;
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', IMPORT_SCRIPT, entry],
      { encoding: 'utf8', cwd: reactDir, env: { ...process.env, NODE_ENV: 'production' } },
    );
    expect(JSON.parse(output)).toEqual({ touched: [], timers: 0, hasProvider: true });
  });
});
