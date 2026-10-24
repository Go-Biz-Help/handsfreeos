/**
 * Facebook and Instagram lead ads (funnels): somebody fills in the form on a business's lead ad, and Meta keeps
 * their answers for the business's Page. What their answers mean here is worked out once, in this file, for the
 * worker that reads them and the screens that show them. Browser-safe.
 *
 * - **Answers.** Meta names its own questions (`full_name`, `phone_number`, `zip_code` …); those fill the customer.
 *   A business's own questions are named by Meta from their words, and keep the words the form showed.
 * - **Consent.** A lead form's own tick boxes ("custom disclaimer") come back by key. A ticked box whose words are
 *   about texts is the customer's OK to text; nothing else is.
 * - **Access.** Whether a Page's leads can be read: a sign-in that didn't allow it, or a Page whose Leads Access
 *   keeps HandsFreeOS out, says what to do.
 */

/** One answer on a lead, as Meta sends it: the question's name and what was picked or typed. */
export interface LeadAnswer {
  readonly name: string;
  readonly values: readonly string[];
}

/** A question on the form, by Meta's name for it, and the words the form showed. */
export interface LeadQuestion {
  readonly key: string;
  readonly label: string;
}

/** What a lead tells intake: the same fields a website form sends, and everything else in its own words. */
export interface LeadPayload {
  readonly name: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
  } | null;
  /** The rest, by the words the form showed, at most 30. */
  readonly extra: Readonly<Record<string, string>>;
}

/** Meta's own questions that fill the customer, and the field each fills. */
const STANDARD: Readonly<
  Record<string, keyof Omit<LeadPayload, 'address' | 'extra'> | AddressPart>
> = {
  full_name: 'name',
  first_name: 'firstName',
  last_name: 'lastName',
  email: 'email',
  work_email: 'email',
  phone_number: 'phone',
  work_phone_number: 'phone',
  street_address: 'line1',
  city: 'city',
  state: 'state',
  province: 'state',
  zip_code: 'postalCode',
  post_code: 'postalCode',
  zip: 'postalCode',
};
type AddressPart = 'line1' | 'city' | 'state' | 'postalCode';
const ADDRESS: ReadonlySet<string> = new Set(['line1', 'city', 'state', 'postalCode']);

/** How Meta's other standard questions read, when the form didn't say. */
const STANDARD_WORDS: Readonly<Record<string, string>> = {
  job_title: 'Job title',
  company_name: 'Company',
  country: 'Country',
  date_of_birth: 'Date of birth',
  gender: 'Gender',
  marital_status: 'Marital status',
  relationship_status: 'Relationship status',
  military_status: 'Military status',
};

/** The most a lead keeps beside its contact details: what a website form may send. */
export const LEAD_EXTRA_MAX = 30;

/** "what_is_your_budget?" → "What is your budget?": a question's name, when the form's words aren't known. */
export function leadQuestionWords(key: string): string {
  const words = key.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Answer';
}

const said = (values: readonly string[]): string =>
  values
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(', ');

/** A lead's answers as intake takes them. Meta's names fill the customer; every other answer keeps its words. */
export function leadPayload(
  answers: readonly LeadAnswer[],
  questions: readonly LeadQuestion[] = [],
): LeadPayload {
  const labels = new Map(questions.map((q) => [q.key, q.label.trim()]));
  const out: Record<string, string | null> = {
    name: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
  };
  const address: Record<AddressPart, string | null> = {
    line1: null,
    city: null,
    state: null,
    postalCode: null,
  };
  const extra: Record<string, string> = {};
  for (const a of answers) {
    const value = said(a.values);
    if (!value) continue;
    const field = STANDARD[a.name.toLowerCase()];
    if (field && ADDRESS.has(field)) address[field as AddressPart] ??= value.slice(0, 200);
    else if (field) out[field] ??= value.slice(0, field === 'email' ? 320 : 160);
    else if (Object.keys(extra).length < LEAD_EXTRA_MAX) {
      const label = (
        labels.get(a.name) ||
        STANDARD_WORDS[a.name.toLowerCase()] ||
        leadQuestionWords(a.name)
      ).slice(0, 80);
      extra[label] = extra[label]
        ? `${extra[label]}; ${value}`.slice(0, 2000)
        : value.slice(0, 2000);
    }
  }
  const hasAddress = Object.values(address).some(Boolean);
  return {
    name: out['name'] ?? null,
    firstName: out['firstName']?.slice(0, 80) ?? null,
    lastName: out['lastName']?.slice(0, 80) ?? null,
    email: out['email'] ?? null,
    phone: out['phone']?.slice(0, 40) ?? null,
    address: hasAddress
      ? { ...address, postalCode: address.postalCode?.slice(0, 20) ?? null }
      : null,
    extra,
  };
}

const ABOUT_TEXTS =
  /\b(texts?|texting|texted|sms|txt|text messages?|mobile messages?|messag(e|es|ing) (and|&|or) data rates)\b/i;

/** Whether a lead form's tick box asks for the OK to text: its words name texts or SMS. */
export function isTextConsentBox(words: string): boolean {
  return ABOUT_TEXTS.test(words);
}

/** The form's tick boxes that are about texts, by key. */
export function textConsentKeys(
  boxes: readonly { readonly key: string; readonly text: string }[],
): string[] {
  return [...new Set(boxes.filter((b) => b.key && isTextConsentBox(b.text)).map((b) => b.key))];
}

/** Whether the lead ticked a box about texts. */
export function leadAgreedToTexts(
  consents: readonly { readonly key: string; readonly checked: boolean }[],
  textKeys: readonly string[],
): boolean {
  const keys = new Set(textKeys);
  return consents.some((c) => c.checked && keys.has(c.key));
}

/** Where a customer's OK to text came from, as their record says it. */
export const leadConsentSource = (formName: string): string =>
  `Facebook lead form: ${formName.trim() || 'a lead ad'}`.slice(0, 200);

/** Whether HandsFreeOS can read a Page's leads: not yet known, yes, not allowed at sign-in, or kept out by the Page. */
export type LeadsAccess = 'unknown' | 'ok' | 'not_allowed' | 'blocked';

/**
 * What Settings says about a Page's leads, and what to do when they can't be read. Null when there's nothing to
 * say yet.
 */
export function leadsAccessWords(
  access: LeadsAccess,
  page: string,
): { readonly ok: boolean; readonly words: string } | null {
  switch (access) {
    case 'ok':
      return { ok: true, words: `Leads from ${page}’s lead ads come in here.` };
    case 'not_allowed':
      return {
        ok: false,
        words: `The Facebook sign-in for ${page} didn’t allow reading leads. Connect again and leave “Leads” ticked.`,
      };
    case 'blocked':
      return {
        ok: false,
        words: `Facebook is keeping ${page}’s leads from HandsFreeOS. In Meta Business Suite, open Settings → Leads Access and add HandsFreeOS.`,
      };
    default:
      return null;
  }
}
