import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReadingScreen } from '../src/components/ReadingScreen.js';
import { I18nProvider } from '../src/i18n/index.js';
import { renderApp } from './helpers/app.js';
import { loaded, pagedDoc, renderReading } from './helpers/render.js';
import { MemoryStorage } from './helpers/storage.js';

describe('ReadingScreen keeps no position itself (the app restores it, #24 AC36)', () => {
  it('a remount starts at page 1 again', () => {
    const content = loaded(pagedDoc(3));
    const first = renderReading(content);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByText('3 / 3')).toBeDefined();
    first.unmount();
    renderReading(content);
    expect(screen.getByText('1 / 3')).toBeDefined();
  });

  it('writes nothing to storage or the URL', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const pushState = vi.spyOn(history, 'pushState');
    const replaceState = vi.spyOn(history, 'replaceState');
    renderReading(loaded(pagedDoc(3)));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(setItem).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('initial page, move source and modal dialogs (#24 7.2, 7.7)', () => {
  function renderWith(props: Partial<Parameters<typeof ReadingScreen>[0]>) {
    return render(
      <I18nProvider lang="en">
        <ReadingScreen content={loaded(pagedDoc(5))} {...props} />
      </I18nProvider>,
    );
  }

  it('starts at the initial page, clamped, without announcing it', () => {
    renderWith({ initialIndex: 3 });
    expect(screen.getByText('4 / 5')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('clamps an initial page past the end', () => {
    renderWith({ initialIndex: 99 });
    expect(screen.getByText('5 / 5')).toBeDefined();
  });

  it('reports user turns as user moves', () => {
    const onPageChange = vi.fn();
    renderWith({ onPageChange });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange.mock.calls).toEqual([
      [1, 'user'],
      [2, 'user'],
    ]);
  });

  it('ignores page-turn keys while a modal dialog is open', () => {
    const onPageChange = vi.fn();
    renderWith({ onPageChange });
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const input = document.createElement('button');
    dialog.append(input);
    document.body.append(dialog);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(onPageChange).not.toHaveBeenCalled();
    dialog.remove();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onPageChange).toHaveBeenCalledTimes(1);
  });
});

describe('solo reading position across a reload (#24 AC36)', () => {
  it('returns to the page of this book in this tab', async () => {
    const storage = new MemoryStorage();
    const location = { search: '?book=samples%2Fpride-and-prejudice-en' };
    const first = renderApp({ location, storage });
    await screen.findByText(/^1 \/ \d+$/);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByText(/^3 \/ \d+$/)).toBeDefined();
    first.unmount();
    renderApp({ location, storage });
    expect(await screen.findByText(/^3 \/ \d+$/)).toBeDefined();
    expect(storage.keys()).toEqual([
      expect.stringMatching(/^reader:v1:page:samples\/pride-and-prejudice-en:[0-9a-f]{64}$/),
    ]);
  });

  it('starts at page 1 for another book', async () => {
    const storage = new MemoryStorage();
    renderApp({
      location: { search: '?book=samples%2Fpride-and-prejudice-en' },
      storage,
    }).unmount();
    storage.setItem('reader:v1:page:samples/psalms-he:' + '0'.repeat(64), '{"v":1,"pageIndex":2}');
    renderApp({ location: { search: '?book=samples%2Fpsalms-he' }, storage });
    expect(await screen.findByText(/^1 \/ \d+$/)).toBeDefined();
  });
});
