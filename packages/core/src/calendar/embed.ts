/**
 * A calendar on the business's own website (the owner, 2026-11-18: an embed like forms have). The booking page in a
 * frame, opened with `?embed=1` so it drops our header and footer, and the same line a form's embed uses to fit the
 * frame to the page as it grows and shrinks (`/embed/v1/book.js`, the script `/embed/v1/form.js` serves). The frame
 * opens the calendar's public link (`bookingUrl`, on the business's own domain when one is serving); the line always
 * loads from the app's own address (`appOrigin`), since a business's domain serves its pages, not our scripts.
 *
 * It shows only on the sites listed under Sites allowed to show it (`calendar.set_embed_sites`), since every other
 * site gets the booking page's frame rule ('self' alone). The calendar's page copies this, and the Assistant hands
 * out the same. Browser-safe.
 */
export const BOOKING_EMBED_HEIGHT = 760;

export const bookingEmbedSnippet = (c: {
  readonly bookingUrl: string;
  readonly appOrigin: string;
  readonly name: string;
}): string =>
  `<iframe src="${c.bookingUrl}?embed=1" title="${escapeAttr(c.name)}" width="100%" height="${BOOKING_EMBED_HEIGHT}" style="border:0" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>\n<script src="${c.appOrigin}/embed/v1/book.js" async></script>`;

/** A calendar's name in the title attribute: quotes and angle brackets can't end it early. */
const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
