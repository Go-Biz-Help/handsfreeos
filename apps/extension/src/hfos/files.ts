/**
 * The zips Facebook gives the person, as Chrome downloaded them: the "Download your information" file (one or more
 * parts) and the chat backup. The panel finds them in Chrome's downloads, so it doesn't matter whether the extension
 * pressed Download or the person did, and reads them from the person's computer, where they stay, once the person
 * lets the extension open files (Chrome's **Allow access to file URLs**). What's read goes to HandsFreeOS as the
 * Friends tab's card sends it: names and moments, never what a message said
 * (@hfos/core/addons/outreach/download-read).
 */

/** Facebook's own hosts, which its files come from: its pages, its file servers and Messenger. */
const FACEBOOK_HOST = /(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|messenger\.com)$/i;

/** The host of an address, a page's own for a file it made itself (`blob:https://www.facebook.com/…`). */
function hostOf(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href.startsWith('blob:') ? href.slice(5) : href).hostname;
  } catch {
    return null;
  }
}

/** What the panel needs to know of a download. */
export interface DownloadSeen {
  readonly url: string;
  readonly finalUrl?: string;
  readonly referrer?: string;
  /** Where Chrome saved it, the whole path. */
  readonly filename: string;
  readonly mime?: string;
}

/** Whether a download is one of Facebook's zips: from Facebook, or started on one of its pages, and a zip. */
export function isFacebookZip(item: DownloadSeen): boolean {
  const zip = /\.zip$/i.test(item.filename) || item.mime === 'application/zip';
  return (
    zip &&
    [item.url, item.finalUrl, item.referrer].some((href) => FACEBOOK_HOST.test(hostOf(href) ?? ''))
  );
}

/** A file's name without its folders, on a Mac or Windows alike. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * The address the extension opens a downloaded file at: `/Users/me/Downloads/facebook-me.zip` on a Mac, and
 * `C:\Users\me\Downloads\facebook-me.zip` on Windows, each part spelled so a `#` or a space in a name can't break it.
 */
export function fileUrlOf(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path);
  const parts = path.split(windows ? /[\\/]/ : '/');
  const spelled = parts.map((part, i) =>
    windows && i === 0 ? part.toUpperCase() : encodeURIComponent(part),
  );
  return windows ? `file:///${spelled.join('/')}` : `file://${spelled.join('/')}`;
}
