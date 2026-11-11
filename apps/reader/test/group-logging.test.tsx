import { SyncClientError } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_ID, connected } from './helpers/fake-sync-client.js';
import { createAsLeader, renderGroupApp } from './helpers/group.js';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

afterEach(() => vi.restoreAllMocks());

describe('the reader logs nothing about groups (#24 AC54, R9)', () => {
  it('stays silent through create, codes, join errors and end', async () => {
    const spies = METHODS.map((method) => vi.spyOn(console, method));
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    act(() =>
      client.emit('codesChanged', {
        groupId: GROUP_ID,
        codes: { generation: 2, groupCode: '111222', doorCode: '333444' },
        reason: 'rotated',
      }),
    );
    act(() => client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'ended_by_leader' }));

    act(() => client.setConnection(connected()));
    fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Join a group' }));
    const dialog = screen.getByRole('dialog', { name: 'Join a group' });
    client.impl.joinByCode = () => {
      throw new SyncClientError('CODE_NOT_FOUND');
    };
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Code' }), {
      target: { value: '482913' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
      await Promise.resolve();
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the group UI in Hebrew (#24 AC50)', () => {
  it('is right to left with Hebrew text, while codes and inputs stay left to right', async () => {
    const { client } = await renderGroupApp({ uiLang: 'he' });
    act(() => client.setConnection(connected()));
    fireEvent.click(screen.getByRole('button', { name: 'קבוצה, אפשרויות קבוצה' }));
    expect(screen.getByRole('dialog', { name: 'קריאה משותפת' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'הצטרפות לקבוצה' }));
    const field = screen.getByRole('textbox', { name: 'קוד' });
    expect(field.getAttribute('dir')).toBe('ltr');
  });
});
