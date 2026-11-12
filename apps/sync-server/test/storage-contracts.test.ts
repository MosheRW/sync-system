import { EndedGroups } from '../src/groups/ended-groups.js';
import { CodeIndex } from '../src/joins/code-index.js';
import { MemoryDoorStates, MemoryEndedGroups } from '../src/storage/memory/memory-state.js';
import { codeIndexContract, doorStateContract, endedGroupsContract } from './contracts/state.js';

codeIndexContract('memory', {
  make: () => {
    const index = new CodeIndex();
    return Promise.resolve({ index, count: () => Promise.resolve(index.size) });
  },
});

endedGroupsContract('memory', {
  make: (cap) => {
    let time = 1_000;
    const warnings: object[] = [];
    const groups = new EndedGroups(() => time, { warn: (obj) => warnings.push(obj) }, cap);
    return Promise.resolve({
      ended: new MemoryEndedGroups(groups),
      warnings,
      advance: (ms: number) => {
        time += ms;
      },
      size: () => Promise.resolve(groups.size),
    });
  },
});

doorStateContract('memory', { make: () => Promise.resolve(new MemoryDoorStates()) });
