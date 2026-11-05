import { QUOTE_MAX_LENGTH } from './limits.js';

/**
 * Shortens an untrusted string for display in error details: at most
 * `max` code points (never splits a surrogate pair), with an ellipsis.
 */
export function truncate(value: string, max = QUOTE_MAX_LENGTH): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}
