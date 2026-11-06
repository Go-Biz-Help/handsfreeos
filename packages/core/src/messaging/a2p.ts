/**
 * What a carrier is going to object to, worked out before we send it (the registration wizard).
 *
 * **A rejection costs weeks, and a blocked submit costs a minute.** A 10DLC brand and campaign go to The
 * Campaign Registry and come back three to seven business days later, and when one comes back turned down
 * the business waits out that clock again with a corrected form. Nearly every rejection we could have seen
 * coming: a legal name that is not the name on the EIN letter, example texts that do not name the sender,
 * a use case picked as "marketing" by a business that only confirms appointments, an opt-in description
 * that promises a box no reviewer can find.
 *
 * So the checks live here, in one pure module, and the wizard runs them as the business types. Each one
 * carries **why the carrier asks**, because a business that understands the question answers it properly
 * and a business told only "invalid" types something else wrong.
 *
 * Two severities, and the difference is what the wizard does with them:
 *
 * - `blocker` — this will be turned down. The wizard refuses to submit.
 * - `warning` — this is often turned down, or is true but looks wrong. The wizard says so and lets it go.
 *
 * Checks that need the network (is the website up, does the privacy policy mention texting, is the opt-in
 * box actually on the page) are not here: they belong to the worker, which can fetch. This module is what
 * can be decided from the form alone, and it is browser-safe so the wizard can run it on every keystroke.
 */
import { normalizePhone } from '../crm/phone';
import { STOP_KEYWORDS } from './sms';
import type { OptInPath } from './consent';
import {
  FREQUENCY_RE,
  namesBusiness,
  RATES_RE,
  TEXT_KINDS_RE,
  tradingName,
  type ConfirmationId,
} from './preflight';

export type IssueSeverity = 'blocker' | 'warning';

/** Names a field the wizard can focus, using the same paths the server's validation errors use. */
export type A2pField =
  | 'legalName'
  | 'businessType'
  | 'ein'
  | 'website'
  | 'contact'
  | 'useCase'
  | 'messageSamples'
  | 'optInDescription'
  | 'optInPath'
  | 'optInUrl'
  | 'optInProofUrl'
  | 'sensitiveTopics'
  | 'monthlyVolume'
  | 'policyContact'
  | 'otherWays';

export interface A2pIssue {
  readonly field: A2pField;
  readonly severity: IssueSeverity;
  /** What is wrong, said to the business in its own words. */
  readonly message: string;
  /** Why the carrier cares. Shown under the message, because "because they said so" teaches nobody. */
  readonly why: string;
  /**
   * A question only the business can answer ("is this exactly the name on your EIN letter?"): the last step asks it
   * as a tick (core's `confirmationsFor`), and once ticked it no longer stands between the registration and all green.
   */
  readonly confirm?: ConfirmationId;
}

/** The shape the checks read. A loose mirror of `BusinessProfile`, so a half-typed form can be checked. */
export interface A2pDraft {
  readonly legalName?: string;
  readonly businessType?: string;
  readonly ein?: string | null;
  readonly website?: string;
  readonly useCase?: string;
  readonly messageSamples?: readonly string[];
  readonly optInDescription?: string;
  readonly optInPath?: OptInPath;
  /** The business's own page carrying the box, for `own_site`. */
  readonly optInUrl?: string | null;
  /** A link anyone can open showing what customers see or hear before they agree (`in_person`). */
  readonly optInProofUrl?: string | null;
  /** The answer to "do your texts touch any of these?": the ids picked, `[]` for none, null before answering. */
  readonly sensitiveTopics?: readonly string[] | null;
  readonly monthlyVolume?: string;
  /** The business's own privacy policy and terms; empty when it uses the ones HandsFreeOS hosts. */
  readonly policyUrl?: string | null;
  readonly termsUrl?: string | null;
  /** How customers reach the business, as the privacy policy and terms say. */
  readonly policyContact?: { readonly email?: string; readonly phone?: string };
  /**
   * The addresses the reviewer is given, as the description has to name them (Twilio 30924 and 30896): the privacy
   * policy and terms (the business's own or ours), and the page where customers agree (for the chat, its sign-up
   * page). Left out, the description isn't checked for them.
   */
  readonly privacyPageUrl?: string | null;
  readonly termsPageUrl?: string | null;
  readonly optInPageUrl?: string | null;
  /** Every other way customers agree, each with its page or proof ("list every method along with proofs"). */
  readonly otherWays?: readonly { readonly path: OptInPath; readonly url: string }[];
  /** The legal name, also accepted where the description names the business. */
  readonly displayName?: string;
}

