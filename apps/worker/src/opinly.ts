/**
 * Opinly, the website's marketing analytics, from the server's side: the money it cannot see from a browser.
 *
 * The pixel runs on handsfreeos.com only, never in the app, because the app is full of other people's customers and
 * the pixel records what is on the page. So what happens in the app reaches Opinly from here, keyed by the email
 * address a person gave the website. Opinly holds that address only as a hash, matches it to the visit where it was
 * typed, and credits the payment to the ad or post that brought them.
 *
 * **Null when OPINLY_API_KEY is unset**, which is local runs, tests and a production that has not been given a key:
 * nothing is sent and nothing is queued, the same as SITE_HOST=off.
 */
import { createOpinlyClient } from '@opinly/backend';

export interface Opinly {
  track(
    event: string,
    properties: Record<string, unknown>,
    opts: { readonly externalEventId: string; readonly email?: string; readonly anonId?: string },
  ): Promise<unknown>;
}

export function createOpinly(apiKey: string | null): Opinly | null {
  return apiKey ? createOpinlyClient({ apiKey }) : null;
}
