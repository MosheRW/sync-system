import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QrCodeView, qrPath } from '../src/components/group/QrCodeView.js';
import { I18nProvider } from '../src/i18n/index.js';
import { connected } from './helpers/fake-sync-client.js';
import { CODES, createAsLeader, largeScreen, renderGroupApp } from './helpers/group.js';

const TICKET = `eyJnIjoxfQ.${'s'.repeat(43)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('QR rendering (#24 ADR 0007, R12)', () => {
  it('draws one path of dark-module runs, or nothing for a link that does not fit', () => {
    const path = qrPath(`https://reader.example.org/?book=a%2Fb#t=${TICKET}`)!;
    expect(path.size).toBeGreaterThanOrEqual(21);
    expect(path.d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    expect(qrPath('x'.repeat(5000))).toBeNull();
  });

  it('renders SVG elements with a fixed name: no data URL, no style attribute, no ticket', () => {
    const { container } = render(
      <I18nProvider lang="en">
        <QrCodeView
          state={{ status: 'ready', ticket: { ticket: TICKET, expiresAt: Date.now() + 300_000 } }}
          linkFor={(ticket) => `https://reader.example.org/#t=${ticket}`}
          offline={false}
          hasCodes
        />
      </I18nProvider>,
    );
    const svg = screen.getByRole('img', { name: 'QR code to join this group' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('path')!.getAttribute('d')).not.toBe('');
    expect(container.innerHTML).not.toContain('data:');
    expect(container.innerHTML).not.toContain('style=');
    expect(container.innerHTML).not.toContain(TICKET);
  });

  it.each([
    [{ status: 'loading', ticket: null } as const, false, true, 'Making a QR code…'],
    [
      { status: 'unavailable' } as const,
      false,
      true,
      "Can't show a QR code right now. People can still join with a code.",
    ],
    [{ status: 'unavailable' } as const, false, false, "Can't show a QR code right now."],
    [{ status: 'idle' } as const, true, true, "The QR code will refresh when you're back online."],
  ])('shows the %j state', (state, offline, hasCodes, text) => {
    render(
      <I18nProvider lang="en">
        <QrCodeView state={state} linkFor={() => null} offline={offline} hasCodes={hasCodes} />
      </I18nProvider>,
    );
    expect(screen.getByText(text)).toBeDefined();
  });

  it('says the QR cannot be shown when no link can be built', () => {
    render(
      <I18nProvider lang="en">
        <QrCodeView
          state={{ status: 'ready', ticket: { ticket: TICKET, expiresAt: Date.now() + 1000 } }}
          linkFor={() => null}
          offline={false}
          hasCodes={false}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("Can't show a QR code right now.")).toBeDefined();
  });
});

describe('issuing QR tickets only while shown (#24 AC12)', () => {
  function issueTickets(client: Parameters<typeof createAsLeader>[0]) {
    client.impl.issueQrTicket = () => ({ ticket: TICKET, expiresAt: Date.now() + 300_000 });
  }

  it('shows the QR in the ready view, stops when it closes, and again from the strip', async () => {
    const { client } = await renderGroupApp();
    issueTickets(client);
    await createAsLeader(client);
    await screen.findByRole('img', { name: 'QR code to join this group' });
    expect(client.count('issueQrTicket')).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));
    expect(screen.queryByRole('img', { name: 'QR code to join this group' })).toBeNull();
    const strip = screen.getByRole('region', { name: 'Group codes' });
    const qrButton = within(strip).getByRole('button', { name: 'Show QR code' });
    qrButton.focus();
    fireEvent.click(qrButton);
    const sheet = screen.getByRole('dialog', { name: 'Scan to join' });
    expect(
      await within(sheet).findByRole('img', { name: 'QR code to join this group' }),
    ).toBeDefined();
    expect(within(sheet).getByRole('img', { name: 'Group code: 4 8 2 9 1 3' })).toBeDefined();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(document.activeElement).toBe(qrButton);
  });

  it('issues nothing while the tab is hidden', async () => {
    const { client } = await renderGroupApp();
    issueTickets(client);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await createAsLeader(client);
    expect(client.count('issueQrTicket')).toBe(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it('remembers Show/Hide QR in the panel for the tab', async () => {
    largeScreen();
    const { client, storage } = await renderGroupApp();
    issueTickets(client);
    await createAsLeader(client);
    fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    expect(
      await within(panel).findByRole('img', { name: 'QR code to join this group' }),
    ).toBeDefined();
    fireEvent.click(within(panel).getByRole('button', { name: 'Hide QR code' }));
    expect(within(panel).queryByRole('img', { name: 'QR code to join this group' })).toBeNull();
    expect(storage.getItem('reader:v1:group@127.0.0.1:8080')).toContain('"qrShown":false');
  });

  it('shows no QR button for a group without method D', async () => {
    const { client } = await renderGroupApp();
    act(() => client.setConnection(connected(['A'])));
    await createAsLeader(client, ['A'], CODES);
    fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));
    expect(screen.queryByRole('button', { name: 'Show QR code' })).toBeNull();
    expect(client.count('issueQrTicket')).toBe(0);
  });
});
