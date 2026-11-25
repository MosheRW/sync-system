import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { shownText } from './apps-config.js';
import type { EnvSource } from './env.js';

/**
 * Reading a secret from a file named by an `X_FILE` variable (ADR 0023,
 * #58). This module is the only code that opens a secret file (security C1).
 *
 * Messages come from SECRET_FILE_MESSAGES only: they name the variable and,
 * for an entry that exists, the sanitized path. File content, error text,
 * `err.path`, sizes and offsets are never printed (security C2).
 */

/** The variables that may be read from a file; each has an `X_FILE` twin. */
export const SECRET_FILE_VARIABLES = [
  'TOKEN_SECRET',
  'TOKEN_SECRET_PREVIOUS',
  'REDIS_URL',
] as const;

export type SecretVariable = (typeof SECRET_FILE_VARIABLES)[number];
export type SecretFileVariable = `${SecretVariable}_FILE`;

/** Largest accepted secret file, in bytes (Gate 1 Q3). */
export const MAX_SECRET_FILE_BYTES = 4096;

/** An errno code is printed only when it has this shape (security C2). */
const ERRNO_CODE_PATTERN = /^E[A-Z0-9]+$/;

/** The `Config error` lines of this module (architecture 5.2). */
export const SECRET_FILE_MESSAGES = {
  conflict: (base: SecretVariable, variable: SecretFileVariable): string =>
    `${base} and ${variable} are both set; set only one`,
  emptyVariable: (variable: SecretFileVariable): string => `${variable} must not be empty`,
  missing: (variable: SecretFileVariable): string => `${variable} file does not exist`,
  notReadable: (variable: SecretFileVariable, path: string): string =>
    `${variable} file "${shownText(path)}" is not readable by the server user`,
  /** EACCES/EPERM where the entry is not known to exist (an unsearchable directory). */
  notAccessible: (variable: SecretFileVariable): string =>
    `${variable} file is not accessible to the server user`,
  notRegular: (variable: SecretFileVariable, path: string): string =>
    `${variable} file "${shownText(path)}" is not a regular file`,
  tooLarge: (variable: SecretFileVariable, path: string): string =>
    `${variable} file "${shownText(path)}" is larger than ${MAX_SECRET_FILE_BYTES} bytes`,
  empty: (variable: SecretFileVariable, path: string): string =>
    `${variable} file "${shownText(path)}" is empty`,
  notUtf8: (variable: SecretFileVariable, path: string): string =>
    `${variable} file "${shownText(path)}" is not valid UTF-8`,
  nul: (variable: SecretFileVariable, path: string): string =>
    `${variable} file "${shownText(path)}" contains a NUL character`,
  cannotRead: (variable: SecretFileVariable, code: string): string =>
    `${variable} file cannot be read (${code})`,
} as const;

/** The file system calls the reader makes; injectable so errno mapping is testable everywhere. */
export interface SecretFileSystem {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; size: number };
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: null): number;
  closeSync(fd: number): void;
  /** Only to learn whether the entry exists; the file is not opened (no content is read). */
  lstatSync(path: string): unknown;
}

const NODE_FS: SecretFileSystem = { openSync, fstatSync, readSync, closeSync, lstatSync };

/** Flags that only exist on some platforms are undefined elsewhere (Windows). */
function optionalFlag(name: 'O_NONBLOCK' | 'O_NOCTTY'): number {
  return (constants as Readonly<Record<string, number | undefined>>)[name] ?? 0;
}

/**
 * Read-only; `O_NONBLOCK` so a FIFO cannot block startup, `O_NOCTTY` so a
 * terminal device never becomes the controlling terminal (security F2).
 * Symlinks are followed (Kubernetes secret volumes).
 */
export const SECRET_FILE_OPEN_FLAGS =
  constants.O_RDONLY | optionalFlag('O_NONBLOCK') | optionalFlag('O_NOCTTY');

export type SecretFileResult = { ok: true; value: string } | { ok: false; problem: string };

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** True when `lstat` finds an entry at `path`; it reads no content. */
function entryExists(fs: SecretFileSystem, path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The problem for a failed system call. `exists` is true once the open
 * succeeded; before that the path is printed only for an entry known to
 * exist: EISDIR proves it, and for EACCES/EPERM an `lstat` of the path must
 * succeed (an unsearchable directory on the path also gives EACCES). So a
 * secret pasted into `X_FILE` is never echoed (Gate 2, narrowing of Q6).
 */
function errorProblem(
  variable: SecretFileVariable,
  path: string,
  err: unknown,
  exists: boolean,
  fs: SecretFileSystem,
): string {
  const code = errnoCode(err);
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return exists || entryExists(fs, path)
        ? SECRET_FILE_MESSAGES.notReadable(variable, path)
        : SECRET_FILE_MESSAGES.notAccessible(variable);
    case 'EISDIR':
      return SECRET_FILE_MESSAGES.notRegular(variable, path);
    case 'ENOENT':
    case 'ENOTDIR':
      if (!exists) return SECRET_FILE_MESSAGES.missing(variable);
      break;
    default:
      break;
  }
  return SECRET_FILE_MESSAGES.cannotRead(
    variable,
    code !== undefined && ERRNO_CODE_PATTERN.test(code) ? code : 'unknown',
  );
}

