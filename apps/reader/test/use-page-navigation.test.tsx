import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { loaded, pagedDoc, renderReading } from './helpers/render.js';

describe('reading position is not kept (AC35)', () => {
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