// ---------- what the business does ----------

/**
 * Topics the carriers treat differently, asked about once so nobody finds out from a rejection.
 *
 * - `refused`: not approved on an ordinary business registration. The wizard stops, and says so.
 * - `age`: allowed only when customers' ages are checked before they sign up; the campaign is marked age-gated.
 * - `lending`: allowed, looked at harder; the campaign is marked as direct lending.
 */
export const SENSITIVE_TOPICS = [
  { id: 'lending', label: 'Loans or credit you give customers yourself', kind: 'lending' },
  {
    id: 'debt',
    label: 'Payday loans, debt relief, debt collection or credit repair',
    kind: 'refused',
  },
  { id: 'lead_selling', label: 'Buying or selling leads for other businesses', kind: 'refused' },
  {
    id: 'cannabis',
    label: 'Cannabis, CBD, kratom or other controlled substances',
    kind: 'refused',
  },
  { id: 'gambling', label: 'Gambling, betting or sweepstakes', kind: 'refused' },
  { id: 'alcohol', label: 'Alcohol', kind: 'age' },
  { id: 'tobacco', label: 'Tobacco or vaping', kind: 'age' },
  { id: 'firearms', label: 'Firearms or ammunition', kind: 'age' },
] as const;
export type SensitiveTopicId = (typeof SENSITIVE_TOPICS)[number]['id'];
export const SENSITIVE_TOPIC_IDS = SENSITIVE_TOPICS.map((t) => t.id) as [
  SensitiveTopicId,
  ...SensitiveTopicId[],
];

const topicKind = (id: string) => SENSITIVE_TOPICS.find((t) => t.id === id)?.kind ?? null;

/** The carriers' two flags, read off the answer: age-gated content, and direct lending. */
export function sensitiveFlags(topics: readonly string[] | null | undefined): {
  ageGated: boolean;
  directLending: boolean;
} {
  const list = topics ?? [];
  return {
    ageGated: list.some((t) => topicKind(t) === 'age'),
    directLending: list.some((t) => topicKind(t) === 'lending'),
  };
}

// ---------- example texts ----------

/**
 * Words that make a text read as marketing whatever the business ticked. A campaign registered for customer
 * care whose examples say "20% off" is turned down for mismatch, not for the discount — the carriers check
 * that the samples match the use case, and this is the cheapest way to catch it.
 */
const PROMOTIONAL = [
  'sale',
  'discount',
  '% off',
  'percent off',
  'deal',
  'offer ends',
  'limited time',
  'coupon',
  'promo',
  'special offer',
  'buy now',
  'act now',
  'free gift',
];

/** A URL shortener in a sample is an automatic problem: carriers block shared shorteners outright. */
const SHORTENERS = [
  'bit.ly',
  'tinyurl',
  'goo.gl',
  't.co/',
  'ow.ly',
  'buff.ly',
  'is.gd',
  'rebrand.ly',
];

const lower = (s: string) => s.toLowerCase();

/** Does this text read as an offer? Money off, a sale, a deal: the words a reviewer reads as promotion. */
export function readsPromotional(sample: string): boolean {
  const text = lower(sample);
  return (
    PROMOTIONAL.some((w) => text.includes(w)) ||
    /\$\s?\d+\s*off\b|\bsave \$?\d+|\b(special|specials|offer)\b/.test(text)
  );
}

/** Does this sample name the business? A reviewer has to see who is texting, in the text itself. */
export function sampleNamesBusiness(sample: string, business: string): boolean {
  const name = business.trim();
  if (!name) return false;
  const haystack = lower(sample);
  if (haystack.includes(lower(name))) return true;
  // "Lone Star HVAC" also counts as named when the text says "Lone Star" — businesses shorten themselves.
  const words = name.split(/\s+/).filter((w) => w.length > 2);
  return words.length >= 2 && haystack.includes(lower(words.slice(0, 2).join(' ')));
}

