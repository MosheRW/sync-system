// pnpm release:dry-run (#37 AC54, C1). Mirrors the real publish without a
// token: pack:check --out .release-out, then `npm publish <tgz> --dry-run
// --ignore-scripts --access public` for each tarball by its literal expected
// name, in publish order. Never `pnpm -r publish`, never `changeset publish`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLISHED, npmCommand, readManifest, repoRoot, run, tarballName } from './lib.ts';
import { packAndCheck } from './pack-check.ts';

function main(): void {
  const out = join(repoRoot, '.release-out');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  const { problems, integrity } = packAndCheck(out);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`release:dry-run: ${problem}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(join(out, 'INTEGRITY.txt'), `${integrity.join('\n')}\n`);
  const npm = npmCommand();
  for (const pkg of PUBLISHED) {
    const file = tarballName(pkg.name, String(readManifest(pkg.dir).version));
    console.log(`release:dry-run: npm publish ${file} --dry-run`);
    const output = run(
      npm,
      ['publish', join(out, file), '--dry-run', '--ignore-scripts', '--access', 'public'],
      out,
    );
    process.stdout.write(output);
  }
  console.log('release:dry-run: ok (nothing was published)');
  process.stdout.write(readFileSync(join(out, 'INTEGRITY.txt'), 'utf8'));
}

main();
