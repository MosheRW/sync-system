import { GROUP_ID_PATTERN } from '@sync-system/protocol';
import { describe, expect, it } from 'vitest';
import { newGroupId, newParticipantId } from '../src/groups/ids.js';

describe('ids (AC11)', () => {
  it('generates 43-char base64url group IDs (256 bits)', () => {
    const id = newGroupId();
    expect(id).toMatch(GROUP_ID_PATTERN);
    expect(Buffer.from(id, 'base64url')).toHaveLength(32);
  });

  it('generates 1,000 unique group IDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newGroupId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(GROUP_ID_PATTERN);
  });

  it('generates UUID participant IDs', () => {
    expect(newParticipantId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newParticipantId()).not.toBe(newParticipantId());
  });
});
