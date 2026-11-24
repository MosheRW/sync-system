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
