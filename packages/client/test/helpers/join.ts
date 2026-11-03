import type { SyncClient } from '../../src/client.js';
import type { CreatedGroup, JoinedGroup } from '../../src/state.js';

/**
 * Joins `created` by its codes (#10 D11): group code plus door code
 * (method A), the group code (B) or the alphanumeric code (C).
 */
export function joinCreated(client: SyncClient, created: CreatedGroup): Promise<JoinedGroup> {
  const { groupCode, doorCode, alphaCode } = created.codes;
  if (groupCode !== undefined) {
    return client.joinByCode(groupCode, doorCode === undefined ? {} : { doorCode });
  }
  if (alphaCode !== undefined) return client.joinByCode(alphaCode);
  throw new Error('the group has no join code (method D only)');
}
