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
  /** Reserved for item 8 (connection indicator, group controls). Empty in item 7. */
  endSlot?: ReactNode;
}

/**
 * Document title (content, isolated with the document's `dir`/`lang`, line
 * breaks collapsed) and the page counter (interface). No library link or
 * book switcher (AC24, AC36).
 */
export function ReaderHeader({ title, docDir, docLang, index, total, endSlot }: ReaderHeaderProps) {
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
    </header>
  );
}
