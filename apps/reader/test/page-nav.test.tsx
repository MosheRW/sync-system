import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loaded, pagedDoc, renderReading } from './helpers/render.js';

function navButtons() {
  const nav = screen.getByRole('navigation', { name: 'Pages' });
  return Array.from(nav.querySelectorAll('button'));
}

const counter = () => screen.getByText(/^\d+ \/ \d+$/).textContent;

describe('page navigation (AC13)', () => {
  it('LTR: Previous on the left, Next on the right, DOM order = visual order', () => {
    renderReading(loaded(pagedDoc(3, 'ltr')));
    const [left, right] = navButtons();
    expect(left!.getAttribute('aria-label')).toBe('Previous page');
    expect(right!.getAttribute('aria-label')).toBe('Next page');
    expect(left!.textContent).toBe('Previous');
    expect(left!.querySelector('path')!.getAttribute('d')).toBe('M15 5l-7 7 7 7');
  });

  it('RTL: Next on the left, chevrons still point physically', () => {
    renderReading(loaded(pagedDoc(3, 'rtl')));
    const [left, right] = navButtons();
    expect(left!.getAttribute('aria-label')).toBe('Next page');
    expect(right!.getAttribute('aria-label')).toBe('Previous page');
    expect(left!.querySelector('path')!.getAttribute('d')).toBe('M15 5l-7 7 7 7');
    expect(right!.querySelector('path')!.getAttribute('d')).toBe('M9 5l7 7-7 7');
  });

  it('buttons turn pages and are aria-disabled at the ends', () => {
    renderReading(loaded(pagedDoc(2, 'ltr')));
    const next = screen.getByRole('button', { name: 'Next page' });
    const previous = screen.getByRole('button', { name: 'Previous page' });
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(previous);
    expect(counter()).toBe('1 / 2');
    fireEvent.click(next);
    expect(counter()).toBe('2 / 2');
    expect(screen.getByText('Page 2 text')).toBeDefined();
    expect(next.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(next);
    expect(counter()).toBe('2 / 2');
  });

  it('arrow keys follow the document direction', () => {
    renderReading(loaded(pagedDoc(3, 'rtl')));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(counter()).toBe('2 / 3');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(counter()).toBe('1 / 3');
    fireEvent.keyDown(document, { key: 'End' });
    expect(counter()).toBe('3 / 3');
    fireEvent.keyDown(document, { key: 'Home' });
    expect(counter()).toBe('1 / 3');
  });

  it('a page whose direction differs from the document does not change the mapping', () => {
    const doc = pagedDoc(3, 'rtl');
    (doc['pages'] as Record<string, unknown>[])[0]!['dir'] = 'ltr';
    (doc['pages'] as Record<string, unknown>[])[1]!['dir'] = 'ltr';
    renderReading(loaded(doc));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(counter()).toBe('2 / 3');
    expect(navButtons()[0]!.getAttribute('aria-label')).toBe('Next page');
  });

  it('ignores Shift+Arrow, modified keys and keys typed in inputs', () => {
    renderReading(loaded(pagedDoc(3, 'ltr')));
    fireEvent.keyDown(document, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(document, { key: 'ArrowRight', ctrlKey: true });
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    input.remove();
    expect(counter()).toBe('1 / 3');
  });

  it('swipes with a finger follow the document direction', () => {
    renderReading(loaded(pagedDoc(3, 'rtl')));
    const article = screen.getByRole('article');
    // Finger left-to-right in an RTL document: next.
    fireEvent.pointerDown(article, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 50,
      clientY: 10,
    });
    fireEvent.pointerUp(article, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 12 });
    expect(counter()).toBe('2 / 3');
  });

  it('announces page changes politely, not on first load', () => {
    renderReading(loaded(pagedDoc(3, 'ltr')));
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(status.textContent).toBe('Page 2 of 3');
  });

  it('keeps focus on the button after a page turn', () => {
    renderReading(loaded(pagedDoc(3, 'ltr')));
    const next = screen.getByRole('button', { name: 'Next page' });
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
  });

  it('progress fills from the document start side', () => {
    const { container } = renderReading(loaded(pagedDoc(4, 'rtl')));
    const progress = container.querySelector('progress')!;
    expect(progress.getAttribute('dir')).toBe('rtl');
    expect(progress.getAttribute('max')).toBe('4');
    expect(progress.getAttribute('value')).toBe('1');
  });
});
