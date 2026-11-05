import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoadingScreen, StatusScreen } from '../src/components/StatusScreen.js';
import { type StatusInput, statusView } from '../src/components/status-screens.js';
import type { ContentError } from '../src/content/errors.js';
import { I18nProvider, createI18n } from '../src/i18n/index.js';

const en = createI18n('en');

function show(input: StatusInput, libraryOn: boolean, onRetry?: () => void) {
  const view = statusView(input, en, libraryOn);
  return render(
    <I18nProvider lang="en">
      <StatusScreen view={view} {...(onRetry ? { onRetry } : {})} />
    </I18nProvider>,
  );
}

const error = (e: ContentError): StatusInput => ({ kind: 'content-error', error: e });

const FETCH_FAILURES: [string, ContentError, string][] = [
  ['network', { kind: 'network' }, "Can't load this text"],
  ['http', { kind: 'http', status: 404 }, "Can't load this text"],
  ['timeout', { kind: 'timeout', seconds: 15 }, 'Loading took too long'],
];

const REFUSALS: [string, ContentError, string, string][] = [
  ['invalid json', { kind: 'invalid-json' }, "This file can't be opened", 'Not valid JSON'],
  [
    'invalid content',
    { kind: 'invalid-content', path: 'Page 3', code: 'empty', detail: 'has no blocks' },
    "This file can't be opened",
    'Page 3: has no blocks',
  ],
  [
    'missing version',
    { kind: 'schema-version-missing' },
    "This file can't be opened",
    'Missing schema version',
  ],
  [
    'invalid version',
    { kind: 'schema-version-invalid' },
    "This file can't be opened",
    'Schema version is not valid',
  ],
  [
    'too new',
    { kind: 'schema-version-unsupported', version: 2, min: 1, max: 1 },
    'This text needs a newer app',
    'Schema version 2. This app reads version 1.',
  ],
  [
    'too old',
    { kind: 'schema-version-unsupported', version: 1, min: 2, max: 3 },
    'This text uses an old format',
    'Schema version 1. This app reads version 2-3.',
  ],
  [
    'too large',
    { kind: 'too-large', maxBytes: 5_242_880 },
    "This file can't be opened",
    'Larger than 5 MB.',
  ],
  ['src invalid', { kind: 'src-invalid' }, "This link isn't valid", 'Reason: invalid address'],
  [
    'src not allowed',
    { kind: 'src-not-allowed', origin: 'https://evil.example' },
    "This text can't be opened here",
    'Source: https://evil.example',
  ],
];

describe('fetch-failure screens (AC5, AC31)', () => {
  it.each(FETCH_FAILURES)('%s: Try again re-runs, Back to library when on', (_name, e, heading) => {
    const onRetry = vi.fn();
    show(error(e), true, onRetry);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Back to library' }).getAttribute('href')).toBe(
      '/library',
    );
  });

  it.each(FETCH_FAILURES)('%s: only Try again when the library is off', (_name, e) => {
    show(error(e), false, vi.fn());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows HTTP status and the configured timeout in details (AC34)', () => {
    expect(statusView(error({ kind: 'http', status: 503 }), en, true).details).toBe(
      'Reason: HTTP 503',
    );
    expect(statusView(error({ kind: 'timeout', seconds: 3 }), en, true).details).toBe(
      'Reason: timed out after 3 s',
    );
  });

  it('uses the singular for a 1-second timeout in Hebrew', () => {
    const he = createI18n('he');
    expect(statusView(error({ kind: 'timeout', seconds: 1 }), he, true).details).toBe(
      'סיבה: תם הזמן אחרי שנייה אחת',
    );
    expect(statusView(error({ kind: 'timeout', seconds: 2 }), he, true).details).toBe(
      'סיבה: תם הזמן אחרי 2 שניות',
    );
    expect(statusView(error({ kind: 'timeout', seconds: 1 }), en, true).details).toBe(
      'Reason: timed out after 1 s',
    );
  });
});

