import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import styles from './group.module.css';

/**
 * One join code (design 6.4): grouped 3+3 or 4+4 by a CSS gap (no space
 * character, so copying gives the code), left to right in both interfaces,
 * isolated. Screen readers get the characters spelled out ("4 8 2 9 1 3")
 * instead of a number. A changed value flashes briefly (not with reduced
 * motion); the codes notice says why in words.
 */
export function CodeDisplay({
  label,
  spokenLabel = label,
  code,
  large = false,
}: {
  /** The visible label ("Group" in the strip, "Group code" elsewhere). */
  label: string;
  /** The full label for screen readers ("Group code"). */
  spokenLabel?: string;
  code: string;
  large?: boolean;
}) {
  const { t, format } = useI18n();
  const half = code.length === 8 ? 4 : 3;
  const previous = useRef(code);
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    if (previous.current !== code) {
      previous.current = code;
      setChanged((n) => n + 1);
    }
  }, [code]);
  return (
    <span className={styles.codeRow}>
      <span className={styles.codeLabel} aria-hidden="true">
        {label}
      </span>
      <bdi
        key={changed}
        dir="ltr"
        role="img"
        aria-label={format(t.codeSpoken, { label: spokenLabel, spelled: [...code].join(' ') })}
        className={`${styles.code} ${large ? styles.codeLarge : ''} ${changed > 0 ? styles.codeChanged : ''}`}
      >
        <span aria-hidden="true">{code.slice(0, half)}</span>
        <span aria-hidden="true">{code.slice(half)}</span>
      </bdi>
    </span>
  );
}
