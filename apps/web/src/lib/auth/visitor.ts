/**
 * Who this person was on handsfreeos.com before they got here: the website adds Opinly's anonymous visitor id to its
 * "Start free" links as `?oa=`. A new account keeps it, whether made with an email or with Google, so the worker can
 * credit the sign-up, and anything bought later, to the article or campaign that brought them
 * (apps/worker/src/opinly.ts). Only something shaped like one of Opinly's ids is kept, and deleting the account clears
 * it with the rest of the sign-in's details.
 */
export function opinlyVisitor(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value) ? value : undefined;
}