/**
 * Does this sample offer a way out? At least one sample in a campaign has to carry it.
 *
 * **Whole words only.** The stop keywords include `END` and `QUIT`, and a substring match reads "we'll
 * send it over" as an opt-out — which would wave through a set of samples that never tells a customer how
 * to stop, and earn the rejection this module exists to prevent.
 */
export function sampleHasOptOut(sample: string): boolean {
  const words = new Set(lower(sample).match(/[a-z]+/g) ?? []);
  return STOP_KEYWORDS.some((k) => words.has(lower(k)));
}

/** Everything wrong with one example text, in the order a business would want to hear it. */
export function checkSample(sample: string, business: string): A2pIssue[] {
  const issues: A2pIssue[] = [];
  const text = sample.trim();
  if (text.length < 20)
    issues.push({
      field: 'messageSamples',
      severity: 'blocker',
      message: 'Write the whole text, the way you would really send it.',
      why: 'The carrier reads these as the actual messages you plan to send. A fragment reads as a business that has not thought about what it is sending.',
    });
  if (text.length > 320)
    issues.push({
      field: 'messageSamples',
      severity: 'blocker',
      message: 'Keep the example under 320 characters.',
      why: 'Longer than two segments and the carrier treats it as a different kind of traffic than the one you registered for.',
    });
  if (text && !sampleNamesBusiness(text, business))
    issues.push({
      field: 'messageSamples',
      severity: 'blocker',
      message: `Say your business name in the text, the way a customer would recognise it.`,
      why: 'Somebody reading the text has to know who it is from without saving your number. A carrier checks every sample for it.',
    });
  const shortener = SHORTENERS.find((s) => lower(text).includes(s));
  if (shortener)
    issues.push({
      field: 'messageSamples',
      severity: 'blocker',
      message: `Take out the ${shortener} link and write your own web address instead.`,
      why: 'Shared link shorteners are blocked by the carriers outright, because spammers use them to hide where a link goes.',
    });
  return issues;
}

/**
 * Example texts a business can start from, already carrying the things a reviewer checks for: the
 * business's name, a real reason to be texting, and STOP on the last one.
 *
 * Offered rather than imposed. A business that writes its own texts writes better ones, and a campaign
 * whose samples all read as though the same tool wrote them is its own kind of flag.
 */
export function sampleSuggestions(business: string, useCase: string): string[] {
  const who = business.trim() || 'Lone Star HVAC';
  const care = [
    `${who}: hi [First Name], your appointment is confirmed for [Date] at [Time]. Reply STOP to stop texts.`,
    `Hi [First Name], it's ${who}. Your estimate is ready — reply here and we'll send it over.`,
    `${who}: [Technician] is on the way and should be with you in about [Minutes] minutes.`,
  ];
  const marketing = [
    `${who}: spring special — $[Amount] off a tune-up booked this month. Reply here to book. Reply STOP to stop texts.`,
    `Hi [First Name], it's ${who}. It's been six months since your last service — would you like us to book the next one?`,
  ];
  if (useCase === 'marketing') return marketing;
  if (useCase === 'mixed') return [care[0]!, marketing[0]!, care[2]!];
  return care;
}

/**
 * A mixed campaign's examples have to show both kinds of text: at least one offer, and at least one about a
 * customer's own work. A reviewer approves what the examples show and nothing more.
 */
function mixedSamplesIssue(samples: readonly string[], useCase: string): A2pIssue | null {
  if (useCase !== 'mixed' || samples.length < 2) return null;
  const offers = samples.filter(readsPromotional).length;
  if (offers > 0 && offers < samples.length) return null;
  return {
    field: 'messageSamples',
    severity: 'warning',
    message:
      offers === 0
        ? 'Make one example an offer, like "$20 off a tune-up this month", and keep the other about a customer’s own job.'
        : 'Make one example about a customer’s own job, like an appointment reminder, and keep the other an offer.',
    why: 'You picked customer care and the odd promotion, so the carrier checks your examples show both. A kind of text with no example is a kind of text the campaign isn’t approved for.',
  };
}

