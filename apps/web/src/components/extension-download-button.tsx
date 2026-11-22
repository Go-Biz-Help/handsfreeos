'use client';
/**
 * The browser extension's download, one button wherever it's offered (docs/outreach.md, decisions 71 and 189): Social
 * Outreach's setup and its Settings → Your computer, and AI Social Media Content Creator's Settings. HandsFreeOS hands
 * out its own build, zipped into `public/downloads` as this web app builds (apps/extension/scripts/download.mjs).
 * Beside the button: its version, when that version was made (apps/extension/release.json), on the reader's own
 * clock, its size, and where it works; all three come through next.config.ts. A business's own link (Social
 * Outreach's `extensionLink`) opens wherever it lives and says none of that: the copy isn't ours.
 */
import {
  EXTENSION_DOWNLOAD_NAME,
  EXTENSION_DOWNLOAD_PATH,
  EXTENSION_DOWNLOAD_WORDS as W,
} from '@hfos/core/extension-download';
import { Download } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { buttonClassName } from '@/components/ui/button';

/** The build this web app hands out. Read whole: Next.js puts the values in as it builds. */
const VERSION = process.env.HFOS_EXTENSION_VERSION ?? '';
const UPDATED_AT = process.env.HFOS_EXTENSION_UPDATED || null;
const BYTES = Number(process.env.HFOS_EXTENSION_BYTES) || null;
/**
 * The name stays the same from version to version, so a newer zip unzips over the same folder; the version on the end
 * only makes browsers fetch the newer one.
 */
const OURS = `${EXTENSION_DOWNLOAD_PATH}?v=${VERSION}`;

const never = () => () => {};

/** Where the extension downloads from: the business's own link, else HandsFreeOS's build. */
export function extensionHref(link: string | null): string {
  return link ?? OURS;
}

export function ExtensionDownloadButton({
  link = null,
}: {
  /** The business's own link to the zip, when it gave one. */
  link?: string | null;
}) {
  // When it was updated reads on the reader's own clock, so it's written once the page is in their browser: the
  // server's clock is another zone's.
  const here = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  const ours = link === null;
  return (
    // The line always sits under the button, so it looks the same in a wide card and a narrow one.
    <div className="flex flex-col items-start gap-2" data-testid="extension-download">
      <a
        href={extensionHref(link)}
        // Ours downloads as hfos-social.zip; a team's own link opens wherever it lives.
        {...(ours
          ? { download: EXTENSION_DOWNLOAD_NAME }
          : { target: '_blank', rel: 'noopener noreferrer' })}
        className={buttonClassName({})}
        data-testid="extension-download-button"
      >
        <Download className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        {W.download}
      </a>
      {ours ? (
        <span className="text-[12.5px] text-text-3" data-testid="extension-download-about">
          {W.about(VERSION, here ? UPDATED_AT : null, BYTES)}
        </span>
      ) : null}
    </div>
  );
}
