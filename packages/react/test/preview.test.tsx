import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { type Preview, usePreview } from '../src/hooks/preview.js';
import { FakeSyncClient } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

function track(client: FakeSyncClient): Preview[] {
  const values: Preview[] = [];
  function Probe(): ReactNode {
    values.push(usePreview());
    return null;
  }
  renderWithProvider(<Probe />, { client });
  return values;
}

describe('usePreview (AC24)', () => {
  it('start, move, returnToGroup delegate to client.preview and update the state', () => {
    const client = new FakeSyncClient();
    const values = track(client);
    act(() => client.lead('g-1', { hasPosition: true, position: 1 }));
    expect(values.at(-1)).toMatchObject({
      active: false,
      groupPosition: 1,
      previewPosition: undefined,
    });
    act(() => values.at(-1)!.start());
    expect(values.at(-1)).toMatchObject({ active: true, groupPosition: 1, previewPosition: 1 });
    act(() => values.at(-1)!.move(5));
    expect(values.at(-1)).toMatchObject({ active: true, groupPosition: 1, previewPosition: 5 });
    expect(client.count('updatePosition')).toBe(0);
    let back: unknown;
    act(() => {
      back = values.at(-1)!.returnToGroup();
    });
    expect(back).toBe(1);
    expect(values.at(-1)).toMatchObject({ active: false, previewPosition: undefined });
  });

  it('bringGroupHere moves the group with one update, then ends', () => {
    const client = new FakeSyncClient();
    const values = track(client);
    act(() => client.lead('g-1', { hasPosition: true, position: 1 }));
    act(() => values.at(-1)!.start(7));
    let result: unknown;
    act(() => {
      result = values.at(-1)!.bringGroupHere();
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(client.calls.get('updatePosition')).toEqual([[7]]);
    expect(values.at(-1)).toMatchObject({ active: false, groupPosition: 7 });
  });

  it('end stops the preview; a demotion snapshot ends it in the state', () => {
    const client = new FakeSyncClient();
    const values = track(client);
    act(() => client.lead('g-1', { hasPosition: true, position: 1 }));
    act(() => values.at(-1)!.start(3));
    act(() => values.at(-1)!.end());
    expect(values.at(-1)?.active).toBe(false);
    act(() => values.at(-1)!.start(3));
    act(() => {
      // The core ends the preview on demotion; the snapshot change recomputes it.
      client.preview.end();
      client.follow('g-1', { hasPosition: true, position: 1 });
    });
    expect(values.at(-1)).toMatchObject({ active: false, previewPosition: undefined });
  });

  it('bringGroupHere returns the core error instead of throwing', () => {
    const client = new FakeSyncClient();
    const values = track(client);
    act(() => client.lead('g-1', { hasPosition: true, position: 1 }));
    act(() => values.at(-1)!.start(3));
    act(() => client.setConnection({ status: 'connecting' }));
    let result: unknown;
    act(() => {
      result = values.at(-1)!.bringGroupHere();
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
  });
});