/** Does this set of samples read like the use case the business ticked? */
function useCaseMismatch(samples: readonly string[], useCase: string): A2pIssue | null {
  if (useCase !== 'customer_care') return null;
  const hit = samples.find((s) => PROMOTIONAL.some((w) => lower(s).includes(w)));
  if (!hit) return null;
  return {
    field: 'useCase',
    severity: 'warning',
    message:
      'One of your examples reads like a promotion. Pick "customer care and occasional promotions" instead.',
    why: 'The carrier checks that your examples match the use case you picked. Promotional wording under a customer-care campaign is read as a business hiding what it really sends.',
  };
}

// ---------- the business itself ----------

/** A legal name that is really a trading name. The EIN letter is what the carrier compares against. */
function legalNameIssue(draft: A2pDraft): A2pIssue | null {
  const name = (draft.legalName ?? '').trim();
  if (name.length < 2) return null;
  const sole = draft.businessType === 'sole_proprietor';
  const hasSuffix =
    /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|pc)\b\.?/i.test(
      name,
    );
  if (sole || hasSuffix) return null;
  return {
    field: 'legalName',
    severity: 'warning',
    message: 'Is this exactly the name on your EIN letter, including LLC or Inc?',
    why: 'The carrier compares this against IRS records character by character. "Lone Star Heating" fails where "Lone Star Heating LLC" passes. If customers know you by another name (a DBA), still put the legal name here: we tell the carriers the other name too.',
    confirm: 'legal_name_exact',
  };
}

/**
 * Who the carriers are told is texting: "Go Biz Help LLC (doing business as HandsFreeOS)" for a business
 * customers know by another name (`tradingName`), or the legal name alone. Campaign descriptions start with it,
 * so the legal name the brand was checked against and the name the texts are signed with arrive together.
 */
export function senderForCarriers(legalName: string, displayName?: string | null): string {
  const dba = tradingName(legalName, displayName);
  return dba ? `${legalName.trim()} (doing business as ${dba})` : legalName.trim();
}

const EIN_RE = /^[0-9]{2}-?[0-9]{7}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * How customers reach the business, for the "Contact us" of the privacy policy and terms we host. A reviewer reads
 * the terms for a way to get help, and a policy that gives none reads as unfinished. Asked for only while one of
 * them is ours; the business's own pages say it themselves.
 */
function policyContactIssues(draft: A2pDraft): A2pIssue[] {
  const ours = !(draft.policyUrl ?? '').trim() || !(draft.termsUrl ?? '').trim();
  if (!ours) return [];
  const email = (draft.policyContact?.email ?? '').trim();
  const phone = (draft.policyContact?.phone ?? '').trim();
  const why =
    'Your privacy policy and terms say this under “Contact us”. The reviewer reads them for a way customers can reach you, and turns down pages without one.';
  if (!email && !phone)
    return [
      {
        field: 'policyContact',
        severity: 'blocker',
        message: 'Add an email address or a phone number customers can reach you at.',
        why,
      },
    ];
  const issues: A2pIssue[] = [];
  if (email && !EMAIL_RE.test(email))
    issues.push({
      field: 'policyContact',
      severity: 'blocker',
      message: `“${email}” isn’t an email address. Check it, or leave it empty and give a phone number.`,
      why,
    });
  if (phone && !normalizePhone(phone))
    issues.push({
      field: 'policyContact',
      severity: 'blocker',
      message: `“${phone}” isn’t a phone number. Check it, or leave it empty and give an email address.`,
      why,
    });
  return issues;
}

/**
 * A registration's details as they're sent (`BusinessProfile`, already read by its schema), as the checks read them.
 * The server runs `checkDraft` on what it's asked to send, not on what a screen said it found, so the wizard, the
 * Assistant and a direct call are all held to the same list.
 */
