// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const e2e = workflow.slice(workflow.indexOf('\n  e2e:'));

describe('CI e2e job (#24 ADR 0008, security R11, L5)', () => {
  it('exists, separate from check, and runs the reader e2e suite after a build', () => {
    expect(e2e).toContain('runs-on: ubuntu-latest');
    expect(e2e).toContain('timeout-minutes: 15');
    expect(e2e).toContain('run: pnpm build');
    expect(e2e).toContain('playwright install --with-deps chromium');
    expect(e2e).toContain('test:e2e');
  });

  it('keeps the token read-only, no secrets, no credentials, no uploads', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toMatch(/secrets\./);
    expect(e2e).toContain('persist-credentials: false');
    expect(e2e).not.toContain('upload-artifact');
  });
});
