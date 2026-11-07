import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupButton, indicatorText } from '../src/components/group/GroupButton.js';
import { indicatorAnnouncement } from '../src/group/announce.js';
import { formatClock, formatLong, formatShort } from '../src/group/countdown.js';
import { type IndicatorKind, derivePhase, indicatorFor } from '../src/group/phase.js';
import { I18nProvider, createI18n } from '../src/i18n/index.js';
import { SYNC, renderApp, testConfig } from './helpers/app.js';
import { FakeSyncClient, activeGroup, connected } from './helpers/fake-sync-client.js';
import { MemoryStorage } from './helpers/storage.js';

const en = createI18n('en');
const he = createI18n('he');

afterEach(() => {
  vi.useRealTimers();
});

const KINDS: [IndicatorKind, string, string][] = [
  ['group', 'Group', 'קבוצה'],
  ['following', 'Following', 'עם הקבוצה'],
  ['not-following', 'Not following', 'לא בעמוד הקבוצה'],
  ['leading', 'Leading', 'בהובלתך'],
  ['reconnecting', 'Reconnecting…', 'מתחברים מחדש…'],
  ['leader-offline', 'Leader offline', 'המוביל לא מחובר'],
  ['leader-grace', 'Waiting for leader · 0:24', 'ממתינים למוביל · 0:24'],
  ['awaiting', 'Waiting for approval', 'ממתינים לאישור'],
  ['joining', 'Joining…', 'מצטרפים…'],
  ['disconnected', 'Not connected', 'אין חיבור'],
];

