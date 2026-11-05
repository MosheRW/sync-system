import type { Block, ContentDocument, Page } from '../content/schema.js';
import { blockDir } from '../direction/effective.js';
import styles from './ReadingScreen.module.css';

/** `\r\n` and lone `\r` are line breaks like `\n` (AC33, design.md section 7). */
export function normaliseLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export interface ContentBlockProps {
  doc: ContentDocument;
  page: Page;
  block: Block;
}

/**
 * One block: its own element with an explicit effective `dir` (a bidi
 * isolate), its `lang` when known, `text-align: start` and
 * `white-space: pre-line` (AC10, AC11, AC14, AC33). The text is a React
 * child, never HTML (AC4).
 */
export function ContentBlock({ doc, page, block }: ContentBlockProps) {
  const dir = blockDir(doc, page, block);
  const lang = block.lang ?? page.lang;
  const text = normaliseLineBreaks(block.text);
  if (block.type === 'heading') {
    return (
      <h2 className={`${styles.block} ${styles.heading}`} dir={dir} lang={lang}>
        {text}
      </h2>
    );
  }
  return (
    <p className={styles.block} dir={dir} lang={lang}>
      {text}
    </p>
  );
}

/** The blocks of one page. `lang` is inherited from the article, so only overrides are set. */
export function PageView({ doc, page }: { doc: ContentDocument; page: Page }) {
  return (
    <div className={styles.page} lang={page.lang}>
      {page.blocks.map((block, i) => (
        <ContentBlock key={i} doc={doc} page={page} block={block} />
      ))}
    </div>
  );
}
