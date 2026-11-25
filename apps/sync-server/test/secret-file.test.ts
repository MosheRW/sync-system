import { execFileSync } from 'node:child_process';
import { chmodSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_SECRET_FILE_BYTES,
  SECRET_FILE_MESSAGES,
  SECRET_FILE_OPEN_FLAGS,
  SECRET_FILE_VARIABLES,
  type SecretFileSystem,
  readSecretFile,
  resolveSecret,
  stripOneTerminator,
} from '../src/config/secret-file.js';
import { expectNoSentinel, secretFileDir } from './helpers/secret-files.js';

/** Test-only values; never real secrets. */
const SENTINEL = 'SENTINEL-secret-file-Qm7Zx2Lv9Kd4Rt8Wn3Hb6Jf1';
const BASE64_SENTINEL = 'SENTINEL/b64+Qm7Zx2Lv9Kd4/Rt8Wn3Hb6Jf1=';
const URL_SENTINEL = 'redis://:SENTINEL-redis-pw@sentinel-host.example:6390';

const files = secretFileDir();
afterAll(() => files.cleanup());

const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function errno(code: string | undefined, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`failed ${SENTINEL}`), { code, path: SENTINEL, ...extra });
}

/** A fake file system: `content` is returned in chunks of `chunk` bytes. */
function fakeFs(
  options: {
    open?: () => number;
    stat?: () => { isFile(): boolean; size: number };
    content?: Buffer;
    chunk?: number;
    readError?: Error;
    /** Throws to say the path names no entry the server can see; succeeds by default. */
    lstat?: (path: string) => unknown;
  } = {},
): SecretFileSystem & { closed: number; opened: number } {
  const content = options.content ?? Buffer.from(SENTINEL);
  let offset = 0;
  const fs = {
    closed: 0,
    opened: 0,
    openSync: () => {
      fs.opened += 1;
      return options.open ? options.open() : 7;
    },
    fstatSync: () => (options.stat ? options.stat() : { isFile: () => true, size: content.length }),
    readSync: (_fd: number, buffer: Buffer, at: number, length: number) => {
      if (options.readError) throw options.readError;
      const n = Math.min(length, options.chunk ?? length, content.length - offset);
      content.copy(buffer, at, offset, offset + n);
      offset += n;
      return n;
    },
    closeSync: () => {
      fs.closed += 1;
    },
    lstatSync: (path: string) => (options.lstat ? options.lstat(path) : {}),
  };
  return fs;
}

function problemOf(result: ReturnType<typeof readSecretFile>): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.problem;
}

