import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripLaterTickets } from '../src/group/deep-link.js';
import { createPastedLinkSignal } from '../src/group/pasted-link.js';
import { SYNC, readingReady, renderApp, testConfig } from './helpers/app.js';
import { FakeSyncClient } from './helpers/fake-sync-client.js';
import { getNotice, renderGroupApp } from './helpers/group.js';

const TICKET = `eyJnIjoxfQ.${'s'.repeat(43)}`;
const TEXT =
  "That link wasn't used. To join with it, open it in a new tab or scan the QR code again.";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  history.replaceState(null, '', '/');
  vi.useRealTimers();
});

function wire() {
  const signal = createPastedLinkSignal();
  stop = stripLaterTickets(window, signal.notify);
  return signal;
}

function paste() {
  act(() => {
    history.replaceState(null, '', `/#t=${TICKET}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

function expectNoTicketAnywhere() {
  const html = document.documentElement.outerHTML;
  expect(html).not.toContain(TICKET);
  expect(html).not.toContain('#t=');
  expect(location.href).not.toContain(TICKET);
}

describe('pasted QR link notice (#25 AC57, design F24)', () => {
  it('shows a sticky banner on the reading page, announced, no join', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] });
    const pastedLinks = wire();
    const { client } = await renderGroupApp({ pastedLinks });
    paste();
    expect(getNotice(TEXT)).toBeDefined();
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe(TEXT);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(getNotice(TEXT)).toBeDefined();
    expect(client.count('joinByQr')).toBe(0);
    expectNoTicketAnywhere();
    paste();
    expect(getNotice(TEXT)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryAllByRole('status').filter((el) => !el.hasAttribute('aria-live'))).toEqual(
      [],
    );
  });

  it('shows a sticky notice on the library page', async () => {
    const pastedLinks = wire();
    const client = new FakeSyncClient();
    renderApp({
      config: testConfig('library', 'on', { sync: SYNC }),
      syncClient: client,
      pastedLinks,
    });
    await screen.findByRole('button', { name: 'Join a group' });
    paste();
    expect(getNotice(TEXT)).toBeDefined();
    expect(client.count('joinByQr')).toBe(0);
    expectNoTicketAnywhere();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(TEXT)).toBeNull();
  });

  it('is silent with sync off', async () => {
    const pastedLinks = wire();
    renderApp({
      config: testConfig('library', 'on'),
      location: { search: '?book=samples%2Fpride-and-prejudice-en' },
      pastedLinks,
    });
    await readingReady();
    paste();
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(location.hash).toBe('');
  });
});
