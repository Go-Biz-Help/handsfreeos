/**
 * What the Assistant reads of the Real Estate Agent's answers, and what its cards say (each operation's `ai.answer`,
 * `ai.card` and `ai.outcome`, in ../../kernel/types.ts): the short facts ahead of the long lists, a home's MLS photos
 * as a count, a history's lines in the words the screens show, and what a change would do rather than the ids it was
 * given. They only reshape what the kernel gave the person, so they never show more than the screens do.
 *
 * Browser-safe and pure.
 */
import { dealHistoryWords, dutyLogWords } from './history-words';

type Bag = Record<string, unknown>;
type Card = {
  readonly title: string;
  readonly lines: readonly { readonly label: string; readonly value: string }[];
  readonly warning?: string;
};
type Outcome = { readonly words: string; readonly path?: string | null } | null;

const isObject = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const n = (count: number) => count.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`) =>
  `${n(count)} ${count === 1 ? one : many}`;

/** Longest an MLS description runs in a list of homes before "…": the home's own answer has it whole. */
const MLS_WORDS = 300;

/**
 * A home's MLS answer, lighter: its photos as a count and its description cut short, without the display notice and
 * logo the page shows beside them. A few homes found on the MLS otherwise fill the whole answer with photo links.
 */
export function briefMls(mls: unknown, whole = false): unknown {
  if (!isObject(mls)) return mls;
  const { photos, description, display, ...rest } = mls;
  const words = typeof description === 'string' ? description : null;
  return {
    ...rest,
    photoCount: Array.isArray(photos) ? photos.length : 0,
    description:
      words && !whole && words.length > MLS_WORDS ? `${words.slice(0, MLS_WORDS)}…` : words,
    courtesy: isObject(display) ? (display['courtesy'] ?? null) : null,
  };
}

const withBriefMls = (row: unknown, whole = false): unknown =>
  isObject(row) && 'mls' in row ? { ...row, mls: briefMls(row['mls'], whole) } : row;

/** A buyer's homes as the model reads them: how many there are first, each home's MLS answer lighter. */
export function homesAnswer(output: unknown, input: unknown): unknown {
  if (!isObject(output) || !Array.isArray(output['homes'])) return output;
  // One home asked for by its id: its MLS description whole.
  const one = isObject(input) && typeof input['homeId'] === 'string';
  return {
    total: output['total'],
    shown: output['homes'].length,
    homes: output['homes'].map((h) => withBriefMls(h, one)),
  };
}

/** A buyer's matches as the model reads them: the search and the counts first, each match's MLS answer lighter. */
export function matchesAnswer(output: unknown): unknown {
  if (!isObject(output) || !Array.isArray(output['matches'])) return output;
  return {
    search: output['search'],
    counts: output['counts'],
    matches: output['matches'].map((m) => withBriefMls(m)),
  };
}

/**
 * A listing as the model reads it: its price, page, MLS number and the description in use first, then the facts, and
 * the long lists (photos, the feed's answer, each fact's choices) last, so a listing with many photos never pushes
 * the price or the signed-off words out of reach. Earlier descriptions keep how they ended but not their words.
 */
export function listingAnswer(output: unknown): unknown {
  if (!isObject(output) || !isObject(output['listing'])) return output;
  const l = output['listing'];
  const d = isObject(l['description']) ? l['description'] : null;
  const feed = isObject(l['feed']) ? l['feed'] : null;
  return {
    dealId: l['dealId'],
    address: l['address'],
    street: l['street'],
    listPriceCents: l['listPriceCents'],
    page: l['page'],
    mls: l['mls'],
    can: l['can'],
    description: d
      ? {
          inUse: d['inUse'],
          working: d['working'],
          history: Array.isArray(d['history'])
            ? d['history'].map((h) => {
                if (!isObject(h)) return h;
                const { words: _words, ...rest } = h;
                return rest;
              })
            : d['history'],
        }
      : l['description'],
    factsConfirmedAt: l['factsConfirmedAt'],
    factsConfirmedBy: l['factsConfirmedBy'],
    facts: l['facts'],
    highlights: l['highlights'],
    questionnaire: l['questionnaire'],
    pasted: l['pasted'],
    matches: l['matches'],
    feed: feed ? { ...feed, mls: briefMls(feed['mls']) } : l['feed'],
    photos: l['photos'],
    choices: l['choices'],
  };
}

/** Each line of a deal's history, or a duty's, with the sentence its screen shows. */
function linesInWords(
  lines: unknown,
  words: (what: string, before: Bag | null, after: Bag | null) => string,
): unknown {
  if (!Array.isArray(lines)) return lines;
  return lines.map((l) => {
    if (!isObject(l) || typeof l['what'] !== 'string') return l;
    const { at, what, ...rest } = l;
    const before = isObject(l['before']) ? l['before'] : null;
    const after = isObject(l['after']) ? l['after'] : null;
    return { at, words: words(what, before, after), what, ...rest };
  });
}

/** A deal's history as the model reads it: each line in the words the History page shows. */
export function historyAnswer(output: unknown): unknown {
  if (!isObject(output)) return output;
  return { ...output, lines: linesInWords(output['lines'], dealHistoryWords) };
}

/** A duty as the model reads it: its log in the words the duty's drawer shows. */
export function dutyAnswer(output: unknown): unknown {
  if (!isObject(output)) return output;
  return { ...output, log: linesInWords(output['log'], dutyLogWords) };
}

// ---------- the listing's photos ----------

interface PhotoWas {
  readonly id: string;
  readonly caption: string | null;
  readonly public: boolean;
  readonly name: string | null;
}
interface PhotoNow {
  readonly id: string;
  readonly caption: string | null;
  readonly public: boolean;
}

/**
 * What putting the photos in order changes, a line for each photo that changes and how ("Photo 3 (Kitchen): caption
 * “Kitchen” → “Updated kitchen”; moved from 5"). Photos that stay as they were aren't named.
 */
export function photoChanges(before: readonly PhotoWas[], after: readonly PhotoNow[]): string[] {
  const quoted = (c: string | null) => (c ? `“${c}”` : 'none');
  return after.flatMap((p, i) => {
    const at = before.findIndex((b) => b.id === p.id);
    const was = before[at];
    if (!was) return [];
    const parts = [
      (was.caption ?? null) !== (p.caption ?? null)
        ? `caption ${quoted(was.caption)} → ${quoted(p.caption)}`
        : null,
      was.public !== p.public ? (p.public ? 'on the public page' : 'off the public page') : null,
      at !== i ? `moved from ${at + 1}` : null,
    ].filter((x): x is string => !!x);
    const name = p.caption ?? was.caption ?? was.name;
    return parts.length ? [`Photo ${i + 1}${name ? ` (${name})` : ''}: ${parts.join('; ')}`] : [];
  });
}

/** The card for putting a listing's photos in order: whose listing, and only what changes. */
export function photosArrangeCard(output: unknown): Card | null {
  if (!isObject(output) || !Array.isArray(output['changes'])) return null;
  const changes = output['changes'].filter((c): c is string => typeof c === 'string');
  const whose = typeof output['dealName'] === 'string' ? output['dealName'] : 'this listing';
  if (!changes.length)
    return {
      title: `Keep ${whose}’s photos as they are?`,
      lines: [{ label: 'Changes', value: 'None: every photo stays as it is.' }],
    };
  return {
    title: `Change ${plural(changes.length, 'photo')} on ${whose}?`,
    lines: changes.map((c, i) => ({ label: `Change ${i + 1}`, value: c })),
  };
}

// ---------- key dates ----------

/** The card for confirming several key dates at once: whose deal, and each value it confirms. */
export function termsConfirmCard(output: unknown): Card | null {
  if (!isObject(output) || !Array.isArray(output['confirmed'])) return null;
  const whose = typeof output['dealName'] === 'string' ? output['dealName'] : 'this deal';
  const lines = output['confirmed'].flatMap((c) =>
    isObject(c) && typeof c['label'] === 'string' && typeof c['value'] === 'string'
      ? [{ label: c['label'], value: c['value'] }]
      : [],
  );
  if (!lines.length)
    return {
      title: `Nothing to confirm on ${whose}`,
      lines: [{ label: 'Key dates', value: 'Every one of these is confirmed already.' }],
    };
  return { title: `Confirm ${plural(lines.length, 'value')} on ${whose}?`, lines };
}

// ---------- lockboxes ----------

/**
 * The card for adding or changing a lockbox without its code: whose listing, and each part as it was and will be. A
 * lockbox's answer never has a code, so none can show here.
 */
export function lockboxCard(output: unknown): Card | null {
  if (!isObject(output) || !isObject(output['lockbox'])) return null;
  const box = output['lockbox'];
  const was = isObject(output['before']) ? output['before'] : null;
  const whose = typeof output['dealName'] === 'string' ? output['dealName'] : 'this listing';
  const say = (v: unknown) => (typeof v === 'string' && v ? v : 'none');
  const line = (label: string, key: string) => ({
    label,
    value:
      was && say(was[key]) !== say(box[key])
        ? `${say(was[key])} → ${say(box[key])}`
        : say(box[key]),
  });
  return {
    title: was ? `Change a lockbox on ${whose}?` : `Add a lockbox to ${whose}?`,
    lines: [
      line('Kind', 'kindLabel'),
      line('Where it is', 'place'),
      line('Serial number', 'serial'),
      {
        label: 'Code',
        value: box['hasCode'] === true ? 'Kept as it is, locked' : 'None yet',
      },
    ],
  };
}

// ---------- email or text to contacts ----------

/**
 * The card for telling the business's contacts about a listing: how many it reaches and who by name, how many it
 * leaves out, and its exact words with the page's link, as Campaigns will show them.
 */
export function listingCampaignCard(output: unknown): Card | null {
  if (!isObject(output) || typeof output['recipients'] !== 'number') return null;
  const email = output['channel'] === 'email';
  const people = plural(output['recipients'], 'person', 'people');
  const street = typeof output['street'] === 'string' ? output['street'] : 'this listing';
  const audience = isObject(output['audience']) ? output['audience'] : {};
  const names = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const tags = names(audience['tags']);
  const stages = names(audience['stages']);
  const words = isObject(output['words']) ? output['words'] : {};
  const skipped = typeof output['skipped'] === 'number' ? output['skipped'] : 0;
  return {
    title: `${email ? 'Email' : 'Text'} ${people} about ${street}?`,
    lines: [
      ...(tags.length ? [{ label: 'Tagged', value: tags.join(', ') }] : []),
      ...(stages.length ? [{ label: 'At the stage', value: stages.join(', ') }] : []),
      {
        label: 'Left out',
        value: skipped
          ? `${plural(skipped, 'person', 'people')}: ${
              email
                ? 'no email, unsubscribed, bounced or emailed lately'
                : 'no texting consent, texted lately, mid-conversation or booked'
            }`
          : 'Nobody',
      },
      ...(typeof words['subject'] === 'string' && words['subject']
        ? [{ label: 'Subject', value: words['subject'] }]
        : []),
      ...(typeof words['body'] === 'string' ? [{ label: 'Words', value: words['body'] }] : []),
    ],
    warning: `It goes to ${people} of the business’s contacts. It waits in Campaigns until someone approves it, and nothing goes out before then.`,
  };
}

/** Telling the business's contacts, confirmed: where the campaign waits, as Marketing's toast says it. */
export function listingCampaignOutcome(output: unknown): Outcome {
  if (!isObject(output) || typeof output['campaignId'] !== 'string') return null;
  const email = output['channel'] === 'email';
  const recipients = typeof output['recipients'] === 'number' ? output['recipients'] : 0;
  const street = typeof output['street'] === 'string' ? output['street'] : 'the listing';
  return {
    words: `The ${email ? 'email' : 'text'} to ${plural(recipients, 'person', 'people')} about ${street} waits in Campaigns for someone to approve it.`,
    path: `campaigns/${output['campaignId']}`,
  };
}
