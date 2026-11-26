// pnpm release:dry-run (#37 AC54, C1; #92). Mirrors the real publish without
// a token: pack:check --out .release-out, then, per tarball in publish order,
// asks the npm registry whether that exact `<name>@<version>` exists (#92):
// - 404 (not published): `npm publish <tgz> --dry-run --ignore-scripts
//   --access public` by its literal expected name, as before #92;
// - 200 (published): compares the local tarball's sha512 with the published
//   `dist.integrity`; a difference fails the run;
// - anything else (network error, timeout, other status, bad body): fails the
//   run. A lookup problem never skips a check (fail closed).
// Never `pnpm -r publish`, never `changeset publish`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLISHED,
  npmCommand,
  readManifest,
  readTarball,
  repoRoot,
  run,
  sha512Integrity,
  tarballName,
} from './lib.ts';
import { packAndCheck } from './pack-check.ts';

/**
 * The registry step 4 publishes to. A constant on purpose (#92 C2): no
 * `npm_config_registry`, `.npmrc` or other env can point the check elsewhere.
 */
export const REGISTRY = 'https://registry.npmjs.org';

/** Exact `x.y.z` or `x.y.z-pre`, checked before the version goes into a URL (C3). */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** One `sha512-<base64>` value, nothing else (C6). */
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;

/** Thrown for every failed registry lookup; the message holds no registry text (C8). */
export class RegistryLookupError extends Error {
  override name = 'RegistryLookupError';
}

export type LookupResult = { published: false } | { published: true; integrity: string };

/**
 * `https://registry.npmjs.org/@scope%2Fname/<version>` for one of the
 * published packages (C3). Throws for any other name or an invalid version.
 */
export function registryVersionUrl(name: string, version: string): URL {
  if (!PUBLISHED.some((pkg) => pkg.name === name)) {
    throw new RegistryLookupError(`registry lookup failed: ${name} is not a published package`);
  }
  if (!VERSION.test(version)) {
    throw new RegistryLookupError(`registry lookup for ${name} failed: version is not x.y.z[-pre]`);
  }
  const pathname = `/${name.replace('/', '%2F')}/${version}`;
  const url = new URL(`${REGISTRY}${pathname}`);
  if (url.origin !== REGISTRY || url.pathname !== pathname) {
    throw new RegistryLookupError(`registry lookup for ${name}@${version} failed: unexpected URL`);
  }
  return url;
}

/**
 * The published `dist.integrity` from a registry version document (C6, C7).
 * The body is untrusted: it must be a JSON object naming exactly this
 * `name` and `version`, with one `sha512-<base64>` integrity. Throws otherwise.
 */
