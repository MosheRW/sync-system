/**
 * A startup configuration problem, or several. Each problem is one
 * human-readable line, printed to stderr as `Config error: <problem>`. A
 * problem must never contain an API key value or any other received secret;
 * callers build it from field names, paths and validated numbers only.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  /** One line per problem, in the order they were found. */
  readonly problems: readonly string[];

  constructor(problems: string | readonly string[]) {
    const list = Object.freeze(typeof problems === 'string' ? [problems] : [...problems]);
    super(list.join('\n'));
    this.problems = list;
  }
}
