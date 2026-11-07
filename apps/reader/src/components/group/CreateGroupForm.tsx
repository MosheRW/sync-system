import type { CreateGroupOptions, HandoffMode, JoinMethod } from '@sync-system/react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { formatLong } from '../../group/countdown.js';
import { checkDisplayName } from '../../group/names.js';
import { useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import { NameField } from './NameField.js';
import styles from './group.module.css';

export const CREATE_FORM_ID = 'group-create-form';

export interface CreateChoices {
  readonly code: boolean;
  readonly ab: 'A' | 'B';
  readonly alpha: boolean;
  readonly qr: boolean;
  readonly handoff: HandoffMode;
}

/**
 * The defaults (design 6.3): QR on if D is allowed; then one code method,
 * A if allowed, else C, else B. Handoff: the app's default (P1).
 */
export function defaultChoices(
  allowed: readonly JoinMethod[],
  handoff: HandoffMode,
): CreateChoices {
  const has = (m: JoinMethod) => allowed.includes(m);
  const ab: 'A' | 'B' = has('A') ? 'A' : 'B';
  const alpha = !has('A') && has('C');
  const code = has('A') || (!alpha && has('B'));
  return { code, ab, alpha, qr: has('D'), handoff };
}

/** The chosen methods; A and B never together (#10 Q1.3). */
export function chosenMethods(
  choices: CreateChoices,
  allowed: readonly JoinMethod[],
): JoinMethod[] {
  const methods: JoinMethod[] = [];
  if (choices.code && allowed.includes(choices.ab)) methods.push(choices.ab);
  if (choices.alpha && allowed.includes('C')) methods.push('C');
  if (choices.qr && allowed.includes('D')) methods.push('D');
  return methods;
}

export interface CreateGroupFormProps {
  /** `null` until `hello.ok` said which methods the app allows. */
  allowed: readonly JoinMethod[] | null;
  defaultHandoff: HandoffMode;
  graceSeconds: number | null;
  /** The book being shared (title or content ID, as in the library). */
  title: string | undefined;
  contentId: string;
  docDir: 'ltr' | 'rtl';
  docLang: string | undefined;
  /** A server error for the name (`INVALID_DISPLAY_NAME`). */
  nameError: string | null;
  onSubmit: (options: CreateGroupOptions) => void;
}

/** Start a group (design 6.3, AC5-AC7): every choice preselected. */
export function CreateGroupForm(props: CreateGroupFormProps) {
  const { allowed } = props;
  if (allowed === null) return <LoadingOptions />;
  return <CreateGroupFields {...props} allowed={allowed} />;
}

function LoadingOptions() {
  const { t } = useI18n();
  return (
    <p className={styles.qrState} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      {t.loadingOptions}
    </p>
  );
}

function CreateGroupFields({
  allowed,
  defaultHandoff,
  graceSeconds,
  title,
  contentId,
  docDir,
  docLang,
  nameError,
  onSubmit,
}: CreateGroupFormProps & { allowed: readonly JoinMethod[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const id = useId();
  const [choices, setChoices] = useState(() => defaultChoices(allowed, defaultHandoff));
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<{ methods: string | null; name: string | null }>({
    methods: null,
    name: null,
  });
  const nameRef = useRef<HTMLInputElement>(null);
  const firstMethodRef = useRef<HTMLInputElement>(null);
  const set = (change: Partial<CreateChoices>) => setChoices((c) => ({ ...c, ...change }));
  const has = (m: JoinMethod) => allowed.includes(m);
  const onlyOne = allowed.length === 1;

  const submit = (event: FormEvent) => {
    // A handler, never a GET submit: no code or name can reach the URL (R8).
    event.preventDefault();
    const methods = chosenMethods(choices, allowed);
    const nameCheck = checkDisplayName(name);
    const next = {
      methods: methods.length === 0 ? t.methodsRequired : null,
      name: nameCheck.ok ? null : t[nameCheck.key],
    };
    setErrors(next);
    if (next.methods !== null) {
      firstMethodRef.current?.focus();
      return;
    }
    if (!nameCheck.ok) {
      nameRef.current?.focus();
      return;
    }
    onSubmit({
      joinMethods: methods,
      handoff: choices.handoff,
      ...(nameCheck.displayName !== undefined ? { displayName: nameCheck.displayName } : {}),
    });
  };

  const methodNames: Record<JoinMethod, string> = {
    A: t.methodGroupCode,
    B: t.methodGroupCode,
    C: t.methodC,
    D: t.methodD,
  };

  return (
    <form id={CREATE_FORM_ID} className={styles.stack} noValidate onSubmit={submit}>
      <p className={styles.para}>
        {t.bookLabel}{' '}
        {title !== undefined ? (
          <PlainText text={title} dir={docDir} {...(docLang ? { lang: docLang } : {})} singleLine />
        ) : (
          <PlainText text={contentId} dir="ltr" />
        )}
      </p>

      {onlyOne ? (
        <p className={styles.para}>
          {i18n.format(t.methodsOnly, { method: methodNames[allowed[0]!] })}
        </p>
      ) : (
        <fieldset
          className={styles.fieldset}
          aria-describedby={errors.methods !== null ? `${id}-methods` : undefined}
        >
          <legend className={styles.legend}>{t.methodsLegend}</legend>
          {has('A') || has('B') ? (
            <div className={styles.stack}>
              <label className={styles.option}>
                <input
                  ref={firstMethodRef}
                  type="checkbox"
                  checked={choices.code}
                  onChange={(e) => set({ code: e.target.checked })}
                />
                <span>{t.methodGroupCode}</span>
              </label>
              {has('A') && has('B') ? (
                <div
                  className={`${styles.sub} ${styles.stack}`}
                  role="radiogroup"
                  aria-label={t.methodGroupCode}
                >
                  {(['A', 'B'] as const).map((m) => (
                    <label key={m} className={styles.option}>
                      <input
                        type="radio"
                        name={`${id}-ab`}
                        checked={choices.ab === m}
                        disabled={!choices.code}
                        onChange={() => set({ ab: m })}
                      />
                      <span>
                        {m === 'A' ? t.methodA : t.methodB}
                        <span className={styles.muted}>
                          {' '}
                          {m === 'A' ? t.methodAHint : t.methodBHint}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className={`${styles.sub} ${styles.muted}`}>
                  {has('A') ? t.methodAHint : t.methodBHint}
                </p>
              )}
            </div>
          ) : null}
          {has('C') ? (
            <label className={styles.option}>
              <input
                {...(!has('A') && !has('B') ? { ref: firstMethodRef } : {})}
                type="checkbox"
                checked={choices.alpha}
                onChange={(e) => set({ alpha: e.target.checked })}
              />
              <span>
                {t.methodC}
                <span className={styles.muted}> {t.methodCHint}</span>
              </span>
            </label>
          ) : null}
          {has('D') ? (
            <label className={styles.option}>
              <input
                type="checkbox"
                checked={choices.qr}
                onChange={(e) => set({ qr: e.target.checked })}
              />
              <span>
                {t.methodD}
                <span className={styles.muted}> {t.methodDHint}</span>
              </span>
            </label>
          ) : null}
          {errors.methods !== null ? (
            <p id={`${id}-methods`} className={styles.fieldError}>
              {errors.methods}
            </p>
          ) : null}
        </fieldset>
      )}

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t.handoffLegend}</legend>
        {(['auto', 'frozen'] as const).map((mode) => (
          <label key={mode} className={styles.option}>
            <input
              type="radio"
              name={`${id}-handoff`}
              checked={choices.handoff === mode}
              onChange={() => set({ handoff: mode })}
            />
            <span>
              {mode === 'auto' ? t.handoffAuto : t.handoffFrozen}
              <span className={styles.muted}>
                {' '}
                {mode === 'frozen'
                  ? t.handoffFrozenHint
                  : graceSeconds !== null
                    ? i18n.format(t.handoffAutoHintTime, {
                        time: formatLong(graceSeconds * 1000, i18n),
                      })
                    : t.handoffAutoHint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <NameField ref={nameRef} value={name} onChange={setName} error={errors.name ?? nameError} />
    </form>
  );
}
