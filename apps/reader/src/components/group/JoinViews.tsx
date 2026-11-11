import {
  MAX_JOIN_CODE_INPUT_LENGTH,
  classifyJoinCode,
  isDoorCode,
  normalizeJoinCode,
} from '@sync-system/react';
import { type FormEvent, type Ref, forwardRef, useEffect, useId, useRef, useState } from 'react';
import { formatShort, useCountdown } from '../../group/countdown.js';
import { errorText } from '../../group/errors.js';
import type { JoinError } from '../../group/use-join.js';
import { checkDisplayName } from '../../group/names.js';
import { useI18n } from '../../i18n/index.js';
import { CodeDisplay } from './CodeDisplay.js';
import { NameField } from './NameField.js';
import styles from './group.module.css';

export const JOIN_FORM_ID = 'group-join-form';
export const DOOR_FORM_ID = 'group-door-form';

export interface CodeFieldProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  /** `numeric` for digit codes, `text` for letters (design 6.8). */
  keyboard: 'numeric' | 'text';
}

/**
 * A code input (design 6.8, AC18, security R8): always `type="text"`, left
 * to right in both interfaces, the numeric keypad for digit codes, paste
 * accepted as is (spaces and dashes are the client's to drop), the
 * protocol's input cap, and nothing a browser or a spell checker keeps.
 */
export const CodeField = forwardRef(function CodeField(
  { label, hint, value, onChange, error, keyboard }: CodeFieldProps,
  ref: Ref<HTMLInputElement>,
) {
  const id = useId();
  const described = [hint !== undefined ? `${id}-hint` : '', error !== null ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        type="text"
        dir="ltr"
        className={`${styles.input} ${styles.codeInput}`}
        inputMode={keyboard}
        autoCapitalize={keyboard === 'text' ? 'characters' : 'off'}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={MAX_JOIN_CODE_INPUT_LENGTH}
        value={value}
        aria-invalid={error !== null ? 'true' : undefined}
        {...(described !== '' ? { 'aria-describedby': described } : {})}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint !== undefined ? (
        <p id={`${id}-hint`} className={styles.muted}>
          {hint}
        </p>
      ) : null}
      {error !== null ? (
        <p id={`${id}-error`} className={styles.fieldError}>
          {error}
        </p>
      ) : null}
    </div>
  );
});

/** What the join form sends (already checked; the server stays authoritative). */
export interface JoinRequestInput {
  readonly code: string;
  readonly displayName?: string;
}

export interface JoinFormProps {
  code: string;
  onCodeChange: (code: string) => void;
  name: string;
  onNameChange: (name: string) => void;
  /** Letters (C) and digits (A/B) are both allowed: offer the keyboard toggle. */
  lettersToggle: boolean;
  /** Only C is allowed: start on the text keyboard. */
  lettersOnly: boolean;
  /** A server error placed on a field. */
  fieldError: { field: 'code' | 'name'; text: string } | null;
  onSubmit: (input: JoinRequestInput) => void;
}

/** Join a group (design 6.7): one code field, an optional name. */
export function JoinForm({
  code,
  onCodeChange,
  name,
  onNameChange,
  lettersToggle,
  lettersOnly,
  fieldError,
  onSubmit,
}: JoinFormProps) {
  const { t } = useI18n();
  const [letters, setLetters] = useState(lettersOnly);
  const [errors, setErrors] = useState<{ code: string | null; name: string | null }>({
    code: null,
    name: null,
  });
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent) => {
    // A handler, never a GET submit: a code never reaches the URL (R8).
    event.preventDefault();
    const normalized = normalizeJoinCode(code);
    const codeError =
      normalized === ''
        ? t.codeEmpty
        : classifyJoinCode(normalized) === undefined
          ? t.codeFormat
          : null;
    const nameCheck = checkDisplayName(name);
    setErrors({ code: codeError, name: nameCheck.ok ? null : t[nameCheck.key] });
    if (codeError !== null) {
      codeRef.current?.focus();
      return;
    }
    if (!nameCheck.ok) {
      nameRef.current?.focus();
      return;
    }
    onSubmit({
      code,
      ...(nameCheck.displayName !== undefined ? { displayName: nameCheck.displayName } : {}),
    });
  };

  return (
    <form id={JOIN_FORM_ID} className={styles.stack} noValidate onSubmit={submit}>
      <CodeField
        ref={codeRef}
        label={t.codeLabel}
        hint={t.codeHint}
        value={code}
        onChange={onCodeChange}
        error={errors.code ?? (fieldError?.field === 'code' ? fieldError.text : null)}
        keyboard={letters ? 'text' : 'numeric'}
      />
      {lettersToggle ? (
        <button
          type="button"
          className={styles.textButton}
          onClick={() => {
            setLetters((value) => !value);
            codeRef.current?.focus();
          }}
        >
          {letters ? t.codeDigitsOnly : t.codeHasLetters}
        </button>
      ) : null}
      <NameField
        ref={nameRef}
        value={name}
        onChange={onNameChange}
        error={errors.name ?? (fieldError?.field === 'name' ? fieldError.text : null)}
      />
    </form>
  );
}