describe('readSecretFile: content rules (AC1, AC6)', () => {
  it.each([
    ['no terminator', 'abc', 'abc'],
    ['one \\n', 'abc\n', 'abc'],
    ['one \\r\\n', 'abc\r\n', 'abc'],
    ['two \\n (one kept)', 'abc\n\n', 'abc\n'],
    ['a lone \\r (kept)', 'abc\r', 'abc\r'],
    ['leading space (kept)', ' abc', ' abc'],
    ['trailing space (kept)', 'abc \n', 'abc '],
    ['leading tab (kept)', '\tabc', '\tabc'],
    ['interior spaces (kept)', 'a b  c\n', 'a b  c'],
    ['a BOM (kept)', '\uFEFFabc', '\uFEFFabc'],
    ['multi-byte UTF-8', 'àéî\n', 'àéî'],
  ])('%s', (_label, content, value) => {
    const path = files.file(`content-${Math.random().toString(36).slice(2)}`, content);
    expect(readSecretFile('TOKEN_SECRET_FILE', path)).toEqual({ ok: true, value });
  });

  it('strips exactly one terminator', () => {
    expect(stripOneTerminator('a\r\n')).toBe('a');
    expect(stripOneTerminator('a\n')).toBe('a');
    expect(stripOneTerminator('a\r\n\r\n')).toBe('a\r\n');
    expect(stripOneTerminator('a\n\r')).toBe('a\n\r');
    expect(stripOneTerminator('')).toBe('');
  });

  it.each([
    ['0 bytes', ''],
    ['only \\n', '\n'],
    ['only \\r\\n', '\r\n'],
  ])('a file with %s is empty (Q2)', (_label, content) => {
    const path = files.file(`empty-${content.length}`, content);
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', path))).toBe(
      SECRET_FILE_MESSAGES.empty('TOKEN_SECRET_FILE', path),
    );
  });

  it(`accepts ${MAX_SECRET_FILE_BYTES} bytes and refuses ${MAX_SECRET_FILE_BYTES + 1}`, () => {
    const ok = files.file('max', 'a'.repeat(MAX_SECRET_FILE_BYTES));
    const big = files.file('max-plus-one', 'a'.repeat(MAX_SECRET_FILE_BYTES + 1));
    expect(readSecretFile('REDIS_URL_FILE', ok)).toEqual({
      ok: true,
      value: 'a'.repeat(MAX_SECRET_FILE_BYTES),
    });
    expect(problemOf(readSecretFile('REDIS_URL_FILE', big))).toBe(
      `REDIS_URL_FILE file "${big.length > 64 ? `${big.slice(0, 64)}...` : big}" is larger than 4096 bytes`,
    );
  });

  it('refuses more bytes than the cap even when the size lies, reading at most cap + 1', () => {
    const content = Buffer.alloc(100_000, 0x61);
    const fs = fakeFs({ content, chunk: 1000, stat: () => ({ isFile: () => true, size: 10 }) });
    const read = vi.spyOn(fs, 'readSync');
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', '/s', fs))).toContain(
      'is larger than 4096 bytes',
    );
    const total = read.mock.results.reduce((sum, r) => sum + (r.value as number), 0);
    expect(total).toBe(MAX_SECRET_FILE_BYTES + 1);
    expect(fs.closed).toBe(1);
  });

  it('refuses a size above the cap before reading', () => {
    const fs = fakeFs({ stat: () => ({ isFile: () => true, size: MAX_SECRET_FILE_BYTES + 1 }) });
    const read = vi.spyOn(fs, 'readSync');
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', '/s', fs))).toContain('is larger than');
    expect(read).not.toHaveBeenCalled();
    expect(fs.closed).toBe(1);
  });

  it('refuses invalid UTF-8 and a NUL character without echoing content', () => {
    const bad = files.file('bad-utf8', Buffer.concat([Buffer.from(SENTINEL), Buffer.from([0xff])]));
    const nul = files.file('nul', `${SENTINEL}\0x`);
    const badProblem = problemOf(readSecretFile('TOKEN_SECRET_FILE', bad));
    const nulProblem = problemOf(readSecretFile('TOKEN_SECRET_FILE', nul));
    expect(badProblem).toBe(SECRET_FILE_MESSAGES.notUtf8('TOKEN_SECRET_FILE', bad));
    expect(nulProblem).toBe(SECRET_FILE_MESSAGES.nul('TOKEN_SECRET_FILE', nul));
    expectNoSentinel(badProblem + nulProblem, SENTINEL);
  });

  it('zeroes the read buffer after decoding', () => {
    let seen: Buffer | undefined;
    const fs = fakeFs();
    const read = vi.spyOn(fs, 'readSync');
    let done = false;
    read.mockImplementation((_fd, buffer, at) => {
      seen = buffer;
      if (done) return 0;
      done = true;
      return Buffer.from(SENTINEL).copy(buffer, at);
    });
    expect(readSecretFile('TOKEN_SECRET_FILE', '/s', fs)).toEqual({ ok: true, value: SENTINEL });
    expect(seen!.every((byte) => byte === 0)).toBe(true);
  });
});