export function draftFromProfile(b: {
  readonly legalName: string;
  readonly businessType: string;
  readonly ein?: string | null;
  readonly website: string;
  readonly useCase: string;
  readonly messageSamples: readonly string[];
  readonly optInDescription: string;
  readonly monthlyVolume: string;
  readonly optInPath?: OptInPath;
  readonly optInUrl?: string | null;
  readonly optInProofUrl?: string | null;
  readonly policyUrl?: string | null;
  readonly termsUrl?: string | null;
  readonly policyContact?: { readonly email?: string; readonly phone?: string };
  readonly privacyPageUrl?: string | null;
  readonly termsPageUrl?: string | null;
  readonly displayName?: string;
  readonly sensitiveTopics?: readonly string[];
  readonly otherWays?: readonly { readonly path: OptInPath; readonly url: string }[];
}): A2pDraft {
  return {
    legalName: b.legalName,
    businessType: b.businessType,
    ein: b.ein ?? null,
    website: b.website,
    useCase: b.useCase,
    messageSamples: b.messageSamples,
    optInDescription: b.optInDescription,
    optInPath: b.optInPath,
    optInUrl: b.optInUrl ?? null,
    optInProofUrl: b.optInProofUrl ?? null,
    sensitiveTopics: b.sensitiveTopics ?? [],
    monthlyVolume: b.monthlyVolume,
    policyUrl: b.policyUrl ?? null,
    termsUrl: b.termsUrl ?? null,
    policyContact: b.policyContact ?? {},
    privacyPageUrl: b.privacyPageUrl ?? null,
    termsPageUrl: b.termsPageUrl ?? null,
    optInPageUrl: b.optInPath === 'in_person' ? (b.optInProofUrl ?? null) : (b.optInUrl ?? null),
    otherWays: b.otherWays ?? [],
    ...(b.displayName ? { displayName: b.displayName } : {}),
  };
}

/** Everything the wizard can decide about a draft without leaving the browser. */
export function checkDraft(draft: A2pDraft, business: string): A2pIssue[] {
  const issues: A2pIssue[] = [];
  const legal = legalNameIssue(draft);
  if (legal) issues.push(legal);

  const sole = draft.businessType === 'sole_proprietor';
  const ein = (draft.ein ?? '').trim();
  if (!sole && !ein)
    issues.push({
      field: 'ein',
      severity: 'blocker',
      message: 'Enter your 9-digit EIN.',
      why: 'The carrier looks your business up by EIN. Without it there is nothing to check your name and address against, and the brand is turned down.',
    });
  else if (ein && !EIN_RE.test(ein))
    issues.push({
      field: 'ein',
      severity: 'blocker',
      message: 'Use the 9-digit EIN from your IRS letter, like 12-3456789.',
      why: 'A mistyped EIN does not match any business, and the carrier reads that as a brand that cannot be verified.',
    });

  const website = (draft.website ?? '').trim();
  if (!website)
    issues.push({
      field: 'website',
      severity: 'blocker',
      message: 'Enter the web address customers would find you at.',
      why: 'A reviewer opens this page looking for what your business does and for the box customers tick. A campaign with no website to check is turned down.',
    });

  const samples = (draft.messageSamples ?? []).map((s) => s.trim()).filter(Boolean);
  if (samples.length < 2)
    issues.push({
      field: 'messageSamples',
      severity: 'blocker',
      message: 'Write two example texts.',
      why: 'A 10DLC campaign is refused outright with fewer than two, because one example does not show a pattern.',
    });
  for (const sample of samples) issues.push(...checkSample(sample, business));
  if (samples.length && !samples.some(sampleHasOptOut))
    issues.push({
      field: 'messageSamples',
      severity: 'blocker',
      message: 'Put "Reply STOP to stop texts" in at least one example.',
      why: 'The carrier checks that customers are told how to get out. Your real texts still honour STOP either way — this is about showing the reviewer that they do.',
    });
  const mismatch = useCaseMismatch(samples, draft.useCase ?? '');
  if (mismatch) issues.push(mismatch);
  const mixed = mixedSamplesIssue(samples, draft.useCase ?? '');
  if (mixed) issues.push(mixed);

  issues.push(...sensitiveIssues(draft.sensitiveTopics));

  if (!draft.optInPath)
    issues.push({
      field: 'optInPath',
      severity: 'blocker',
      message: 'Choose how customers agree to get texts.',
      why: 'This is the part of the form that is checked hardest. The reviewer opens your website looking for the box you describe here.',
    });

  if (draft.optInPath === 'own_site') {
    const page = (draft.optInUrl ?? '').trim();
    if (!page)
      issues.push({
        field: 'optInUrl',
        severity: 'blocker',
        message: 'Enter the address of the page with your tick box, like yoursite.com/contact.',
        why: 'The reviewer opens this exact page looking for the box. Your home page only counts if the box is on it.',
      });
    else if (!looksLikeWebAddress(page))
      issues.push({
        field: 'optInUrl',
        severity: 'blocker',
        message: 'Enter the page’s full web address, like yoursite.com/contact.',
        why: 'The reviewer has to be able to open it, so it has to be a real address on your website.',
      });
  }

  if (draft.optInPath === 'in_person') {
    const proof = (draft.optInProofUrl ?? '').trim();
    if (!proof)
      issues.push({
        field: 'optInProofUrl',
        severity: 'blocker',
        message:
          'Add a link to a photo of your sign-up sheet, or of the words you say on the phone, that anyone can open.',
        why: 'The reviewer can’t watch you ask in person, so they ask to see what customers see or hear. A shared Google Drive or Dropbox link works, as long as it opens without signing in.',
      });
    else if (!looksLikeWebAddress(proof))
      issues.push({
        field: 'optInProofUrl',
        severity: 'blocker',
        message: 'Enter the full link, starting with https://.',
        why: 'The reviewer opens it from the registration, so it has to be a link that works.',
      });
  }

  issues.push(...policyContactIssues(draft));

  issues.push(...otherWayIssues(draft));

  const optIn = (draft.optInDescription ?? '').trim();
  if (optIn.length < 40)
    issues.push({
      field: 'optInDescription',
      severity: 'blocker',
      message: 'Explain how customers agree to get texts.',
      why: 'A short answer here reads as a business that has not set consent up at all, which is the most common reason these are turned down.',
    });
  else {
    const gaps = descriptionGaps(optIn, draft, business);
    if (gaps.length)
      issues.push({
        field: 'optInDescription',
        severity: 'blocker',
        message: `What we tell the carriers doesn’t say ${joinList(gaps)}. Press “Use our wording” to put it back, or add ${gaps.length === 1 ? 'it' : 'them'}.`,
        why: 'The reviewer reads this for every way customers agree with where to see each one, the words customers read before agreeing (the kinds of texts, “Message frequency varies”, rates, STOP and HELP), and links to your privacy policy and terms. Leaving one out is how these get turned down (Twilio’s errors 30896 and 30924).',
      });
  }

  return issues;
}

