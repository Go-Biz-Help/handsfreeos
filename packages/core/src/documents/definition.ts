/**
 * A document's definition (`DocumentDefinition`, version 1): a PDF's pages, who signs it (its roles, in signing
 * order), the fields placed on it for each of them, the words of the PDF typed over (the owner's answer 26c), and its
 * settings. A template keeps one; a sent document keeps its own copy, with that customer's own changes (27a) and what
 * was filled in before it went (`presets`).
 *
 * - **Positions are fractions of the page** (0 to 1 from the top left), so the editor, the signing page, the phone
 *   and the signed PDF agree whatever size each draws it at.
 * - **Pages come from the PDF**, never from an editor: `document_template.set_source` reads them in.
 * - **The `sender` role** is the business before it sends: its fields are filled in on the Send screen, from
 *   HandsFreeOS (`fillFrom`) or by hand, and are part of the copy that goes out.
 *
 * Browser-safe, so the editor checks a template with the same schema the server saves it with.
 */
import { z } from 'zod';

export const DOCUMENT_DEFINITION_VERSION = 1;

export const MAX_DOCUMENT_PAGES = 100;
export const MAX_DOCUMENT_ROLES = 10;
export const MAX_DOCUMENT_FIELDS = 300;
export const MAX_DOCUMENT_EDITS = 300;
export const MAX_DOCUMENT_COPIES = 10;

/** A signer's role: lowercase, as it's kept on each signer (`document_signers.role_key`). */
export const DocumentRoleKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, { error: 'A role key is lowercase letters, digits and _.' });
/** The business itself, filling in its part before it sends. Never a signer. */
export const SENDER_ROLE = 'sender';

