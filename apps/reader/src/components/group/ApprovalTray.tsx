import type { JoinRequest, JoinRequests } from '@sync-system/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import { Button } from './controls.js';
import styles from './group.module.css';

/**
 * A template with one `{name}` filled by a React node (#24 security R7,
 * L9): the name is never substituted into a string, so it is never
 * re-expanded or read as markup.
 */
export function withName(template: string, name: ReactNode): ReactNode {
  const at = template.indexOf('{name}');
  if (at === -1) return template;
  return (
    <>
      {template.slice(0, at)}
      {name}
      {template.slice(at + '{name}'.length)}
    </>
  );
}

/** A name for an accessible label: the raw text, never interpreted. */
function labelWith(template: string, name: string): string {
  const at = template.indexOf('{name}');
  return at === -1 ? template : template.slice(0, at) + name + template.slice(at + 6);
}

function RequestRow({
  request,
  requests,
  registerFocus,
}: {
  request: JoinRequest;
  requests: JoinRequests;
  registerFocus: (id: string, element: HTMLButtonElement | null) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'answering' | 'failed'>('idle');
  const name = request.displayName;
  const nameNode = name !== undefined ? <PlainText text={name} dir="auto" maxLength={64} /> : null;
  const answer = (approve: boolean) => {
    setState('answering');
    const run = approve
      ? requests.approve.run(request.requestId)
      : requests.deny.run(request.requestId);
    void run.then((result) => setState(result.ok ? 'idle' : 'failed'));
  };
  const busy = state === 'answering';
  return (
    <li className={styles.trayRow} data-request-id={request.requestId}>
      <span className={styles.trayName}>
        {nameNode !== null ? withName(t.approvalRequest, nameNode) : t.approvalSomeone}
      </span>
      <Button
        pending={busy}
        aria-label={name !== undefined ? labelWith(t.denyName, name) : t.deny}
        onClick={() => answer(false)}
      >
        {t.deny}
      </Button>
      <Button
        ref={(element) => registerFocus(request.requestId, element)}
        variant="primary"
        pending={busy}
        aria-label={name !== undefined ? labelWith(t.approveName, name) : t.approve}
        onClick={() => answer(true)}
      >
        {t.approve}
      </Button>
      {state === 'failed' ? (
        <p role="alert" className={styles.fieldError}>
          {t.approvalFailed}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Join requests for the leader (#24 AC20, design F9, 6.15): a non-modal
 * region that never takes focus. The oldest request shows; "Show all"
 * lists every one in arrival order. A request that goes away (answered,
 * withdrawn, timed out) disappears; if it had focus, focus moves to the
 * next request's Let in, or back to where it was before the tray.
 */
export function ApprovalTray({
  requests,
  announce,
}: {
  requests: JoinRequests;
  announce: (text: string) => void;
}) {
  const { t, format } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const before = useRef<HTMLElement | null>(null);
  const list = requests.requests;
  const seen = useRef(new Set<string>());

  // A new request is announced once (politely); focus stays where it is.
  useEffect(() => {
    for (const request of list) {
      if (seen.current.has(request.requestId)) continue;
      seen.current.add(request.requestId);
      announce(
        request.displayName !== undefined
          ? labelWith(t.announceRequest, request.displayName)
          : t.approvalSomeone,
      );
    }
  }, [list, announce, t.announceRequest, t.approvalSomeone]);

  // Focus moves on when the request that had it is gone (never to body).
  const ids = list.map((r) => r.requestId).join(' ');
  const previousIds = useRef<string[]>([]);
  const focusedId = useRef<string | null>(null);
  useEffect(() => {
    const now = list.map((r) => r.requestId);
    const lost = focusedId.current;
    if (lost !== null && !now.includes(lost)) {
      focusedId.current = null;
      const index = previousIds.current.indexOf(lost);
      const next = now[Math.min(Math.max(index, 0), now.length - 1)];
      const target = next !== undefined ? buttons.current.get(next) : null;
      if (target) target.focus();
      else before.current?.focus();
    }
    previousIds.current = now;
    // `ids` stands for the list's identity.
  }, [ids, list]);

  if (list.length === 0) return null;
  const shown = expanded ? list : list.slice(0, 1);
  const more = list.length - 1;
  return (
    <div
      role="region"
      aria-label={t.approvalRegion}
      className={styles.card}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const related = event.relatedTarget as HTMLElement | null;
        if (related !== null && !event.currentTarget.contains(related)) before.current = related;
        const row = target.closest<HTMLElement>('[data-request-id]');
        focusedId.current = row?.dataset['requestId'] ?? null;
      }}
    >
      <ul className={styles.trayList}>
        {shown.map((request) => (
          <RequestRow
            key={request.requestId}
            request={request}
            requests={requests}
            registerFocus={(id, element) => {
              if (element) buttons.current.set(id, element);
              else buttons.current.delete(id);
            }}
          />
        ))}
      </ul>
      {more > 0 ? (
        <button type="button" className={styles.textButton} onClick={() => setExpanded((v) => !v)}>
          {expanded
            ? t.showLess
            : `${more === 1 ? t.approvalMoreOne : format(t.approvalMore, { n: more })} · ${t.showAll}`}
        </button>
      ) : null}
    </div>
  );
}
