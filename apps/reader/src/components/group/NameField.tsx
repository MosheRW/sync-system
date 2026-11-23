import { MAX_DISPLAY_NAME_INPUT_LENGTH } from '@mosherw/sync-system-react';
import { type Ref, forwardRef, useId } from 'react';
import { useI18n } from '../../i18n/index.js';
import styles from './group.module.css';

/**
 * The optional display name (design 6.17, AC7): `maxlength` is the
 * protocol's input cap (larger than 32, so a long paste is explained rather
 * than cut), `dir="auto"`. The error, when any, is linked to the field.
 */
export const NameField = forwardRef(function NameField(
  {
    value,
    onChange,
    error,
  }: { value: string; onChange: (value: string) => void; error: string | null },
  ref: Ref<HTMLInputElement>,
) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {t.nameLabel}
      </label>
      <input
        ref={ref}
        id={id}
        type="text"
        className={styles.input}
        dir="auto"
        autoComplete="nickname"
        maxLength={MAX_DISPLAY_NAME_INPUT_LENGTH}
        value={value}
        aria-invalid={error !== null ? 'true' : undefined}
        aria-describedby={`${id}-hint${error !== null ? ` ${id}-error` : ''}`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className={styles.muted}>
        {t.nameHint}
      </p>
      {error !== null ? (
        <p id={`${id}-error`} className={styles.fieldError}>
          {error}
        </p>
      ) : null}
    </div>
  );
});
