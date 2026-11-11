import type { ReactNode } from 'react';
import type { Direction } from '../content/schema.js';
import { useI18n } from '../i18n/index.js';
import { PlainText } from './PlainText.js';
import styles from './ReadingScreen.module.css';

export interface ReaderHeaderProps {
  title: string | undefined;
  docDir: Direction;
  docLang: string | undefined;
  index: number;
  total: number;
  /** The Group button (#24); empty without sync. */
  endSlot?: ReactNode;
  /** A second row inside the sticky header: the leader's code strip (#24 design 4.2). */
  below?: ReactNode;
}

/**
 * Document title (content, isolated with the document's `dir`/`lang`, line
 * breaks collapsed) and the page counter (interface). No library link or
 * book switcher (AC24, AC36).
 */
export function ReaderHeader({
  title,
  docDir,
  docLang,
  index,
  total,
  endSlot,
  below,
}: ReaderHeaderProps) {
  const { t, format } = useI18n();
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <p className={styles.title}>
          {title !== undefined ? (
            <PlainText
              text={title}
              dir={docDir}
              {...(docLang ? { lang: docLang } : {})}
              singleLine
            />
          ) : null}
        </p>
        <p className={styles.counter}>{format(t.pageCounter, { n: index + 1, total })}</p>
        <div className={styles.slot}>{endSlot}</div>
      </div>
      {below}
    </header>
  );
}
