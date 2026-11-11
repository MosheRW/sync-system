import { type PublicConfig, type PublicConfigResult, parsePublicConfig } from '../config/schema.js';
import { type UiLanguage, pickUiLanguage, uiDirection } from '../i18n/index.js';
import { type LocationLike, type Route, resolveEntry } from './resolve-entry.js';

export const CONFIG_ELEMENT_ID = 'reader-config';

export interface BootResult {
  /** `null`: the injected config is missing or invalid ("app isn't set up"). */
  config: PublicConfig | null;
  /** Why `config` is `null`: `sync` when only the sync settings were refused (#24 AC1). */
  configIssue: 'sync' | 'config' | null;
  uiLang: UiLanguage;
  route: Route | null;
}

/**
 * Reads the config the server injected into the page as
 * `<script type="application/json" id="reader-config">` and re-validates it
 * (security C5). Never throws.
 */
export function readInjectedConfig(doc: Document): PublicConfigResult {
  const element = doc.getElementById(CONFIG_ELEMENT_ID);
  if (!element || element.getAttribute('type') !== 'application/json') {
    return { ok: false, reason: 'config' };
  }
  try {
    return parsePublicConfig(JSON.parse(element.textContent ?? ''));
  } catch {
    return { ok: false, reason: 'config' };
  }
}

/** The interface scope: `<html lang dir>` (AC12, design.md section 6). */
export function applyInterfaceLanguage(doc: Document, lang: UiLanguage): void {
  doc.documentElement.lang = lang;
  doc.documentElement.dir = uiDirection(lang);
}

/** Config, interface language and route for this page load. */
export function boot(
  doc: Document,
  navigatorLanguages: readonly string[],
  location: LocationLike,
  libraryIds: readonly string[],
): BootResult {
  const result = readInjectedConfig(doc);
  const config = result.ok ? result.config : null;
  const uiLang = pickUiLanguage(navigatorLanguages, config?.uiLang ?? 'auto');
  applyInterfaceLanguage(doc, uiLang);
  const route = config ? resolveEntry(config, location, libraryIds) : null;
  return { config, configIssue: result.ok ? null : result.reason, uiLang, route };
}
