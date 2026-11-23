// pnpm docs:links (#37 AC43), run inside `pnpm lint`. Checks every Markdown
// file of the repo (not node_modules, build output, .claude, docs/issues or
// the generated changelogs): each relative link target exists, each
// `#fragment` matches a heading of its target, and each
// https://github.com/MosheRW/sync-system/(blob|tree)/main/<path> link maps to
// an existing local path. Nothing is fetched: no network access at all.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { repoRoot } from './lib.ts';

export interface FsLike {
  /** 'file', 'dir' or undefined, for a repo-relative POSIX path. */
  kind(path: string): 'file' | 'dir' | undefined;
  read(path: string): string;
}

export interface LinkProblem {
  file: string;
  line: number;
  target: string;
  problem: string;
}

const REPO_URL =
  /^https:\/\/github\.com\/MosheRW\/sync-system\/(?:blob|tree)\/main\/([^#?]*)(?:#(.*))?$/;

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** The rendered text of a heading: links to their text, no code or emphasis marks. */
function headingText(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** Lines outside fenced code blocks, with their 1-based numbers. */
function proseLines(markdown: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let fence: string | undefined;
  markdown.split(/\r?\n/).forEach((text, index) => {
    const marker = /^\s*(```+|~~~+)/.exec(text)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    if (fence === undefined) out.push({ text, line: index + 1 });
  });
  return out;
}

/** Every anchor a Markdown file offers: heading slugs (GitHub numbering) and HTML ids. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text } of proseLines(markdown)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text)?.[1];
    if (heading !== undefined) {
      const base = slugify(headingText(heading));
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) {
      if (match[1] !== undefined) anchors.add(match[1]);
    }
  }
  return anchors;
}

/** Inline links `[text](target)` and `![alt](target)` outside code, with line numbers. */
export function linksOf(markdown: string): Array<{ target: string; line: number }> {
  const links: Array<{ target: string; line: number }> = [];
  for (const { text, line } of proseLines(markdown)) {
    const prose = text.replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      if (match[1] !== undefined) links.push({ target: match[1], line });
    }
  }
  return links;
}

function checkTarget(
  fs: FsLike,
  file: string,
  path: string,
  fragment: string | undefined,
): string | undefined {
  const kind = fs.kind(path);
  if (kind === undefined) return `${path} does not exist`;
  if (fragment === undefined || fragment === '') return undefined;
  let doc: string | undefined;
  if (kind === 'file' && path.endsWith('.md')) doc = path;
  if (kind === 'dir') {
    if (fragment === 'readme') return undefined;
    const readme = posix.join(path, 'README.md');
    if (fs.kind(readme) === 'file') doc = readme;
  }
  if (doc === undefined) return undefined; // e.g. a line anchor into a source file
  const anchor = decodeURIComponent(fragment).toLowerCase();
  return anchorsOf(fs.read(doc)).has(anchor)
    ? undefined
    : `#${fragment} is not a heading of ${doc === file ? 'this file' : doc}`;
}

/** Checks the links of one Markdown file (repo-relative POSIX path). */
export function checkFile(fs: FsLike, file: string): LinkProblem[] {
  const problems: LinkProblem[] = [];
  for (const { target, line } of linksOf(fs.read(file))) {
    let path: string;
    let fragment: string | undefined;
    const repo = REPO_URL.exec(target);
    if (repo !== null) {
      path = posix.normalize(decodeURIComponent(repo[1] ?? '')).replace(/\/$/, '') || '.';
      fragment = repo[2];
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      continue; // external URL or mailto: never fetched
    } else {
      const hash = target.indexOf('#');
      const rawPath = hash === -1 ? target : target.slice(0, hash);
      fragment = hash === -1 ? undefined : target.slice(hash + 1);
      path =
        rawPath === ''
          ? file
          : posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(rawPath)));
      path = path.replace(/\/$/, '') || '.';
    }
    if (path.startsWith('../')) {
      problems.push({ file, line, target, problem: 'points outside the repository' });
      continue;
    }
    const problem = checkTarget(fs, file, path, fragment);
    if (problem !== undefined) problems.push({ file, line, target, problem });
  }
  return problems;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'coverage',
  'test-results',
  'playwright-report',
  '.release-out',
]);

/** Markdown files to check, repo-relative POSIX paths. */
export function markdownFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('dist')) continue;
        if (rel === 'docs/issues') continue;
        walk(full);
      } else if (entry.name.endsWith('.md') && entry.name !== 'CHANGELOG.md') {
        files.push(rel);
      }
    }
  };
  walk(root);
  return files.sort();
}

export function repoFs(root: string): FsLike {
  return {
    kind(path) {
      const full = join(root, path);
      if (!existsSync(full)) return undefined;
      return statSync(full).isDirectory() ? 'dir' : 'file';
    },
    read(path) {
      return readFileSync(join(root, path), 'utf8');
    },
  };
}

function main(): void {
  const fs = repoFs(repoRoot);
  const files = markdownFiles(repoRoot);
  const problems = files.flatMap((file) => checkFile(fs, file));
  for (const p of problems) {
    console.error(`${p.file}:${p.line}: ${p.target}: ${p.problem}`);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`docs:links: ${files.length} Markdown files, every link resolves`);
}

if (import.meta.main) main();
