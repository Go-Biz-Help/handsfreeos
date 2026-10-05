/**
 * The AI's upkeep of a customer's tags and contact details (0107): what it may answer, and the rules its answer
 * goes through before anything changes. The worker asks (apps/worker/src/contact-ai), this decides what of the
 * answer is done, and the commands do it, so every change has its event and its audit row like a person's.
 *
 * What the rules hold, whatever the AI says:
 * - **Only the business's own tags**, by name, and only the ones the pass may use. It never makes a tag up.
 * - **A tag a person put on stays on.** The AI takes off only tags HandsFreeOS itself put on (the AI, a workflow,
 *   the AI teammate): someone on the team decided the rest.
 * - **A detail it writes is one it read.** A new email, number, name or address must be in what the customer or
 *   the team actually wrote or said: texts, emails, call transcripts, form answers, notes. Never an unverified
 *   website chat, where anybody can say they're anybody, and never a guess.
 * - **Nothing on file is lost.** A main email or number it replaces moves to the other emails or numbers,
 *   labelled "Previous", and every change keeps its before and after in the audit log.
 *
 * Browser-safe and pure: the worker, the tests and the screens read the same rules.
 */
import { z } from 'zod';
import type { OtherEmail, OtherPhone } from '../crm/contact-points';
import { normalizePhone } from '../crm/phone';

/** The details the AI may change, one at a time. */
export const CONTACT_AI_DETAIL_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'otherEmail',
  'otherPhone',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
] as const;
export type ContactAiDetailField = (typeof CONTACT_AI_DETAIL_FIELDS)[number];

/** Each detail as a person reads it ("changed the email"). */
export const CONTACT_AI_DETAIL_LABELS: Readonly<Record<ContactAiDetailField, string>> = {
  firstName: 'first name',
  lastName: 'last name',
  email: 'email',
  phone: 'phone number',
  otherEmail: 'other email',
  otherPhone: 'other number',
  addressLine1: 'street address',
  addressLine2: 'address line 2',
  city: 'city',
  state: 'state',
  postalCode: 'ZIP code',
};

/** The longest each may be, as the customer columns hold them. */
const MAX_LENGTH: Readonly<Record<ContactAiDetailField, number>> = {
  firstName: 80,
  lastName: 80,
  email: 254,
  phone: 40,
  otherEmail: 254,
  otherPhone: 40,
  addressLine1: 200,
  addressLine2: 200,
  city: 100,
  state: 50,
  postalCode: 20,
};

/** The label a replaced main email or number keeps in the other ones. */
export const CONTACT_AI_PREVIOUS_LABEL = 'Previous';

/** The most tags or details the AI changes on one customer in one look. */
export const CONTACT_AI_MAX_CHANGES = 10;

const reason = z.string().trim().min(1).max(300);
const TagChange = z.object({ tag: z.string().trim().min(1).max(40), reason });
const DetailChange = z.object({
  field: z.enum(CONTACT_AI_DETAIL_FIELDS),
  /** set: add it or change it to `value`; remove: take it off (for the other ones, the one in `value`). */
  action: z.enum(['set', 'remove']),
  value: z.string().trim().max(300).nullable(),
  reason,
});

/** What the AI answers about one customer: tags to put on and take off, and details, each with its reason. */
export const ContactAiDecision = z.object({
  addTags: z.array(TagChange).max(CONTACT_AI_MAX_CHANGES),
  removeTags: z.array(TagChange).max(CONTACT_AI_MAX_CHANGES),
  details: z.array(DetailChange).max(CONTACT_AI_MAX_CHANGES),
});
export type ContactAiDecision = z.infer<typeof ContactAiDecision>;

const TAG_CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tag', 'reason'],
  properties: {
    tag: { type: 'string', description: 'The tag’s name, exactly as listed' },
    reason: { type: 'string', description: 'Why, in one short sentence a person can check' },
  },
};

