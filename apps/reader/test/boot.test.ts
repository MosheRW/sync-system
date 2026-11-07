import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_ELEMENT_ID, boot, readInjectedConfig } from '../src/app/boot.js';
import { testConfig } from './helpers/app.js';

function inject(text: string, type = 'application/json') {
  const script = document.createElement('script');
  script.id = CONFIG_ELEMENT_ID;
  script.type = type;
  script.textContent = text;
  document.head.append(script);
}

afterEach(() => {
  document.getElementById(CONFIG_ELEMENT_ID)?.remove();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});

describe('boot (ADR 0005 E1, security C5)', () => {
  it('reads and re-validates the injected config', () => {
    const config = testConfig('error', 'on', { uiLang: 'he' });
    inject(JSON.stringify(config));
    expect(readInjectedConfig(document)).toEqual({ ok: true, config });
  });

  it('reports a config whose only problem is the sync block as a sync issue (#24 AC1)', () => {
    const config = testConfig('error', 'on', {
      sync: {
        url: 'https://x.example/',
        apiKey: 'k'.repeat(32),
        appVersion: '1.0.0',
        lateJoinSeconds: 10,
      },
    });
    inject(JSON.stringify(config));
    expect(readInjectedConfig(document)).toEqual({ ok: false, reason: 'sync' });
    const result = boot(document, ['en'], { pathname: '/', search: '' }, []);
    expect(result).toMatchObject({ config: null, configIssue: 'sync', route: null });
  });

  it.each([
    ['missing', null],
    ['not JSON', '{'],
    ['invalid', JSON.stringify({ entry: 'nope' })],
  ])('refuses a %s config', (_name, text) => {
    if (text !== null) inject(text);
    expect(readInjectedConfig(document)).toEqual({ ok: false, reason: 'config' });
  });

  it('ignores a config block that is not JSON-typed', () => {
    inject(JSON.stringify(testConfig()), 'module');
    expect(readInjectedConfig(document)).toEqual({ ok: false, reason: 'config' });
  });

  it('sets <html lang dir> from the pinned language and resolves the route', () => {
    inject(JSON.stringify(testConfig('error', 'on', { uiLang: 'he' })));
    const result = boot(document, ['en-US'], { pathname: '/', search: '' }, []);
    expect(result.uiLang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('he');
    expect(result.route).toEqual({ kind: 'no-book', libraryLink: true });
  });

  it('falls back to the browser language and no route without config', () => {
    const result = boot(document, ['he-IL'], { pathname: '/', search: '' }, []);
    expect(result).toEqual({ config: null, configIssue: 'config', uiLang: 'he', route: null });
  });
});
