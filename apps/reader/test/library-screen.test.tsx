import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LibraryScreen, bookHref } from '../src/components/LibraryScreen.js';
import { I18nProvider, type UiLanguage } from '../src/i18n/index.js';
import type { LibraryEntry } from '../src/library/types.js';
import { ENTRIES } from './helpers/app.js';

const WITH_ARABIC: LibraryEntry[] = [
  ...ENTRIES,
  { contentId: 'acme/arabic', title: 'كتاب عربي', lang: 'ar', dir: 'rtl' },
  {
    contentId: 'samples/mixed-en-he',
    title: 'מדריך קצר: English with Hebrew',
    lang: 'en',
    dir: 'ltr',
  },
];

function show(entries: readonly LibraryEntry[] = WITH_ARABIC, lang: UiLanguage = 'en') {
  return render(
    <I18nProvider lang={lang}>
      <LibraryScreen entries={entries} />
    </I18nProvider>,
  );
}

describe('library screen (AC26, AC39)', () => {
  it('has a Library heading and a real list', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Library');
    expect(screen.getByRole('list')).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(WITH_ARABIC.length);
    expect(document.title).toBe('Library');
  });

  it('links each row to its own reading page', () => {
    show();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/?book=samples%2Fpsalms-he');
    expect(hrefs).toContain('/?book=acme%2Farabic');
    expect(bookHref('a/b.c-d')).toBe('/?book=a%2Fb.c-d');
  });

  it('isolates each title with the book direction and language', () => {
    show();
    const psalms = screen.getByText('תהילים: מזמורים נבחרים');
    expect(psalms.tagName).toBe('BDI');
    expect(psalms.getAttribute('dir')).toBe('rtl');
    expect(psalms.getAttribute('lang')).toBe('he');
    const mixed = screen.getByText('מדריך קצר: English with Hebrew');
    expect(mixed.getAttribute('dir')).toBe('ltr');
    expect(mixed.getAttribute('lang')).toBe('en');
  });

  it('falls back to the content ID, LTR, with no language line', () => {
    show();
    const id = screen.getByText('samples/untitled');
    expect(id.getAttribute('dir')).toBe('ltr');
    expect(id.getAttribute('lang')).toBeNull();
    const row = id.closest('a')!;
    expect(row.textContent).toBe('samples/untitled');
  });

  it('shows the language name in the interface language', () => {
    show();
    const row = screen.getByText('كتاب عربي').closest('a')!;
    expect(within(row).getByText('Arabic')).toBeDefined();
    show(WITH_ARABIC, 'he');
    expect(screen.getAllByText('ערבית').length).toBeGreaterThan(0);
  });

  it('sorts by title (content ID when untitled) with the interface collator', () => {
    show();
    const titles = screen.getAllByRole('link').map((a) => a.querySelector('bdi')!.textContent);
    const expected = WITH_ARABIC.map((e) => e.title ?? e.contentId).sort(
      new Intl.Collator('en').compare,
    );
    expect(titles).toEqual(expected);
  });

  it('renders markup in titles as text', () => {
    const { container } = show([
      { contentId: 'a/b', title: '<img src=x onerror=alert(1)>', dir: 'ltr' },
    ]);
    expect(container.querySelector('img')).toBeNull();
  });
});
