import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { normaliseLineBreaks } from '../src/components/ContentBlock.js';
import { loaded, pagedDoc, renderReading } from './helpers/render.js';

function docWith(text: string, title = 'Title') {
  const doc = pagedDoc(1);
  doc['title'] = title;
  (doc['pages'] as { blocks: { text: string }[] }[])[0]!.blocks[0]!.text = text;
  return loaded(doc);
}

describe('line breaks (AC33)', () => {
  it('keeps \\n in the text node and renders with the pre-line block class', () => {
    renderReading(docWith('line one\nline two\n\nline four'));
    const block = screen.getByText(/line one/);
    expect(block.textContent).toBe('line one\nline two\n\nline four');
    expect(block.classList.contains('block')).toBe(true);
    expect(block.tagName).toBe('P');
  });

  it('normalises \\r\\n and lone \\r to \\n', () => {
    expect(normaliseLineBreaks('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    renderReading(docWith('first\r\nsecond'));
    expect(screen.getByText(/first/).textContent).toBe('first\nsecond');
  });

  it('collapses line breaks in the header title', () => {
    renderReading(docWith('x', 'Two\nlines'));
    const banner = screen.getByRole('banner');
    expect(banner.querySelector('bdi')!.textContent).toBe('Two lines');
  });

  it('renders heading blocks as h2', () => {
    const doc = pagedDoc(1);
    (doc['pages'] as { blocks: Record<string, string>[] }[])[0]!.blocks[0]!['type'] = 'heading';
    renderReading(loaded(doc));
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.classList.contains('heading')).toBe(true);
  });
});
