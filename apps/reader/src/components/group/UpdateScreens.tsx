import type { UpdateRequired } from '@sync-system/react';
import { browserNavigation } from '../../group/browser.js';
import { useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import { StatusScreen } from '../StatusScreen.js';

/**
 * "Update the app to use groups" (`APP_VERSION_TOO_OLD`) and "Groups aren't
 * available" (`PROTOCOL_TOO_OLD`, `SERVER_UNSUPPORTED`), design 6.12, AC4.
 * Full screen, never a half-rendered reading screen. **Read without a group**
 * hides every group control for this page load and returns to the book.
 */
export function UpdateScreen({
  update,
  onReadWithoutGroup,
}: {
  update: UpdateRequired;
  onReadWithoutGroup: () => void;
}) {
  const { t, format } = useI18n();
  const readWithout = { label: t.readWithoutGroup, onClick: onReadWithoutGroup };

  if (update.kind === 'app') {
    const min = update.minAppVersion;
    return (
      <StatusScreen
        view={{
          heading: t.updateTitle,
          body: t.updateBody,
          tone: 'neutral',
          retry: false,
          libraryLink: null,
          ...(min !== undefined
            ? {
                details: (
                  <>
                    {format(t.updateDetails, { version: '' }).trimEnd()}{' '}
                    <PlainText text={min} dir="ltr" maxLength={40} />
                  </>
                ),
              }
            : {}),
        }}
        actions={[
          { label: t.reload, onClick: () => browserNavigation.reload(), primary: true },
          readWithout,
        ]}
      />
    );
  }

  const version =
    update.kind === 'protocol' ? update.minProtocolVersion : update.serverProtocolVersion;
  return (
    <StatusScreen
      view={{
        heading: t.serverUnsupportedTitle,
        body: t.serverUnsupportedBody,
        tone: 'neutral',
        retry: false,
        libraryLink: null,
        ...(version !== undefined && Number.isFinite(version)
          ? { details: format(t.serverProtocolDetails, { version }) }
          : {}),
      }}
      actions={[{ ...readWithout, primary: true }]}
    />
  );
}