/** Removes exactly one trailing `\r\n`, else one trailing `\n` (Gate 1 Q1). */
export function stripOneTerminator(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

/**
 * Reads the secret in the file at `path` (the value of `variable`). Bounded
 * and race-free: the decision about the file type and size is made on the
 * open descriptor, at most MAX_SECRET_FILE_BYTES + 1 bytes are read, and
 * the descriptor is always closed (security C1). Never throws for an error
 * of the file system: every such error becomes a fixed message (C8).
 */
export function readSecretFile(
  variable: SecretFileVariable,
  path: string,
  fs: SecretFileSystem = NODE_FS,
): SecretFileResult {
  let fd: number;
  try {
    fd = fs.openSync(path, SECRET_FILE_OPEN_FLAGS);
  } catch (err) {
    return { ok: false, problem: errorProblem(variable, path, err, false, fs) };
  }
  const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
  try {
    let length: number;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        return { ok: false, problem: SECRET_FILE_MESSAGES.notRegular(variable, path) };
      }
      if (stat.size > MAX_SECRET_FILE_BYTES) {
        return { ok: false, problem: SECRET_FILE_MESSAGES.tooLarge(variable, path) };
      }
      length = 0;
      // The size can lie (special mounts): read until EOF or one byte past the cap.
      while (length < buffer.length) {
        const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (read <= 0) break;
        length += read;
      }
    } catch (err) {
      return { ok: false, problem: errorProblem(variable, path, err, true, fs) };
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // A failed close of a read-only descriptor loses nothing.
      }
    }
    if (length > MAX_SECRET_FILE_BYTES) {
      return { ok: false, problem: SECRET_FILE_MESSAGES.tooLarge(variable, path) };
    }
    let text: string;
    try {
      // `ignoreBOM: true` keeps a BOM in the text, so the value checks reject it.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      return { ok: false, problem: SECRET_FILE_MESSAGES.notUtf8(variable, path) };
    }
    if (text.includes('\0')) {
      return { ok: false, problem: SECRET_FILE_MESSAGES.nul(variable, path) };
    }
    const value = stripOneTerminator(text);
    if (value === '') return { ok: false, problem: SECRET_FILE_MESSAGES.empty(variable, path) };
    return { ok: true, value };
  } finally {
    // Best effort: the decoded string lives on, like an env value (C5).
    buffer.fill(0);
  }
}

export type ResolvedSecret =
  /** Neither `X` nor `X_FILE` is set. */
  | { kind: 'unset' }
  /** A problem was pushed; the caller must never fall back to a default (C3). */
  | { kind: 'invalid' }
  /** `label` names the source in validation messages: `X` or `X (from X_FILE)`. */
  | { kind: 'set'; value: string; from: 'env' | 'file'; label: string };

/**
 * The value of `variable` from the environment or from the file named by
 * `<variable>_FILE` (ADR 0023). Both set (even to `""`) is a conflict and
 * the file is not opened; `X_FILE=""` is an error, not "unset". Problems are
 * pushed to `problems`; the result never carries an error text.
 */
export function resolveSecret(
  env: EnvSource,
  variable: SecretVariable,
  problems: string[],
  fs: SecretFileSystem = NODE_FS,
): ResolvedSecret {
  const fileVariable: SecretFileVariable = `${variable}_FILE`;
  const direct = env[variable];
  const path = env[fileVariable];
  if (direct !== undefined && path !== undefined) {
    problems.push(SECRET_FILE_MESSAGES.conflict(variable, fileVariable));
    return { kind: 'invalid' };
  }
  if (path === '') {
    problems.push(SECRET_FILE_MESSAGES.emptyVariable(fileVariable));
    return { kind: 'invalid' };
  }
  if (path !== undefined) {
    const read = readSecretFile(fileVariable, path, fs);
    if (!read.ok) {
      problems.push(read.problem);
      return { kind: 'invalid' };
    }
    return {
      kind: 'set',
      value: read.value,
      from: 'file',
      label: `${variable} (from ${fileVariable})`,
    };
  }
  if (direct !== undefined) return { kind: 'set', value: direct, from: 'env', label: variable };
  return { kind: 'unset' };
}