/** "a, b and c", the way the messages list things. */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Whether `text` carries this address, with or without its https:// and a trailing slash. */
function mentionsUrl(text: string, url: string | null | undefined): boolean {
  const bare = (url ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();
  return !bare || text.toLowerCase().includes(bare);
}

/**
 * What the description sent to the carrier (its `message_flow`) leaves out of what Twilio's reviewers check it for:
 * who is texting, the kinds of texts, "Message frequency varies", rates, STOP and HELP, every page where customers
 * agree, and the privacy policy and terms. Ours says all of it; this catches a business's own edit that drops some.
 */
export function descriptionGaps(text: string, draft: A2pDraft, business: string): string[] {
  const lower = text.toLowerCase();
  const gaps: string[] = [];
  const names = [business, draft.displayName ?? '', draft.legalName ?? ''].filter((n) => n.trim());
  if (names.length && !namesBusiness(lower, names)) gaps.push('your business name');
  if (!TEXT_KINDS_RE.test(lower)) gaps.push('the kinds of texts you send');
  if (!FREQUENCY_RE.test(lower)) gaps.push('“Message frequency varies”');
  if (!RATES_RE.test(lower)) gaps.push('“Message and data rates may apply”');
  if (!/\bstop\b/.test(lower)) gaps.push('“Reply STOP to unsubscribe”');
  if (!/\bhelp\b/.test(lower)) gaps.push('“Reply HELP for help”');
  const pages = [draft.optInPageUrl, ...(draft.otherWays ?? []).map((w) => w.url)].filter(
    (u): u is string => !!u?.trim(),
  );
  const unnamed = pages.filter((u) => !mentionsUrl(text, u));
  if (unnamed.length) gaps.push(`where to see it (${joinList(unnamed)})`);
  if (draft.privacyPageUrl && !mentionsUrl(text, draft.privacyPageUrl))
    gaps.push('the link to your privacy policy');
  if (draft.termsPageUrl && !mentionsUrl(text, draft.termsPageUrl))
    gaps.push('the link to your terms');
  return gaps;
}

/** Each other way customers agree needs its own proof, and can't be the main way again. */
function otherWayIssues(draft: A2pDraft): A2pIssue[] {
  const issues: A2pIssue[] = [];
  for (const way of draft.otherWays ?? []) {
    const url = way.url.trim();
    const what =
      way.path === 'own_site'
        ? 'the page with your tick box'
        : way.path === 'in_person'
          ? 'a link to what customers see or hear'
          : 'your website chat’s sign-up page';
    if (way.path === draft.optInPath)
      issues.push({
        field: 'otherWays',
        severity: 'blocker',
        message: 'That other way is the same as the main one. Take it out of the list.',
        why: 'Each way customers agree is said once, with its own proof.',
      });
    else if (!url)
      issues.push({
        field: 'otherWays',
        severity: 'blocker',
        message: `Add ${what} for each other way customers agree, or take that way out.`,
        why: 'Twilio asks for every way customers agree, each with somewhere the reviewer can see it.',
      });
    else if (!looksLikeWebAddress(url))
      issues.push({
        field: 'otherWays',
        severity: 'blocker',
        message: `“${url}” isn’t a web address. Enter the full link, like https://yoursite.com/contact.`,
        why: 'The reviewer opens it from the registration, so it has to be a link that works.',
      });
  }
  return issues;
}

/** A web address someone could open: a dot in the host, and nothing a browser would refuse. */
function looksLikeWebAddress(raw: string): boolean {
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('.') && !/\s/.test(raw);
  } catch {
    return false;
  }
}

