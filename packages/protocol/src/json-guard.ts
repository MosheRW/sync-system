export type JsonCheckResult = 'ok' | 'too_deep' | 'invalid';

export interface JsonCheckOptions {
  /** Maximum number of nested containers (objects/arrays). `{}` has depth 1. */
  maxDepth: number;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks that `value` is a JSON value (null, boolean, finite number, string,
 * array, plain object) nested at most `maxDepth` containers deep.
 *
 * The walk is iterative (explicit stack), so a frame like `[[[[...]]]]` with
 * thousands of levels cannot overflow the call stack (M4). It never copies
 * or rebuilds the value, so `__proto__` keys and identity are preserved (L6).
 */
export function checkJson(value: unknown, options: JsonCheckOptions): JsonCheckResult {
  const { maxDepth } = options;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const item = stack.pop()!;
    const current = item.value;

    if (current === null) continue;
    switch (typeof current) {
      case 'string':
      case 'boolean':
        continue;
      case 'number':
        if (!Number.isFinite(current)) return 'invalid';
        continue;
      case 'object':
        break;
      default:
        return 'invalid';
    }

    const depth = item.depth + 1;
    if (depth > maxDepth) return 'too_deep';

    if (Array.isArray(current)) {
      for (const child of current as unknown[]) {
        stack.push({ value: child, depth });
      }
    } else {
      if (!isPlainObject(current)) return 'invalid';
      for (const child of Object.values(current)) {
        stack.push({ value: child, depth });
      }
    }
  }

  return 'ok';
}
