/**
 * Opinly's analytics pixel, in the <head> of every page on handsfreeos.com.
 *
 * It is how the blog earns its keep: it sees which search, campaign or post brought a visitor in, and when that
 * visitor later types their email into the founding application, it ties the visit to them. The worker then
 * reports the sign-up and the paid seat with the same email (apps/worker/src/analytics/opinly.ts), so a sale is
 * credited to the post that started it.
 *
 * The key is Opinly's *publishable* one (`pk-`): it can only send events, never read anything, and is meant to
 * be public. The secret `sk-` key is a different thing and lives only in the server's environment.
 *
 * What it records is on /privacy ("Cookies and tracking"); keep the two in step. It sets no cookies, and never
 * reads what is typed into a form beyond an email address, which Opinly keeps only as a hash.
 */
const PIXEL_SRC = 'https://static.opinly.ai/p.js';
const PUBLISHABLE_KEY = 'pk-4URAEI_KUurk_6J8t-fX_Hg2OjhEeT1fjYPs4h5';

export function OpinlyPixel() {
  return <script async src={PIXEL_SRC} data-key={PUBLISHABLE_KEY} />;
}
