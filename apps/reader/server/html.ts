import { type PublicConfig, publicConfig } from '../src/config/schema.js';

/** Placeholder in `index.html` replaced by the config block (ADR 0005 E1). */
export const CONFIG_PLACEHOLDER = '<!--reader-config-->';

/** Characters that could end the `<script>` block or break JS parsers (security C5). */
const UNSAFE_IN_SCRIPT = /[<>&\u{2028}\u{2029}]/gu;

function jsonEscape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/**
 * The public config as JSON that is safe inside `<script>`: after
 * `JSON.stringify`, `<`, `>`, `&`, U+2028 and U+2029 become JSON `\u` escapes
 * (never HTML entities, which are not decoded inside `<script>`). Built from
 * an explicit field list (`publicConfig`), never from the env.
 */
export function serialiseConfig(config: PublicConfig): string {
  return JSON.stringify(publicConfig(config)).replace(UNSAFE_IN_SCRIPT, jsonEscape);
}

/** `index.html` with the config block in place of the placeholder. */
export function renderIndexHtml(template: string, config: PublicConfig): string {
  const at = template.indexOf(CONFIG_PLACEHOLDER);
  if (at === -1 || template.indexOf(CONFIG_PLACEHOLDER, at + 1) !== -1) {
    throw new Error(`index.html must contain ${CONFIG_PLACEHOLDER} exactly once`);
  }
  const block = `<script type="application/json" id="reader-config">${serialiseConfig(config)}</script>`;
  return template.slice(0, at) + block + template.slice(at + CONFIG_PLACEHOLDER.length);
}
