import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.js';
import { he } from '../src/i18n/he.js';
import { format, languageName, pickUiLanguage, uiDirection } from '../src/i18n/index.js';

describe('interface language (ADR 0003)', () => {
  it.each<[readonly string[], 'auto' | 'en' | 'he', 'en' | 'he']>([
    [['he-IL', 'en-US'], 'auto', 'he'],
    [['iw'], 'auto', 'he'],
    [['fr-FR', 'he'], 'auto', 'he'],
    [['en-GB'], 'auto', 'en'],
    [['fr', 'de'], 'auto', 'en'],
    [[], 'auto', 'en'],
    [['he'], 'en', 'en'],
    [['en'], 'he', 'he'],
  ])('%j with %s -> %s', (languages, setting, expected) => {
    expect(pickUiLanguage(languages, setting)).toBe(expected);
  });

  it('maps Hebrew to rtl', () => {
    expect(uiDirection('he')).toBe('rtl');
    expect(uiDirection('en')).toBe('ltr');
  });

  it('has every message in both languages, none empty', () => {
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(he)) expect(value, key).not.toBe('');
  });

  it('keeps placeholders the same in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(he[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('formats placeholders and numbers', () => {
    expect(format('en', en.pageCounter, { n: 3, total: 12 })).toBe('3 / 12');
    expect(format('he', he.pageAnnouncement, { n: 4, total: 12 })).toBe('עמוד 4 מתוך 12');
    expect(format('en', 'x {missing}')).toBe('x {missing}');
    expect(format('en', '{n}', { n: 12345 })).toBe('12345');
  });

  it('names languages in the interface language, falling back to the tag', () => {
    expect(languageName('en', 'he')).toBe('Hebrew');
    expect(languageName('he', 'en')).toBe('אנגלית');
    expect(languageName('en', 'not a tag!')).toBe('not a tag!');
  });
});
