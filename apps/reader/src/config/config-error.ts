/**
 * A startup configuration problem (AC30, AC41). Each problem names the
 * variable and the rule; the server prints each as `Config error: <problem>`
 * and exits 1. Messages quote only the offending reader variable's value,
 * truncated, never any other environment value (security C9).
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(readonly problems: readonly string[]) {
    super(problems.join('\n'));
  }
}