export function parsePublishedIntegrity(text: string, name: string, version: string): string {
  const fail = (reason: string): RegistryLookupError =>
    new RegistryLookupError(`registry lookup for ${name}@${version} failed: ${reason}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw fail('invalid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw fail('body is not a JSON object');
  }
  const doc = body as Record<string, unknown>;
  if (doc['name'] !== name) throw fail('body names another package');
  if (doc['version'] !== version) throw fail('body names another version');
  const dist = doc['dist'];
  if (typeof dist !== 'object' || dist === null || Array.isArray(dist)) {
    throw fail('dist is missing');
  }
  const integrity = (dist as Record<string, unknown>)['integrity'];
  if (typeof integrity !== 'string') throw fail('dist.integrity is missing');
  if (!SHA512_INTEGRITY.test(integrity)) throw fail('dist.integrity is not one sha512 value');
  return integrity;
}

/** A safe label for a fetch failure: the error name and code only, never its message (C8). */
function networkReason(error: unknown): string {
  const label = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined;
  const err = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const name = label(err?.name) ?? 'Error';
  const code = label(err?.code) ?? label(err?.cause?.code);
  return code === undefined ? `network error (${name})` : `network error (${name} ${code})`;
}

/** Reads the body as a stream and stops once it passes `MAX_BODY_BYTES` (C5). */
async function readCapped(response: Response, fail: (reason: string) => Error): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw fail('body is over 1 MiB');
  }
  if (response.body === null) return '';
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw fail('body is over 1 MiB');
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw fail('invalid JSON');
  }
}

/**
 * Asks the npm registry whether `<name>@<version>` is published (#92).
 * `{ published: false }` only for a 404, `{ published: true, integrity }` only
 * for a 200 with a valid body; every other outcome throws a
 * `RegistryLookupError` (C1). `fetchImpl` and `env` are for tests.
 */
export async function lookupPublished(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LookupResult> {
  const url = registryVersionUrl(name, version);
  const fail = (reason: string): RegistryLookupError =>
    new RegistryLookupError(`registry lookup for ${name}@${version} failed: ${reason}`);
  if (env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    // L4 (user decision at Gate 2): never read the registry without TLS checks.
    throw fail('NODE_TLS_REJECT_UNAUTHORIZED=0 turns off TLS certificate checks; unset it');
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw fail(networkReason(error));
  }
  if (response.redirected) {
    await response.body?.cancel().catch(() => undefined);
    throw fail('redirected');
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { published: false };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw fail(`HTTP status ${response.status}`);
  }
  let text: string;
  try {
    text = await readCapped(response, fail);
  } catch (error) {
    if (error instanceof RegistryLookupError) throw error;
    throw fail(networkReason(error));
  }
  return { published: true, integrity: parsePublishedIntegrity(text, name, version) };
}

/** One checked tarball in `.release-out`. */
export interface DryRunEntry {
  name: string;
  version: string;
  file: string;
  /** Absolute path of the tarball. */
  path: string;
  /** `sha512-<base64>` of the tarball bytes. */
  integrity: string;
}

export interface DryRunDeps {
  lookup: (name: string, version: string) => Promise<LookupResult>;
  /** Runs `npm` with these arguments (argument array, no shell). */
  publishDryRun: (args: readonly string[]) => void;
  log: (line: string) => void;
}

/**
 * Per package, in the given (publish) order: an unpublished version gets
 * `npm publish --dry-run` as before #92; a published one is compared with
 * the registry's integrity. Returns the mismatches. Lookup errors are not
 * caught: they fail the run (C1).
 */
export async function dryRunPackages(
  entries: readonly DryRunEntry[],
  deps: DryRunDeps,
): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of entries) {
    const result = await deps.lookup(entry.name, entry.version);
    if (!result.published) {
      deps.log(`release:dry-run: npm publish ${entry.file} --dry-run`);
      deps.publishDryRun([
        'publish',
        entry.path,
        '--dry-run',
        '--ignore-scripts',
        '--access',
        'public',
      ]);
    } else if (result.integrity === entry.integrity) {
      deps.log(
        `release:dry-run: ${entry.file}: ${entry.name}@${entry.version} already on npm, integrity matches`,
      );
    } else {
      problems.push(
        `${entry.file}: local ${entry.integrity} differs from the published ` +
          `${result.integrity} of ${entry.name}@${entry.version}`,
      );
    }
  }
  return problems;
}

/** The checked tarballs in `out`, named and looked up by one version string each (C3). */
function releaseEntries(out: string): DryRunEntry[] {
  return PUBLISHED.map((pkg) => {
    const version = String(readManifest(pkg.dir).version);
    const file = tarballName(pkg.name, version);
    const path = join(out, file);
    const bytes = readFileSync(path);
    const packed = readTarball(bytes).find((e) => e.path === 'package/package.json');
    const packedVersion =
      packed === undefined
        ? undefined
        : (JSON.parse(packed.content.toString('utf8')) as { version?: unknown }).version;
    if (packedVersion !== version) {
      throw new Error(`${file}: packed version differs from ${pkg.dir}/package.json`);
    }
    return { name: pkg.name, version, file, path, integrity: sha512Integrity(bytes) };
  });
}

async function main(): Promise<void> {
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
  let mismatches: string[];
  try {
    mismatches = await dryRunPackages(releaseEntries(out), {
      lookup: (name, version) => lookupPublished(name, version),
      publishDryRun: (args) => {
        process.stdout.write(run(npm, args, out));
      },
      log: (line) => console.log(line),
    });
  } catch (error) {
    if (!(error instanceof RegistryLookupError)) throw error;
    console.error(`release:dry-run: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (mismatches.length > 0) {
    for (const problem of mismatches) console.error(`release:dry-run: ${problem}`);
    console.error(
      'release:dry-run: the published tarball differs from this checkout; run it through ' +
        'the step 2 block on the released tag, or bump the version (#92)',
    );
    process.exitCode = 1;
    return;
  }
  console.log('release:dry-run: ok (nothing was published)');
  process.stdout.write(readFileSync(join(out, 'INTEGRITY.txt'), 'utf8'));
}

if (import.meta.main) await main();