/** A field's or a word edit's id, made once by the editor and never changed (`document_values.field_id`). */
export const DocumentItemId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, { error: 'An id is up to 40 letters, digits, _ or -.' });

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomChars(count: number, random?: () => number): string {
  let out = '';
  if (random) {
    for (let i = 0; i < count; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
    return out;
  }
  // Bytes from 252 up are thrown away, so each of the 36 characters is as likely as the next.
  const fair = 256 - (256 % ALPHABET.length);
  while (out.length < count) {
    for (const b of crypto.getRandomValues(new Uint8Array(count))) {
      if (b < fair && out.length < count) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}
/** A new field's id: `f_` and 8 letters or digits. */
export const newFieldId = (random?: () => number) => `f_${randomChars(8, random)}`;
/** A new word edit's id: `e_` and 8 letters or digits. */
export const newEditId = (random?: () => number) => `e_${randomChars(8, random)}`;

// ---------- who signs ----------

/** customer: someone the business sends it to. team: someone from the business signing too (answer 9b). */
export const DOCUMENT_ROLE_KINDS = ['customer', 'team'] as const;
export type DocumentRoleKind = (typeof DOCUMENT_ROLE_KINDS)[number];

export const DocumentRole = z.object({
  key: DocumentRoleKey.refine((k) => k !== SENDER_ROLE, {
    error: 'That role name is kept for the business.',
  }),
  /** What the editor and the signing page call them: "Customer", "Second signer", "Us". */
  label: z.string().trim().min(1, 'Name who signs.').max(60, 'Keep it under 60 characters.'),
  kind: z.enum(DOCUMENT_ROLE_KINDS).default('customer'),
});
export type DocumentRole = z.infer<typeof DocumentRole>;

// ---------- what's filled in ----------

export const DOCUMENT_FIELD_TYPES = [
  'signature',
  'initials',
  'date_signed',
  'name',
  'email',
  'phone',
  'text',
  'long_text',
  'number',
  'date',
  'checkbox',
  'choice',
] as const;
export type DocumentFieldType = (typeof DOCUMENT_FIELD_TYPES)[number];

export const DOCUMENT_FIELD_LABELS: Readonly<Record<DocumentFieldType, string>> = {
  signature: 'Signature',
  initials: 'Initials',
  date_signed: 'Date signed',
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  text: 'Text',
  long_text: 'Paragraph',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  choice: 'Pick one',
};

/** Fields nobody types into: the signature pad, and the day it was signed, which fills itself. */
export const SIGNATURE_TYPES: readonly DocumentFieldType[] = ['signature', 'initials'];

/**
 * Where a fill-in comes from (answer 6a): the customer, their company, the lead, the record, the business, an
 * estimate, and the day it's sent. A signer's field that comes from the customer also fills that blank on them when
 * they sign (answer 7a), and never writes over what's there.
 */
export const FILL_SOURCES = {
  'customer.name': { group: 'Customer', label: 'Full name' },
  'customer.first_name': { group: 'Customer', label: 'First name' },
  'customer.last_name': { group: 'Customer', label: 'Last name' },
  'customer.email': { group: 'Customer', label: 'Email' },
  'customer.phone': { group: 'Customer', label: 'Phone' },
  'customer.address': { group: 'Customer', label: 'Address' },
  'company.name': { group: 'Company', label: 'Name' },
  'company.email': { group: 'Company', label: 'Email' },
  'company.phone': { group: 'Company', label: 'Phone' },
  'company.website': { group: 'Company', label: 'Website' },
  'lead.title': { group: 'Lead', label: 'Title' },
  'lead.value': { group: 'Lead', label: 'Value' },
  'record.name': { group: 'Record', label: 'Name' },
  'business.name': { group: 'Your business', label: 'Name' },
  'business.phone': { group: 'Your business', label: 'Phone' },
  'business.address': { group: 'Your business', label: 'Address' },
  'estimate.number': { group: 'Estimate', label: 'Number' },
  'estimate.title': { group: 'Estimate', label: 'Title' },
  'estimate.total': { group: 'Estimate', label: 'Total' },
  'sender.name': { group: 'Sending it', label: 'Your name' },
  today: { group: 'Sending it', label: 'Today’s date' },
} as const;
export type FillSource = keyof typeof FILL_SOURCES;
export const FILL_SOURCE_KEYS = Object.keys(FILL_SOURCES) as [FillSource, ...FillSource[]];
export const FillSourceSchema = z.enum(FILL_SOURCE_KEYS);

/** The customer's own details a signer's answer may fill in, when they're blank (answer 7a). */
export const WRITE_BACK_SOURCES: readonly FillSource[] = [
  'customer.name',
  'customer.first_name',
  'customer.last_name',
  'customer.email',
  'customer.phone',
];

/** A fraction of the page, from the top left. */
const Fraction = z.number().min(0).max(1);

const box = {
  /** The page it's on, from 0. */
  page: z
    .int()
    .min(0)
    .max(MAX_DOCUMENT_PAGES - 1),
  x: Fraction,
  y: Fraction,
  w: z.number().min(0.005).max(1),
  h: z.number().min(0.005).max(1),
};

export const DocumentField = z.object({
  id: DocumentItemId,
  type: z.enum(DOCUMENT_FIELD_TYPES),
  /** The role that fills it in, or `sender` for the business before it sends. */
  role: DocumentRoleKey,
  ...box,
  required: z.boolean().default(true),
  /** What it asks for, on the signing page ("Your initials", "Start date"). */
  label: z.string().trim().max(80, 'Keep it under 80 characters.').default(''),
  /** Filled in from HandsFreeOS when it's sent. */
  fillFrom: FillSourceSchema.nullable().default(null),
  /** A pick-one field's choices. */
  options: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** The size of what's written in it, in points. */
  fontSize: z.number().min(6).max(36).default(11),
});
export type DocumentField = z.infer<typeof DocumentField>;
export type DocumentFieldInput = z.input<typeof DocumentField>;

// ---------- the words typed over (26c) ----------

export const DOCUMENT_FONTS = ['sans', 'serif', 'mono'] as const;
export type DocumentFont = (typeof DOCUMENT_FONTS)[number];

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'A colour is #RRGGBB.' });

/**
 * Words on the PDF changed: a box covered over in its background colour, with the new words written on it. An empty
 * `text` takes the words out.
 */
export const DocumentEdit = z.object({
  id: DocumentItemId,
  ...box,
  text: z.string().max(2000, 'Keep it under 2,000 characters.').default(''),
  /** The words it covers, as the PDF had them: what "Changed from" shows. */
  original: z.string().max(2000).default(''),
  size: z.number().min(4).max(72).default(11),
  font: z.enum(DOCUMENT_FONTS).default('sans'),
  bold: z.boolean().default(false),
  color: hexColour.default('#000000'),
  background: hexColour.default('#ffffff'),
});
export type DocumentEdit = z.infer<typeof DocumentEdit>;
export type DocumentEditInput = z.input<typeof DocumentEdit>;

// ---------- its settings ----------

export const DOCUMENT_ORDERS = ['order', 'together'] as const;
export type DocumentOrder = (typeof DOCUMENT_ORDERS)[number];

/** Answer 14a: a reminder after 2 days, then every 3; out of time after 30. */
export const DEFAULT_REMIND_AFTER_DAYS = 2;
export const DEFAULT_REMIND_EVERY_DAYS = 3;
export const DEFAULT_EXPIRE_DAYS = 30;

export const DocumentSettings = z.object({
  /** One after another in the roles' order, or everyone at once. */
  order: z.enum(DOCUMENT_ORDERS).default('order'),
  /** A 6-digit code by text or email before they see it (answer 11a). */
  askCode: z.boolean().default(false),
  /** Null: no reminders. */
  remindAfterDays: z.int().min(1).max(30).nullable().default(DEFAULT_REMIND_AFTER_DAYS),
  remindEveryDays: z.int().min(1).max(30).nullable().default(DEFAULT_REMIND_EVERY_DAYS),
  expireDays: z.int().min(1).max(365).default(DEFAULT_EXPIRE_DAYS),
  /** The note that goes with the links. */
  message: z.string().trim().max(2000, 'Keep it under 2,000 characters.').default(''),
});
export type DocumentSettings = z.infer<typeof DocumentSettings>;

// ---------- a page ----------

/** A page as the PDF has it, in points (72 to the inch). */
export const DocumentPage = z.object({
  width: z.number().positive().max(14_400),
  height: z.number().positive().max(14_400),
});
export type DocumentPage = z.infer<typeof DocumentPage>;

// ---------- what was filled in ----------

/** A signature's picture: a PNG as a data URL, small enough to keep. */
export const SIGNATURE_IMAGE_MAX = 300_000;
const pngDataUrl = z
  .string()
  .max(SIGNATURE_IMAGE_MAX, 'That signature is too big. Clear it and sign again.')
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, { error: 'A signature is a PNG picture.' });

