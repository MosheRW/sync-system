import { isContentId } from '../content/content-id.js';
import type { ContentError } from '../content/errors.js';
import { isRetryable } from '../content/errors.js';
import { QUOTE_MAX_LENGTH } from '../content/limits.js';
import type { I18n } from '../i18n/index.js';
import { PlainText } from './PlainText.js';
import type { StatusView } from './StatusScreen.js';

/** Everything that ends on a status screen instead of the reading screen. */
export type StatusInput =
  | { kind: 'content-error'; error: ContentError }
  | { kind: 'book-not-found'; contentId: string | null }
  | { kind: 'no-book' }
  | { kind: 'invalid-link' }
  | { kind: 'not-configured'; syncInvalid?: boolean };

function formatBytes(i18n: I18n, bytes: number): string {
  const mib = 1024 * 1024;
  if (bytes >= mib && bytes % mib === 0) return i18n.format('{n} MB', { n: bytes / mib });
  return i18n.format('{n} KB', { n: Math.ceil(bytes / 1024) });
}

/** A label followed by an untrusted value, isolated and truncated (security C6). */
function labelled(label: string, value: string) {
  return (
    <>
      {label} <PlainText text={value} dir="ltr" maxLength={QUOTE_MAX_LENGTH} />
    </>
  );
}

function supportedText(i18n: I18n, min: number, max: number): string {
  return min === max ? i18n.format('{n}', { n: min }) : i18n.format('{a}-{b}', { a: min, b: max });
}

/**
 * Copy, actions and details for each status (design.md 8 and 8a,
 * architecture.md 6.4). `libraryOn` is the deployment's library setting:
 * library links appear only when it is on (AC28, AC31).
 */
export function statusView(input: StatusInput, i18n: I18n, libraryOn: boolean): StatusView {
  const { t } = i18n;
  const back = libraryOn ? 'secondary' : null;
  const go = libraryOn ? 'primary' : null;

  switch (input.kind) {
    case 'book-not-found':
      return {
        heading: t.bookNotFoundHeading,
        body: t.bookNotFoundBody,
        tone: 'neutral',
        retry: false,
        libraryLink: go,
        details:
          input.contentId !== null ? labelled(t.bookIdLabel, input.contentId) : t.bookIdInvalid,
      };
    case 'no-book':
      return {
        heading: t.noBookHeading,
        body: t.noBookBody,
        tone: 'neutral',
        retry: false,
        libraryLink: go,
        details: t.noBookDetails,
      };
    case 'invalid-link':
      return {
        heading: t.invalidLinkHeading,
        body: t.invalidLinkBody,
        tone: 'neutral',
        retry: false,
        libraryLink: go,
        details: t.invalidLinkDetails,
      };
    case 'not-configured':
      return {
        heading: t.notConfiguredHeading,
        body: t.notConfiguredBody,
        tone: 'danger',
        retry: false,
        libraryLink: null,
        // Only the sync settings were refused (#24 AC1, design F0.2).
        ...(input.syncInvalid === true ? { details: t.syncConfigInvalidDetails } : {}),
      };
    case 'content-error':
      return errorView(input.error, i18n, back);
  }
}

function errorView(error: ContentError, i18n: I18n, back: StatusView['libraryLink']): StatusView {
  const { t } = i18n;
  const refused = (body: string, details?: StatusView['details'], heading = t.cantOpenHeading) => ({
    heading,
    body,
    tone: 'danger' as const,
    retry: false,
    libraryLink: back,
    ...(details !== undefined ? { details } : {}),
  });
  const failed = (heading: string, body: string, details: string): StatusView => ({
    heading,
    body,
    tone: 'danger',
    retry: isRetryable(error),
    libraryLink: back,
    details,
  });

  switch (error.kind) {
    case 'network':
      return failed(t.fetchFailedHeading, t.fetchNetworkBody, t.reasonNetwork);
    case 'http':
      return failed(
        t.fetchFailedHeading,
        t.fetchHttpBody,
        i18n.format(t.reasonHttp, { status: String(error.status) }),
      );
    case 'timeout':
      return failed(
        t.timeoutHeading,
        t.timeoutBody,
        error.seconds === 1
          ? t.reasonTimeoutOne
          : i18n.format(t.reasonTimeout, { seconds: error.seconds }),
      );
    case 'too-large':
      return refused(
        t.tooLargeBody,
        i18n.format(t.tooLargeDetails, { size: formatBytes(i18n, error.maxBytes) }),
      );
    case 'src-invalid':
      return refused(t.srcInvalidBody, t.srcInvalidDetails, t.invalidLinkHeading);
    case 'src-not-allowed':
      return refused(
        t.srcNotAllowedBody,
        labelled(t.sourceLabel, error.origin),
        t.cantOpenHereHeading,
      );
    case 'crypto-unavailable':
      return {
        ...refused(t.cryptoBody, t.cryptoDetails, t.cantOpenHereHeading),
        libraryLink: null,
      };
    case 'invalid-json':
      return refused(t.invalidContentBody, t.invalidJson);
    case 'invalid-content': {
      const text = error.path ? `${error.path}: ${error.detail}` : error.detail;
      return refused(t.invalidContentBody, <PlainText text={text} dir="ltr" lang="en" />);
    }
    case 'schema-version-missing':
      return refused(t.notReadingFileBody, t.missingSchemaVersion);
    case 'schema-version-invalid':
      return refused(t.notReadingFileBody, t.invalidSchemaVersion);
    case 'schema-version-unsupported': {
      const details = i18n.format(t.schemaVersionDetails, {
        version: error.version,
        supported: supportedText(i18n, error.min, error.max),
      });
      return error.version > error.max
        ? refused(t.tooNewBody, details, t.tooNewHeading)
        : refused(t.tooOldBody, details, t.tooOldHeading);
    }
    case 'not-found':
      return statusView(
        {
          kind: 'book-not-found',
          contentId: isContentId(error.contentId) ? error.contentId : null,
        },
        i18n,
        back !== null,
      );
    case 'aborted':
      return failed(t.fetchFailedHeading, t.fetchNetworkBody, t.reasonNetwork);
  }
}
