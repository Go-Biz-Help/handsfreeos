/**
 * The browser extension's download, said the same wherever HandsFreeOS offers it (docs/outreach.md, decision 189; the
 * owner, 22 Nov 2026: "make the download buttons looks the same and also add the version number and the date and time
 * it was last updated … also add the version number at the top of the extension screen"). One extension works for
 * Social Outreach and for AI Social Media Content Creator, so these words belong to neither add-on:
 *
 * - the web's one button reads them (apps/web/src/components/extension-download-button.tsx);
 * - each add-on's own words name the button by them, so what they say to press is what the button says;
 * - the extension's panel says its version the same way at its top (apps/extension/src/panel/version.ts), so the two
 *   can be held side by side.
 *
 * Browser-safe, and no zod, so the extension stays small.
 */
import { formatDate } from './crm/format';

/**
 * Where HandsFreeOS's own build of the extension downloads from, on the web app's address (decision 71). The same
 * name every version, so a newer zip unzips over the same folder.
 */
export const EXTENSION_DOWNLOAD_PATH = '/downloads/hfos-social.zip';
/** The name it downloads under. */
export const EXTENSION_DOWNLOAD_NAME = 'hfos-social.zip';

/** "Version 0.151.0": beside the download, and at the top of the extension's panel. */
export const extensionVersionWords = (version: string): string => `Version ${version}`;

export const EXTENSION_DOWNLOAD_WORDS = {
  download: 'Download HandsFreeOS Social',
  /**
   * Beside the button: which version, when that version was made, how big, and where it works. The moment reads on
   * the device's own clock ("Nov 22, 1:20 AM", with the year in another one), so pass `updatedAt` only in the
   * person's browser; without it, or without a size, that part is left out.
   */
  about: (
    version: string,
    updatedAt: string | null,
    bytes: number | null,
    now: Date = new Date(),
  ): string => {
    const updated = formatDate(updatedAt, { time: true }, now);
    return [
      extensionVersionWords(version),
      updated ? `Updated ${updated}` : null,
      bytes ? `${Math.max(0.1, Math.round(bytes / 104_857.6) / 10)} MB` : null,
      'for Chrome on a computer',
    ]
      .filter(Boolean)
      .join(' · ');
  },
} as const;
