import { CONTENT_LIMITS } from './limits.js';

/**
 * Content ID `<namespace>/<slug>` (ADR 0004 B1, AC23): lowercase letters,
 * digits, `-` and `.`; each part starts and ends with a letter or digit; no
 * `..`; namespace 1-64, slug 1-128 characters. A lowercase UUID is a slug.
 */
export const CONTENT_ID_PATTERN =
  /^(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;

export type ContentIdIssue =
  | 'not-a-string'
  | 'too-long'
  | 'missing-namespace'
  | 'too-many-parts'
  | 'empty-part'
  | 'part-too-long'
  | 'uppercase'
  | 'character'
  | 'double-dot'
  | 'edge-character';

/** True for a valid content ID. The length is checked before the regex (F7). */
export function isContentId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CONTENT_LIMITS.contentIdLength &&
    CONTENT_ID_PATTERN.test(value)
  );
}

/** The specific reason a value is not a content ID, or `null` when it is one. */
export function contentIdIssue(value: unknown): ContentIdIssue | null {
  if (typeof value !== 'string') return 'not-a-string';
  if (value.length > CONTENT_LIMITS.contentIdLength) return 'too-long';
  const parts = value.split('/');
  if (parts.length < 2) return 'missing-namespace';
  if (parts.length > 2) return 'too-many-parts';
  const [namespace = '', slug = ''] = parts;
  if (namespace === '' || slug === '') return 'empty-part';
  if (namespace.length > CONTENT_LIMITS.namespaceLength) return 'part-too-long';
  if (slug.length > CONTENT_LIMITS.slugLength) return 'part-too-long';
  for (const part of parts) {
    if (/[A-Z]/.test(part)) return 'uppercase';
    if (/[^a-z0-9.-]/.test(part)) return 'character';
    if (part.includes('..')) return 'double-dot';
    if (!/^[a-z0-9]/.test(part) || !/[a-z0-9]$/.test(part)) return 'edge-character';
  }
  return CONTENT_ID_PATTERN.test(value) ? null : 'character';
}

const ISSUE_TEXT: Record<ContentIdIssue, string> = {
  'not-a-string': 'is not a string',
  'too-long': `is longer than ${CONTENT_LIMITS.contentIdLength} characters`,
  'missing-namespace': 'has no namespace (expected namespace/slug)',
  'too-many-parts': 'has more than one "/"',
  'empty-part': 'has an empty namespace or slug',
  'part-too-long': `has a namespace over ${CONTENT_LIMITS.namespaceLength} or a slug over ${CONTENT_LIMITS.slugLength} characters`,
  uppercase: 'has uppercase letters',
  character: 'has a character other than a-z, 0-9, "-" and "."',
  'double-dot': 'contains ".."',
  'edge-character': 'has a part that starts or ends with "-" or "."',
};

/** Author-facing explanation, e.g. for the "invalid content" Details. */
export function describeContentIdIssue(issue: ContentIdIssue): string {
  return `Content ID must look like namespace/slug: it ${ISSUE_TEXT[issue]}`;
}
