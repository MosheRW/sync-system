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
