import type { JsonObject } from '@sync-system/react';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ContentMetadata,
  parseLeaderMetadata,
  toGroupMetadata,
} from '../src/content/metadata.js';

const metadata: ContentMetadata = {
  contentId: 'acme/psalms-he',
  fingerprint: '0'.repeat(64),
  schemaVersion: 1,
};

describe('group metadata (AC8)', () => {
  it('has exactly contentId, fingerprint and schemaVersion', () => {
    const value = toGroupMetadata(metadata);
    expect(Object.keys(value).sort()).toEqual(['contentId', 'fingerprint', 'schemaVersion']);
    expect(value).toEqual(metadata);
  });

  it('is a fresh plain JSON object', () => {
    const value = toGroupMetadata(metadata);
    expect(value).not.toBe(metadata);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it('is typed as JsonObject from @sync-system/react', () => {
    expectTypeOf(toGroupMetadata).returns.toEqualTypeOf<JsonObject>();
    expectTypeOf<ContentMetadata>().toExtend<JsonObject>();
  });

  it('round-trips through parseLeaderMetadata', () => {
    expect(parseLeaderMetadata(toGroupMetadata(metadata))).toEqual(metadata);
    expect(parseLeaderMetadata({ ...metadata, schemaVersion: -1 })).toBeNull();
  });
});