/** The same answer as JSON Schema, for the provider. */
export const CONTACT_AI_DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['addTags', 'removeTags', 'details'],
  properties: {
    addTags: { type: 'array', items: TAG_CHANGE_SCHEMA },
    removeTags: { type: 'array', items: TAG_CHANGE_SCHEMA },
    details: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'action', 'value', 'reason'],
        properties: {
          field: { type: 'string', enum: [...CONTACT_AI_DETAIL_FIELDS] },
          action: { type: 'string', enum: ['set', 'remove'] },
          value: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/** An answer that changes nothing. */
export const NO_CONTACT_AI_CHANGES: ContactAiDecision = {
  addTags: [],
  removeTags: [],
  details: [],
};

/** A tag the AI may use. */
export interface ContactAiTagOption {
  readonly id: string;
  readonly name: string;
}

/** The customer as the AI's answer is checked against: their details now, and the tags on them. */
export interface ContactAiSnapshot {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phoneE164: string | null;
  readonly otherEmails: readonly OtherEmail[];
  readonly otherPhones: readonly OtherPhone[];
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
  };
  /** `byPerson`: someone on the team put it on (record_tags.created_by), so the AI leaves it. */
  readonly tags: readonly {
    readonly id: string;
    readonly name: string;
    readonly byPerson: boolean;
  }[];
}

export interface ContactAiPlanOptions {
  /** The tags it may put on or take off: the business's, or the ones a pass was given. */
  readonly tags: readonly ContactAiTagOption[];
  /** Whether it may change details at all ("Keep contact details up to date", or the pass's choice). */
  readonly details: boolean;
  /**
   * Everything the customer and the team are known to have written or said: never an unverified website chat, a
   * public form or the notes on file. A detail it sets must be found here; with nothing here, it changes no details.
   */
  readonly trustedText: string;
}

/** The details part of person.update's input, as the AI's answer leaves it. */
export interface ContactAiPersonPatch {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  otherEmails?: { email: string; label?: string }[];
  otherPhones?: { phone: string; label?: string }[];
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  };
}

export interface ContactAiTagStep {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

export interface ContactAiDetailStep {
  readonly field: ContactAiDetailField;
  readonly action: 'set' | 'remove';
  readonly from: string | null;
  readonly to: string | null;
  readonly reason: string;
}

/** What of the AI's answer is done, and what is left alone and why (both are written down). */
export interface ContactAiPlan {
  readonly addTags: readonly ContactAiTagStep[];
  readonly removeTags: readonly ContactAiTagStep[];
  readonly details: readonly ContactAiDetailStep[];
  /** person.update's details, or null when no detail changes. */
  readonly personPatch: ContactAiPersonPatch | null;
  readonly skipped: readonly { readonly what: string; readonly why: string }[];
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The numbers written in some text, as E.164. */
function phonesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/\+?\(?\d[\d\s().-]{5,}\d/g)) {
    const e164 = normalizePhone(m[0]);
    if (e164) found.add(e164);
  }
  return found;
}

/** Whether words the AI quoted are in the text it read, word for word, ignoring case and spacing. */
export function quoteFoundIn(quote: string, text: string): boolean {
  if (!quote.trim() || !text.trim()) return false;
  return squash(text).includes(squash(quote));
}

/**
 * Whether a value the AI wants to write is in what was really written or said: a number as a number (however it
 * was typed), anything else word for word, ignoring case and spacing.
 */
export function foundInWords(field: ContactAiDetailField, value: string, text: string): boolean {
  if (!value.trim() || !text.trim()) return false;
  if (field === 'phone' || field === 'otherPhone') {
    const e164 = normalizePhone(value);
    return !!e164 && phonesIn(text).has(e164);
  }
  return quoteFoundIn(value, text);
}

const isEmail = (v: string): boolean => z.email().safeParse(v).success;

type AddressPart = 'line1' | 'line2' | 'city' | 'state' | 'postalCode';
const ADDRESS_PART: Partial<Record<ContactAiDetailField, AddressPart>> = {
  addressLine1: 'line1',
  addressLine2: 'line2',
  city: 'city',
  state: 'state',
  postalCode: 'postalCode',
};

