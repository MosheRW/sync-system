import type { ReactNode } from 'react';
import { AUTO_HIDE_MS, autoHides, bannerText, bannerTone } from '../../group/banners.js';
import type { BannerSlot as Slot } from '../../group/use-banner-slot.js';
import { useI18n } from '../../i18n/index.js';
import { NoticeBar } from './controls.js';

/**
 * What the banner slot shows (#25 architecture 6.2 rule 5, design 2.3): the
 * ended notice wins; else the preview banner while previewing (queued
 * banners wait, their auto-hide clock doesn't run); else the current banner.
 * Banners never take focus, except the Dismiss of a notice that explains
 * why the focused part closed (design 2.5).
 */
export function BannerSlot({
  slot,
  preview = null,
  onDismissed,
}: {
  slot: Slot;
  /** The preview banner while previewing (a mode, row 2). */
  preview?: ReactNode;
  /** After Dismiss: focus goes to the article (design 6.9). */
  onDismissed: () => void;
}) {
  const { t } = useI18n();
  const banner = slot.shown;
  if (banner === null || (banner.row !== 1 && preview !== null)) return <>{preview}</>;
  const focus = 'focus' in banner && banner.focus === true;
  return (
    <NoticeBar
      key={banner.id}
      tone={bannerTone(banner)}
      dismissLabel={t.dismiss}
      autoFocus={focus}
      {...(autoHides(banner)
        ? { autoHideMs: AUTO_HIDE_MS, onAutoHide: () => slot.expire(banner.id) }
        : {})}
      onDismiss={() => {
        slot.dismiss(banner.id);
        onDismissed();
      }}
    >
      {t[bannerText(banner)]}
    </NoticeBar>
  );
}
