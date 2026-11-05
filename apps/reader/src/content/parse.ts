import type { ContentIdIssue } from './content-id.js';
import type { ContentError, InvalidContentCode } from './errors.js';
import { CONTENT_LIMITS, SUPPORTED_SCHEMA, type SchemaRange } from './limits.js';
import { truncate } from './quote.js';
import { type ContentDocument, contentSchemaV1 } from './schema.js';
import type { z } from './zod.js';

export type ParseResult =
  { ok: true; document: ContentDocument } | { ok: false; error: ContentError };

const BOM = 0xfeff;

/**
 * Raw text -> JSON -> plain-object check -> schema-version gate -> strict
 * schema (architecture P1, P2). Shared by the loader, the library plugin and
 * the tests, so bundled and fetched content are validated identically (AC2).
 * Never throws.
 */
export function parseContentText(
  text: string,
  supported: SchemaRange = SUPPORTED_SCHEMA,
): ParseResult {
  const source = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, error: { kind: 'invalid-json' } };
  }
  return parseContentValue(value, supported);
}

/** A plain JSON object (security C4): not null, not an array, no odd prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Validates a value produced by `JSON.parse`. Never copies or spreads it first (C4). */
export function parseContentValue(
  value: unknown,
  supported: SchemaRange = SUPPORTED_SCHEMA,
): ParseResult {
  if (!isPlainObject(value)) {
    return invalid('not-an-object', 'the file must be a JSON object');
  }
  // Version gate before full validation (P2), reading only an own property.
  if (!Object.hasOwn(value, 'schemaVersion')) {
    return { ok: false, error: { kind: 'schema-version-missing' } };
  }
  const version = value['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: { kind: 'schema-version-invalid' } };
  }
  if (version < supported.min || version > supported.max) {
    return {
      ok: false,
      error: {
        kind: 'schema-version-unsupported',
        version,
        min: supported.min,
        max: supported.max,
      },
    };
  }

  const result = contentSchemaV1.safeParse(value, { reportInput: true });
  if (result.success) return { ok: true, document: result.data };
  const issue = result.error.issues[0];
  if (!issue) return invalid('wrong-type', 'the file is not valid');
  return { ok: false, error: describeIssue(issue) };
}

function invalid(code: InvalidContentCode, detail: string): ParseResult {
  return { ok: false, error: { kind: 'invalid-content', path: '', code, detail } };
}

/** `['pages', 2, 'blocks', 1, 'dir']` -> "Page 3, block 2". */
export function pathLabel(path: readonly PropertyKey[]): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = path[i + 1];
    if (key === 'pages' && typeof next === 'number') {
      parts.push(`Page ${next + 1}`);
      i++;
    } else if (key === 'blocks' && typeof next === 'number') {
      parts.push(`block ${next + 1}`);
      i++;
    }
  }
  return parts.join(', ');
}

/** The field the issue is about: the last string key in the path. */
function fieldOf(path: readonly PropertyKey[]): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const key = path[i];
    if (typeof key === 'string') return key;
  }
  return undefined;
}

function quote(value: unknown): string {
  if (typeof value === 'string') return `"${truncate(value)}"`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return Array.isArray(value) ? 'a list' : 'an object';
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

const EXPECTED: Record<string, string> = {
  string: 'text',
  array: 'a list',
  object: 'an object',
  number: 'a number',
};

const FIELD_NAMES: Record<string, string> = {
  dir: 'direction',
  type: 'block type',
  lang: 'language tag',
  pages: 'pages',
  blocks: 'blocks',
  text: 'text',
  title: 'title',
  contentId: 'content ID',
  schemaVersion: 'schema version',
};

function describeIssue(issue: z.core.$ZodIssue): ContentError {
  const path = pathLabel(issue.path);
  const field = fieldOf(issue.path);
  const name = field ? (FIELD_NAMES[field] ?? `"${truncate(field)}"`) : 'value';
  const make = (
    code: InvalidContentCode,
    detail: string,
    contentIdIssue?: ContentIdIssue,
  ): ContentError =>
    contentIdIssue
      ? { kind: 'invalid-content', path, code, detail, contentIdIssue }
      : { kind: 'invalid-content', path, code, detail };

  switch (issue.code) {
    case 'unrecognized_keys':
      return make('unknown-field', `unknown field "${truncate(issue.keys[0] ?? '')}"`);
    case 'invalid_type': {
      if (issue.input === undefined) return make('missing-field', `missing ${name}`);
      const expected = EXPECTED[issue.expected] ?? issue.expected;
      return make('wrong-type', `${name} must be ${expected}, not ${typeName(issue.input)}`);
    }
    case 'invalid_value':
      return make('invalid-value', `unknown ${name} ${quote(issue.input)}`);
    case 'invalid_format':
      return make('invalid-lang', `${name} is not valid: ${quote(issue.input)}`);
    case 'too_small':
      if (field === 'blocks') return make('empty', 'has no blocks');
      if (field === 'pages') return make('empty', 'has no pages');
      return make('empty', `${name} is empty`);
    case 'too_big':
      if (field === 'blocks') {
        return make('too-many', `has more than ${CONTENT_LIMITS.blocksPerPage} blocks`);
      }
      if (field === 'pages') return make('too-many', `has more than ${CONTENT_LIMITS.pages} pages`);
      return make('too-long', `${name} is longer than ${String(issue.maximum)} characters`);
    case 'custom': {
      const params = issue.params as { contentIdIssue?: ContentIdIssue } | undefined;
      if (params?.contentIdIssue) {
        return make('invalid-content-id', issue.message, params.contentIdIssue);
      }
      return make('invalid-text', `${name} ${issue.message}`);
    }
    default:
      return make('wrong-type', `${name} is not valid`);
  }
}
