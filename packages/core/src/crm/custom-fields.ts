/**
 * Fields a business invents (M15, 0076): on customers, companies and leads, and since 0101 on each kind of record a
 * business makes up (a pet's breed, a car's plate). Browser-safe, so the field editor, the record page, the phone
 * and the server agree on three things: what each type of field holds, how a value is checked before it is written,
 * and how it reads on a page.
 *
 * The values live on the record itself (`custom`, keyed by the field's id), in the shapes the importer and forms
 * already write: text as text, a number or an amount of money as a number (money in dollars, as a form's money
 * question answers), a date as YYYY-MM-DD, a choice as its option's value, several choices as a list of them, and
 * yes or no as a boolean.
 */
import { money } from '../money/format';
import { formatDateOnly } from './format';
import { formatPhone, normalizePhone } from './phone';

export const CUSTOM_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'choice',
  'multi_choice',
  'boolean',
  'phone',
  'email',
  'url',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** What a field can be on: a customer, a company, a lead, or a record of a kind the business made up. */
export const CUSTOM_FIELD_ENTITIES = ['person', 'company', 'lead', 'custom_record'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export type CustomFieldOption = {
  readonly value: string;
  readonly label: string;
};

/** What a value is checked against and read with. */
export interface CustomFieldShape {
  readonly id: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly options: readonly CustomFieldOption[];
}

/** The field editor's words for each type, in the order it offers them. */
export const CUSTOM_FIELD_TYPE_LABELS: Readonly<Record<CustomFieldType, string>> = {
  text: 'Short text',
  long_text: 'Long text',
  number: 'Number',
  money: 'Amount of money',
  date: 'Date',
  choice: 'One choice from a list',
  multi_choice: 'Several choices from a list',
  boolean: 'Yes or no',
  phone: 'Phone number',
  email: 'Email address',
  url: 'Web address',
};

/** Whether the type picks from the field's own list of options. */
export const hasOptions = (type: CustomFieldType): boolean =>
  type === 'choice' || type === 'multi_choice';

/** How long a typed value may be: a line for short text, a page for long text. */
export const CUSTOM_TEXT_MAX = 500;
export const CUSTOM_LONG_TEXT_MAX = 5000;

/**
 * The short name a field is known by in imports, exports and the API: "Gate code" → "gate_code". Lower-case
 * letters, digits and underscores, starting with a letter, at most 40 long (0076's rule); `taken` are the keys
 * already used on the same kind of record, and a clash gets a number on the end.
 */
export function keyFromLabel(label: string, taken: Iterable<string> = []): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^[^a-z]+/, '')
      .replace(/_+$/g, '')
      .slice(0, 40)
      .replace(/_+$/g, '') || 'field';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const key = `${base.slice(0, 40 - suffix.length).replace(/_+$/g, '')}${suffix}`;
    if (!used.has(key)) return key;
  }
}

/** An option's value from its label, unique among the others: "Every other week" → "every_other_week". */
export function optionValueFrom(label: string, taken: Iterable<string> = []): string {
  return keyFromLabel(label, taken);
}

export type CustomValueCheck =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

const ok = (value: unknown): CustomValueCheck => ({ ok: true, value });
const refuse = (message: string): CustomValueCheck => ({ ok: false, message });

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Nothing there: no value, blank text or an empty list. Writing it takes the value off the record. */
export function customValueIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * A value as the field keeps it, or why it can't be: text trimmed, a number as a number, money rounded to the cent,
 * a day as YYYY-MM-DD, a choice as one of the field's own options, a phone in the business's usual format, a web
 * address with its https://. An empty value is fine (it clears the field) and comes back as null.
 */
export function checkCustomValue(field: CustomFieldShape, raw: unknown): CustomValueCheck {
  if (customValueIsEmpty(raw)) return ok(null);
  const text = typeof raw === 'string' ? raw.trim() : null;
  switch (field.type) {
    case 'text':
    case 'long_text': {
      if (text === null) return refuse('Type some words here.');
      const max = field.type === 'text' ? CUSTOM_TEXT_MAX : CUSTOM_LONG_TEXT_MAX;
      return text.length > max ? refuse(`Keep it under ${max} characters.`) : ok(text);
    }
    case 'number':
    case 'money': {
      const n =
        typeof raw === 'number' ? raw : text !== null ? Number(text.replace(/[$,\s]/g, '')) : NaN;
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) return refuse('Enter a number.');
      return ok(field.type === 'money' ? Math.round(n * 100) / 100 : n);
    }
    case 'date': {
      const m = text === null ? null : DAY.exec(text.slice(0, 10));
      if (!m) return refuse('Pick a date.');
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3]))
        return refuse('Pick a date.');
      return ok(text!.slice(0, 10));
    }
    case 'choice': {
      if (text === null || !field.options.some((o) => o.value === text))
        return refuse('Pick one of the choices.');
      return ok(text);
    }
    case 'multi_choice': {
      const list = Array.isArray(raw) ? raw : [raw];
      const picked = [...new Set(list.map((v) => (typeof v === 'string' ? v.trim() : v)))];
      if (!picked.every((v) => typeof v === 'string' && field.options.some((o) => o.value === v)))
        return refuse('Pick from the choices.');
      return ok(picked);
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return ok(raw);
      if (text === 'true' || text === 'yes') return ok(true);
      if (text === 'false' || text === 'no') return ok(false);
      return refuse('Pick yes or no.');
    }
    case 'phone': {
      const e164 = text === null ? null : normalizePhone(text);
      return e164 ? ok(formatPhone(e164)) : refuse('Enter a valid phone number.');
    }
    case 'email': {
      if (text === null || text.length > 254 || !EMAIL.test(text))
        return refuse('Enter a valid email address.');
      return ok(text.toLowerCase());
    }
    case 'url': {
      if (text === null || text.length > CUSTOM_TEXT_MAX) return refuse('Enter a web address.');
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
      try {
        const url = new URL(withScheme);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.'))
          return refuse('Enter a web address.');
        return ok(withScheme);
      } catch {
        return refuse('Enter a web address.');
      }
    }
  }
}

/**
 * How a value reads on a page: a choice's label, "Yes" or "No", a day as "Sep 18, 2027", money as "$1,250". A
 * value that no longer fits its field (a choice since taken off the list, text in a number field from an old
 * import) is shown as it was stored rather than hidden. Nothing for an empty value.
 */
export function customValueText(field: CustomFieldShape, value: unknown): string | null {
  if (customValueIsEmpty(value)) return null;
  const label = (v: unknown) => field.options.find((o) => o.value === v)?.label ?? String(v);
  switch (field.type) {
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'money':
      return typeof value === 'number' ? money(Math.round(value * 100)) : String(value);
    case 'number':
      return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
    case 'date':
      return typeof value === 'string' && DAY.test(value) ? formatDateOnly(value) : String(value);
    case 'choice':
      return label(value);
    case 'multi_choice':
      return (Array.isArray(value) ? value : [value]).map(label).join(', ');
    default:
      return Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
}

/**
 * The line under a record's name in a list: its first few filled-in fields, in the order the business put them,
 * "Golden retriever · 4 years". Nothing when none is filled in.
 */
export function customSummary(
  fields: readonly CustomFieldShape[],
  values: Readonly<Record<string, unknown>>,
  count = 2,
): string | null {
  const shown: string[] = [];
  for (const field of fields) {
    if (field.type === 'long_text') continue;
    const text = customValueText(field, values[field.id]);
    if (text) shown.push(text.length > 60 ? `${text.slice(0, 59)}…` : text);
    if (shown.length >= count) break;
  }
  return shown.length ? shown.join(' · ') : null;
}