describe('refused-file screens (AC3, AC4, AC31)', () => {
  it.each(REFUSALS)('%s: no retry, Back to library when on', (_name, e, heading, details) => {
    const { container } = show(error(e), true, vi.fn());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(heading);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to library' })).toBeDefined();
    expect(container.querySelector('details')!.textContent).toContain(details);
  });

  it.each(REFUSALS)('%s: no action when the library is off', (_name, e) => {
    show(error(e), false, vi.fn());
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('crypto-unavailable: needs HTTPS, no action', () => {
    show(error({ kind: 'crypto-unavailable' }), true);
    expect(screen.getByRole('heading').textContent).toBe("This text can't be opened here");
    expect(screen.getByText('This app needs a secure (HTTPS) connection.')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders markup in error details as text', () => {
    const { container } = show(
      error({ kind: 'src-not-allowed', origin: 'https://<img src=x onerror=alert(1)>' }),
      true,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('details')!.textContent).toContain('<img src=x');
  });
});

describe('book-not-found, no-book, invalid-link, not-configured (AC27, AC28, AC37)', () => {
  it.each([true, false])('book not found shows the ID; Go to library only when on (%s)', (on) => {
    const { container } = show({ kind: 'book-not-found', contentId: 'acme/psalms-hh' }, on);
    expect(screen.getByRole('heading').textContent).toBe('Book not found');
    expect(container.querySelector('details bdi')!.textContent).toBe('acme/psalms-hh');
    expect(container.querySelector('details bdi')!.getAttribute('dir')).toBe('ltr');
    expect(screen.queryByRole('link', { name: 'Go to library' }) !== null).toBe(on);
  });

  it('book not found with a malformed ID does not echo it (C6)', () => {
    const { container } = show({ kind: 'book-not-found', contentId: null }, true);
    expect(container.querySelector('details')!.textContent).toContain(
      'The book ID in the link is not valid.',
    );
  });

  it.each([true, false])('no book selected (library %s)', (on) => {
    show({ kind: 'no-book' }, on);
    expect(screen.getByRole('heading').textContent).toBe('No book selected');
    expect(screen.queryByRole('link', { name: 'Go to library' }) !== null).toBe(on);
  });

  it('invalid link', () => {
    show({ kind: 'invalid-link' }, true);
    expect(screen.getByRole('heading').textContent).toBe("This link isn't valid");
    expect(screen.getByText('It names more than one text to open.')).toBeDefined();
  });

  it('not configured has no action', () => {
    show({ kind: 'not-configured' }, true);
    expect(screen.getByRole('heading').textContent).toBe("This app isn't set up");
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('StatusScreen behaviour', () => {
  it('focuses the heading and sets the page title', () => {
    show({ kind: 'no-book' }, false);
    expect(document.activeElement).toBe(screen.getByRole('heading'));
    expect(document.title).toBe('No book selected');
  });

  it('shows a disabled-looking retry while retrying', () => {
    const onRetry = vi.fn();
    render(
      <StatusScreen
        view={statusView(error({ kind: 'network' }), en, false)}
        onRetry={onRetry}
        retrying
      />,
    );
    const button = screen.getByRole('button', { name: 'Trying again…' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('uses the Hebrew copy with a Hebrew interface', () => {
    render(
      <I18nProvider lang="he">
        <StatusScreen view={statusView({ kind: 'no-book' }, createI18n('he'), true)} />
      </I18nProvider>,
    );
    expect(screen.getByRole('heading').textContent).toBe('לא נבחר ספר');
    expect(screen.getByRole('link').textContent).toBe('לספרייה');
  });

  it('shows the loading state and the still-loading text', () => {
    const { rerender } = render(<LoadingScreen stillLoading={false} />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    rerender(<LoadingScreen stillLoading />);
    expect(screen.getByRole('status').textContent).toContain('Still loading.');
  });
});
