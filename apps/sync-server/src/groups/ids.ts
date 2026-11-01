import { randomBytes, randomUUID } from 'node:crypto';

/** A group ID: 32 bytes (256 bits) from the CSPRNG, base64url, 43 characters. */
export function newGroupId(): string {
  return randomBytes(32).toString('base64url');
}

/** A participant ID: a random UUID from the CSPRNG. */
export function newParticipantId(): string {
  return randomUUID();
}
