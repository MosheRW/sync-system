import { MAX_DISPLAY_NAME_LENGTH, resolveDisplayName } from '@sync-system/react';
import type { Messages } from '../i18n/en.js';

/** The result of checking an optional display name before sending (#24 AC7). */
export type NameCheck =
  | { readonly ok: true; readonly displayName?: string }
  | { readonly ok: false; readonly key: 'nameTooLong' | 'nameInvalidChars' };

/**
 * The client's and server's own rule (`resolveDisplayName`, #13 AC35):
 * blank is a generated name (nothing sent); a refused name is "too long"
 * when its trimmed length is over 32 code points, else "hidden or special
 * characters". Nothing is sent for an invalid name.
 */
export function checkDisplayName(raw: string): NameCheck {
  const resolved = resolveDisplayName(raw);
  if (resolved.ok)
    return resolved.generated ? { ok: true } : { ok: true, displayName: resolved.name };
  return {
    ok: false,
    key: [...raw.trim()].length > MAX_DISPLAY_NAME_LENGTH ? 'nameTooLong' : 'nameInvalidChars',
  };
}

const GUEST = /^Guest ([1-9][0-9]{0,5})$/;

/**
 * How to show this user's own group name (#24 D5): a server-generated
 * `Guest N` is localised ("אורח 3"); any other name is plain text as given
 * (render it through `PlainText`, AC51).
 */
export function ownNameText(
  name: string,
  generated: boolean,
  t: Messages,
  format: (template: string, values: Record<string, string | number>) => string,
): string {
  const match = generated ? GUEST.exec(name) : null;
  return match ? format(t.guestName, { n: Number(match[1]) }) : name;
}

/**
 * How to show a roster entry's name (#25 D6, AC39): a generated name is
 * localised from `guestNumber` ("אורח 3"), or the bare `guestNameUnknown`
 * without one; a chosen name is the text as given, even when it looks like
 * "Guest 3". No pattern match on roster names. Render through `PlainText`.
 */
export function rosterNameText(
  entry: {
    readonly displayName: string;
    readonly generated: boolean;
    readonly guestNumber?: number;
  },
  t: Messages,
  format: (template: string, values: Record<string, string | number>) => string,
): string {
  if (!entry.generated) return entry.displayName;
  return entry.guestNumber !== undefined
    ? format(t.guestName, { n: entry.guestNumber })
    : t.guestNameUnknown;
}

/** Bidi controls a name must not carry into an isolate (#25 R15, L1). */
const BIDI_CONTROLS = /\p{Bidi_Control}/gu;

/**
 * A name for an announcement string (#25 R15): bidi controls dropped, then
 * wrapped in FSI/PDI so it cannot reorder the sentence around it.
 */
export function isolateName(name: string): string {
  return `⁨${name.replace(BIDI_CONTROLS, '')}⁩`;
}
