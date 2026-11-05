import type { Direction } from '../content/schema.js';
import { useI18n } from '../i18n/index.js';
import { type NavAction, buttonSides } from '../navigation/input-map.js';
import styles from './ReadingScreen.module.css';

export interface PageNavProps {
  docDir: Direction;
  index: number;
  total: number;
  onAction: (action: NavAction) => void;
}

function Chevron({ points }: { points: 'left' | 'right' }) {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={points === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Thin progress bar; fills from the document's start side (design.md section 5). */
export function PageProgress({ docDir, index, total }: Omit<PageNavProps, 'onAction'>) {
  return (
    <progress
      className={styles.progress}
      dir={docDir}
      max={total}
      value={index + 1}
      aria-hidden="true"
    />
  );
}

/**
 * Previous/next buttons positioned by the **document** direction (AC13): in
 * an RTL document "next" is on the left. The bar is laid out physically
 * (`dir="ltr"`), so DOM and tab order equal the visual order; labels are
 * interface strings in the interface direction. Chevrons point in the
 * physical direction of travel. At the ends a button stays focusable with
 * `aria-disabled` and does nothing.
 */
export function PageNav({ docDir, index, total, onAction }: PageNavProps) {
  const { t, dir: uiDir } = useI18n();
  const sides = buttonSides(docDir);

  const button = (side: 'left' | 'right') => {
    const action = sides[side];
    const isNext = action === 'next';
    const disabled = isNext ? index >= total - 1 : index <= 0;
    const label = isNext ? t.next : t.previous;
    return (
      <button
        type="button"
        className={`${styles.navButton} ${side === 'left' ? styles.navLeft : styles.navRight}`}
        aria-label={isNext ? t.nextPage : t.previousPage}
        aria-disabled={disabled ? 'true' : undefined}
        data-action={action}
        onClick={() => {
          if (!disabled) onAction(action);
        }}
      >
        {side === 'left' ? <Chevron points="left" /> : null}
        <span dir={uiDir}>{label}</span>
        {side === 'right' ? <Chevron points="right" /> : null}
      </button>
    );
  };

  return (
    <nav className={styles.nav} aria-label={t.pagesNav}>
      <PageProgress docDir={docDir} index={index} total={total} />
      <div className={styles.navButtons} dir="ltr">
        {button('left')}
        {button('right')}
      </div>
    </nav>
  );
}
