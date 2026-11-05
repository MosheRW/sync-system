/** Any value `JSON.parse` can return (structurally the same as `JsonValue` in the packages). */
export type CanonicalJsonValue =
  string | number | boolean | null | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

/** Deeper than any valid content (the schema nests 5 levels); a guard, not a feature. */
const MAX_DEPTH = 32;

export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the values `JSON.parse`
 * produces (ADR 0004 D1): no whitespace; object keys sorted by UTF-16 code
 * units (the default `Array.prototype.sort` order for strings); strings and
 * numbers serialised exactly as ECMAScript `JSON.stringify` does. Only own
 * enumerable keys are read. Throws `CanonicalJsonError` for values JSON
 * cannot hold (undefined, functions, non-finite numbers, cycles via depth).
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  return serialise(value, 0);
}

function serialise(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError('value is nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('number is not finite');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialise(item, depth + 1)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const members = keys.map(
        (key) => `${JSON.stringify(key)}:${serialise(record[key], depth + 1)}`,
      );
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`${typeof value} is not a JSON value`);
  }
}