export interface DoorFormProps {
  code: string;
  door: string;
  onDoorChange: (door: string) => void;
  error: string | null;
  onChangeCode: () => void;
  onSubmit: (door: string) => void;
}

/** "Enter the door code" (design 6.7, AC14). */
export function DoorForm({
  code,
  door,
  onDoorChange,
  error,
  onChangeCode,
  onSubmit,
}: DoorFormProps) {
  const { t } = useI18n();
  const [localError, setLocalError] = useState<string | null>(null);
  const doorRef = useRef<HTMLInputElement>(null);
  const normalizedCode = normalizeJoinCode(code);
  return (
    <form
      id={DOOR_FORM_ID}
      className={styles.stack}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = normalizeJoinCode(door);
        const problem =
          normalized === '' ? t.doorEmpty : isDoorCode(normalized) ? null : t.doorFormat;
        setLocalError(problem);
        if (problem !== null) {
          doorRef.current?.focus();
          return;
        }
        onSubmit(door);
      }}
    >
      <p className={styles.para}>{t.doorBody}</p>
      <div className={styles.codeRow}>
        <CodeDisplay label={t.groupCodeLabel} code={normalizedCode} />
        <button type="button" className={styles.textButton} onClick={onChangeCode}>
          {t.changeCode}
        </button>
      </div>
      <CodeField
        ref={doorRef}
        label={t.doorCodeLabel}
        value={door}
        onChange={onDoorChange}
        error={localError ?? error}
        keyboard="numeric"
      />
    </form>
  );
}

/** "Waiting for the leader" with the time left (design F3, AC15, AC53). */
export function WaitingBody({ expiresAt }: { expiresAt: number }) {
  const i18n = useI18n();
  const left = useCountdown(expiresAt) ?? 0;
  const [before, after] = i18n.format(i18n.t.waitingTimeLeft, { time: '\u0000' }).split('\u0000');
  return (
    <div className={styles.stack}>
      <p className={styles.para}>{i18n.t.waitingBody}</p>
      <p className={styles.para}>
        {before}
        <bdi dir="ltr">{formatShort(left, i18n)}</bdi>
        {after}
      </p>
    </div>
  );
}

/** Milliseconds left of a server wait (JOIN_PAUSED, RATE_LIMITED), or 0. */
export function useWaitLeft(error: JoinError | null): number {
  return useCountdown(error?.retryAt ?? null) ?? 0;
}

/**
 * A join or create error (design 7.4): `role="alert"`, a next step, the
 * server wait counted down; at 0 it says "You can try again now.". Takes
 * focus when the table says the message gets it.
 */
export function JoinErrorMessage({ error }: { error: JoinError }) {
  const i18n = useI18n();
  const left = useWaitLeft(error);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error.view.focus === 'message' || error.view.focus === 'heading') ref.current?.focus();
  }, [error]);
  const text =
    error.retryAt === null
      ? errorText(error.view, i18n)
      : left > 0
        ? errorText(error.view, i18n, left)
        : i18n.t.canTryNow;
  return (
    <p ref={ref} role="alert" tabIndex={-1} className={styles.formError}>
      {text}
    </p>
  );
}
