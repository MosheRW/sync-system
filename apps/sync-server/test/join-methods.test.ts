import type { JoinMethod } from '@sync-system/protocol';
import { describe, expect, it } from 'vitest';
import {
  canonicalMethods,
  defaultAppMethods,
  defaultGroupMethods,
  isValidGroupMethodSet,
  resolveGroupMethods,
  usesGroupCode,
} from '../src/joins/join-methods.js';

describe('join method rules (#10 AC2, AC5)', () => {
  it('orders methods canonically', () => {
    expect(canonicalMethods(['D', 'B', 'A'])).toEqual(['A', 'B', 'D']);
  });

  it('defaults an app to A and D within the env list', () => {
    expect(defaultAppMethods(['A', 'B', 'C', 'D'])).toEqual(['A', 'D']);
    expect(defaultAppMethods(['C', 'D'])).toEqual(['D']);
    expect(defaultAppMethods(['B', 'C'])).toEqual([]);
  });

  it('defaults a group to the app methods minus B when A is there', () => {
    expect(defaultGroupMethods(['A', 'B', 'C', 'D'])).toEqual(['A', 'C', 'D']);
    expect(defaultGroupMethods(['B', 'D'])).toEqual(['B', 'D']);
    expect(defaultGroupMethods(['C'])).toEqual(['C']);
  });

  it('resolves an omitted set to the group default', () => {
    expect(resolveGroupMethods(['A', 'B', 'D'])).toEqual({ ok: true, methods: ['A', 'D'] });
  });

  it('accepts a valid requested subset in canonical order', () => {
    expect(resolveGroupMethods(['A', 'B', 'C', 'D'], ['D', 'B'])).toEqual({
      ok: true,
      methods: ['B', 'D'],
    });
  });

  it('rejects empty, duplicate, A with B, and methods outside the app set', () => {
    const bad: JoinMethod[][] = [[], ['A', 'A'], ['A', 'B'], ['C']];
    for (const requested of bad) {
      expect(resolveGroupMethods(['A', 'B', 'D'], requested)).toEqual({ ok: false });
    }
  });

  it('knows which sets are valid and which use a group code', () => {
    expect(isValidGroupMethodSet([])).toBe(false);
    expect(isValidGroupMethodSet(['A', 'B'])).toBe(false);
    expect(isValidGroupMethodSet(['B', 'C', 'D'])).toBe(true);
    expect(usesGroupCode(['A'])).toBe(true);
    expect(usesGroupCode(['B'])).toBe(true);
    expect(usesGroupCode(['C', 'D'])).toBe(false);
  });
});
