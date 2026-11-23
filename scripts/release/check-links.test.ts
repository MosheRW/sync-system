// Unit tests of the docs link check (#37 AC43): a broken file link and a
// broken anchor fail; GitHub URLs of this repo map to local paths.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorsOf, checkFile, linksOf, slugify, type FsLike } from './check-links.ts';

function memoryFs(files: Record<string, string>, dirs: string[] = []): FsLike {
  return {
    kind(path) {
      if (path in files) return 'file';
      if (path === '.' || dirs.includes(path)) return 'dir';
      return undefined;
    },
    read(path) {
      const text = files[path];
      if (text === undefined) throw new Error(`no ${path}`);
      return text;
    },
  };
}

const GUIDE = [
  '# Operator guide',
  '## Config file (registered client apps)',
  '## Fetched content (`?src`)',
  '## Reloads, phone locks and storage',
  '## Notes',
  '## Notes',
  '```md',
  '## Not a heading',
  '[inside code](missing.md)',
  '```',
].join('\n');

describe('slugify and anchors (GitHub rules)', () => {
  it('slugs headings like GitHub', () => {
    assert.equal(
      slugify('Config file (registered client apps)'),
      'config-file-registered-client-apps',
    );
    assert.equal(slugify('Reloads, phone locks and storage'), 'reloads-phone-locks-and-storage');
    assert.equal(slugify('Wire protocol v1'), 'wire-protocol-v1');
  });

  it('numbers duplicates, strips code marks and ignores fenced code', () => {
    const anchors = anchorsOf(GUIDE);
    assert.ok(anchors.has('fetched-content-src'));
    assert.ok(anchors.has('notes'));
    assert.ok(anchors.has('notes-1'));
    assert.ok(!anchors.has('not-a-heading'));
  });

  it('finds inline links outside code', () => {
    assert.deepEqual(
      linksOf('See [a](a.md#x) and `[b](b.md)`.\n```\n[c](c.md)\n```').map((l) => l.target),
      ['a.md#x'],
    );
  });
});

describe('checkFile', () => {
  const fs = memoryFs(
    {
      'README.md': '',
      'docs/guide.md': GUIDE,
      'packages/client/README.md': '# Client\n## QR tickets and deep links\n',
    },
    ['docs', 'packages', 'packages/client'],
  );

  function problems(markdown: string): string[] {
    const withDoc = memoryFs(
      {
        ...{ 'README.md': '', 'docs/guide.md': GUIDE },
        'docs/page.md': markdown,
        'packages/client/README.md': '# Client\n## QR tickets and deep links\n',
      },
      ['docs', 'packages', 'packages/client'],
    );
    return checkFile(withDoc, 'docs/page.md').map((p) => p.problem);
  }

  it('accepts existing files, anchors and same-file anchors', () => {
    assert.deepEqual(
      problems(
        '# Page\n[g](guide.md#config-file-registered-client-apps) [r](../README.md) [s](#page) [d](../packages/client)',
      ),
      [],
    );
  });

  it('fails a broken file link', () => {
    assert.deepEqual(problems('[x](missing.md)'), ['docs/missing.md does not exist']);
  });

  it('fails a broken anchor', () => {
    assert.match(
      problems('[x](guide.md#no-such-heading)').join(),
      /not a heading of docs\/guide\.md/,
    );
    assert.match(problems('# Page\n[x](#nope)').join(), /not a heading of this file/);
  });

  it('fails a link outside the repository', () => {
    assert.deepEqual(problems('[x](../../etc/passwd)'), ['points outside the repository']);
  });

  it('maps GitHub URLs of this repo to local paths, never fetching them', () => {
    const base = 'https://github.com/MosheRW/sync-system';
    assert.deepEqual(
      problems(
        `[a](${base}/blob/main/docs/guide.md) [b](${base}/tree/main/packages/client#readme) ` +
          `[c](${base}/tree/main/packages/client#qr-tickets-and-deep-links) [e](https://example.org/x)`,
      ),
      [],
    );
    assert.deepEqual(problems(`[a](${base}/blob/main/docs/nope.md)`), [
      'docs/nope.md does not exist',
    ]);
    assert.match(problems(`[a](${base}/tree/main/packages/client#nope)`).join(), /not a heading/);
  });

  it('checks the repo file set through checkFile', () => {
    assert.deepEqual(checkFile(fs, 'README.md'), []);
  });
});
