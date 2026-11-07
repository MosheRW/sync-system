import { afterAll, afterEach, expect } from 'vitest';

/**
 * No unhandled rejection or uncaught exception may fire anywhere in the
 * suite. Each test file asserts this once all its tests have run.
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

// jsdom has no <dialog> modal API: a minimal shim that toggles `open` and
// fires `close` (#24 architecture 7.7). Inertness and real focus trapping
// are checked in the e2e suite (Chromium).
if (typeof HTMLDialogElement !== 'undefined' && !('showModal' in HTMLDialogElement.prototype)) {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    show(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
}

// jsdom has no matchMedia: phone width by default; tests stub wider screens.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom files: unmount every rendered tree after each test (no Vitest
// globals, so Testing Library cannot register this itself).
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}