/** How someone signed: drawn with a finger or mouse, or typed in a handwriting style (answer 12a). */
export const SIGNATURE_HOWS = ['drawn', 'typed'] as const;

/** The handwriting styles a typed signature can take, by the font the web draws it in. */
export const SIGNATURE_STYLES = ['caveat', 'dancing', 'homemade', 'satisfy'] as const;
export type SignatureStyle = (typeof SIGNATURE_STYLES)[number];

export const DocumentValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(5000) }),
  z.object({ kind: z.literal('check'), checked: z.boolean() }),
  z.object({ kind: z.literal('date'), date: z.iso.date() }),
  z.object({
    kind: z.literal('signature'),
    how: z.enum(SIGNATURE_HOWS),
    image: pngDataUrl,
    /** The name it stands for: what they typed, or their name when they drew it. */
    name: z.string().trim().min(1).max(120),
    style: z.enum(SIGNATURE_STYLES).nullable().default(null),
  }),
]);
export type DocumentValue = z.infer<typeof DocumentValue>;
export type DocumentValueInput = z.input<typeof DocumentValue>;

/** What kind of value a field takes. */
export function valueKindOf(type: DocumentFieldType): DocumentValue['kind'] {
  switch (type) {
    case 'signature':
    case 'initials':
      return 'signature';
    case 'date':
    case 'date_signed':
      return 'date';
    case 'checkbox':
      return 'check';
    default:
      return 'text';
  }
}

