import { randomUUID } from 'node:crypto';

/** A participant ID: a random UUID from the CSPRNG. */
export function newParticipantId(): string {
  return randomUUID();
}
