// docs/protocol.md covers the whole wire protocol (#37 AC43): every message
// type, every error code and every close code appears in it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  ErrorCode,
  GROUP_ENDED_REASONS,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  TOKEN_STATUSES,
  clientMessageSchema,
} from '../src/index.js';

const doc = readFileSync(new URL('../../../docs/protocol.md', import.meta.url), 'utf8');
const messagesSource = readFileSync(new URL('../src/messages.ts', import.meta.url), 'utf8');

/** Every `type: '<name>'` literal in messages.ts (client and server messages). */
const messageTypes = [
  ...new Set([...messagesSource.matchAll(/^\s+type: '([a-zA-Z.]+)';$/gm)].map((m) => m[1] ?? '')),
];

function section(heading: string): string {
  const start = doc.indexOf(`## ${heading}`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

describe('docs/protocol.md (#37 AC43)', () => {
  it('finds the message types in messages.ts', () => {
    // A guard for the regex: every client schema type is among them.
    const clientTypes = clientMessageSchema.options.map((option) => option.shape.type.value);
    expect(clientTypes.length).toBeGreaterThan(20);
    for (const type of clientTypes) expect(messageTypes).toContain(type);
    expect(messageTypes.length).toBeGreaterThan(55);
  });

  it('lists every client message type in the client table', () => {
    const table = section('Client messages');
    for (const option of clientMessageSchema.options) {
      expect(table, option.shape.type.value).toContain(`| \`${option.shape.type.value}\``);
    }
  });

  it('lists every server message type in the server table', () => {
    const table = section('Server messages');
    const clientTypes = new Set<string>(clientMessageSchema.options.map((o) => o.shape.type.value));
    for (const type of messageTypes.filter((t) => !clientTypes.has(t))) {
      expect(table, type).toContain(`| \`${type}\``);
    }
  });

  it('lists every error code', () => {
    const table = section('Error codes');
    for (const code of Object.values(ErrorCode)) {
      expect(table, code).toContain(`| \`${code}\``);
    }
  });

  it('lists every close code with its name', () => {
    const table = section('Close codes');
    for (const [name, code] of Object.entries(CloseCode)) {
      expect(table, name).toMatch(new RegExp(`\\| \`${code}\` +\\| \`${name}\` +\\|`));
    }
  });

  it('lists the group-ended reasons and token statuses', () => {
    for (const value of [...GROUP_ENDED_REASONS, ...TOKEN_STATUSES]) {
      expect(doc, value).toContain(`\`${value}\``);
    }
  });

  it('states the protocol versions', () => {
    expect(doc).toContain(`\`PROTOCOL_VERSION = ${PROTOCOL_VERSION}\``);
    expect(doc).toContain(`\`MIN_CLIENT_PROTOCOL_VERSION = ${MIN_CLIENT_PROTOCOL_VERSION}\``);
  });
});