// ---------- the whole thing ----------

export const DocumentDefinition = z
  .object({
    version: z.literal(DOCUMENT_DEFINITION_VERSION).default(DOCUMENT_DEFINITION_VERSION),
    pages: z.array(DocumentPage).max(MAX_DOCUMENT_PAGES).default([]),
    roles: z
      .array(DocumentRole)
      .min(1, 'Someone has to sign it.')
      .max(MAX_DOCUMENT_ROLES, `Up to ${MAX_DOCUMENT_ROLES} people can sign one document.`),
    fields: z
      .array(DocumentField)
      .max(MAX_DOCUMENT_FIELDS, `Up to ${MAX_DOCUMENT_FIELDS} fields fit on one document.`)
      .default([]),
    edits: z
      .array(DocumentEdit)
      .max(
        MAX_DOCUMENT_EDITS,
        `Up to ${MAX_DOCUMENT_EDITS} changes to the words fit on one document.`,
      )
      .default([]),
    settings: DocumentSettings.prefault({}),
    /** A sent document's: what each field held when it went (the team's fill-ins, and signers' starting values). */
    presets: z.record(DocumentItemId, DocumentValue).default({}),
  })
  .superRefine((d, ctx) => {
    const roles = new Set<string>();
    d.roles.forEach((r, i) => {
      if (roles.has(r.key))
        ctx.addIssue({
          code: 'custom',
          path: ['roles', i, 'key'],
          message: 'Two signers have the same role.',
        });
      roles.add(r.key);
    });
    const ids = new Set<string>();
    const pageCount = d.pages.length;
    d.fields.forEach((f, i) => {
      if (ids.has(f.id))
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'id'],
          message: 'Two fields have the same id.',
        });
      ids.add(f.id);
      if (f.role !== SENDER_ROLE && !roles.has(f.role))
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'role'],
          message: 'That field is for someone who doesn’t sign this document.',
        });
      if (pageCount && f.page >= pageCount)
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'page'],
          message: 'That page isn’t in the PDF.',
        });
      if (f.type === 'choice' && f.options.length < 2)
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'options'],
          message: 'Give a pick-one field at least two choices.',
        });
      if (f.role === SENDER_ROLE && SIGNATURE_TYPES.includes(f.type))
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'role'],
          message:
            'A signature is for someone who signs. Give it to a signer, or add “Us” as a signer.',
        });
    });
    d.edits.forEach((e, i) => {
      if (ids.has(e.id))
        ctx.addIssue({
          code: 'custom',
          path: ['edits', i, 'id'],
          message: 'Two changes have the same id.',
        });
      ids.add(e.id);
      if (pageCount && e.page >= pageCount)
        ctx.addIssue({
          code: 'custom',
          path: ['edits', i, 'page'],
          message: 'That page isn’t in the PDF.',
        });
    });
    for (const id of Object.keys(d.presets))
      if (!d.fields.some((f) => f.id === id))
        ctx.addIssue({
          code: 'custom',
          path: ['presets', id],
          message: 'That field isn’t on the document.',
        });
  });
export type DocumentDefinition = z.infer<typeof DocumentDefinition>;
export type DocumentDefinitionInput = z.input<typeof DocumentDefinition>;

/** A new template's definition: one customer to sign, nothing placed yet, and answer 14a's settings. */
export function blankDocumentDefinition(): DocumentDefinition {
  return DocumentDefinition.parse({
    roles: [{ key: 'customer', label: 'Customer', kind: 'customer' }],
  });
}

/** Reads a stored definition, forgiving nothing: a stored one that doesn't parse is a bug, not a customer's. */
export function parseDocumentDefinition(stored: unknown): DocumentDefinition {
  return DocumentDefinition.parse(stored);
}

/** The fields one role fills in, top to bottom on each page, as the signing page steps through them. */
export function fieldsOf(definition: DocumentDefinition, role: string): DocumentField[] {
  return definition.fields
    .filter((f) => f.role === role)
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}
