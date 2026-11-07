// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseReaderConfig } from '../src/config/schema.js';
import { CONFIG_PLACEHOLDER, renderIndexHtml, serialiseConfig } from '../server/html.js';
import { INDEX_TEMPLATE } from './helpers/server.js';

const IDS = ['samples/psalms-he'];
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function configBlock(html: string): string {
  const match = /<script type="application\/json" id="reader-config">(.*?)<\/script>/s.exec(html);
  if (!match) throw new Error('no config block');
  return match[1]!;
}

describe('config injection (ADR 0005 E1, security C5)', () => {
  const config = parseReaderConfig({ READER_SRC_ORIGINS: 'https://a.example' }, IDS);

  it('replaces the placeholder with a JSON block', () => {
    const html = renderIndexHtml(INDEX_TEMPLATE, config);
    expect(html).not.toContain(CONFIG_PLACEHOLDER);
    expect(JSON.parse(configBlock(html))).toEqual({
      entry: 'library',
      book: null,
      library: 'on',
      uiLang: 'auto',
      srcOrigins: ['https://a.example'],
      fetchTimeoutSeconds: 15,
      srcMaxBytes: 5_242_880,
      sync: null,
    });
  });

  it('escapes <, >, &, U+2028 and U+2029 as JSON escapes, and round-trips', () => {
    const hostile = { ...config, book: `</script><!--<script>&${LS}${PS}` };
    const json = serialiseConfig(hostile);
    for (const char of ['<', '>', '&', LS, PS]) expect(json).not.toContain(char);
    const bs = String.fromCharCode(92);
    for (const escape of ['003c', '003e', '0026', '2028', '2029']) {
      expect(json).toContain(`${bs}u${escape}`);
    }
    expect(json).not.toContain('&lt;');
    const html = renderIndexHtml(INDEX_TEMPLATE, hostile);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect((JSON.parse(configBlock(html)) as { book: string }).book).toBe(hostile.book);
  });

  it('never includes values outside the public field list', () => {
    const withSecrets = parseReaderConfig(
      { TOKEN_SECRET: 'super-secret-x', PORT: '9999', HOST: '10.1.2.3' },
      IDS,
    );
    const html = renderIndexHtml(INDEX_TEMPLATE, {
      ...withSecrets,
      ...({ extra: 'leak-me' } as object),
    });
    for (const value of ['super-secret-x', '9999', '10.1.2.3', 'leak-me', 'warnings']) {
      expect(html).not.toContain(value);
    }
  });

  it('requires the placeholder exactly once', () => {
    expect(() => renderIndexHtml('<html></html>', config)).toThrow(/exactly once/);
    expect(() => renderIndexHtml(`${CONFIG_PLACEHOLDER}${CONFIG_PLACEHOLDER}`, config)).toThrow(
      /exactly once/,
    );
  });
});
