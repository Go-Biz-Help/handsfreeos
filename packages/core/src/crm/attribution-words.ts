/**
 * Where a customer came from, in words (20261025000200): the card on a Messenger or Instagram conversation and on a
 * customer's record, on the web and the phone, and since the funnels plan the lead ad form they sent. Browser-safe.
 *
 * Every ad or link that brought somebody is a touch of its own, so these words describe one touch at a time; the
 * card lists them newest first and says which came first.
 */
import type { AttributionTouchRow } from '../schemas/social';

const PLATFORM: Readonly<Record<AttributionTouchRow['platform'], string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};

/** What a lead ad form's touch says it came from: Meta says nothing, so it's ours. */
export const LEAD_FORM_SOURCE = 'LEAD_FORM';

/** "Facebook ad", "Instagram link", "Chat on your website": where Meta says they came from. */
export function touchSourceWords(
  t: Pick<AttributionTouchRow, 'platform' | 'source' | 'adId'>,
): string {
  const where = PLATFORM[t.platform];
  const source = (t.source ?? '').toUpperCase();
  if (source === LEAD_FORM_SOURCE) return t.adId ? `${where} lead ad` : `${where} lead form`;
  if (t.adId || source === 'ADS') return `${where} ad`;
  if (source === 'SHORTLINK') return `${where} link`;
  if (source === 'CUSTOMER_CHAT_PLUGIN' || source === 'CHAT_PLUGIN') return 'Chat on your website';
  if (source === 'MESSENGER_CODE') return 'Messenger code';
  if (source === 'DISCOVER_TAB') return 'Messenger’s Discover tab';
  return `${where} link`;
}

/** The ad's own name when Meta has said it, else the headline the customer saw, else where it was. */
export function touchTitle(t: AttributionTouchRow): string {
  const source = touchSourceWords(t);
  const name = t.ad?.name?.trim() || t.adTitle?.trim();
  return name ? `${source}: “${name}”` : source;
}

/** "Started the conversation", "Came back through it", "Sent its form". */
export const touchKindWords = (t: Pick<AttributionTouchRow, 'kind'>): string =>
  t.kind === 'started'
    ? 'Started the conversation'
    : t.kind === 'lead_form'
      ? 'Sent its form'
      : 'Came back through it';

export interface TouchFact {
  readonly label: string;
  readonly value: string;
}

/** The lines under a touch: its campaign, ad set, ad, creative and link code, as far as they're known. */
export function touchFacts(t: AttributionTouchRow): TouchFact[] {
  const out: TouchFact[] = [];
  const ad = t.ad;
  const named = (name: string | null | undefined, id: string | null | undefined): string | null =>
    name?.trim() || id?.trim() || null;
  const campaign = named(ad?.campaignName, ad?.campaignId);
  if (campaign) out.push({ label: 'Campaign', value: campaign });
  const adset = named(ad?.adsetName, ad?.adsetId);
  if (adset) out.push({ label: 'Ad set', value: adset });
  if (t.adId) out.push({ label: 'Ad', value: named(ad?.name, null) ?? `Ad ${t.adId}` });
  const creative =
    ad?.creativeTitle?.trim() || ad?.creativeBody?.trim() || ad?.creativeName?.trim();
  if (creative) out.push({ label: 'Creative', value: clip(creative, 140) });
  if (ad?.callToAction) out.push({ label: 'Button', value: titleCase(ad.callToAction) });
  if (t.formName) out.push({ label: 'Form', value: t.formName });
  if (t.ref) out.push({ label: 'Link code', value: t.ref });
  if (t.accountName)
    out.push({ label: t.platform === 'facebook' ? 'Page' : 'Account', value: t.accountName });
  return out;
}

/**
 * Why the campaign isn't showing, when it isn't: Meta is still being asked, the sign-in can't read ads, or Meta has
 * no such ad. Null when there's nothing to say.
 */
export function adLookupNote(t: AttributionTouchRow): string | null {
  if (!t.adId) return null;
  switch (t.ad?.status ?? 'pending') {
    case 'pending':
      return 'Looking up its campaign and ad set at Meta.';
    case 'no_access':
      return 'The campaign and ad set show once Facebook is connected by somebody who can see this ad’s ad account. Connect again in Settings → Facebook & Instagram and allow reading ads.';
    case 'not_found':
      return 'Meta no longer has this ad, so its campaign can’t be looked up.';
    case 'failed':
      return 'Meta wouldn’t say which campaign this ad is in. HandsFreeOS keeps trying for a few days.';
    default:
      return null;
  }
}

/** "a Facebook ad", "an Instagram link", "the chat on your website": what "came from" goes on with. */
function fromWords(t: Pick<AttributionTouchRow, 'platform' | 'source' | 'adId'>): string {
  const words = touchSourceWords(t);
  if (words === 'Chat on your website') return 'the chat on your website';
  if (words === 'Messenger’s Discover tab') return words;
  return /^[AEIOU]/.test(words) ? `an ${words}` : `a ${words}`;
}

/**
 * The line a card opens with: "Came from a Facebook ad (“Spring tune-up”), and 2 more since." Null when nothing
 * brought them. `firstId` and `total` are the list's own, which count touches beyond the page it holds.
 */
export function attributionSummary(
  touches: readonly AttributionTouchRow[],
  firstId: string | null,
  total: number,
): string | null {
  const first = touches.find((t) => t.id === firstId) ?? touches[touches.length - 1];
  if (!first) return null;
  const name = first.ad?.name?.trim() || first.adTitle?.trim();
  const more = Math.max(0, total - 1);
  return `Came from ${fromWords(first)}${name ? ` (“${name}”)` : ''}${
    more > 0 ? `, and ${more === 1 ? 'one more' : `${more} more`} since` : ''
  }.`;
}

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;

/** LEARN_MORE → Learn more. */
const titleCase = (s: string): string => {
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
