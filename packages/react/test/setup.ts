import { afterAll, expect } from 'vitest';

/**
 * No unhandled rejection or uncaught exception may fire anywhere in the
 * suite (L6, H2). Each test file asserts this once all its tests have run.
 */
const failures: string[] = [];

const onRejection = (reason: unknown) => {
  failures.push(`unhandledRejection: ${reason instanceof Error ? reason.name : typeof reason}`);
};
const onException = (err: Error) => {
  failures.push(`uncaughtException: ${err.name}`);
};

process.on('unhandledRejection', onRejection);
process.on('uncaughtException', onException);

afterAll(() => {
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
  expect(failures).toEqual([]);
});
