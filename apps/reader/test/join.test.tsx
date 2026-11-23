import { type JoinedGroup, SyncClientError } from '@mosherw/sync-system-react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { errorText, errorView } from '../src/group/errors.js';
import { createI18n } from '../src/i18n/index.js';
import { POINTER_KEY } from './helpers/app.js';
import type { FakeSyncClient } from './helpers/fake-sync-client.js';
import { GROUP_ID, activeGroup, connected } from './helpers/fake-sync-client.js';
import { renderGroupApp } from './helpers/group.js';

const en = createI18n('en');
const he = createI18n('he');

function joined(client: FakeSyncClient): JoinedGroup {
  client.follow({ metadata: { contentId: 'x/y', fingerprint: 'a'.repeat(64), schemaVersion: 1 } });
  return {
    groupId: GROUP_ID,
    role: 'member',
    participantId: 'p-self',
    metadata: {},
    hasPosition: false,
  };
}

async function openJoin(methods: readonly ('A' | 'B' | 'C' | 'D')[] = ['A', 'B', 'C', 'D']) {
  const { client, storage } = await renderGroupApp();
  act(() => client.setConnection(connected(methods)));
  fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Join a group' }));
  return { client, storage, dialog: screen.getByRole('dialog', { name: 'Join a group' }) };
}

async function press(dialog: HTMLElement, name = 'Join') {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeCode(dialog: HTMLElement, value: string, label = 'Code') {
  fireEvent.change(within(dialog).getByRole('textbox', { name: label }), { target: { value } });
}

describe('code field (#24 AC18, R8)', () => {
  it('is a plain LTR text field with the numeric keypad and nothing remembered', async () => {
    const { dialog } = await openJoin();
    const field = within(dialog).getByRole('textbox', { name: 'Code' });
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('type')).toBe('text');
    expect(field.getAttribute('dir')).toBe('ltr');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('maxlength')).toBe('32');
  });

  it('switches to letters and back, keeping the value and the focus', async () => {
    const { dialog } = await openJoin();
    typeCode(dialog, 'K7');
    fireEvent.click(within(dialog).getByRole('button', { name: 'My code has letters' }));
    const field = within(dialog).getByRole('textbox', { name: 'Code' });
    expect(field.getAttribute('inputmode')).toBe('text');
    expect(field.getAttribute('autocapitalize')).toBe('characters');
    expect((field as HTMLInputElement).value).toBe('K7');
    expect(document.activeElement).toBe(field);
    fireEvent.click(within(dialog).getByRole('button', { name: 'My code is only digits' }));
    expect(field.getAttribute('inputmode')).toBe('numeric');
  });

  it('starts on letters when only C is allowed, with no toggle', async () => {
    const { dialog } = await openJoin(['C']);
    expect(within(dialog).getByRole('textbox', { name: 'Code' }).getAttribute('inputmode')).toBe(
      'text',
    );
    expect(within(dialog).queryByRole('button', { name: 'My code has letters' })).toBeNull();
  });
});

describe('client checks before sending (#24 AC16, AC19)', () => {
  it.each([
    ['', 'Enter the code.'],
    ['12345', 'A code is 6 digits, or 8 letters and digits.'],
    ['12 34 5x', 'A code is 6 digits, or 8 letters and digits.'],
  ])('%j -> %s, nothing sent', async (value, message) => {
    const { client, dialog } = await openJoin();
    typeCode(dialog, value);
    await press(dialog);
    expect(within(dialog).getByText(message)).toBeDefined();
    expect(client.count('joinByCode')).toBe(0);
  });

  it.each([' 482 913 ', '482-913', ' k7mq-9xpr ', 'K7MQ9XPR'])(
    'accepts the pasted code %j as typed (the client normalises it)',
    async (value) => {
      const { client, dialog } = await openJoin();
      typeCode(dialog, value);
      await press(dialog);
      expect(client.args('joinByCode')).toEqual([value, {}]);
    },
  );
});