/**
 * The AI's answer, checked: the tags it may change and the details it may write, with person.update's input for
 * them, and a line for everything it said that is left alone. Adding a tag the customer has, or setting a detail
 * to what it already is, is neither done nor noted.
 */
export function planContactChanges(
  decision: ContactAiDecision,
  current: ContactAiSnapshot,
  options: ContactAiPlanOptions,
): ContactAiPlan {
  const skipped: { what: string; why: string }[] = [];
  const allowed = new Map(options.tags.map((t) => [t.name.trim().toLowerCase(), t]));
  const on = new Map(current.tags.map((t) => [t.id, t]));
  const key = (name: string) => name.trim().toLowerCase();
  const both = new Set(
    decision.addTags
      .map((t) => key(t.tag))
      .filter((k) => decision.removeTags.some((r) => key(r.tag) === k)),
  );
  for (const k of both) skipped.push({ what: `the tag “${k}”`, why: 'it said both on and off' });

  const addTags: ContactAiTagStep[] = [];
  for (const t of decision.addTags) {
    if (both.has(key(t.tag))) continue;
    const tag = allowed.get(key(t.tag));
    if (!tag) {
      skipped.push({ what: `the tag “${t.tag}”`, why: 'it isn’t one of the tags it may use' });
      continue;
    }
    if (on.has(tag.id) || addTags.some((a) => a.id === tag.id)) continue;
    addTags.push({ id: tag.id, name: tag.name, reason: t.reason });
  }

  const removeTags: ContactAiTagStep[] = [];
  for (const t of decision.removeTags) {
    if (both.has(key(t.tag))) continue;
    const tag = allowed.get(key(t.tag));
    if (!tag) {
      skipped.push({ what: `taking off “${t.tag}”`, why: 'it isn’t one of the tags it may use' });
      continue;
    }
    const has = on.get(tag.id);
    if (!has || removeTags.some((r) => r.id === tag.id)) continue;
    if (has.byPerson) {
      skipped.push({ what: `taking off “${tag.name}”`, why: 'someone on the team put it on' });
      continue;
    }
    removeTags.push({ id: tag.id, name: tag.name, reason: t.reason });
  }

  const details: ContactAiDetailStep[] = [];
  const patch: ContactAiPersonPatch = {};
  const touched = new Set<ContactAiDetailField>();
  let email = current.email;
  let phone = current.phoneE164;
  let otherEmails: { email: string; label?: string }[] = current.otherEmails.map((e) => ({
    email: e.email,
    ...(e.label ? { label: e.label } : {}),
  }));
  let otherPhones: { phone: string; label?: string }[] = current.otherPhones.map((p) => ({
    phone: p.phone,
    ...(p.label ? { label: p.label } : {}),
  }));
  let emailsChanged = false;
  let phonesChanged = false;
  const noDetails = !options.details
    ? 'keeping contact details up to date is switched off'
    : !options.trustedText.trim()
      ? 'there’s nothing the customer or the team is known to have written to go on'
      : null;

  for (const d of decision.details) {
    const label = CONTACT_AI_DETAIL_LABELS[d.field];
    const what = `the ${label}`;
    if (noDetails) {
      skipped.push({ what, why: noDetails });
      continue;
    }
    const lists = d.field === 'otherEmail' || d.field === 'otherPhone';
    if (touched.has(d.field) && !lists) {
      skipped.push({ what, why: 'it changed it once already' });
      continue;
    }
    const raw = (d.value ?? '').trim();
    if (d.action === 'set' || lists) {
      if (!raw) {
        skipped.push({ what, why: 'it gave no value' });
        continue;
      }
      if (raw.length > MAX_LENGTH[d.field]) {
        skipped.push({ what, why: 'it’s too long' });
        continue;
      }
    }
    if (d.action === 'set' && !foundInWords(d.field, raw, options.trustedText)) {
      skipped.push({ what, why: 'it isn’t in anything the customer or the team wrote or said' });
      continue;
    }
    const step = (from: string | null, to: string | null) => {
      details.push({ field: d.field, action: d.action, from, to, reason: d.reason });
      touched.add(d.field);
    };

    switch (d.field) {
      case 'firstName':
      case 'lastName': {
        if (d.action === 'remove') {
          skipped.push({ what, why: 'a customer always keeps their name' });
          break;
        }
        const now = d.field === 'firstName' ? current.firstName : current.lastName;
        if (now.trim() === raw) break;
        patch[d.field] = raw;
        step(now || null, raw);
        break;
      }
      case 'email': {
        if (d.action === 'remove') {
          if (!email) break;
          step(email, null);
          patch.email = null;
          email = null;
          break;
        }
        const next = raw.toLowerCase();
        if (!isEmail(next)) {
          skipped.push({ what, why: 'it isn’t an email address' });
          break;
        }
        if (next === email) break;
        if (email) otherEmails = [...otherEmails, { email, label: CONTACT_AI_PREVIOUS_LABEL }];
        otherEmails = otherEmails.filter((e) => e.email !== next);
        emailsChanged = true;
        step(email, next);
        patch.email = next;
        email = next;
        break;
      }
      case 'phone': {
        if (d.action === 'remove') {
          if (!phone) break;
          step(phone, null);
          patch.phone = null;
          phone = null;
          break;
        }
        const next = normalizePhone(raw);
        if (!next) {
          skipped.push({ what, why: 'it isn’t a phone number' });
          break;
        }
        if (next === phone) break;
        if (phone) otherPhones = [...otherPhones, { phone, label: CONTACT_AI_PREVIOUS_LABEL }];
        otherPhones = otherPhones.filter((p) => p.phone !== next);
        phonesChanged = true;
        step(phone, next);
        patch.phone = next;
        phone = next;
        break;
      }
      case 'otherEmail': {
        const value = raw.toLowerCase();
        if (!isEmail(value)) {
          skipped.push({ what, why: 'it isn’t an email address' });
          break;
        }
        const has = otherEmails.some((e) => e.email === value);
        if (d.action === 'remove') {
          if (!has) break;
          otherEmails = otherEmails.filter((e) => e.email !== value);
          emailsChanged = true;
          step(value, null);
          break;
        }
        if (has || value === email) break;
        otherEmails = [...otherEmails, { email: value }];
        emailsChanged = true;
        step(null, value);
        break;
      }
      case 'otherPhone': {
        const value = normalizePhone(raw);
        if (!value) {
          skipped.push({ what, why: 'it isn’t a phone number' });
          break;
        }
        const has = otherPhones.some((p) => p.phone === value);
        if (d.action === 'remove') {
          if (!has) break;
          otherPhones = otherPhones.filter((p) => p.phone !== value);
          phonesChanged = true;
          step(value, null);
          break;
        }
        if (has || value === phone) break;
        otherPhones = [...otherPhones, { phone: value }];
        phonesChanged = true;
        step(null, value);
        break;
      }
      default: {
        const part = ADDRESS_PART[d.field]!;
        const now = current.address[part];
        if (d.action === 'remove') {
          if (!now) break;
          patch.address = { ...patch.address, [part]: null };
          step(now, null);
          break;
        }
        if (now && squash(now) === squash(raw)) break;
        patch.address = { ...patch.address, [part]: raw };
        step(now, raw);
      }
    }
  }
  if (emailsChanged) patch.otherEmails = otherEmails;
  if (phonesChanged) patch.otherPhones = otherPhones;
  return {
    addTags,
    removeTags,
    details,
    personPatch: details.length ? patch : null,
    skipped,
  };
}

/** Whether a plan changes anything. */
export const planChanges = (plan: ContactAiPlan): boolean =>
  plan.addTags.length + plan.removeTags.length + plan.details.length > 0;

/** One detail change as the audit log's reason says it: "email: moved to their work address". */
export const detailReason = (steps: readonly ContactAiDetailStep[]): string =>
  steps
    .map((s) => `${CONTACT_AI_DETAIL_LABELS[s.field]}: ${s.reason}`)
    .join('; ')
    .slice(0, 1000);
