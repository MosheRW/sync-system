import { EndedGroups } from '../src/groups/ended-groups.js';
import { CodeIndex } from '../src/joins/code-index.js';
import { MemoryDoorStates, MemoryEndedGroups } from '../src/storage/memory/memory-state.js';
import { MemoryLiveGroups } from '../src/groups/live-groups.js';
import {
  codeIndexContract,
  doorStateContract,
  endedGroupsContract,
  liveGroupsContract,
} from './contracts/state.js';

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

liveGroupsContract('memory', {
  exactClock: true,
  make: () => {
    let time = 1_700_000_000_000;
    const store = new MemoryLiveGroups(() => time);
    return Promise.resolve({
      store,
      now: () => time,
      advance: (ms: number) => {
        time += ms;
        return Promise.resolve();
      },
      count: (namespace: string) => Promise.resolve(store.count(namespace)),
    });
  },
});