describe('method A: the door code (#24 AC14)', () => {
  it('asks for the door code, clears a wrong one, then joins', async () => {
    const { client, storage, dialog } = await openJoin();
    let call = 0;
    client.impl.joinByCode = () => {
      call += 1;
      if (call === 1) throw new SyncClientError('DOOR_CODE_REQUIRED');
      if (call === 2) throw new SyncClientError('DOOR_CODE_WRONG');
      return joined(client);
    };
    typeCode(dialog, '482913');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Your name (optional)' }), {
      target: { value: 'Dana' },
    });
    await press(dialog);
    expect(within(dialog).getByRole('heading', { name: 'Enter the door code' })).toBeDefined();
    expect(within(dialog).getByRole('img', { name: 'Group code: 4 8 2 9 1 3' })).toBeDefined();
    const door = within(dialog).getByRole('textbox', { name: 'Door code' });
    expect(document.activeElement).toBe(door);
    fireEvent.change(door, { target: { value: '111111' } });
    await press(dialog);
    expect((door as HTMLInputElement).value).toBe('');
    expect(
      within(dialog).getByText(
        "That door code didn't work. Check it with the leader and try again.",
      ),
    ).toBeDefined();
    expect(client.args('joinByCode', 1)).toEqual([
      '482913',
      { doorCode: '111111', displayName: 'Dana' },
    ]);
    fireEvent.change(door, { target: { value: '205118' } });
    await press(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(JSON.parse(storage.getItem(POINTER_KEY)!)).toMatchObject({
      groupId: GROUP_ID,
      mode: 'following',
    });
  });

  it('Change goes back to the code, kept', async () => {
    const { client, dialog } = await openJoin();
    client.impl.joinByCode = () => {
      throw new SyncClientError('DOOR_CODE_REQUIRED');
    };
    typeCode(dialog, '482913');
    await press(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change' }));
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Code' }).value).toBe(
      '482913',
    );
  });

  it('pauses the Join button for a JOIN_PAUSED wait', async () => {
    const { client, dialog } = await openJoin();
    client.impl.joinByCode = () => {
      throw new SyncClientError('JOIN_PAUSED', { details: { retryAfterMs: 120_000 } });
    };
    typeCode(dialog, '482913');
    await press(dialog);
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Joining with this code is paused. Try again in 2 minutes.',
    );
    expect(within(dialog).getByRole('button', { name: 'Join' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });
});

describe('method B: waiting for approval (#24 AC15)', () => {
  async function waitForApproval() {
    const opened = await openJoin();
    typeCode(opened.dialog, '482913');
    await press(opened.dialog);
    act(() =>
      opened.client.setGroup({
        status: 'awaiting_approval',
        requestId: 'r1',
        expiresAt: Date.now() + 120_000,
      }),
    );
    return opened;
  }

  it('shows the time left and the indicator, and the sheet can close', async () => {
    const { dialog } = await waitForApproval();
    expect(within(dialog).getByRole('heading', { name: 'Waiting for the leader' })).toBeDefined();
    expect(
      within(dialog).getByText(
        (_, el) => el?.tagName === 'P' && /left$/.test(el.textContent ?? ''),
      ),
    ).toBeDefined();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(
      screen.getByRole('button', { name: 'Waiting for approval, group options' }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Waiting for approval, group options' }));
    expect(screen.getByRole('dialog', { name: 'Waiting for the leader' })).toBeDefined();
  });

  it('approved: admitted', async () => {
    const { client } = await waitForApproval();
    await act(async () => {
      client.lastPending('joinByCode').resolve(joined(client));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['JOIN_DENIED', "The leader didn't let you in. Talk to the leader, then try again."],
    [
      'APPROVAL_TIMEOUT',
      "The leader didn't answer in time. Ask them to check their screen, then try again.",
    ],
    ['GROUP_FULL', 'This group is full. Ask the leader.'],
  ] as const)('%s reopens the join view with the message, code kept', async (code, message) => {
    const { client, dialog } = await waitForApproval();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {
      client.setGroup(null);
      client.lastPending('joinByCode').reject(new SyncClientError(code));
      await Promise.resolve();
      await Promise.resolve();
    });
    const reopened = screen.getByRole('dialog', { name: 'Join a group' });
    expect(within(reopened).getByRole('alert').textContent).toBe(message);
    expect(within(reopened).getByRole<HTMLInputElement>('textbox', { name: 'Code' }).value).toBe(
      '482913',
    );
  });

  it('Cancel request withdraws it and goes back with no message', async () => {
    const { client, dialog } = await waitForApproval();
    client.impl.cancelJoin = () => undefined;
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
      await Promise.resolve();
    });
    expect(client.count('cancelJoin')).toBe(1);
    await act(async () => {
      client.setGroup(null);
      client.lastPending('joinByCode').reject(new SyncClientError('JOIN_CANCELLED'));
      await Promise.resolve();
      await Promise.resolve();
    });
    const view = screen.getByRole('dialog', { name: 'Join a group' });
    expect(within(view).queryByRole('alert')).toBeNull();
  });
});

describe('every join error has its own message, never the code (#24 AC19)', () => {
  const CASES: [string, Record<string, unknown> | undefined, string][] = [
    ['CODE_NOT_FOUND', undefined, 'errCodeNotFound'],
    ['INVALID_JOIN_CODE', { field: 'code' }, 'errCodeNotFound'],
    ['DOOR_CODE_WRONG', undefined, 'errDoorWrong'],
    ['JOIN_PAUSED', { retryAfterMs: 90_000 }, 'errJoinPaused'],
    ['JOIN_PAUSED', undefined, 'errJoinPausedNoTime'],
    ['JOIN_DENIED', undefined, 'errJoinDenied'],
    ['APPROVAL_TIMEOUT', undefined, 'errApprovalTimeout'],
    ['APPROVAL_QUEUE_FULL', undefined, 'errQueueFull'],
    ['QR_INVALID', undefined, 'errQrInvalid'],
    ['QR_EXPIRED', undefined, 'errQrExpired'],
    ['RATE_LIMITED', { retryAfterMs: 5_000 }, 'errRateLimited'],
    ['RATE_LIMITED', undefined, 'errRateLimitedNoTime'],
    ['GROUP_LOCKED', undefined, 'errGroupLocked'],
    ['GROUP_FULL', undefined, 'errGroupFull'],
    ['JOIN_METHOD_NOT_ALLOWED', undefined, 'errMethod'],
    ['JOIN_METHOD_UNAVAILABLE', undefined, 'errMethod'],
    ['ALREADY_IN_GROUP', undefined, 'errAlreadyInGroup'],
    ['INVALID_DISPLAY_NAME', undefined, 'nameInvalidChars'],
    ['CONNECTION_LOST', undefined, 'errNetwork'],
    ['NOT_CONNECTED', undefined, 'errNetwork'],
    ['REQUEST_TIMEOUT', undefined, 'errNetwork'],
    ['APP_CONNECTION_LIMIT', undefined, 'errBusy'],
    ['CODES_EXHAUSTED', undefined, 'errBusy'],
    ['APP_GROUP_LIMIT', { maxLiveGroups: 10_000 }, 'errBusy'],
    ['INVALID_API_KEY', undefined, 'errSetup'],
    ['INTERNAL_ERROR', undefined, 'errServer'],
    ['SOMETHING_NEW', undefined, 'errServer'],
  ];

  it.each(CASES)('%s %j -> %s, in en and he', (code, details, key) => {
    const error = new SyncClientError(
      code as 'INTERNAL_ERROR',
      (details ? { details } : {}) as never,
    );
    const view = errorView(error)!;
    expect(view.key).toBe(key);
    for (const i18n of [en, he]) {
      const text = errorText(view, i18n);
      expect(text).not.toBe('');
      expect(text).not.toContain('482913');
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/\{\w+\}/);
    }
  });

  it('says nothing for a cancelled join', () => {
    expect(errorView(new SyncClientError('JOIN_CANCELLED'))).toBeNull();
  });

  it('never echoes the typed code in the rendered sheet', async () => {
    const { client, dialog } = await openJoin();
    client.impl.joinByCode = () => {
      throw new SyncClientError('CODE_NOT_FOUND');
    };
    typeCode(dialog, '482913');
    await press(dialog);
    expect(within(dialog).getByRole('alert').textContent).not.toContain('482913');
    void activeGroup;
  });
});