/** What the answer to the sensitive-topics question means for the registration. */
function sensitiveIssues(topics: readonly string[] | null | undefined): A2pIssue[] {
  if (topics == null)
    return [
      {
        field: 'sensitiveTopics',
        severity: 'blocker',
        message: 'Tell us whether your texts are about any of these, or pick “None of these”.',
        why: 'The carriers handle some kinds of business differently. Saying so now is better than finding out from a rejection.',
      },
    ];
  const issues: A2pIssue[] = [];
  const refused = SENSITIVE_TOPICS.filter((t) => t.kind === 'refused' && topics.includes(t.id));
  if (refused.length)
    issues.push({
      field: 'sensitiveTopics',
      severity: 'blocker',
      message: `The carriers don’t approve texting about ${refused.map((t) => t.label.toLowerCase()).join(' or ')} on a business registration like this one. If your texts won’t be about it, untick it.`,
      why: 'These are on the carriers’ list of restricted or forbidden kinds of texting. A registration that includes them is turned down, and a number caught sending them is shut off.',
    });
  const aged = SENSITIVE_TOPICS.filter((t) => t.kind === 'age' && topics.includes(t.id));
  if (aged.length)
    issues.push({
      field: 'sensitiveTopics',
      severity: 'warning',
      message: `Texts about ${aged.map((t) => t.label.toLowerCase()).join(' or ')} are only allowed to people whose age you have checked. Ask for it before they agree, or leave these out of your texts.`,
      why: 'We tell the carriers these texts are age-gated. They check the page where people agree for an age question, and they look harder at the whole registration.',
      confirm: 'ages_checked',
    });
  if (topics.includes('lending'))
    issues.push({
      field: 'sensitiveTopics',
      severity: 'warning',
      message: 'Lending is allowed, but expect extra questions and a slower answer.',
      why: 'We tell the carriers your texts are about loans you make yourself. They check lenders more closely than other businesses.',
      confirm: 'lending_ok',
    });
  return issues;
}

/** True when nothing found will stop the carrier taking it. Warnings do not count. */
export const hasBlockers = (issues: readonly A2pIssue[]): boolean =>
  issues.some((i) => i.severity === 'blocker');

/** The issues for one field, so the wizard can show them under it. */
export const issuesFor = (issues: readonly A2pIssue[], field: A2pField): A2pIssue[] =>
  issues.filter((i) => i.field === field);
