import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyInterfaceLanguage } from '../src/app/boot.js';
import type { UiLanguage } from '../src/i18n/index.js';
import { loaded, renderReading, sampleText } from './helpers/render.js';

afterEach(() => {
  applyInterfaceLanguage(document, 'en');
});

describe('interface and content direction are independent (AC12)', () => {
  it.each<[UiLanguage, string, 'ltr' | 'rtl', 'ltr' | 'rtl', 'left' | 'right', string]>([
    ['en', 'pride-and-prejudice-en', 'ltr', 'ltr', 'right', 'Next'],
    ['en', 'psalms-he', 'ltr', 'rtl', 'left', 'Next'],
    ['he', 'pride-and-prejudice-en', 'rtl', 'ltr', 'right', 'הבא'],
    ['he', 'psalms-he', 'rtl', 'rtl', 'left', 'הבא'],
  ])(
    'UI %s, content %s: html %s, article %s, Next on the %s',
    (ui, sample, htmlDir, docDir, nextSide, nextLabel) => {
      applyInterfaceLanguage(document, ui);
      renderReading(loaded(sampleText(sample)), ui);

      expect(document.documentElement.getAttribute('dir')).toBe(htmlDir);
      expect(document.documentElement.getAttribute('lang')).toBe(ui);

      const article = screen.getByRole('article');
      expect(article.getAttribute('dir')).toBe(docDir);
      expect(screen.getByRole('banner').querySelector('bdi')!.getAttribute('dir')).toBe(docDir);
      for (const block of article.querySelectorAll('p, h2')) {
        expect(block.getAttribute('dir')).toBe(docDir);
      }

      const buttons = screen.getByRole('navigation').querySelectorAll('button');
      const next = nextSide === 'left' ? buttons[0]! : buttons[1]!;
      expect(next.getAttribute('data-action')).toBe('next');
      expect(next.textContent).toBe(nextLabel);
      expect(next.querySelector('span')!.getAttribute('dir')).toBe(htmlDir);
    },
  );
});
