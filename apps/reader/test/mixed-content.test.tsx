import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loaded, renderReading, sampleText } from './helpers/render.js';

function blockFor(text: RegExp): HTMLElement {
  return screen.getByText(text);
}

describe('mixed-direction samples (AC14, AC20)', () => {
  it('mixed-he-en: RTL document with LTR, auto, Arabic and poem blocks', () => {
    renderReading(loaded(sampleText('mixed-he-en')));
    const article = screen.getByRole('article');
    expect(article.getAttribute('dir')).toBe('rtl');
    expect(article.getAttribute('lang')).toBe('he');

    const expectations: [RegExp, string, string | null][] = [
      [/^טקסט מעורב/, 'rtl', null],
      [/^זהו משפט בעברית/, 'rtl', null],
      [/^הספר Pride and Prejudice/, 'rtl', null],
      [/^This English paragraph/, 'ltr', 'en'],
      [/^Hello, עולם!/, 'ltr', null],
      [/^1948 - 2024\.$/, 'rtl', null],
      [/^هذه فقرة/, 'rtl', 'ar'],
      [/^שורה ראשונה/, 'rtl', null],
    ];
    for (const [text, dir, lang] of expectations) {
      const block = blockFor(text);
      expect(block.getAttribute('dir'), String(text)).toBe(dir);
      expect(block.getAttribute('lang'), String(text)).toBe(lang);
      expect(block.classList.contains('block')).toBe(true);
    }
    expect(blockFor(/^שורה ראשונה/).textContent).toContain('\n');
  });

  it('mixed-he-en page 2: page direction ltr, an rtl block inside', () => {
    renderReading(loaded(sampleText('mixed-he-en')));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(blockFor(/^This page is left to right/).getAttribute('dir')).toBe('ltr');
    expect(blockFor(/^ובלוק עברי/).getAttribute('dir')).toBe('rtl');
    expect(blockFor(/^ובלוק עברי/).getAttribute('lang')).toBe('he');
  });

  it('mixed-en-he: LTR document with rtl, auto and neutral blocks', () => {
    renderReading(loaded(sampleText('mixed-en-he')));
    expect(screen.getByRole('article').getAttribute('dir')).toBe('ltr');
    expect(blockFor(/^זוהי פסקה בעברית/).getAttribute('dir')).toBe('rtl');
    expect(blockFor(/^שלום! This automatic/).getAttribute('dir')).toBe('rtl');
    expect(blockFor(/^- 42 -$/).getAttribute('dir')).toBe('ltr');
    expect(blockFor(/^A first line/).getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('banner').querySelector('bdi')!.getAttribute('dir')).toBe('ltr');
  });

  it('psalms-he: RTL with a Hebrew title isolated in the header', () => {
    renderReading(loaded(sampleText('psalms-he')));
    const title = screen.getByRole('banner').querySelector('bdi')!;
    expect(title.getAttribute('dir')).toBe('rtl');
    expect(title.getAttribute('lang')).toBe('he');
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('dir')).toBe('rtl');
  });
});
