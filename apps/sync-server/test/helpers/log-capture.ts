import type { DestinationStream } from 'pino';

/** Captures pino output in memory. */
export class LogCapture implements DestinationStream {
  readonly lines: string[] = [];

  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.length > 0) this.lines.push(line);
    }
  }

  get text(): string {
    return this.lines.join('\n');
  }

  records(): Array<Record<string, unknown>> {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  events(): unknown[] {
    return this.records().map((record) => record.event);
  }
}
