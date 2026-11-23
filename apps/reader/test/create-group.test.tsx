import { SyncClientError } from '@mosherw/sync-system-react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chosenMethods, defaultChoices } from '../src/components/group/CreateGroupForm.js';
import { checkDisplayName } from '../src/group/names.js';
import { POINTER_KEY } from './helpers/app.js';
import { GROUP_ID, connected } from './helpers/fake-sync-client.js';
import { CODES, createAsLeader, largeScreen, renderGroupApp } from './helpers/group.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function openCreate() {
  fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Start a group' }));
  return screen.getByRole('dialog', { name: 'Start a group' });
}

function submit(dialog: HTMLElement) {
  return act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start group' }));
    await Promise.resolve();
  });
}

describe('create form defaults (#24 AC5, design 6.3)', () => {
  it.each([
    [
      ['A', 'B', 'C', 'D'],
      ['A', 'D'],
    ],
    [
      ['B', 'C', 'D'],
      ['C', 'D'],
    ],
    [
      ['B', 'D'],
      ['B', 'D'],
    ],
    [['C'], ['C']],
    [['D'], ['D']],
    [['A'], ['A']],
  ] as const)('with %j allowed, defaults to %j', (allowed, expected) => {
    expect(chosenMethods(defaultChoices(allowed, 'auto'), allowed)).toEqual(expected);
  });

  it('never combines A and B', () => {
    const allowed = ['A', 'B'] as const;
    const choices = { ...defaultChoices(allowed, 'auto'), ab: 'B' as const };
    expect(chosenMethods(choices, allowed)).toEqual(['B']);
  });
});

describe('display names (#24 AC7, design 6.17)', () => {
  it.each([
    ['', { ok: true }],
    ['   ', { ok: true }],
    ['  Dana  ', { ok: true, displayName: 'Dana' }],
    ['דנה (Dana)', { ok: true, displayName: 'דנה (Dana)' }],
    ['x'.repeat(33), { ok: false, key: 'nameTooLong' }],
    ['‮evil', { ok: false, key: 'nameInvalidChars' }],
    ['a\u0007b', { ok: false, key: 'nameInvalidChars' }],
  ])('%j', (raw, expected) => {
    expect(checkDisplayName(raw)).toEqual(expected);
  });
});

