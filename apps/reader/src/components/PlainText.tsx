import { truncate } from '../content/quote.js';

export interface PlainTextProps {
  text: string;
  dir?: 'ltr' | 'rtl';
  lang?: string;
  /** Truncate to this many characters (code points), with an ellipsis. */
  maxLength?: number;
  /** Collapse line breaks to spaces (titles, design.md section 7). */
  singleLine?: boolean;
}

/**
 * The one way to show external text: content, titles, values from the URL,
 * and later sync display names (AC4, AC18, security C6). The text is a React
 * child, so React escapes it; it is isolated in a `<bdi>` with its own
 * direction and language so it cannot reorder the surrounding interface.
 */
export function PlainText({ text, dir, lang, maxLength, singleLine = false }: PlainTextProps) {
  let shown = singleLine ? text.replace(/\s*[\r\n]+\s*/g, ' ') : text;
  if (maxLength !== undefined) shown = truncate(shown, maxLength);
  return (
    <bdi dir={dir} lang={lang}>
      {shown}
    </bdi>
  );
}
