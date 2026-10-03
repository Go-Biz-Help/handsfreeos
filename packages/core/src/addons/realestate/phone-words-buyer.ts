/**
 * The buyer's pages on the phone (Real Estate round six, step 15; boards 82–84): what they want, their homes, new
 * matches, tours in the field, offers and a CMA. Words and the small sums the screens read off core's views
 * (`views/buyer.ts`, `tours.ts`, `offers.ts`, `cma.ts`), so the phone says what the web and the portal say. Reuses
 * core's own words where they exist (`homes.ts`, `tours.ts`, `offer-words.ts`, `feed.ts`, `memory.ts`). Browser-safe
 * and pure.
 */
import { fmtDateShort, fmtMonthDay, fmtTime, localDayOf } from '../../calendar/when';
import { addDays, daysBetween } from '../../calendar/engine/zoned';
import { money } from '../../money/format';
import { roundedMoney } from './cma';
import { FEED_SUPPLIERS } from './feed';
import {
  HOME_STATUSES,
  HOME_TYPES,
  type HomeStatus,
  type HomeType,
  type ListingFacts,
} from './homes';
import { LOAN_TYPES, offerStatusWords, type LoanType, type OfferStatus } from './offer-words';
import { STOP_STATUSES, TOUR_INTEREST, type StopStatus, type TourInterest } from './tours';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const n = (x: number) => x.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`) =>
  `${n(count)} ${count === 1 ? one : many}`;

/** The street part of an address: "418 Maple Ave". */
export const street = (address: string): string => address.split(',')[0]!.trim() || address;

/** First names joined: "Linh", "Linh and Tuan", "Linh, Tuan and Mai"; "the client" when there are none. */
export function firstNames(names: readonly string[]): string {
  const first = names.map((x) => x.trim().split(/\s+/)[0]!).filter(Boolean);
  if (first.length === 0) return 'the client';
  if (first.length === 1) return first[0]!;
  return `${first.slice(0, -1).join(', ')} and ${first.at(-1)}`;
}

/** "Linh’s", "Linh and Tuan’s". */
export const possessive = (who: string): string => `${who}’s`;

/** "3 bd · 2 ba · 1,780 sq ft": what's known, in that order. */
export function roomsLine(f: {
  readonly beds?: number | null;
  readonly baths?: number | null;
  readonly sqft?: number | null;
}): string {
  return [
    f.beds != null ? `${f.beds} bd` : null,
    f.baths != null ? `${f.baths} ba` : null,
    f.sqft != null ? `${n(f.sqft)} sq ft` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "$409,000 · 3 bd · 2 ba · 1,780 sq ft". */
export function homeFactsLine(f: ListingFacts): string {
  return [f.price_cents != null ? money(f.price_cents) : null, roomsLine(f) || null]
    .filter(Boolean)
    .join(' · ');
}

/** A home's facts: what the agent kept, filled in from what the MLS says where nothing's kept. */
export function factsOf(home: {
  readonly facts: ListingFacts;
  readonly mls: { readonly facts: ListingFacts } | null;
}): ListingFacts {
  return { ...(home.mls?.facts ?? {}), ...stripEmpty(home.facts) };
}

function stripEmpty(f: ListingFacts): ListingFacts {
  return Object.fromEntries(
    Object.entries(f).filter(([, v]) => v !== undefined && v !== null),
  ) as ListingFacts;
}

/**
 * Which supplier brought something from the MLS, from core's own words for where it came from ("From the MLS
 * (Unlock MLS, through Repliers)"): "Repliers", or null when the words don't name one.
 */
export function mlsSupplier(sourceWords: string | null | undefined): string | null {
  if (!sourceWords) return null;
  const through = /through ([^)]+)\)?$/.exec(sourceWords)?.[1]?.trim();
  if (through) return through;
  return (
    Object.values(FEED_SUPPLIERS).find((s) =>
      sourceWords.toLowerCase().includes(s.toLowerCase()),
    ) ?? null
  );
}

/** "Moving by": a month when the date is the 1st ("December"), else the day ("Dec 15"); the year when it isn't this one. */
export function moveByWords(date: string, today: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const thisYear = Number(today.slice(0, 4));
  if (d === 1) return y === thisYear ? MONTHS[m - 1]! : `${MONTHS[m - 1]} ${y}`;
  return fmtMonthDay(date, thisYear);
}

/** A price range: "$380,000 – $430,000", "Up to $430,000", "From $380,000". */
export function budgetWords(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `${money(min)} – ${money(max)}`;
  if (max !== null) return `Up to ${money(max)}`;
  if (min !== null) return `From ${money(min)}`;
  return null;
}

/** What the buyer wants, as a profile and what's remembered, a line each; only what's filled in. */
export function wantsLines(
  p: {
    readonly budgetMinCents: number | null;
    readonly budgetMaxCents: number | null;
    readonly areas: readonly string[];
    readonly homeTypes: readonly string[];
    readonly bedsMin: number | null;
    readonly bathsMin: number | null;
    readonly sqftMin: number | null;
    readonly moveBy: string | null;
    readonly mustHaves: readonly string[];
    readonly dealBreakers: readonly string[];
  } | null,
  remembered: readonly { readonly kind: string; readonly words: string; readonly status: string }[],
  today: string,
): { readonly key: string; readonly label: string; readonly value: string }[] {
  const out: { key: string; label: string; value: string }[] = [];
  const kept = (kind: string) =>
    remembered.filter((m) => m.kind === kind && m.status === 'confirmed').map((m) => m.words);
  const join = (xs: readonly string[]) => xs.join(', ');
  const budget = p ? budgetWords(p.budgetMinCents, p.budgetMaxCents) : null;
  if (budget) out.push({ key: 'price', label: RE_BUYER_WORDS.price, value: budget });
  if (p && (p.bedsMin !== null || p.bathsMin !== null))
    out.push({
      key: 'rooms',
      label: RE_BUYER_WORDS.bedsBaths,
      value: `${p.bedsMin !== null ? `${p.bedsMin}+` : 'Any'} · ${p.bathsMin !== null ? `${p.bathsMin}+` : 'Any'}`,
    });
  if (p?.sqftMin)
    out.push({ key: 'size', label: RE_BUYER_WORDS.size, value: `${n(p.sqftMin)}+ sq ft` });
  if (p?.homeTypes.length)
    out.push({
      key: 'types',
      label: RE_BUYER_WORDS.types,
      value: join(p.homeTypes.map((t) => HOME_TYPES[t as HomeType] ?? t)),
    });
  if (p?.areas.length)
    out.push({ key: 'areas', label: RE_BUYER_WORDS.areas, value: join(p.areas) });
  const must = [...(p?.mustHaves ?? [])];
  for (const w of kept('must_have')) if (!must.includes(w)) must.push(w);
  if (must.length) out.push({ key: 'must', label: RE_BUYER_WORDS.mustHave, value: join(must) });
  const likes = kept('likes');
  if (likes.length)
    out.push({ key: 'likes', label: RE_BUYER_WORDS.niceToHave, value: join(likes) });
  const never = [...(p?.dealBreakers ?? [])];
  for (const w of kept('deal_breaker')) if (!never.includes(w)) never.push(w);
  if (never.length)
    out.push({ key: 'never', label: RE_BUYER_WORDS.dealBreakers, value: join(never) });
  if (p?.moveBy)
    out.push({ key: 'move', label: RE_BUYER_WORDS.movingBy, value: moveByWords(p.moveBy, today) });
  return out;
}

/** How many of the matches were found on the business's today. */
export function foundToday(
  matches: readonly { readonly state: string; readonly foundAt: string }[],
  today: string,
  timeZone: string,
): number {
  return matches.filter((m) => m.state === 'new' && localDayOf(m.foundAt, timeZone) === today)
    .length;
}

/** "New · 4 hours ago", "New · yesterday", "New · Sep 28", "Changed on the MLS". */
export function matchTag(
  m: { readonly foundAt: string; readonly changedAt: string | null },
  now: number,
  today: string,
  timeZone: string,
): string {
  if (m.changedAt) return 'Changed on the MLS';
  const day = localDayOf(m.foundAt, timeZone);
  if (day === today) {
    const mins = Math.max(0, Math.round((now - Date.parse(m.foundAt)) / 60_000));
    const h = Math.floor(mins / 60);
    return `New · ${h >= 1 ? `${plural(h, 'hour')} ago` : mins <= 1 ? 'just now' : `${mins} minutes ago`}`;
  }
  if (day === addDays(today, -1)) return 'New · yesterday';
  return `New · ${fmtMonthDay(day, Number(today.slice(0, 4)))}`;
}

/** The new matches' heading: "New today", "New since yesterday", or "New". */
export function newMatchesLabel(
  matches: readonly { readonly foundAt: string }[],
  today: string,
  timeZone: string,
): string {
  const days = matches.map((m) => localDayOf(m.foundAt, timeZone)).sort();
  if (!days.length || days[0] === today) return 'New today';
  if (days[0] === addDays(today, -1)) return 'New since yesterday';
  return 'New';
}

/** A home's reaction as its card shows it: the client's own from the portal, else what they said on a tour. */
export function reactionOf(
  home: {
    readonly status: HomeStatus;
    readonly reactions: readonly { readonly reaction: string }[];
  },
  tourInterest: TourInterest | null,
): { readonly words: string; readonly tone: 'ok' | 'gray' } | null {
  const last = home.reactions.at(-1)?.reaction;
  if (last === 'saved') return { words: 'Loved', tone: 'ok' };
  if (last === 'passed' || home.status === 'passed') return { words: 'Passed', tone: 'gray' };
  if (tourInterest === 'love') return { words: 'Loved', tone: 'ok' };
  if (tourInterest === 'maybe') return { words: 'Maybe', tone: 'gray' };
  if (tourInterest === 'no') return { words: 'Passed', tone: 'gray' };
  return null;
}

/** What the clients last said of each home on a tour, newest first: home id → their interest. */
export function interestByHome(
  tours: readonly {
    readonly stops: readonly {
      readonly homeId: string;
      readonly feedback: readonly { readonly interest: TourInterest; readonly at: string }[];
    }[];
  }[],
): ReadonlyMap<string, TourInterest> {
  const latest = new Map<string, { interest: TourInterest; at: string }>();
  for (const t of tours)
    for (const s of t.stops)
      for (const f of s.feedback) {
        const had = latest.get(s.homeId);
        if (!had || had.at < f.at) latest.set(s.homeId, { interest: f.interest, at: f.at });
      }
  return new Map([...latest].map(([home, f]) => [home, f.interest]));
}

/** A client's reaction at a stop, the way the board names "no": "Not for Linh". */
export const interestWords = (interest: TourInterest, who: string): string =>
  interest === 'no' ? `Not for ${who}` : TOUR_INTEREST[interest];

/**
 * A tour's name, from the business's today: "Today’s tour", "Tomorrow’s tour", "Saturday’s tour" within the week
 * either way, else "The Oct 12 tour".
 */
export function tourName(startsAt: string, today: string, timeZone: string): string {
  const day = localDayOf(startsAt, timeZone);
  const away = daysBetween(today, day);
  if (away === 0) return 'Today’s tour';
  if (away === 1) return 'Tomorrow’s tour';
  if (away === -1) return 'Yesterday’s tour';
  if (Math.abs(away) < 7) return `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]}’s tour`;
  return `The ${fmtMonthDay(day, Number(today.slice(0, 4)))} tour`;
}

/** A tour's name inside a sentence: "today’s tour", "the Oct 12 tour", "Saturday’s tour". */
const inSentence = (name: string) =>
  /^(Today|Tomorrow|Yesterday|The) /.test(name) || /^(Today|Tomorrow|Yesterday)’/.test(name)
    ? name[0]!.toLowerCase() + name.slice(1)
    : name;

/** When each stop is, spread evenly over the tour: the first at its start. */
export function stopTimes(startsAt: string, endsAt: string, stops: number): number[] {
  const start = Date.parse(startsAt);
  const each = stops > 0 ? (Date.parse(endsAt) - start) / stops : 0;
  return Array.from({ length: stops }, (_, i) => start + Math.round(each * i));
}

/** "10:00" for a stop's time: the clock without AM or PM, as the board lists them. */
export const stopClock = (at: number, timeZone: string): string =>
  fmtTime(at, timeZone).replace(/\s?[AP]M$/, '');

/** A stop's line on the tour: where it stands, and the agent's note. */
export const stopLine = (status: StopStatus, note: string | null): string =>
  [STOP_STATUSES[status], note].filter(Boolean).join(' · ');

/**
 * What the agent noted at a stop, as the client's portal shows it beside their reaction: typed notes and recordings'
 * words, oldest first, in one paragraph of at most 2,000 characters.
 */
export function stopNotesWords(
  notes: readonly {
    readonly body: string | null;
    readonly transcript: string | null;
    readonly notedAt: string;
  }[],
): string {
  return [...notes]
    .sort((a, b) => a.notedAt.localeCompare(b.notedAt))
    .flatMap((n) => [n.transcript?.trim(), n.body?.trim()].filter((x): x is string => !!x))
    .join(' ')
    .slice(0, 2000)
    .trim();
}

/** "0:42". */
export function clockOfSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** An offer's name on the phone: the buyers' last name on a listing ("Okafor"), else the home's street. */
export function offerName(o: {
  readonly buyerNames: string | null;
  readonly address: string;
  readonly number: number;
}): string {
  const buyers = o.buyerNames?.trim();
  if (buyers) return buyers.split(/\s+/).at(-1)!;
  return street(o.address) || `Offer ${o.number}`;
}

/** "Conventional, 20% down · closes Nov 6 · option 5 days": an offer's terms on one line. */
export function offerTermsLine(
  v: {
    readonly loanType: LoanType | null;
    readonly downPaymentPct: number | null;
    readonly closingDate: string | null;
    readonly inspectionDays: number | null;
  },
  today: string,
): string {
  const loan = v.loanType
    ? v.loanType !== 'cash' && v.downPaymentPct !== null
      ? `${LOAN_TYPES[v.loanType]}, ${n(v.downPaymentPct)}% down`
      : LOAN_TYPES[v.loanType]
    : null;
  const closes = v.closingDate
    ? `closes ${fmtMonthDay(v.closingDate, Number(today.slice(0, 4)))}`
    : null;
  const option =
    v.inspectionDays && v.inspectionDays > 0
      ? `option ${plural(v.inspectionDays, 'day')}`
      : 'no option period';
  return [loan, closes, option].filter(Boolean).join(' · ');
}

/** The clock on an offer's card: "Answer by 6:00 PM", "Answer by tomorrow 12:00 PM", "Answer time passed". */
export function answerByWords(respondBy: string, now: number, timeZone: string): string {
  if (Date.parse(respondBy) < now) return 'Answer time passed';
  const day = localDayOf(respondBy, timeZone);
  const today = localDayOf(now, timeZone);
  const time = fmtTime(respondBy, timeZone);
  if (day === today) return `Answer by ${time}`;
  if (day === addDays(today, 1)) return `Answer by tomorrow ${time}`;
  return `Answer by ${fmtDateShort(day)} ${time}`;
}

/** An offer's badge: "Countered" once it's gone back and forth, else where it stands for the deal's side. */
export function offerBadge(
  status: OfferStatus,
  versions: number,
  side: 'buyer' | 'listing',
): { readonly words: string; readonly tone: 'ok' | 'pending' | 'gray' } {
  if (status === 'accepted') return { words: 'Accepted', tone: 'ok' };
  if (status === 'waiting_them' || status === 'waiting_us')
    return versions > 1
      ? { words: 'Countered', tone: 'pending' }
      : { words: offerStatusWords(status, side), tone: 'pending' };
  return { words: offerStatusWords(status, side), tone: 'gray' };
}

/** A version as its row names it: "v2 · their counter", "v1 · first offer". */
export const versionWords = (v: { readonly number: number; readonly side: 'us' | 'them' }) =>
  `v${v.number} · ${v.number === 1 ? 'first offer' : v.side === 'them' ? 'their counter' : 'our counter'}`;

/** "Oct 1, 10:02 AM". */
export const versionAt = (at: string, timeZone: string, today: string): string =>
  `${fmtMonthDay(localDayOf(at, timeZone), Number(today.slice(0, 4)))}, ${fmtTime(at, timeZone)}`;

/** One version's terms, a line each, as the offer's page lists them; the price says what it was before. */
export function offerTermRows(
  v: {
    readonly priceCents: number;
    readonly emdCents: number | null;
    readonly emdDays: number | null;
    readonly loanType: LoanType | null;
    readonly downPaymentPct: number | null;
    readonly financingDays: number | null;
    readonly inspectionDays: number | null;
    readonly closingDate: string | null;
    readonly sellerCreditCents: number;
    readonly appraisalContingency: boolean | null;
    readonly homeSaleContingency: boolean | null;
    readonly escalationCapCents: number | null;
    readonly possession: string | null;
    readonly otherTerms: string | null;
  },
  before: { readonly number: number; readonly priceCents: number } | null,
  today: string,
): { readonly label: string; readonly value: string; readonly was?: string }[] {
  const year = Number(today.slice(0, 4));
  const rows: { label: string; value: string; was?: string }[] = [
    {
      label: 'Price',
      value: money(v.priceCents),
      ...(before && before.priceCents !== v.priceCents
        ? { was: `(v${before.number} ${money(before.priceCents)})` }
        : {}),
    },
  ];
  if (v.emdCents !== null)
    rows.push({
      label: 'Earnest money',
      value:
        v.emdDays !== null
          ? `${money(v.emdCents)}, within ${plural(v.emdDays, 'day')}`
          : money(v.emdCents),
    });
  if (v.loanType)
    rows.push({
      label: 'Financing',
      value:
        v.loanType === 'cash'
          ? 'Cash'
          : [
              LOAN_TYPES[v.loanType],
              v.downPaymentPct !== null ? `${n(v.downPaymentPct)}% down` : null,
              v.financingDays !== null ? plural(v.financingDays, 'day') : null,
            ]
              .filter(Boolean)
              .join(' · '),
    });
  rows.push({
    label: 'Option',
    value: v.inspectionDays && v.inspectionDays > 0 ? plural(v.inspectionDays, 'day') : 'None',
  });
  if (v.appraisalContingency !== null)
    rows.push({
      label: 'Appraisal',
      value: v.appraisalContingency ? 'Can back out if it appraises low' : 'No appraisal condition',
    });
  if (v.homeSaleContingency) rows.push({ label: 'Home to sell first', value: 'Yes' });
  if (v.escalationCapCents !== null)
    rows.push({ label: 'Escalation', value: `Up to ${money(v.escalationCapCents)}` });
  if (v.closingDate) rows.push({ label: 'Closing', value: fmtMonthDay(v.closingDate, year) });
  if (v.possession) rows.push({ label: 'Possession', value: v.possession });
  rows.push({
    label: 'Seller pays',
    value:
      v.sellerCreditCents > 0 ? `${money(v.sellerCreditCents)} toward closing costs` : 'Nothing',
  });
  if (v.otherTerms?.trim()) rows.push({ label: 'Also', value: v.otherTerms.trim() });
  return rows;
}

/** What could undo an offer, in words: "Financing and a 5-day option", "None: cash, no option period". */
export function riskWords(v: {
  readonly loanType: LoanType | null;
  readonly inspectionDays: number | null;
  readonly appraisalContingency: boolean | null;
  readonly homeSaleContingency: boolean | null;
}): string {
  const parts = [
    v.loanType && v.loanType !== 'cash' ? 'Financing' : null,
    v.inspectionDays && v.inspectionDays > 0 ? `a ${v.inspectionDays}-day option` : null,
    v.appraisalContingency ? 'the appraisal' : null,
    v.homeSaleContingency ? 'selling their home first' : null,
  ].filter((x): x is string => !!x);
  if (!parts.length) return 'None: no financing or option period';
  const said = parts.map((p, i) => (i === 0 ? p[0]!.toUpperCase() + p.slice(1) : p));
  return said.length === 1 ? said[0]! : `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`;
}

/** "Nov 6 · 36 days": a closing date and how far off it is. */
export function closingWords(date: string, today: string): string {
  const away = daysBetween(today, date);
  const when = fmtMonthDay(date, Number(today.slice(0, 4)));
  return away >= 0 ? `${when} · ${plural(away, 'day')}` : when;
}

/** "+$2,260 net, 15 days later": one offer against another. */
export function versusWords(
  net: number,
  otherNet: number,
  closing: string | null,
  otherClosing: string | null,
): string {
  const diff = net - otherNet;
  const money_ = `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))} net`;
  if (!closing || !otherClosing) return money_;
  const days = daysBetween(otherClosing, closing);
  if (days === 0) return `${money_}, same day`;
  return `${money_}, ${plural(Math.abs(days), 'day')} ${days > 0 ? 'later' : 'sooner'}`;
}

/** A comp's line: "Sold Aug 28 · $482,000 · 1,880 sq ft". */
export function compLine(
  c: {
    readonly status: 'sold' | 'pending' | 'active';
    readonly soldOn: string | null;
    readonly priceCents: number;
    readonly sqft: number | null;
  },
  today: string,
): string {
  const year = Number(today.slice(0, 4));
  const what =
    c.status === 'sold'
      ? c.soldOn
        ? `Sold ${fmtMonthDay(c.soldOn, year)}`
        : 'Sold'
      : c.status === 'pending'
        ? 'Pending'
        : 'For sale';
  return [what, money(c.priceCents), c.sqft != null ? `${n(c.sqft)} sq ft` : null]
    .filter(Boolean)
    .join(' · ');
}

/** "0.1 mi". */
export const milesWords = (miles: number): string =>
  `${miles.toLocaleString('en-US', { maximumFractionDigits: 1 })} mi`;

/** The buyer's pages' own words on the phone. */
export const RE_BUYER_WORDS = {
  // ---------- What they want (board 82) ----------
  wantsTitle: 'What they want',
  price: 'Price',
  bedsBaths: 'Beds · baths',
  size: 'Size',
  types: 'Type',
  areas: 'Areas',
  mustHave: 'Must have',
  niceToHave: 'Nice to have',
  dealBreakers: 'Deal-breakers',
  movingBy: 'Moving by',
  wantsEmpty: (who: string) =>
    `Nothing yet. Add what ${who} wants, and every home is checked against it.`,
  theSearch: 'The search',
  searchSaved: (supplier: string | null) =>
    supplier ? `Saved on ${supplier}` : 'Saved on the MLS',
  searchOff: 'The search is off',
  searchLine: (on: boolean, newToday: number) =>
    [
      on ? 'Asked at once when it changes' : 'Turn it on on the web',
      newToday ? `${newToday} new today` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  change: 'Change what they want',
  changesWait: 'Changes wait on this phone; the search runs again when they send.',
  remembered: 'Remembered',
  remember: 'Remember something',
  rememberHint:
    'What they like, what they won’t have, when they need to move. Never who lives nearby.',
  remembering: 'Kept. It waits on this phone until it sends.',
  saved: 'Saved. The search runs again when it sends.',
  // The profile sheet, as the web's dialog says it.
  sheetWhy:
    'Every home is checked against this. Describe the home, never the people who live near it.',
  lowest: 'Lowest price',
  highest: 'Highest price',
  areasHint: 'Towns, ZIP codes or neighborhoods, with commas.',
  kinds: 'Kinds of home',
  bedsAtLeast: 'Bedrooms, at least',
  bathsAtLeast: 'Bathrooms, at least',
  sqftAtLeast: 'Square feet, at least',
  moveBy: 'Move by (YYYY-MM-DD)',
  mustHaves: 'Must-haves, with commas',
  neverHaves: 'Deal-breakers, with commas',
  notAmount: (what: string) => `${what} isn’t an amount. Type it like 450,000.`,
  notNumber: (what: string) => `${what} isn’t a number. Type it like 3.`,
  notDate: 'Type the move-by date like 2026-12-01.',
  save: 'Save',
  cancel: 'Cancel',

  // ---------- Homes (board 82) ----------
  homesTitle: 'Homes',
  homesCount: (dealName: string, count: number) => `${dealName} · ${plural(count, 'home')}`,
  homesEmpty: (who: string) =>
    `No homes yet. Add an address, and ${who} can add the ones they find in their portal.`,
  addedBy: (who: string) => `added by ${who}`,
  addHome: 'Add a home',
  address: 'Address',
  addressHint: '418 Maple Ave, Austin, TX',
  mlsNumber: 'MLS number (if you have it)',
  addNote: 'Note for the team',
  added: (address: string) =>
    `${street(address)} is on their homes. It’s looked up on the MLS when it sends.`,
  homeGone: 'That home isn’t on this phone. It may have been removed.',
  photoOf: (caption: string | null, i: number, of: number) =>
    `${caption ? `${caption} · ` : ''}${i} of ${of}`,
  mlsBadge: (statusWords: string, mlsNumber: string) => `${statusWords} · MLS #${mlsNumber}`,
  fromMls: 'from the MLS',
  fromMlsAt: (supplier: string | null, time: string) =>
    ['from the MLS', supplier, time].filter(Boolean).join(' · '),
  fromListing: 'from the listing’s words, to confirm',
  keptBy: 'as the agent typed it',
  beds: 'Beds · baths',
  hoa: 'HOA',
  hoaValue: (cents: number) => `${money(cents)} a month`,
  built: 'Built',
  lot: 'Lot',
  garage: 'Garage',
  garageValue: (spaces: number) => plural(spaces, 'space'),
  addToTour: 'Add to a tour',
  note: 'Note',
  noted: 'Noted. It waits on this phone until it sends.',
  where: 'Where it stands',
  savedIt: 'Loved it',
  passedIt: 'Passed',
  statuses: HOME_STATUSES,
  marked: (status: HomeStatus) => `Marked ${HOME_STATUSES[status].toLowerCase()}.`,
  lookUp: 'Look it up on the MLS',
  lookUpWhy: 'Looking a home up on the MLS needs signal. Try again when you have signal.',
  lookingUp: 'Asking the MLS. Its facts come in here.',
  photosWithSignal: 'Photos the phone hasn’t seen load with signal.',

  // ---------- New matches (board 82) ----------
  matchesTitle: 'New matches',
  sendTo: (who: string) => `Send to ${who}`,
  notFor: (who: string) => `Not for ${who}`,
  sendNote: (who: string) =>
    `Send to ${who} reaches ${possessive(who)} portal; with no signal it waits and asks again after 30 minutes.`,
  sent: (who: string) => `Sent to ${who}. It’s with their homes now.`,
  sentWaits: (who: string) => `It goes to ${who} when it sends.`,
  dismissed: (who: string) => `Skipped. ${who} never saw it.`,
  noMatches: (who: string, on: boolean) =>
    on
      ? `Nothing new. ${possessive(who)} search runs every time the MLS changes, and new homes come here.`
      : `Nothing new. ${possessive(who)} search is off; turn it on on the web.`,
  sentLabel: 'Sent',
  skippedLabel: 'Skipped',
  ourListings: 'Our listings that fit',
  addToHomes: 'Add to their homes',
  notAFit: 'Not a fit',
  suggestionAdded: (who: string) => `Added to ${possessive(who)} homes.`,

  // ---------- Tours in the field (board 83) ----------
  toursTitle: 'Tours',
  agreementOnFile: 'Agreement on file',
  tourDone: 'Done',
  tourLine: (clients: string, homes: number, range: string) =>
    [clients || null, plural(homes, 'home'), range].filter(Boolean).join(' · '),
  directions: 'Directions',
  checkIn: 'Check in',
  stops: 'Stops',
  toursEmpty:
    'No tours yet. Plan one and it goes on the calendar as one appointment, with its homes in order.',
  planTour: 'Plan a tour',
  planWhy: 'Planning a tour needs signal; it goes on the calendar and the clients are invited.',
  planWhen: 'When',
  planTime: 'Starts at',
  planHomes: 'Homes, in order',
  planned: 'Planned. It’s on the calendar, and the clients are invited.',
  /** "Add to Saturday’s tour", "Add to today’s tour", "Add to the Oct 12 tour". */
  addToThat: (tour: string) => `Add to ${inSentence(tour)}`,
  addedToThat: (tour: string) => `Added to ${inSentence(tour)}. The calendar has it.`,
  stopOf: (tourName: string, i: number) => `${tourName} · stop ${i}`,
  stopCount: (i: number, of: number) => `Stop ${i} of ${of}`,
  bedsBathsSize: 'Beds · baths · size',
  builtHoa: 'Built · HOA',
  noHoa: 'No HOA',
  askThere: 'Ask while you’re there',
  theirMustHave: (who: string) => `${possessive(who)} must-have`,
  theirDealBreaker: (who: string) => `${possessive(who)} deal-breaker`,
  notOnListing: 'Not on the listing',
  whatTheyThought: (who: string) => `What ${who} thought`,
  voice: 'Voice',
  photo: 'Photo',
  nextStop: (address: string) => `Next stop · ${street(address)}`,
  finishTour: 'Done with this tour',
  skipStop: 'Skip this stop',
  skipWhy: 'Why it was skipped',
  skipped: 'Skipped.',
  skippedBecause: (why: string) => `Skipped: ${why}`,
  heard: 'Kept. It waits on this phone until it sends.',
  notesHere: 'Notes here',
  voiceNoteLine: (transcript: string | null, waiting: boolean) =>
    transcript
      ? `“${transcript}” · voice note`
      : waiting
        ? 'Voice note · the words come when it sends'
        : 'Voice note',
  photoNoteLine: (count: number) => plural(count, 'photo'),
  noCamera:
    'HandsFreeOS can’t use the camera. Allow it in Settings → HandsFreeOS → Camera, then try again.',
  photoKept: 'Photo kept with the stop. It uploads when it can.',
  feedbackTitle: 'Tour feedback',
  whatTheySaid: (tourName: string, who: string) => `${tourName} · what ${who} said`,
  sendToPortal: (who: string) => `Send to ${possessive(who)} portal`,
  sentToPortal: (who: string) => `It’s in ${possessive(who)} portal once it sends.`,
  nothingSaid: 'Nothing noted yet.',
  feedback: 'Feedback',
  stopGone: 'That stop isn’t on this phone. The tour may have changed.',

  // ---------- A voice note (board 83) ----------
  voiceTitle: 'Voice note',
  voiceAt: (address: string, clock: string) => `${street(address)} · ${clock}`,
  recording: 'Recording…',
  stop: 'Stop',
  recordedOffline:
    'Recorded with no signal. The words come when it sends; the recording is kept with the stop.',
  recordedOnline: 'The words come once it’s sent; the recording is kept with the stop.',
  keepIt: 'Keep it',
  recordAgain: 'Record again',
  noMicrophone:
    'HandsFreeOS can’t use the microphone. Allow it in Settings → HandsFreeOS → Microphone, then try again.',
  recordFailed: 'The recording didn’t start. Try again.',

  // ---------- Offers and the CMA (board 84) ----------
  offersTitle: 'Offers',
  offersIn: (dealName: string, count: number, side: 'buyer' | 'listing') =>
    `${dealName} · ${plural(count, 'offer')} ${side === 'listing' ? 'in' : 'out'}`,
  offersEmpty: (side: 'buyer' | 'listing') =>
    side === 'listing' ? 'No offers in yet.' : 'No offers yet. Start one on the web.',
  startOnWeb: 'Starting an offer opens on the web, where the whole offer is written.',
  offerCard: (name: string, priceCents: number) => `${name} · ${money(priceCents)}`,
  netTo: (who: string) => `Net to ${who}:`,
  sideBySide: 'Side by side',
  ended: 'Ended',
  acceptedLine: (name: string, number: number) => `${name} · v${number} accepted`,
  endedLine: (name: string, words: string) => `${name} · ${words.toLowerCase()}`,
  offerTitle: (name: string) => `${name} offer`,
  offerHead: (name: string, number: number) => `${name} · v${number}`,
  versions: 'Versions',
  counterWhy: 'Writing a counter needs signal; it goes to the other agent and the seller’s portal.',
  counterWhyBuyer:
    'Writing a counter needs signal; it goes to the other agent and your client’s portal.',
  writeCounter: 'Write a counter',
  counterTitle: 'Counter',
  paying: 'Paying',
  option: 'Option',
  earnestMoney: 'Earnest money',
  sellerPays: 'Seller pays toward closing costs',
  optionDays: 'Option days',
  closingOn: 'Closing (YYYY-MM-DD)',
  counterSent: 'Counter kept. It’s on the offer now.',
  respondIn: 'Answer within (hours)',
  counterNote: 'Note for the team',
  offerGone: 'That offer isn’t on this phone.',
  summary: 'Summary',
  seeSummary: 'The summary',
  summaryTitle: (name: string) => `${name} offer, in one page`,
  summaryFor: (client: string, firstName: string, since: string | null) =>
    [
      `For ${client}`,
      since ? `in ${possessive(firstName)} portal since ${since}` : 'not shared yet',
    ].join(' · '),
  youdNet: 'You’d net',
  closing: 'Closing',
  risk: 'Risk',
  versus: (name: string) => `Versus ${name}`,
  said: (who: string) => `${who} said:`,
  saidAt: (time: string) => `at ${time}`,
  call: (who: string) => `Call ${who}`,
  noNumber: (who: string) =>
    `There’s no phone number for ${who}. Add one on their customer page, then try again.`,
  shareSummary: (who: string) => `Share with ${who}`,
  shareWhy: 'Sharing the summary needs signal; it goes to your client’s portal.',
  shared: (who: string) => `It’s in ${possessive(who)} portal now.`,
  cmaTitle: 'CMA',
  cmaSub: (dealName: string, asOf: string) => `${dealName} · ${asOf}`,
  suggestedRange: 'Suggested range',
  fromComps: (count: number, mls: boolean) => `From ${plural(count, mls ? 'MLS comp' : 'comp')}`,
  noRange: 'No range yet',
  rangeShort: (lowCents: number, highCents: number) =>
    `${roundedMoney(lowCents)} – ${roundedMoney(highCents)}`,
  mostLikely: (cents: number) => `Most likely ${roundedMoney(cents)}`,
  comps: 'Comps',
  notCounted: 'Not counted',
  soldVia: (source: string) => `Sold data ${source.replace(/^From /, 'from ')} · verify it.`,
  cmaSignal: 'Finding comps and writing the summary need signal; the CMA you made reads anywhere.',
  findComps: 'Find comps on the MLS',
  findCompsWhy: 'Finding comps on the MLS needs signal. Try again when you have signal.',
  writeSummary: 'Write the summary',
  writeSummaryWhy: 'Writing the summary needs signal (the AI). Try again when you have signal.',
  asked: 'Asked. It comes in here when it’s ready.',
  cmaSummary: 'Summary',
  unsupported: (amounts: readonly string[]) =>
    `Check ${amounts.join(', ')}: nothing in the CMA supports ${amounts.length === 1 ? 'it' : 'them'}.`,
  cmaGone: 'That CMA isn’t on this phone.',

  // ---------- A deal kept as its summary ----------
  whatThey: 'what the buyer wants',
  homes: 'homes',
  matches: 'new matches',
  tours: 'tours',
  offers: 'offers',
  cma: 'CMA',
  buyersOnly: 'Only a buyer has a saved search. This deal is a listing.',
} as const;
