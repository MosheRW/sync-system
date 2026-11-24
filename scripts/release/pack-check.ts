// pnpm pack:check [--out <dir>] (#37 AC50, C4, C10, L10; #53 R1, R2, L4).
// Packs the three published packages and checks each tarball: contents on the
// allow-list, a public-ready package.json, one shared version. Before packing
// it checks the publishable set, at most one workspace: range per dependency
// map of each published package, and that no pnpmfile is in play (#53,
// ADR 0020); any problem stops it before packing. With --out <dir> (created
// empty, must not hold anything) it keeps the checked tarballs there and writes
// <dir>/INTEGRITY.txt, one `<file> sha512-<base64>` line per tarball in
// publish order. These kept tarballs are the only bytes a release publishes.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PUBLISHED,
  checkEntries,
  checkManifest,
  checkNoPnpmfile,
  checkPublishableSet,
  checkSameVersion,
  checkWorkspaceRanges,
  integrityLine,
  packAll,
  readTarball,
  repoRoot,
  workspacePackages,
  type Manifest,
} from './lib.ts';

export interface PackCheckResult {
  problems: string[];
  integrity: string[];
}

/** Packs into `dir` and checks every tarball. */
export function packAndCheck(dir: string): PackCheckResult {
  const packages = workspacePackages();
  const problems = [
    ...checkPublishableSet(packages),
    ...checkWorkspaceRanges(packages),
    ...checkNoPnpmfile(repoRoot, process.env),
  ];
  if (problems.length > 0) return { problems, integrity: [] };
  const files = packAll(dir);
  const manifests: Manifest[] = [];
  const integrity: string[] = [];
  files.forEach((file, index) => {
    const pkg = PUBLISHED[index];
    if (pkg === undefined) return;
    const bytes = readFileSync(join(dir, file));
    const entries = readTarball(bytes);
    const packed = entries.find((e) => e.path === 'package/package.json');
    const manifest = (
      packed === undefined ? {} : JSON.parse(packed.content.toString('utf8'))
    ) as Manifest;
    manifests.push(manifest);
    for (const problem of [...checkEntries(entries), ...checkManifest(manifest, pkg.name)]) {
      problems.push(`${file}: ${problem}`);
    }
    integrity.push(integrityLine(file, bytes));
    console.log(`${file}: ${entries.length} entries`);
  });
  problems.push(...checkSameVersion(manifests));
  return { problems, integrity };
}

function parseOut(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--out');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error('--out needs a directory');
  return resolve(value);
}

function main(): void {
  const out = parseOut(process.argv.slice(2));
  let dir: string;
  if (out === undefined) {
    dir = mkdtempSync(join(tmpdir(), 'sync-pack-check-'));
  } else {
    mkdirSync(out, { recursive: true });
    if (readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
    dir = out;
  }
  try {
    const { problems, integrity } = packAndCheck(dir);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`pack:check: ${problem}`);
      process.exitCode = 1;
      return;
    }
    if (out !== undefined) {
      writeFileSync(join(out, 'INTEGRITY.txt'), `${integrity.join('\n')}\n`);
    }
    console.log('pack:check: ok');
    for (const line of integrity) console.log(line);
  } finally {
    if (out === undefined) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
