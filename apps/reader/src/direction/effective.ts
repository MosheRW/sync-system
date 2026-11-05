import type { Block, ContentDocument, Direction, Page } from '../content/schema.js';
import { firstStrongDirection } from './first-strong.js';

/** The default when nothing sets a direction (Gate 1 Q9). */
export const DEFAULT_DIRECTION: Direction = 'ltr';

/** The document direction: decides page-turn mapping (AC13). */
export function documentDir(doc: Pick<ContentDocument, 'dir'>): Direction {
  return doc.dir ?? DEFAULT_DIRECTION;
}

export function pageDir(doc: Pick<ContentDocument, 'dir'>, page: Pick<Page, 'dir'>): Direction {
  return page.dir ?? documentDir(doc);
}

/**
 * A block's effective direction (AC10, AC11): block, else page, else
 * document, else `ltr`. `auto` takes the first strong character of the
 * block's own text and falls back to the page direction when there is none.
 */
export function blockDir(
  doc: Pick<ContentDocument, 'dir'>,
  page: Pick<Page, 'dir'>,
  block: Pick<Block, 'dir' | 'text'>,
): Direction {
  if (block.dir === 'auto') return firstStrongDirection(block.text) ?? pageDir(doc, page);
  return block.dir ?? pageDir(doc, page);
}

/** The language that applies to a block, if any level declares one. */
export function effectiveLang(
  doc: Pick<ContentDocument, 'lang'>,
  page?: Pick<Page, 'lang'>,
  block?: Pick<Block, 'lang'>,
): string | undefined {
  return block?.lang ?? page?.lang ?? doc.lang;
}
