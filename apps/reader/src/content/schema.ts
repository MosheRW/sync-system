import { contentIdIssue, describeContentIdIssue } from './content-id.js';
import { CONTENT_LIMITS } from './limits.js';
import { z } from './zod.js';

/** BCP 47 syntax (not registry) check, ADR 0004. */
export const LANG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/** A lone UTF-16 surrogate: not I-JSON (RFC 8785), refused (security F8). */
const LONE_SURROGATE = /[\u{D800}-\u{DFFF}]/u;

export function isWellFormedText(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

const WELL_FORMED = { message: 'contains a lone surrogate (invalid Unicode)' };

const lang = z.string().max(CONTENT_LIMITS.langLength).regex(LANG_PATTERN);
const pageDir = z.enum(['ltr', 'rtl']);
const blockDir = z.enum(['ltr', 'rtl', 'auto']);

const contentId = z.string().superRefine((value, ctx) => {
  const issue = contentIdIssue(value);
  if (issue) {
    ctx.addIssue({
      code: 'custom',
      message: describeContentIdIssue(issue),
      params: { contentIdIssue: issue },
    });
  }
});

export const blockSchema = z.strictObject({
  text: z.string().max(CONTENT_LIMITS.textLength).refine(isWellFormedText, WELL_FORMED),
  dir: blockDir.optional(),
  lang: lang.optional(),
  type: z.enum(['paragraph', 'heading']).optional(),
});

export const pageSchema = z.strictObject({
  dir: pageDir.optional(),
  lang: lang.optional(),
  blocks: z.array(blockSchema).min(1).max(CONTENT_LIMITS.blocksPerPage),
});

/** Content schema v1 (ADR 0004): strict at every level (C1, security C4). */
export const contentSchemaV1 = z.strictObject({
  schemaVersion: z.literal(1),
  contentId,
  title: z
    .string()
    .min(1)
    .max(CONTENT_LIMITS.titleLength)
    .refine(isWellFormedText, WELL_FORMED)
    .optional(),
  lang: lang.optional(),
  dir: pageDir.optional(),
  pages: z.array(pageSchema).min(1).max(CONTENT_LIMITS.pages),
});

export type ContentDocument = z.infer<typeof contentSchemaV1>;
export type Page = ContentDocument['pages'][number];
export type Block = Page['blocks'][number];
export type Direction = 'ltr' | 'rtl';
export type BlockDirection = Direction | 'auto';