describe('readSecretFile: file system errors (AC4, AC7, Q6 narrowing)', () => {
  it('a missing file does not print the path', () => {
    const path = join(files.dir, 'missing');
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', path))).toBe(
      'TOKEN_SECRET_FILE file does not exist',
    );
  });

  it('a path below a regular file (ENOTDIR) does not exist either', () => {
    const parent = files.file('parent', 'x');
    const problem = problemOf(readSecretFile('TOKEN_SECRET_FILE', join(parent, 'child')));
    // Windows reports ENOENT here, POSIX ENOTDIR: both map to "does not exist".
    expect(problem).toBe('TOKEN_SECRET_FILE file does not exist');
  });

  it('a directory is not a regular file and its path is printed', () => {
    const dir = join(files.dir, 'a-directory');
    mkdirSync(dir);
    expect(problemOf(readSecretFile('REDIS_URL_FILE', dir))).toBe(
      SECRET_FILE_MESSAGES.notRegular('REDIS_URL_FILE', dir),
    );
  });

  it.skipIf(isWindows)('a FIFO does not block startup and is not a regular file', () => {
    const fifo = join(files.dir, 'a-fifo');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', fifo))).toBe(
      SECRET_FILE_MESSAGES.notRegular('TOKEN_SECRET_FILE', fifo),
    );
  });

  it.skipIf(isWindows || isRoot)('an unreadable file is "not readable by the server user"', () => {
    const path = files.file('unreadable', SENTINEL);
    chmodSync(path, 0o000);
    const problem = problemOf(readSecretFile('TOKEN_SECRET_PREVIOUS_FILE', path));
    expect(problem).toBe(SECRET_FILE_MESSAGES.notReadable('TOKEN_SECRET_PREVIOUS_FILE', path));
    expectNoSentinel(problem, SENTINEL);
  });

  it.each([
    ['EACCES', 'file "/run/secrets/x" is not readable by the server user'],
    ['EPERM', 'file "/run/secrets/x" is not readable by the server user'],
    ['EISDIR', 'file "/run/secrets/x" is not a regular file'],
    ['ENOENT', 'file does not exist'],
    ['ENOTDIR', 'file does not exist'],
    ['EIO', 'file cannot be read (EIO)'],
    ['ENAMETOOLONG', 'file cannot be read (ENAMETOOLONG)'],
    ['not a code', 'file cannot be read (unknown)'],
    ['Eio', 'file cannot be read (unknown)'],
    [undefined, 'file cannot be read (unknown)'],
  ])('maps an open error %s without its message or path', (code, expected) => {
    const fs = fakeFs({
      open: () => {
        throw errno(code);
      },
    });
    const problem = problemOf(readSecretFile('TOKEN_SECRET_FILE', '/run/secrets/x', fs));
    expect(problem).toBe(`TOKEN_SECRET_FILE ${expected}`);
    expectNoSentinel(problem, SENTINEL);
    expect(fs.closed).toBe(0);
  });

  it.each([
    ['EACCES', 'EACCES'],
    ['EACCES', 'ENOENT'],
    ['EPERM', 'EACCES'],
    ['EPERM', 'ENOTDIR'],
    ['EACCES', undefined],
  ])(
    'an open error %s omits the path when lstat fails with %s (entry not known to exist)',
    (code, lstatCode) => {
      const lstat = vi.fn(() => {
        throw errno(lstatCode);
      });
      const fs = fakeFs({
        open: () => {
          throw errno(code);
        },
        lstat,
      });
      const problem = problemOf(readSecretFile('TOKEN_SECRET_FILE', SENTINEL, fs));
      expect(problem).toBe(SECRET_FILE_MESSAGES.notAccessible('TOKEN_SECRET_FILE'));
      expect(problem).toBe('TOKEN_SECRET_FILE file is not accessible to the server user');
      expect(lstat).toHaveBeenCalledTimes(1);
      expectNoSentinel(problem, SENTINEL);
    },
  );

  it('an open error EACCES prints the path only after lstat finds the entry', () => {
    const lstat = vi.fn(() => ({}));
    const fs = fakeFs({
      open: () => {
        throw errno('EACCES');
      },
      lstat,
    });
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', '/run/secrets/x', fs))).toBe(
      SECRET_FILE_MESSAGES.notReadable('TOKEN_SECRET_FILE', '/run/secrets/x'),
    );
    expect(lstat).toHaveBeenCalledWith('/run/secrets/x');
  });

  it('does not lstat for an error after a successful open', () => {
    const lstat = vi.fn(() => {
      throw errno('ENOENT');
    });
    const fs = fakeFs({
      stat: () => {
        throw errno('EACCES');
      },
      lstat,
    });
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', '/s', fs))).toBe(
      SECRET_FILE_MESSAGES.notReadable('TOKEN_SECRET_FILE', '/s'),
    );
    expect(lstat).not.toHaveBeenCalled();
  });

  it.skipIf(isWindows || isRoot)(
    'a file under an unsearchable directory does not print its path',
    () => {
      const locked = join(files.dir, 'locked');
      mkdirSync(locked, { mode: 0o700 });
      const path = join(locked, SENTINEL);
      chmodSync(locked, 0o000);
      try {
        const problem = problemOf(readSecretFile('TOKEN_SECRET_FILE', path));
        expect(problem).toBe(SECRET_FILE_MESSAGES.notAccessible('TOKEN_SECRET_FILE'));
        expectNoSentinel(problem, SENTINEL);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it('maps a thrown non-error value to "unknown"', () => {
    const fs = fakeFs({
      open: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw SENTINEL;
      },
    });
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', '/s', fs))).toBe(
      'TOKEN_SECRET_FILE file cannot be read (unknown)',
    );
  });

  it.each([
    ['fstat', 'EACCES', 'file "/s" is not readable by the server user'],
    ['fstat', 'EIO', 'file cannot be read (EIO)'],
    ['read', 'EISDIR', 'file "/s" is not a regular file'],
    ['read', 'EIO', 'file cannot be read (EIO)'],
    ['read', 'ENOENT', 'file cannot be read (ENOENT)'],
  ])('a %s error %s after the open closes the descriptor', (where, code, expected) => {
    const fs = fakeFs(
      where === 'fstat'
        ? {
            stat: () => {
              throw errno(code);
            },
          }
        : { readError: errno(code) },
    );
    const problem = problemOf(readSecretFile('TOKEN_SECRET_FILE', '/s', fs));
    expect(problem).toBe(`TOKEN_SECRET_FILE ${expected}`);
    expectNoSentinel(problem, SENTINEL);
    expect(fs.closed).toBe(1);
  });

  it('closes the descriptor on success and on every content error', () => {
    for (const content of [SENTINEL, '', '\n', '\0', '\xff']) {
      const fs = fakeFs({ content: Buffer.from(content, 'latin1') });
      readSecretFile('TOKEN_SECRET_FILE', '/s', fs);
      expect(fs.closed).toBe(1);
    }
    const notFile = fakeFs({ stat: () => ({ isFile: () => false, size: 0 }) });
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', '/s', notFile))).toContain(
      'is not a regular file',
    );
    expect(notFile.closed).toBe(1);
  });

  it('opens read-only, non-blocking and without a controlling terminal', () => {
    const fs = fakeFs();
    const open = vi.spyOn(fs, 'openSync');
    readSecretFile('TOKEN_SECRET_FILE', '/s', fs);
    expect(open).toHaveBeenCalledWith('/s', SECRET_FILE_OPEN_FLAGS);
    expect(SECRET_FILE_OPEN_FLAGS & constants.O_WRONLY).toBe(0);
    expect(SECRET_FILE_OPEN_FLAGS & constants.O_RDWR).toBe(0);
    if (!isWindows) {
      expect(SECRET_FILE_OPEN_FLAGS & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      expect(SECRET_FILE_OPEN_FLAGS & constants.O_NOCTTY).toBe(constants.O_NOCTTY);
    }
  });

  it('prints a path with control characters as ? and cuts a long path', () => {
    const fs = fakeFs({
      open: () => {
        throw errno('EACCES');
      },
    });
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', '/run/x\nConfig error: y', fs))).toBe(
      'TOKEN_SECRET_FILE file "/run/x?Config error: y" is not readable by the server user',
    );
    const long = `/${'d'.repeat(100)}`;
    expect(problemOf(readSecretFile('TOKEN_SECRET_FILE', long, fs))).toBe(
      `TOKEN_SECRET_FILE file "${long.slice(0, 64)}..." is not readable by the server user`,
    );
  });

  it('never echoes a secret pasted into X_FILE by mistake (security C9)', () => {
    for (const [variable, value] of [
      ['TOKEN_SECRET_FILE', SENTINEL],
      ['TOKEN_SECRET_FILE', BASE64_SENTINEL],
      ['REDIS_URL_FILE', URL_SENTINEL],
    ] as const) {
      const problem = problemOf(readSecretFile(variable, value));
      expect(problem.startsWith(`${variable} file `)).toBe(true);
      expectNoSentinel(problem, value);
      expectNoSentinel(problem, 'SENTINEL-redis-pw');
    }
  });
});

