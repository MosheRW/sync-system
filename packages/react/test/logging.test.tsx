import { SyncClientError } from '@sync-system/client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/index.js';
import { AllHooks } from './helpers/all-hooks.js';
import { CONNECTED, FakeSyncClient } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Runs every action once, with failures, so no code path is skipped. */
function Actions({ out }: { out: { run?: () => Promise<void> } }): ReactNode {
  const create = api.useCreateGroup();
  const byCode = api.useJoinByCode();
  const byQr = api.useJoinByQr();
  const approval = api.useJoinApproval();
  const stored = api.useStoredGroups();
  const codes = api.useLeaderCodes();
  const requests = api.useJoinRequests();
  const vice = api.useViceLeader();
  const lock = api.useGroupLock();
  const removal = api.useMemberRemoval();
  const keepAlive = api.useKeepAlive();
  const leadership = api.useLeadership();
  const exit = api.useGroupExit();
  const position = api.usePosition();
  const preview = api.usePreview();
  const qr = api.useQrTicket();
  out.run = async () => {
    await create.run({ title: 'secret-metadata' });
    await byCode.run('123456', { doorCode: '654321' });
    await byQr.run('secret-ticket');
    await approval.cancel.run();
    await stored.check.run();
    await stored.resume.run('g-secret');
    await codes.rotate.run();
    await codes.setJoiningEnabled.run(false);
    await requests.approve.run('r-1');
    await requests.deny.run('r-1');
    await vice.setVice.run('p-1');
    await vice.clearVice.run();
    await lock.lock.run();
    await lock.unlock.run();
    await removal.remove.run('p-1');
    await removal.addToBlockList.run(['p-2']);
    await keepAlive.answer.run();
    await leadership.takeBack.run();
    await exit.end.run();
    await exit.leave.run();
    position.updatePosition({ page: 1 });
    preview.start();
    preview.move(2);
    preview.bringGroupHere();
    qr.refresh();
  };
  return null;
}

describe('no logging (AC27)', () => {
  it('a full flow with credentials and errors writes nothing to the console', async () => {
    const spies = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const client = new FakeSyncClient();
    const failure = () =>
      Promise.reject(new SyncClientError('NOT_LEADER', { serverMessage: 'g-secret' }));
    for (const method of [
      'createGroup',
      'joinByCode',
      'joinByQr',
      'cancelJoin',
      'checkTokens',
      'resumeGroup',
      'rotateCodes',
      'lockGroup',
      'unlockGroup',
      'approveJoin',
      'denyJoin',
      'setViceLeader',
      'clearViceLeader',
      'removeMember',
      'addToBlockList',
      'answerKeepAlive',
      'takeBackLeadership',
      'endGroup',
      'leaveGroup',
      'issueQrTicket',
    ] as const) {
      client.impl[method] = failure;
    }
    client.codes = { generation: 1, groupCode: '123456', doorCode: '654321' };
    const out: { run?: () => Promise<void> } = {};
    const view = renderWithProvider(
      <>
        <AllHooks />
        <Actions out={out} />
      </>,
      { client },
    );
    act(() => client.lead('g-secret'));
    act(() => {
      client.emit('codesChanged', { groupId: 'g-secret', codes: client.codes!, reason: 'rotated' });
      client.emit('joinRequested', { groupId: 'g-secret', requestId: 'r-1', expiresAt: 1 });
      client.emit('keepAlive', { groupId: 'g-secret', countdownMs: 1, deadlineAt: 1 });
      client.emit('error', new SyncClientError('RATE_LIMITED'));
      client.emit('nowLeading', { groupId: 'g-secret', reason: 'take_back' });
    });
    await act(async () => {
      await out.run!();
    });
    act(() => client.setConnection(CONNECTED));
    view.unmount();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
