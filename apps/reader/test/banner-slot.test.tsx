import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BannerSlot } from '../src/components/group/BannerSlot.js';
import { NoticeBar } from '../src/components/group/controls.js';
import { ReadingScreen } from '../src/components/ReadingScreen.js';
import type { Banner, BannerContext } from '../src/group/banners.js';
import { useBannerSlot } from '../src/group/use-banner-slot.js';
import { I18nProvider } from '../src/i18n/index.js';
import { loaded, pagedDoc } from './helpers/render.js';

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const MEMBER: BannerContext = { isLeader: false, isVice: false, locked: false, inGroup: true };

function fakeClock() {
  vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval', 'Date'] });
}
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

describe('NoticeBar auto-hide counts visible time only (#25 design 2.4, AC49)', () => {
  function bar(onAutoHide: () => void) {
    render(
      <NoticeBar
        dismissLabel="Dismiss"
        onDismiss={() => undefined}
        autoHideMs={15_000}
        onAutoHide={onAutoHide}
      >
        Info
      </NoticeBar>,
    );
    return screen.getByRole('status');
  }

  it('hides after 15 s of visible time and not before', () => {
    fakeClock();
    const hidden = vi.fn();
    bar(hidden);
    advance(14_750);
    expect(hidden).not.toHaveBeenCalled();
    advance(500);
    expect(hidden).toHaveBeenCalledTimes(1);
    advance(20_000);
    expect(hidden).toHaveBeenCalledTimes(1);
  });

  it('pauses while the pointer is over it, focus is inside it, or the tab is hidden', () => {
    fakeClock();
    const hidden = vi.fn();
    const element = bar(hidden);
    advance(5_000);
    fireEvent.pointerEnter(element);
    advance(60_000);
    fireEvent.pointerLeave(element);
    advance(5_000);
    act(() => element.querySelector('button')?.focus());
    expect(element.contains(document.activeElement)).toBe(true);
    advance(60_000);
    act(() => (document.activeElement as HTMLElement).blur());
    advance(2_000);
    setHidden(true);
    advance(60_000);
    expect(hidden).not.toHaveBeenCalled();
    setHidden(false);
    advance(3_250);
    expect(hidden).toHaveBeenCalledTimes(1);
  });

  it('never hides without autoHideMs (sticky notices)', () => {
    fakeClock();
    render(<NoticeBar dismissLabel="Dismiss">Sticky</NoticeBar>);
    advance(120_000);
    expect(screen.getByRole('status').textContent).toContain('Sticky');
  });
});

function Harness({
  initial,
  preview,
  announce,
}: {
  initial: Banner[];
  preview?: string;
  announce: (text: string) => void;
}) {
  const [ctx, setCtx] = useState(MEMBER);
  const slot = useBannerSlot(ctx, announce);
  return (
    <>
      <button type="button" onClick={() => initial.forEach(slot.show)}>
        show
      </button>
      <button type="button" onClick={() => setCtx({ ...MEMBER, isLeader: true })}>
        lead
      </button>
      <BannerSlot
        slot={slot}
        preview={preview !== undefined ? <p>{preview}</p> : null}
        onDismissed={() => announce('dismissed')}
      />
    </>
  );
}

function renderHarness(initial: Banner[], preview?: string) {
  const announce = vi.fn();
  render(
    <I18nProvider lang="en">
      <Harness
        initial={initial}
        {...(preview !== undefined ? { preview } : {})}
        announce={announce}
      />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'show' }));
  return announce;
}

const bannerText = () => screen.queryByRole('status')?.textContent ?? null;

describe('BannerSlot (#25 architecture 6.2)', () => {
  it('shows one banner at a time and announces each once, politely', () => {
    const announce = renderHarness([
      { row: 6, kind: 'qr-pasted' },
      { row: 3, kind: 'changed', reason: 'handoff_disconnect' },
    ]);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(bannerText()).toContain('The leader lost connection, so someone else is leading now.');
    // The QR notice was replaced in the same update: never shown, never announced.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      'The leader lost connection, so someone else is leading now.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(announce).toHaveBeenLastCalledWith('dismissed');
    expect(bannerText()).toBeNull();
  });

  it('a waiting banner shows when the current one goes', () => {
    renderHarness([
      { row: 3, kind: 'lost', reason: 'superseded' },
      { row: 6, kind: 'qr-pasted' },
    ]);
    expect(bannerText()).toContain('Someone else is leading this group now.');
    expect(screen.getByRole('status').className).toContain('noticeWarning');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(bannerText()).toContain("That link wasn't used.");
  });

  it('an info notice hides by itself after 15 s; the next waiting one follows', () => {
    fakeClock();
    renderHarness([
      { row: 4, kind: 'vice', on: false },
      { row: 6, kind: 'qr-pasted' },
    ]);
    expect(bannerText()).toContain("You're no longer the vice-leader.");
    advance(15_250);
    expect(bannerText()).toContain("That link wasn't used.");
    advance(120_000);
    expect(bannerText()).toContain("That link wasn't used.");
  });

  it('the preview banner wins over queued banners, never over the ended notice', () => {
    renderHarness([{ row: 6, kind: 'qr-pasted' }], 'Preview is on.');
    expect(screen.getByText('Preview is on.')).toBeDefined();
    expect(bannerText()).toBeNull();
  });

  it('the ended notice shows over the preview and is not announced by the slot', () => {
    const announce = renderHarness(
      [{ row: 1, kind: 'ended', text: 'endedByLeader' }],
      'Preview is on.',
    );
    expect(bannerText()).toContain('The leader ended the group.');
    expect(screen.queryByText('Preview is on.')).toBeNull();
    expect(announce).not.toHaveBeenCalled();
  });

  it('drops member notices when the user leads', () => {
    renderHarness([{ row: 3, kind: 'changed', reason: 'take_back' }]);
    expect(bannerText()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'lead' }));
    expect(bannerText()).toBeNull();
  });
});

describe('ReadingScreen banner slot and assertive channel (#25 D1, D4)', () => {
  it('renders the banner first in the reading column, before the notices and the article', () => {
    render(
      <I18nProvider lang="en">
        <ReadingScreen
          content={loaded(pagedDoc(3))}
          banner={<p>banner</p>}
          notices={<p>codes notice</p>}
        />
      </I18nProvider>,
    );
    const main = screen.getByRole('main');
    const first = main.firstElementChild as HTMLElement;
    expect(first.className).toContain('banner');
    expect(first.textContent).toBe('banner');
    expect(first.nextElementSibling?.textContent).toBe('codes notice');
  });

  it('writes assertive messages into a separate aria-live="assertive" region with no alert role', () => {
    const { rerender } = render(
      <I18nProvider lang="en">
        <ReadingScreen content={loaded(pagedDoc(3))} />
      </I18nProvider>,
    );
    rerender(
      <I18nProvider lang="en">
        <ReadingScreen
          content={loaded(pagedDoc(3))}
          announceAssertive={{ text: 'The group pauses in 1 minute.', id: 1 }}
        />
      </I18nProvider>,
    );
    const region = document.querySelector('[aria-live="assertive"]')!;
    expect(region.textContent).toBe('The group pauses in 1 minute.');
    expect(region.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe('');
  });
});