describe('indicator states (#24 AC30, design 5.2)', () => {
  it.each(KINDS)('%s has distinct text in en and he', (kind, textEn, textHe) => {
    expect(indicatorText(kind, en, 24_000)).toBe(textEn);
    expect(indicatorText(kind, he, 24_000)).toBe(textHe);
  });

  it('every state has its own text', () => {
    const texts = KINDS.map(([kind]) => indicatorText(kind, en, 1000));
    expect(new Set(texts).size).toBe(KINDS.length);
  });

  it.each(KINDS)('renders %s with an accessible name and a dot', (kind, textEn) => {
    render(
      <I18nProvider lang="en">
        <GroupButton kind={kind} graceEndsAt={Date.now() + 24_000} onOpen={() => undefined} />
      </I18nProvider>,
    );
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toMatch(new RegExp(`, group options$`));
    expect(button.textContent).toBe(kind === 'leader-grace' ? textEn : textEn);
    expect(button.getAttribute('aria-live')).toBeNull();
  });

  it('counts the grace down from graceEndsAt and recomputes on visibility change (AC53)', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(1_000_000);
    render(
      <I18nProvider lang="he">
        <GroupButton
          kind="leader-grace"
          graceEndsAt={1_000_000 + 30_000}
          onOpen={() => undefined}
        />
      </I18nProvider>,
    );
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('ממתינים למוביל · 0:30');
    expect(button.querySelector('bdi')!.getAttribute('dir')).toBe('ltr');
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(button.textContent).toBe('ממתינים למוביל · 0:24');
    // A background tab whose timers were throttled: the clock jumped.
    act(() => {
      vi.setSystemTime(1_000_000 + 40_000);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(button.textContent).toBe('ממתינים למוביל · 0:00');
  });
});

describe('time formats (design 7.1)', () => {
  it('formats clocks, short and long durations', () => {
    expect(formatClock(24_000, en)).toBe('0:24');
    expect(formatClock(299_100, en)).toBe('5:00');
    expect(formatShort(8_000, en)).toBe('8 s');
    expect(formatShort(8_000, he)).toBe('8 שנ׳');
    expect(formatShort(65_000, en)).toBe('1:05');
    expect(formatLong(1_000, en)).toBe('1 second');
    expect(formatLong(24_000, en)).toBe('24 seconds');
    expect(formatLong(61_000, en)).toBe('2 minutes');
    expect(formatLong(60_000, he)).toBe('דקה אחת');
  });
});

describe('phase and indicator (#24 architecture 7.1)', () => {
  const base = {
    enabled: true,
    connection: connected(),
    group: null,
    joining: false,
    resuming: false,
    hasPointer: false,
    compare: null,
    acknowledged: false,
  } as const;

  it('derives each phase', () => {
    expect(derivePhase({ ...base, enabled: false })).toBe('off');
    expect(derivePhase(base)).toBe('solo');
    expect(derivePhase({ ...base, joining: true })).toBe('joining');
    expect(derivePhase({ ...base, resuming: true })).toBe('resuming');
    expect(
      derivePhase({
        ...base,
        group: { status: 'awaiting_approval', requestId: 'r', expiresAt: 1 },
      }),
    ).toBe('awaiting');
    expect(derivePhase({ ...base, group: activeGroup('leader') })).toBe('leader');
    expect(derivePhase({ ...base, group: activeGroup('member') })).toBe('checking');
    expect(derivePhase({ ...base, group: activeGroup('member'), compare: 'match' })).toBe('member');
    expect(
      derivePhase({ ...base, group: activeGroup('member'), compare: 'different-content' }),
    ).toBe('mismatch-block');
    expect(
      derivePhase({ ...base, group: activeGroup('member'), compare: 'unsupported-schema' }),
    ).toBe('mismatch-block');
    expect(
      derivePhase({ ...base, group: activeGroup('member'), compare: 'different-version' }),
    ).toBe('mismatch-warn');
    expect(
      derivePhase({
        ...base,
        group: activeGroup('member'),
        compare: 'different-version',
        acknowledged: true,
      }),
    ).toBe('member');
    expect(
      derivePhase({
        ...base,
        hasPointer: true,
        connection: { status: 'closed', reason: 'gave_up' },
      }),
    ).toBe('disconnected');
  });

  it('maps a browsing member who is following to Not following (AC31)', () => {
    expect(indicatorFor('member', 'following', 'browsing')).toBe('not-following');
    expect(indicatorFor('member', 'following', 'following')).toBe('following');
    expect(indicatorFor('member', 'leader_grace', 'following')).toBe('leader-grace');
    expect(indicatorFor('member', 'leader_offline', 'browsing')).toBe('leader-offline');
    expect(indicatorFor('leader', 'reconnecting', 'following')).toBe('reconnecting');
    expect(indicatorFor('mismatch-block', 'following', 'following')).toBe('not-following');
    expect(indicatorFor('off', 'none', 'following')).toBeNull();
  });

  it('announces state changes once, with the design wording', () => {
    const say = (prev: IndicatorKind | null, next: IndicatorKind, leadingAnnounced = false) =>
      indicatorAnnouncement(prev, next, en, { graceMs: 24_000, leadingAnnounced });
    expect(say('joining', 'following')).toBe('Following the group.');
    expect(say('reconnecting', 'following')).toBe('Back with the group.');
    expect(say('leader-grace', 'following')).toBe('The leader is back.');
    expect(say('following', 'not-following')).toBe('Not following the group.');
    expect(say('following', 'reconnecting')).toBe('Connection lost. Reconnecting…');
    expect(say(null, 'reconnecting')).toBeNull();
    expect(say('following', 'leader-grace')).toBe('The leader is away. Waiting up to 24 seconds.');
    expect(say('group', 'leading')).toBe("You're leading the group.");
    expect(say('group', 'leading', true)).toBeNull();
    expect(say('following', 'following')).toBeNull();
  });
});

describe('the Group button in the reading page (#24 design F0, AC2)', () => {
  const BOOK = { search: '?book=samples%2Fpride-and-prejudice-en' };

  it('is absent with sync off', async () => {
    renderApp({ config: testConfig(), location: BOOK });
    await screen.findByText(/^1 \/ \d+$/);
    expect(screen.queryByRole('button', { name: /group options/ })).toBeNull();
  });

  it('opens the Read together sheet, Esc closes it and focus returns to the button', async () => {
    const client = new FakeSyncClient();
    renderApp({
      config: testConfig('library', 'on', { sync: SYNC }),
      location: BOOK,
      storage: new MemoryStorage(),
      syncClient: client,
    });
    const button = await screen.findByRole('button', { name: 'Group, group options' });
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Read together' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Read together' }));
    expect(screen.getByRole('button', { name: 'Start a group' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Join a group' })).toBeDefined();
    // Page keys do nothing behind the open sheet.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByText(/^1 \/ \d+$/)).toBeDefined();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(client.count('connect')).toBe(0);
  });
});
