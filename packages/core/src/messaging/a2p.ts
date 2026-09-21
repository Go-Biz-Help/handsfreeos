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
import { STOP_KEYWORDS } from './sms';
import type { OptInPath } from './consent';

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
  | 'monthlyVolume';

export interface A2pIssue {
  readonly field: A2pField;
  readonly severity: IssueSeverity;
  /** What is wrong, said to the business in its own words. */
  readonly message: string;
  /** Why the carrier cares. Shown under the message, because "because they said so" teaches nobody. */
  readonly why: string;
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
  readonly monthlyVolume?: string;
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
    `${who}: your appointment is confirmed for Thursday at 10am. Reply STOP to stop texts.`,
    `Hi, it's ${who}. Your estimate is ready — reply here and we'll send it over.`,
    `${who}: our technician is on the way and should be with you in about 20 minutes.`,
  ];
  const marketing = [
    `${who}: we have two service slots left this week. Reply here to take one. Reply STOP to stop texts.`,
    `Hi, it's ${who}. It's been six months since your last service — would you like us to book the next one?`,
  ];
  if (useCase === 'marketing') return marketing;
  if (useCase === 'mixed') return [care[0]!, marketing[1]!, care[2]!];
  return care;
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
    why: 'The carrier compares this against IRS records character by character. "Lone Star Heating" fails where "Lone Star Heating LLC" passes.',
  };
}

const EIN_RE = /^[0-9]{2}-?[0-9]{7}$/;

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

  if (!draft.optInPath)
    issues.push({
      field: 'optInPath',
      severity: 'blocker',
      message: 'Choose how customers agree to get texts.',
      why: 'This is the part of the form that is checked hardest. The reviewer opens your website looking for the box you describe here.',
    });

  const optIn = (draft.optInDescription ?? '').trim();
  if (optIn.length < 40)
    issues.push({
      field: 'optInDescription',
      severity: 'blocker',
      message: 'Explain how customers agree to get texts.',
      why: 'A short answer here reads as a business that has not set consent up at all, which is the most common reason these are turned down.',
    });

  return issues;
}

/** True when nothing found will stop the carrier taking it. Warnings do not count. */
export const hasBlockers = (issues: readonly A2pIssue[]): boolean =>
  issues.some((i) => i.severity === 'blocker');

/** The issues for one field, so the wizard can show them under it. */
export const issuesFor = (issues: readonly A2pIssue[], field: A2pField): A2pIssue[] =>
  issues.filter((i) => i.field === field);
