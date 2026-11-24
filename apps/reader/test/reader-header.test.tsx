import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyInterfaceLanguage } from '../src/app/boot.js';
import type { UiLanguage } from '../src/i18n/index.js';
import { loaded, pagedDoc, renderReading, sampleText } from './helpers/render.js';

afterEach(() => {
  applyInterfaceLanguage(document, 'en');
});

describe('page counter is an LTR isolate (#27 AC1)', () => {
  it.each<[UiLanguage]>([['en'], ['he']])(
    'UI %s: one bdi[dir=ltr] reading "1 / 3", then "2 / 3"',
    (ui) => {
      applyInterfaceLanguage(document, ui);
      renderReading(loaded(pagedDoc(3)), ui);

      const counter = screen.getByRole('banner').querySelector('[class*="counter"]')!;
      const isolates = counter.querySelectorAll('bdi[dir="ltr"]');
      expect(isolates).toHaveLength(1);
      expect(isolates[0]!.textContent).toBe('1 / 3');

      fireEvent.click(document.querySelector('[data-action="next"]')!);
      expect(counter.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2 / 3');
    },
  );
});

describe('title is isolated in its own direction (#27 AC2)', () => {
  it.each<[UiLanguage, string, 'ltr' | 'rtl']>([
    ['en', 'pride-and-prejudice-en', 'ltr'],
    ['en', 'psalms-he', 'rtl'],
    ['he', 'pride-and-prejudice-en', 'ltr'],
    ['he', 'psalms-he', 'rtl'],
  ])('UI %s, content %s: title bdi is a direct child with dir %s', (ui, sample, docDir) => {
    applyInterfaceLanguage(document, ui);
    renderReading(loaded(sampleText(sample)), ui);

    const title = screen.getByRole('banner').querySelector('[class*="title"]')!;
    const bdi = title.querySelector(':scope > bdi')!;
    expect(bdi.getAttribute('dir')).toBe(docDir);
    expect(bdi.getAttribute('lang')).toBe(docDir === 'rtl' ? 'he' : 'en');
    expect(title.hasAttribute('dir')).toBe(false);
  });
});