describe('resolveSecret (AC1, AC3, AC5)', () => {
  it.each(SECRET_FILE_VARIABLES)('reads %s from %s_FILE', (variable) => {
    const path = files.file(`resolve-${variable}`, `${SENTINEL}\n`);
    const problems: string[] = [];
    expect(resolveSecret({ [`${variable}_FILE`]: path }, variable, problems)).toEqual({
      kind: 'set',
      value: SENTINEL,
      from: 'file',
      label: `${variable} (from ${variable}_FILE)`,
    });
    expect(problems).toEqual([]);
  });

  it.each(SECRET_FILE_VARIABLES)('reads %s from the environment unchanged', (variable) => {
    const problems: string[] = [];
    expect(resolveSecret({ [variable]: ` ${SENTINEL}\n` }, variable, problems)).toEqual({
      kind: 'set',
      value: ` ${SENTINEL}\n`,
      from: 'env',
      label: variable,
    });
    expect(resolveSecret({}, variable, problems)).toEqual({ kind: 'unset' });
    expect(problems).toEqual([]);
  });

  for (const variable of SECRET_FILE_VARIABLES) {
    it.each([
      [SENTINEL, '/run/secrets/x'],
      ['', '/run/secrets/x'],
      [SENTINEL, ''],
      ['', ''],
    ])(
      `${variable} and ${variable}_FILE both set (%j, %j) is a conflict; no file is opened`,
      (direct, path) => {
        const fs = fakeFs();
        const problems: string[] = [];
        expect(
          resolveSecret({ [variable]: direct, [`${variable}_FILE`]: path }, variable, problems, fs),
        ).toEqual({ kind: 'invalid' });
        expect(problems).toEqual([`${variable} and ${variable}_FILE are both set; set only one`]);
        expect(fs.opened).toBe(0);
      },
    );
  }

  it.each(SECRET_FILE_VARIABLES)('%s_FILE="" is an error, not unset', (variable) => {
    const fs = fakeFs();
    const problems: string[] = [];
    expect(resolveSecret({ [`${variable}_FILE`]: '' }, variable, problems, fs)).toEqual({
      kind: 'invalid',
    });
    expect(problems).toEqual([`${variable}_FILE must not be empty`]);
    expect(fs.opened).toBe(0);
  });

  it('a file problem is invalid and carries no content (C3, C6)', () => {
    const path = files.file('resolve-nul', `${SENTINEL}\0`);
    const problems: string[] = [];
    const result = resolveSecret({ TOKEN_SECRET_FILE: path }, 'TOKEN_SECRET', problems);
    expect(result).toEqual({ kind: 'invalid' });
    expect(problems).toEqual([SECRET_FILE_MESSAGES.nul('TOKEN_SECRET_FILE', path)]);
    expectNoSentinel(JSON.stringify(result) + inspect(result) + problems.join('\n'), SENTINEL);
  });

  it('an error object holding the secret in message and path leaks nothing (C8)', () => {
    const fs = fakeFs({
      open: () => {
        throw errno('EIO', { syscall: SENTINEL });
      },
    });
    const problems: string[] = [];
    resolveSecret({ TOKEN_SECRET_FILE: '/s' }, 'TOKEN_SECRET', problems, fs);
    expect(problems).toEqual(['TOKEN_SECRET_FILE file cannot be read (EIO)']);
  });
});
