import type { QrTicketState } from '@sync-system/react';
// The only lean-qr import, from its main entry (ADR 0007, security R10): no
// extras, whose helpers build data URLs and HTML strings.
import { correction, generate } from 'lean-qr';
import { useMemo } from 'react';
import { useI18n } from '../../i18n/index.js';
import styles from './group.module.css';

/** Modules of quiet zone around the code (camera apps need it). */
const QUIET = 4;

/**
 * One SVG path `d` for the dark modules: one rectangle per run of dark
 * modules in a row. `null` when the link doesn't fit a QR code.
 */
export function qrPath(text: string): { size: number; d: string } | null {
  let code;
  try {
    code = generate(text, { minCorrectionLevel: correction.M });
  } catch {
    return null;
  }
  const { size } = code;
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (!code.get(x, y)) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && code.get(x, y)) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  }
  return { size, d: parts.join('') };
}

export interface QrCodeViewProps {
  state: QrTicketState;
  /** Builds the deep link for a ticket; `null` when no link can be made. */
  linkFor: (ticket: string) => string | null;
  /** The leader is reconnecting: the QR refreshes when back (design 6.6). */
  offline: boolean;
  /** The group also has typed codes (decides the error wording). */
  hasCodes: boolean;
}

/**
 * The leader's QR code (#24 AC12, ADR 0007): React SVG elements only (no
 * `data:` URL, no markup string, no `style=` attribute; R12), dark on light
 * with a 4-module quiet zone in both themes (D1). The accessible name says
 * what it is, never the link or the ticket (R3).
 */
export function QrCodeView({ state, linkFor, offline, hasCodes }: QrCodeViewProps) {
  const { t } = useI18n();
  const ticket =
    state.status === 'ready' || state.status === 'loading' || state.status === 'error'
      ? state.ticket
      : null;
  const link = ticket !== null ? linkFor(ticket.ticket) : null;
  const path = useMemo(() => (link !== null ? qrPath(link) : null), [link]);
  const failed = state.status === 'unavailable' || (link !== null && path === null);

  if (offline) return <p className={styles.qrState}>{t.qrOffline}</p>;
  if (failed || (state.status === 'error' && path === null) || (ticket !== null && link === null)) {
    return <p className={styles.qrState}>{hasCodes ? t.qrError : t.qrErrorOnly}</p>;
  }
  if (path === null) {
    return (
      <p className={styles.qrState} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        {t.qrLoading}
      </p>
    );
  }
  const box = path.size + 2 * QUIET;
  return (
    <div className={styles.qrBox}>
      <svg
        role="img"
        aria-label={t.qrImageName}
        className={styles.qrSvg}
        viewBox={`${-QUIET} ${-QUIET} ${box} ${box}`}
        shapeRendering="crispEdges"
      >
        <rect x={-QUIET} y={-QUIET} width={box} height={box} className={styles.qrLight} />
        <path d={path.d} className={styles.qrDark} />
      </svg>
    </div>
  );
}