describe('creating a group (#24 AC5, AC6, AC7)', () => {
  it('connects on Start, shows Loading options until hello.ok, then the allowed methods', async () => {
    const { client } = await renderGroupApp();
    const dialog = openCreate();
    expect(client.count('connect')).toBe(1);
    expect(within(dialog).getByRole('status').textContent).toBe('Loading options…');
    act(() => client.setConnection(connected(['B', 'C'])));
    expect(within(dialog).queryByRole('checkbox', { name: 'QR code' })).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: 'Group code' })).toBeDefined();
    expect(within(dialog).queryByRole('radio', { name: /With a door code/ })).toBeNull();
  });

  it('creates with no choices: the metadata unchanged, the current page, the defaults', async () => {
    const { client, storage } = await renderGroupApp();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    act(() => client.setConnection(connected(['A', 'B', 'C', 'D'], 'frozen')));
    const dialog = openCreate();
    expect(within(dialog).getByRole('radio', { name: /Pause the group/ })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(dialog).getByText(/After 30 seconds, another member leads/)).toBeDefined();
    await submit(dialog);
    const [metadata, position, options] = client.args('createGroup') as [
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(Object.keys(metadata)).toEqual(['contentId', 'fingerprint', 'schemaVersion']);
    expect(metadata['contentId']).toBe('samples/pride-and-prejudice-en');
    expect(metadata['fingerprint']).toMatch(/^[0-9a-f]{64}$/);
    expect(position).toEqual({ v: 1, pageIndex: 1 });
    expect(options).toEqual({ joinMethods: ['A', 'D'], handoff: 'frozen' });
    void storage;
  });

  it.each([
    ['x'.repeat(33), 'Use 32 characters or fewer.'],
    ['‮evil', 'Remove hidden or special characters from the name.'],
  ])('refuses the name %j before sending', async (name, message) => {
    const { client } = await renderGroupApp();
    act(() => client.setConnection(connected()));
    const dialog = openCreate();
    const field = within(dialog).getByRole('textbox', { name: 'Your name (optional)' });
    fireEvent.change(field, { target: { value: name } });
    await submit(dialog);
    expect(client.count('createGroup')).toBe(0);
    expect(within(dialog).getByText(message)).toBeDefined();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field);
  });

  it('sends a valid name trimmed, and asks for at least one method', async () => {
    const { client } = await renderGroupApp();
    act(() => client.setConnection(connected(['A', 'D'])));
    const dialog = openCreate();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Group code' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /QR code/ }));
    await submit(dialog);
    expect(within(dialog).getByText('Choose at least one way to join.')).toBeDefined();
    expect(client.count('createGroup')).toBe(0);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /QR code/ }));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  Dana ' } });
    await submit(dialog);
    expect(client.args('createGroup')[2]).toEqual({
      joinMethods: ['D'],
      handoff: 'auto',
      displayName: 'Dana',
    });
  });

  it('maps a server name refusal and other errors to messages, keeping the choices', async () => {
    const { client } = await renderGroupApp();
    act(() => client.setConnection(connected()));
    const dialog = openCreate();
    client.impl.createGroup = () => {
      throw new SyncClientError('INVALID_DISPLAY_NAME');
    };
    await submit(dialog);
    expect(
      within(dialog).getByText('Remove hidden or special characters from the name.'),
    ).toBeDefined();
    client.impl.createGroup = () => {
      throw new SyncClientError('CONNECTION_LOST');
    };
    await submit(dialog);
    expect(within(dialog).getByRole('alert').textContent).toBe(
      "Can't reach the group service. Check your connection, then try again.",
    );
    client.impl.createGroup = () => {
      throw new SyncClientError('INTERNAL_ERROR');
    };
    await submit(dialog);
    expect(within(dialog).getByRole('alert').textContent).toBe(
      "Couldn't start the group. Try again.",
    );
  });

  it('shows the ready view, the strip and stores the pointer', async () => {
    const { client, storage } = await renderGroupApp();
    await createAsLeader(client);
    const ready = screen.getByRole('dialog', { name: 'Your group is ready' });
    expect(within(ready).getByRole('img', { name: 'Group code: 4 8 2 9 1 3' })).toBeDefined();
    expect(within(ready).getByRole('img', { name: 'Door code: 2 0 5 1 1 8' })).toBeDefined();
    expect(JSON.parse(storage.getItem(POINTER_KEY)!)).toEqual({
      v: 1,
      groupId: GROUP_ID,
      mode: 'following',
      ack: null,
      qrShown: true,
    });
    fireEvent.click(within(ready).getByRole('button', { name: 'Start reading' }));
    const strip = screen.getByRole('region', { name: 'Group codes' });
    expect(within(strip).getByRole('img', { name: 'Group code: 4 8 2 9 1 3' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Leading, group options' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe("You're leading the group.");
  });
});

describe('codes on screen (#24 AC8, AC13)', () => {
  it.each([
    [
      'A',
      { generation: 1, groupCode: '482913', doorCode: '205118' },
      ['Group code: 4 8 2 9 1 3', 'Door code: 2 0 5 1 1 8'],
    ],
    ['B', { generation: 1, groupCode: '482913' }, ['Group code: 4 8 2 9 1 3']],
    ['C', { generation: 1, alphaCode: 'K7MQ9XPR' }, ['Code: K 7 M Q 9 X P R']],
    [
      'A+C',
      { generation: 1, groupCode: '482913', doorCode: '205118', alphaCode: 'K7MQ9XPR' },
      ['Group code: 4 8 2 9 1 3', 'Door code: 2 0 5 1 1 8', 'Code: K 7 M Q 9 X P R'],
    ],
  ])('strip for %s shows every code, grouped and LTR', async (_m, codes, names) => {
    const { client } = await renderGroupApp();
    await createAsLeader(client, ['A'], codes);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    const strip = screen.getByRole('region', { name: 'Group codes' });
    for (const name of names) {
      const code = within(strip).getByRole('img', { name });
      expect(code.getAttribute('dir')).toBe('ltr');
      expect(code.textContent).not.toContain(' ');
    }
  });

  it('D only says people join with the QR code', async () => {
    const { client } = await renderGroupApp();
    await createAsLeader(client, ['D'], { generation: 1 });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(
      within(screen.getByRole('region', { name: 'Group codes' })).getByText(
        'People join with the QR code',
      ),
    ).toBeDefined();
  });

  it('uses the Group panel from 1024 px instead of the strip', async () => {
    largeScreen();
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Group codes' })).toBeNull();
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    expect(within(panel).getByRole('img', { name: 'Group code: 4 8 2 9 1 3' })).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Get new codes' })).toBeDefined();
  });

  it('removes strip, panel and codes when the lead is lost', async () => {
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('region', { name: 'Group codes' })).toBeDefined();
    act(() => client.patchGroup({ role: 'member' }));
    expect(screen.queryByRole('region', { name: 'Group codes' })).toBeNull();
    expect(screen.queryByRole('img', { name: /code:/ })).toBeNull();
  });
});

