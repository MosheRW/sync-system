import { randomBytes, randomUUID } from 'node:crypto';

/** A group ID: 32 bytes (256 bits) from the CSPRNG, base64url, 43 characters. */
export function newGroupId(): string {
  return randomBytes(32).toString('base64url');
}

/** A participant ID: a random UUID from the CSPRNG. */
export function newParticipantId(): string {
  return randomUUID();
}

/** An attachment ID: 16 bytes from the CSPRNG, base64url, 22 characters (#35 security C16). */
export function newAttachId(): string {
  return randomBytes(16).toString('base64url');
}
