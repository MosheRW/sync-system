import { z } from 'zod';

// zod compiles fast paths with `new Function` unless jitless is set. The
// reader's CSP has no 'unsafe-eval' (ADR 0006, C7), so this module switches
// JIT off before any schema is built: every schema module imports `z` from
// here, so ES module order guarantees the setting comes first.
z.config({ jitless: true });

export { z };