describe('codes changes, rotation and pause (#24 AC9-AC11)', () => {
  it.each([
    ['rotated', 'New codes are ready. The old ones no longer work.'],
    [
      'door_failures',
      "Someone entered a wrong door code too many times, so there's a new door code.",
    ],
    ['member_removed', 'The codes changed after someone was removed.'],
    ['superseded', "The group's codes changed."],
    ['resumed', 'Your group was restarted with new codes.'],
  ] as const)('says why the codes changed (%s), announced', async (reason, text) => {
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    const codes = { ...CODES, generation: 2, doorCode: '999111' };
    act(() => {
      client.codes = codes;
      client.emit('codesChanged', { groupId: GROUP_ID, codes, reason });
    });
    expect(screen.getAllByRole('status').some((el) => el.textContent === text)).toBe(true);
    expect(screen.getByRole('img', { name: 'Door code: 9 9 9 1 1 1' })).toBeDefined();
  });

  it('is silent for created', async () => {
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    act(() => client.emit('codesChanged', { groupId: GROUP_ID, codes: CODES, reason: 'created' }));
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('rotates after a confirmation; a failure keeps the old codes', async () => {
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    const ready = screen.getByRole('dialog', { name: 'Your group is ready' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Get new codes' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Get new codes?' });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    client.impl.rotateCodes = () => {
      throw new SyncClientError('CONNECTION_LOST');
    };
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Get new codes' }));
      await Promise.resolve();
    });
    expect(within(confirm).getByRole('alert').textContent).toBe(
      "Couldn't get new codes. The current ones still work. Try again.",
    );
    expect(client.count('rotateCodes')).toBe(1);
    expect(screen.getAllByRole('img', { name: 'Group code: 4 8 2 9 1 3' }).length).toBeGreaterThan(
      0,
    );
  });

  it('shows the door-code pause with its countdown, then that it works again', async () => {
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    act(() => client.emit('joinPaused', { groupId: GROUP_ID, retryAfterMs: 299_000 }));
    expect(
      screen.getByText(
        (_, el) => el?.textContent === 'Joining with the door code is paused. 4:59 left.',
      ),
    ).toBeDefined();
    act(() => client.emit('joinResumed', { groupId: GROUP_ID }));
    expect(screen.queryByText(/is paused/)).toBeNull();
    expect(screen.getAllByText('Joining with the door code works again.').length).toBeGreaterThan(
      0,
    );
  });
});

describe('ending (#24 AC32)', () => {
  it('ends after a confirmation and forgets the pointer', async () => {
    const { client, storage } = await renderGroupApp();
    await createAsLeader(client);
    const ready = screen.getByRole('dialog', { name: 'Your group is ready' });
    fireEvent.click(within(ready).getByRole('button', { name: 'End group' }));
    const confirm = screen.getByRole('alertdialog', { name: 'End the group for everyone?' });
    client.impl.endGroup = () => {
      client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'left' });
    };
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'End group' }));
      await Promise.resolve();
    });
    expect(client.count('endGroup')).toBe(1);
    expect(storage.getItem(POINTER_KEY)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Group codes' })).toBeNull();
  });
});

describe('codes in the Hebrew interface (#24 AC18, AC50)', () => {
  it('keeps codes left to right inside the RTL strip', async () => {
    const { render: renderStrip } = await import('@testing-library/react');
    const { CodeStrip } = await import('../src/components/group/LeaderViews.js');
    const { I18nProvider } = await import('../src/i18n/index.js');
    renderStrip(
      <I18nProvider lang="he">
        <CodeStrip codes={CODES} pausedUntil={null} />
      </I18nProvider>,
    );
    const strip = screen.getByRole('region', { name: 'קודי הקבוצה' });
    const code = within(strip).getByRole('img', { name: 'קוד קבוצה: 4 8 2 9 1 3' });
    expect(code.getAttribute('dir')).toBe('ltr');
    expect(within(strip).getByText('כניסה')).toBeDefined();
  });
});
