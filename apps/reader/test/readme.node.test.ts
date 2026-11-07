// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../server/headers.js';
import { CONTENT_ID_PATTERN } from '../src/content/content-id.js';
import { CONTENT_LIMITS, SUPPORTED_SCHEMA } from '../src/content/limits.js';

const root = join(import.meta.dirname, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const flat = readme.replace(/\s+/g, ' ');
const vector = readFileSync(join(root, 'test', 'fixtures', 'fingerprint-vector.json'), 'utf8');
const rootReadme = readFileSync(join(root, '..', '..', 'README.md'), 'utf8');

describe('README drift guard (AC22)', () => {
  it('has the schema, version policy, fingerprint and direction sections', () => {
    for (const heading of [
      '## Run',
      '### HTTPS is required',
      '## Configuration',
      '## Fetched content (`?src`)',
      '## Content schema (version 1)',
      '### Content ID',
      '### Schema-version policy',
      '## Fingerprint',
      '### Group metadata and comparison',
      '## Direction rules',
      '### Writing mixed-direction text',
      '## Adding a bundled book',
    ]) {
      expect(readme, heading).toContain(heading);
    }
  });

  it('names every environment variable', () => {
    for (const name of [
      'READER_ENTRY',
      'READER_BOOK',
      'READER_LIBRARY',
      'READER_UI_LANG',
      'READER_SRC_ORIGINS',
      'READER_FETCH_TIMEOUT_SECONDS',
      'READER_SRC_MAX_BYTES',
      'PORT',
      'HOST',
    ]) {
      expect(readme, name).toContain(`\`${name}\``);
    }
  });

  it('states the supported range and the limits from the code', () => {
    expect(flat).toContain(`currently **${SUPPORTED_SCHEMA.min} to ${SUPPORTED_SCHEMA.max}**`);
    expect(flat).toContain(`1-${CONTENT_LIMITS.pages}`);
    expect(flat).toContain(`1-${CONTENT_LIMITS.blocksPerPage}`);
    expect(flat).toContain(`0-${CONTENT_LIMITS.textLength}`);
    expect(flat).toContain(`1-${CONTENT_LIMITS.titleLength}`);
    expect(flat).toContain(`1-${CONTENT_LIMITS.namespaceLength} / 1-${CONTENT_LIMITS.slugLength}`);
  });

  it('documents the exact content ID regex', () => {
    expect(readme).toContain(CONTENT_ID_PATTERN.source.replace('\\/', '/'));
  });

  it('documents the fingerprint algorithm and the test vector', () => {
    expect(flat).toContain('RFC 8785');
    expect(flat).toContain('SHA-256');
    expect(flat).toContain('64 lowercase hexadecimal characters');
    expect(flat).toContain('**not** Unicode-normalised');
    expect(flat).toContain('**not a signature**');
    expect(readme).toContain(vector.trim());
    expect(readme).toContain(
      'Fingerprint: `a8672a8d9ccb84e903c9167de7dbe3d1a7b4cd42f00d53a3872687c1e7f58aee`',
    );
  });

  it('documents the CSP the server sends', () => {
    const csp = contentSecurityPolicy({ srcOrigins: [] }).replace(" connect-src 'self';", '');
    for (const directive of csp.split('; ')) expect(flat, directive).toContain(directive);
    expect(flat).toContain("connect-src 'self' <READER_SRC_ORIGINS>");
  });

  it('documents CORS, redirects and the loopback warning', () => {
    expect(flat).toContain('`Access-Control-Allow-Origin`');
    expect(flat).toContain("`redirect: 'error'`");
    expect(flat).toContain('**for development only**');
    expect(flat).toContain('`Strict-Transport-Security`');
  });
});

describe('root README', () => {
  it('lists the reader package and links its README', () => {
    expect(rootReadme).toContain('`@sync-system/reader`');
    expect(rootReadme).toContain('apps/reader/README.md');
  });
});
