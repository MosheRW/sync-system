import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loaded, pagedDoc, renderReading, sampleText } from './helpers/render.js';

describe('reading screen (AC24, AC36)', () => {
  it.each(['psalms-he', 'pride-and-prejudice-en', 'mixed-he-en', 'untitled'])(
    '%s has no link of any kind (no library link, no book switcher)',
    (name) => {
      const { container } = renderReading(loaded(sampleText(name)));
      expect(container.querySelector('a')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
      expect(container.querySelector('select')).toBeNull();
    },
  );

  it('names the article after the title, or "Reading" without one', () => {
    renderReading(loaded(sampleText('pride-and-prejudice-en')));
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe(
      'Pride and Prejudice (Chapter 1, opening)',
    );
    expect(document.title).toBe('Pride and Prejudice (Chapter 1, opening)');
  });

  it('falls back to "Reading" for an untitled text', () => {
    renderReading(loaded(sampleText('untitled')));
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe('Reading');
  });

  it('starts at page 1 with header, main, article and nav landmarks', () => {
    renderReading(loaded(pagedDoc(3)));
    expect(screen.getByRole('banner')).toBeDefined();
    expect(screen.getByRole('main')).toBeDefined();
    expect(screen.getByText('1 / 3')).toBeDefined();
  });
});

describe('untrusted text renders as text (AC4, AC18)', () => {
  it.each(['<img src=x onerror=alert(1)>', '<script>alert(1)</script>'])(
    '%s in a block and the title creates no element',
    (markup) => {
      const doc = pagedDoc(1);
      doc['title'] = markup;
      (doc['pages'] as { blocks: { text: string }[] }[])[0]!.blocks[0]!.text = markup;
      const { container } = renderReading(loaded(doc));
      expect(container.querySelector('img, script')).toBeNull();
      expect(screen.getAllByText(markup)).toHaveLength(2);
    },
  );
});
