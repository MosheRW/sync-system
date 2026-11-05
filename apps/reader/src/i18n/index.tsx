import { type ReactNode, createContext, useContext, useMemo } from 'react';
import type { UiLangSetting } from '../config/schema.js';
import { en, type Messages } from './en.js';
import { he } from './he.js';

export type UiLanguage = 'en' | 'he';
export const UI_LANGUAGES: readonly UiLanguage[] = ['en', 'he'];
const CATALOGS: Record<UiLanguage, Messages> = { en, he };
/** `iw` is the legacy code for Hebrew, still sent by some browsers. */
const ALIASES: Record<string, UiLanguage> = { en: 'en', he: 'he', iw: 'he' };

export function uiDirection(lang: UiLanguage): 'ltr' | 'rtl' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

/**
 * The interface language (ADR 0003): a pinned setting wins; with `auto`, the
 * first browser language whose primary subtag is supported; else `en`.
 */
export function pickUiLanguage(
  navigatorLanguages: readonly string[],
  setting: UiLangSetting = 'auto',
): UiLanguage {
  if (setting !== 'auto') return setting;
  for (const tag of navigatorLanguages) {
    const primary = tag.split('-')[0]?.toLowerCase() ?? '';
    const lang = ALIASES[primary];
    if (lang) return lang;
  }
  return 'en';
}

export type FormatValues = Readonly<Record<string, string | number>>;

/** Fills `{name}` placeholders; numbers use the interface locale. */
export function format(lang: UiLanguage, template: string, values: FormatValues = {}): string {
  const numbers = new Intl.NumberFormat(lang, { useGrouping: false });
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(values, name)) return match;
    const value = values[name];
    return typeof value === 'number' ? numbers.format(value) : String(value);
  });
}

/** A language tag's name in the interface language, falling back to the tag. */
export function languageName(uiLang: UiLanguage, tag: string): string {
  try {
    return new Intl.DisplayNames([uiLang], { type: 'language', fallback: 'code' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export interface I18n {
  lang: UiLanguage;
  dir: 'ltr' | 'rtl';
  t: Messages;
  format: (template: string, values?: FormatValues) => string;
}

export function createI18n(lang: UiLanguage): I18n {
  return {
    lang,
    dir: uiDirection(lang),
    t: CATALOGS[lang],
    format: (template, values) => format(lang, template, values),
  };
}

const I18nContext = createContext<I18n>(createI18n('en'));

export function I18nProvider({ lang, children }: { lang: UiLanguage; children: ReactNode }) {
  const value = useMemo(() => createI18n(lang), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
