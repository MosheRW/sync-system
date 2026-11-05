import { describe, expect, it } from 'vitest';
import {
  CONTENT_ID_PATTERN,
  type ContentIdIssue,
  contentIdIssue,
  describeContentIdIssue,
  isContentId,
} from '../src/content/content-id.js';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

describe('content ID (AC23, ADR 0004 B1)', () => {
  it.each([
    'acme/psalms-he',
    'a/b',
    `acme/${uuid}`,
    'org.example/book.v2',
    '0/9',
    `${'a'.repeat(64)}/${'b'.repeat(128)}`,
  ])('accepts %s', (id) => {
    expect(isContentId(id)).toBe(true);
    expect(contentIdIssue(id)).toBeNull();
  });

  it.each<[string, ContentIdIssue]>([
    ['psalms', 'missing-namespace'],
    ['', 'missing-namespace'],
    ['Acme/psalms', 'uppercase'],
    [`acme/${uuid.toUpperCase()}`, 'uppercase'],
    ['acme/psalms_he', 'character'],
    ['acme/psalms he', 'character'],
    ['acme/psälms', 'character'],
    ['acme/a..b', 'double-dot'],
    ['acme/-psalms', 'edge-character'],
    ['acme/psalms-', 'edge-character'],
    ['.acme/psalms', 'edge-character'],
    [`${'a'.repeat(65)}/b`, 'part-too-long'],
    [`a/${'b'.repeat(129)}`, 'part-too-long'],
    ['/psalms', 'empty-part'],
    ['acme/', 'empty-part'],
    ['acme/x/y', 'too-many-parts'],
    ['acme//y', 'too-many-parts'],
    [`a/${'b'.repeat(500)}`, 'too-long'],
  ])('rejects %j with %s', (id, reason) => {
    expect(isContentId(id)).toBe(false);
    expect(contentIdIssue(id)).toBe(reason);
    expect(describeContentIdIssue(reason)).toMatch(/^Content ID must look like namespace\/slug/);
  });

  it('rejects non-strings', () => {
    expect(isContentId(42)).toBe(false);
    expect(contentIdIssue(null)).toBe('not-a-string');
  });

  it('checks the length before running the regex (F7)', () => {
    const long = `${'a'.repeat(64)}/${'b'.repeat(129)}`;
    expect(long.length).toBe(194);
    expect(isContentId(long)).toBe(false);
  });

  it('agrees with the documented regex', () => {
    for (const id of ['acme/x', 'a-b.c/d', 'x/y.', 'X/y', 'a..b/c', 'ab/c-d-e']) {
      expect(isContentId(id)).toBe(CONTENT_ID_PATTERN.test(id));
      expect(contentIdIssue(id) === null).toBe(CONTENT_ID_PATTERN.test(id));
    }
  });
});
