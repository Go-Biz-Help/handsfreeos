/**
 * A template changed a piece at a time (docs/documents.md), as the Assistant asks for it: a setting, someone who signs,
 * one field, or one change to the PDF's words, each named by its key or id, and everything the change doesn't name
 * kept as it is. The editors change the whole definition at once (edit.ts); this is the same change said item by
 * item, so a field or word change left out of it is never taken off. What it comes to is told in the editor's words
 * (`templateChangeWords`), for the card the person says yes on. Browser-safe.
 */
import { z } from 'zod';
import { HfosError } from '../errors';
import { fieldName } from './check';
import {
  DEFAULT_REMIND_AFTER_DAYS,
  DEFAULT_REMIND_EVERY_DAYS,
  DOCUMENT_FIELD_LABELS,
  DOCUMENT_FIELD_TYPES,
  DOCUMENT_FONTS,
  DOCUMENT_ORDERS,
  DOCUMENT_ROLE_KINDS,
  DocumentDefinition,
  DocumentItemId,
  DocumentRoleKey,
  FILL_SOURCES,
  FillSourceSchema,
  MAX_DOCUMENT_PAGES,
  newEditId,
  newFieldId,
  SENDER_ROLE,
  type DocumentEdit,
  type DocumentField,
  type DocumentRole,
  type DocumentSettings,
  type FillSource,
} from './definition';
import {
  DOCUMENT_EDITOR_WORDS,
  DOCUMENT_FIELD_SIZES,
  documentRoleName,
  NO_FILL_TYPES,
  retypedField,
} from './edit';
import { DOCUMENT_SCREEN_WORDS } from './words';

const fraction = z.number().min(0).max(1);
const extent = z.number().min(0.005).max(1);
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'A colour is #RRGGBB.' });

/** Where a field or words go: fractions of the page from its top left, the page counted from 0. */
const place = {
  page: z
    .int()
    .min(0)
    .max(MAX_DOCUMENT_PAGES - 1)
    .optional()
    .describe('The page, counted from 0 (the first page is 0)'),
  x: fraction.optional().describe('Its left edge, as a fraction of the page’s width from the left'),
  y: fraction.optional().describe('Its top edge, as a fraction of the page’s height from the top'),
  w: extent.optional().describe('Its width, as a fraction of the page’s width'),
  h: extent.optional().describe('Its height, as a fraction of the page’s height'),
};

/** When it's sent: the template's settings, as the editor's When it's sent panel has them. */
export const DocumentSettingsChange = z.object({
  order: z
    .enum(DOCUMENT_ORDERS)
    .optional()
    .describe(
      'Who signs when. order: one after another, in Who signs’s order. together: all at once',
    ),
  askCode: z
    .boolean()
    .optional()
    .describe('Ask for a code: a 6-digit code by text or email before they can open it'),
  remindAfterDays: z
    .int()
    .min(1)
    .max(30)
    .nullable()
    .optional()
    .describe('Send reminders, the first after this many days. null turns reminders off'),
  remindEveryDays: z
    .int()
    .min(1)
    .max(30)
    .nullable()
    .optional()
    .describe('Then every this many days. null turns reminders off'),
  expireDays: z.int().min(1).max(365).optional().describe('Out of time after this many days'),
  message: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe('The note with the link, in every email and text. Empty takes it off'),
});

/** Someone who signs: added, renamed, made a customer or someone on the team, moved in the order, or taken off. */
export const DocumentRoleChange = z.object({
  key: DocumentRoleKey.describe(
    'Who signs, by their key from read_document_template_get. To add someone, a new lowercase key like customer_2, which their new fields can use too',
  ),
  add: z.boolean().optional().describe('true adds someone new to sign, last in the order'),
  label: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe('What they’re called on the page and the signing page, like Tenant or Us'),
  kind: z
    .enum(DOCUMENT_ROLE_KINDS)
    .optional()
    .describe('customer: someone you send it to. team: someone from your business who signs too'),
  move: z
    .enum(['earlier', 'later'])
    .optional()
    .describe(
      'Signs one place earlier or later. Someone added comes last; move them in another entry',
    ),
  remove: z
    .boolean()
    .optional()
    .describe('true takes them off Who signs, and every field of theirs with them'),
});

/** One field: changed, added (no id) or taken off. */
export const DocumentFieldChange = z.object({
  id: DocumentItemId.optional().describe(
    'The field, by its id from read_document_template_get. Leave out to add a new one',
  ),
  remove: z.boolean().optional().describe('true takes the field off'),
  type: z
    .enum(DOCUMENT_FIELD_TYPES)
    .optional()
    .describe('Its kind. Needed for a new field; on one there, changes its kind'),
  role: DocumentRoleKey.optional().describe(
    `Who fills it in: a signer’s key, or ${SENDER_ROLE} for the business before it sends (never a signature or initials). Needed for a new field`,
  ),
  ...place,
  required: z.boolean().optional().describe('Has to be filled in'),
  label: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe('What it asks for on the signing page, like Start date'),
  fillFrom: FillSourceSchema.nullable()
    .optional()
    .describe(
      'Fill in from HandsFreeOS when it’s sent; null and they type it. Never for a signature, initials, date signed or checkbox',
    ),
  options: z
    .array(z.string().trim().min(1).max(80))
    .min(2)
    .max(20)
    .optional()
    .describe('A pick-one field’s choices'),
  fontSize: z.number().min(6).max(36).optional().describe('Text size, in points'),
});

/** One change to the PDF's words: changed, added (no id), or taken off so the original words show again. */
export const DocumentWordsChange = z.object({
  id: DocumentItemId.optional().describe(
    'A change to the words, by its id from read_document_template_get. Leave out to add one',
  ),
  remove: z
    .boolean()
    .optional()
    .describe('true puts the original words back, or takes added words off'),
  ...place,
  text: z.string().max(2000).optional().describe('What it says now. Empty takes the words out'),
  original: z
    .string()
    .max(2000)
    .optional()
    .describe('The PDF’s own words it covers, as get_document_pages read them'),
  size: z.number().min(4).max(72).optional().describe('In points'),
  font: z.enum(DOCUMENT_FONTS).optional().describe('sans: Plain. serif: Serif. mono: Typewriter'),
  bold: z.boolean().optional(),
  color: hexColour.optional().describe('The words’ colour, #RRGGBB'),
  background: hexColour
    .optional()
    .describe('Behind the words, #RRGGBB: the page’s own, so the old words are covered'),
});

export const DocumentTemplateChange = z.object({
  settings: DocumentSettingsChange.optional(),
  roles: z.array(DocumentRoleChange).max(20).optional(),
  fields: z.array(DocumentFieldChange).max(100).optional(),
  words: z.array(DocumentWordsChange).max(100).optional(),
});
export type DocumentTemplateChange = z.infer<typeof DocumentTemplateChange>;

const refuse = (path: string, message: string) =>
  HfosError.validation([{ path, message }], message);

/** What's given of a box, kept on the page: a box running off the right or bottom edge is moved back on. */
function onPage<T extends { x: number; y: number; w: number; h: number }>(box: T): T {
  const w = Math.min(1, box.w);
  const h = Math.min(1, box.h);
  return { ...box, w, h, x: Math.min(box.x, 1 - w), y: Math.min(box.y, 1 - h) };
}

const given = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * The template as it is after the change. Roles change first, so a new field can be for someone added in the same
 * change. Refuses, naming what's wrong, an id or key the template doesn't have, a new field or words without where
 * they go, and a fill-in on a kind that never fills in; then whatever the definition itself refuses.
 */
export function applyTemplateChange(
  before: DocumentDefinition,
  change: DocumentTemplateChange,
  random?: () => number,
): DocumentDefinition {
  let roles: DocumentRole[] = [...before.roles];
  let fields: DocumentField[] = [...before.fields];
  const edits: DocumentEdit[] = [...before.edits];
  const settings: DocumentSettings = { ...before.settings };

  const s = change.settings;
  if (s) {
    Object.assign(
      settings,
      given({ order: s.order, askCode: s.askCode, expireDays: s.expireDays, message: s.message }),
    );
    // Reminders are one switch on the screen: off stops both, and on, a number not given is the one there or the usual.
    if (s.remindAfterDays === null || s.remindEveryDays === null) {
      settings.remindAfterDays = null;
      settings.remindEveryDays = null;
    } else if (s.remindAfterDays !== undefined || s.remindEveryDays !== undefined) {
      settings.remindAfterDays =
        s.remindAfterDays ?? settings.remindAfterDays ?? DEFAULT_REMIND_AFTER_DAYS;
      settings.remindEveryDays =
        s.remindEveryDays ?? settings.remindEveryDays ?? DEFAULT_REMIND_EVERY_DAYS;
    }
  }

  (change.roles ?? []).forEach((r, i) => {
    const path = `roles.${i}`;
    const at = roles.findIndex((x) => x.key === r.key);
    if (r.add) {
      if (r.remove) throw refuse(path, 'Add someone or take them off, not both at once.');
      if (r.key === SENDER_ROLE || at >= 0)
        throw refuse(
          `${path}.key`,
          `Someone on Who signs already goes by “${r.key}”. Give the new signer another key, like customer_2.`,
        );
      const kind = r.kind ?? 'customer';
      const customers = roles.filter((x) => x.kind === 'customer').length;
      roles.push({
        key: r.key,
        label:
          r.label ??
          (kind === 'team' ? 'Us' : customers ? `Customer ${customers + 1}` : 'Customer'),
        kind,
      });
      return;
    }
    if (at < 0)
      throw refuse(
        `${path}.key`,
        `Nobody on Who signs goes by “${r.key}”. Read the template again to see who signs it.`,
      );
    if (r.remove) {
      roles = roles.filter((x) => x.key !== r.key);
      fields = fields.filter((f) => f.role !== r.key);
      return;
    }
    roles[at] = { ...roles[at]!, ...given({ label: r.label, kind: r.kind }) };
    const to = r.move ? at + (r.move === 'earlier' ? -1 : 1) : at;
    if (to !== at && to >= 0 && to < roles.length)
      [roles[at], roles[to]] = [roles[to]!, roles[at]!];
  });

  (change.fields ?? []).forEach((f, i) => {
    const path = `fields.${i}`;
    let field: DocumentField;
    if (!f.id) {
      if (f.remove) throw refuse(`${path}.id`, 'Say which field to take off, by its id.');
      if (!f.type || !f.role || f.page === undefined || f.x === undefined || f.y === undefined)
        throw refuse(
          path,
          'A new field needs its kind, who fills it in, its page, and where it goes on the page (x and y).',
        );
      const page = before.pages[f.page];
      const [width, height] = DOCUMENT_FIELD_SIZES[f.type];
      field = {
        id: newFieldId(random),
        type: f.type,
        role: f.role,
        ...onPage({
          page: f.page,
          x: f.x,
          y: f.y,
          w: f.w ?? (page ? Math.max(0.005, Math.min(1, width / page.width)) : 0.25),
          h: f.h ?? (page ? Math.max(0.005, Math.min(1, height / page.height)) : 0.03),
        }),
        required: f.required ?? f.type !== 'checkbox',
        label: f.label ?? '',
        fillFrom: f.fillFrom ?? null,
        options: f.options ?? (f.type === 'choice' ? ['Yes', 'No'] : []),
        fontSize: f.fontSize ?? 11,
      };
      fields.push(field);
    } else {
      const at = fields.findIndex((x) => x.id === f.id);
      if (at < 0)
        throw refuse(
          `${path}.id`,
          `This template has no field ${f.id}. Read it again to see its fields.`,
        );
      if (f.remove) {
        fields.splice(at, 1);
        return;
      }
      field = fields[at]!;
      if (f.type && f.type !== field.type) field = retypedField(field, f.type);
      field = onPage({
        ...field,
        ...given({
          role: f.role,
          page: f.page,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          required: f.required,
          label: f.label,
          options: f.options,
          fontSize: f.fontSize,
        }),
        ...(f.fillFrom !== undefined ? { fillFrom: f.fillFrom } : {}),
      });
      fields[at] = field;
    }
    if (field.fillFrom && NO_FILL_TYPES.includes(field.type))
      throw refuse(
        `${path}.fillFrom`,
        `A ${DOCUMENT_FIELD_LABELS[field.type].toLowerCase()} field never fills in from HandsFreeOS. Leave Fill in from HandsFreeOS off it.`,
      );
  });

  (change.words ?? []).forEach((e, i) => {
    const path = `words.${i}`;
    if (!e.id) {
      if (e.remove)
        throw refuse(`${path}.id`, 'Say which change to the words to take off, by its id.');
      if (
        e.page === undefined ||
        e.x === undefined ||
        e.y === undefined ||
        e.w === undefined ||
        e.h === undefined
      )
        throw refuse(
          path,
          'New words need their page and box (x, y, w and h). Over the PDF’s own words, use that line’s box from get_document_pages.',
        );
      edits.push(
        onPage({
          id: newEditId(random),
          page: e.page,
          x: e.x,
          y: e.y,
          w: e.w,
          h: e.h,
          text: e.text ?? '',
          original: e.original ?? '',
          size: e.size ?? 11,
          font: e.font ?? 'sans',
          bold: e.bold ?? false,
          color: e.color ?? '#000000',
          background: e.background ?? '#ffffff',
        }),
      );
      return;
    }
    const at = edits.findIndex((x) => x.id === e.id);
    if (at < 0)
      throw refuse(
        `${path}.id`,
        `This template has no change to its words ${e.id}. Read it again to see them.`,
      );
    if (e.remove) {
      edits.splice(at, 1);
      return;
    }
    const { id: _id, remove: _remove, ...rest } = e;
    edits[at] = onPage({ ...edits[at]!, ...given(rest) });
  });

  const parsed = DocumentDefinition.safeParse({
    ...before,
    roles,
    fields,
    edits,
    settings,
    presets: {},
  });
  if (!parsed.success)
    throw HfosError.validation(
      parsed.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })),
      parsed.error.issues[0]?.message ?? 'Some of the template needs attention.',
    );
  return parsed.data;
}

// ---------- what it comes to, in the editor's words ----------

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const quoted = (s: string) => `“${clip(s.trim())}”`;
const pageWords = (page: number) => `page ${page + 1}`;
const fillWords = (k: FillSource | null) =>
  k ? `${FILL_SOURCES[k].group}: ${FILL_SOURCES[k].label}` : DOCUMENT_EDITOR_WORDS.fillNothing;
const yesNo = (b: boolean) => (b ? 'yes' : 'no');
const kindWords = (kind: string) =>
  kind === 'team' ? DOCUMENT_EDITOR_WORDS.kindTeam : DOCUMENT_EDITOR_WORDS.kindCustomer;
const remindWords = (s: DocumentSettings) =>
  s.remindAfterDays === null || s.remindEveryDays === null
    ? `${DOCUMENT_SCREEN_WORDS.reminders}: off`
    : `${DOCUMENT_SCREEN_WORDS.reminders}: the first after ${days(s.remindAfterDays)}, then every ${days(s.remindEveryDays)}`;
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);
const sameBox = (a: { page: number; x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.page === b.page && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Each thing the change does to the template, one line each, in the editor's words: what the person checks on the
 * card before they say yes. Empty when it changes nothing.
 */
export function templateChangeWords(
  before: DocumentDefinition,
  after: DocumentDefinition,
): string[] {
  const lines: string[] = [];
  const a = before.settings;
  const b = after.settings;
  const W = DOCUMENT_SCREEN_WORDS;
  if (a.order !== b.order)
    lines.push(`${W.whoSignsWhen}: ${b.order === 'together' ? W.together : W.inOrder}`);
  if (a.askCode !== b.askCode) lines.push(`${W.askCode}: ${b.askCode ? 'on' : 'off'}`);
  if (a.remindAfterDays !== b.remindAfterDays || a.remindEveryDays !== b.remindEveryDays)
    lines.push(remindWords(b));
  if (a.expireDays !== b.expireDays) lines.push(`Out of time after ${days(b.expireDays)}`);
  if (a.message !== b.message)
    lines.push(b.message ? `${W.note}: ${quoted(b.message)}` : `${W.note}: taken off`);

  // Who signs.
  const was = new Map(before.roles.map((r) => [r.key, r]));
  const now = new Map(after.roles.map((r) => [r.key, r]));
  for (const r of after.roles) {
    const old = was.get(r.key);
    if (!old) lines.push(`Signs it too: ${r.label} (${kindWords(r.kind).toLowerCase()})`);
    else {
      if (old.label !== r.label) lines.push(`${old.label} is now called ${r.label}`);
      if (old.kind !== r.kind) lines.push(`${r.label} is now ${kindWords(r.kind).toLowerCase()}`);
    }
  }
  for (const r of before.roles)
    if (!now.has(r.key)) {
      const theirs = before.fields.filter((f) => f.role === r.key).length;
      lines.push(
        `${DOCUMENT_EDITOR_WORDS.takeRoleOff(r.label)}${theirs ? `, with ${theirs === 1 ? 'their field' : `their ${theirs} fields`}` : ''}`,
      );
    }
  // Said when it isn't the order it was, with anyone new last, as Add puts them.
  const expected = [
    ...before.roles.filter((r) => now.has(r.key)).map((r) => r.key),
    ...after.roles.filter((r) => !was.has(r.key)).map((r) => r.key),
  ];
  if (after.roles.length > 1 && expected.join() !== after.roles.map((r) => r.key).join())
    lines.push(`Signing order: ${after.roles.map((r) => r.label).join(', then ')}`);

  // The fields: who's gone is said with them, so a role taken off doesn't list each of its fields too.
  const roleOf = (d: DocumentDefinition, f: DocumentField) => documentRoleName(d, f.role);
  const fieldWas = new Map(before.fields.map((f) => [f.id, f]));
  const fieldNow = new Map(after.fields.map((f) => [f.id, f]));
  for (const f of after.fields) {
    const old = fieldWas.get(f.id);
    if (!old) {
      lines.push(
        `New ${fieldName(f)} for ${roleOf(after, f)} on ${pageWords(f.page)}${f.fillFrom ? `, filled in from ${fillWords(f.fillFrom)}` : ''}`,
      );
      continue;
    }
    const what: string[] = [];
    if (old.type !== f.type)
      what.push(`${DOCUMENT_EDITOR_WORDS.kind}: ${DOCUMENT_FIELD_LABELS[f.type]}`);
    if (old.role !== f.role) what.push(`${DOCUMENT_EDITOR_WORDS.whoFillsIn}: ${roleOf(after, f)}`);
    if (old.label !== f.label)
      what.push(
        `${DOCUMENT_EDITOR_WORDS.asksFor}: ${f.label ? quoted(f.label) : DOCUMENT_FIELD_LABELS[f.type]}`,
      );
    if (old.required !== f.required)
      what.push(`${DOCUMENT_EDITOR_WORDS.required}: ${yesNo(f.required)}`);
    if (old.fillFrom !== f.fillFrom)
      what.push(`${DOCUMENT_EDITOR_WORDS.fillFrom}: ${fillWords(f.fillFrom)}`);
    if (old.options.join('\n') !== f.options.join('\n') && f.type === 'choice')
      what.push(`Choices: ${clip(f.options.join(', '))}`);
    if (old.fontSize !== f.fontSize) what.push(`${DOCUMENT_EDITOR_WORDS.textSize}: ${f.fontSize}`);
    if (old.page !== f.page) what.push(`moved to ${pageWords(f.page)}`);
    else if (!sameBox(old, f)) what.push('moved or resized');
    if (what.length) lines.push(`${fieldName(old)} on ${pageWords(old.page)}: ${what.join('; ')}`);
  }
  for (const f of before.fields)
    if (!fieldNow.has(f.id) && now.has(f.role))
      lines.push(`Taken off: ${fieldName(f)} for ${roleOf(before, f)} on ${pageWords(f.page)}`);

  // The PDF's words.
  const editWas = new Map(before.edits.map((e) => [e.id, e]));
  const editNow = new Map(after.edits.map((e) => [e.id, e]));
  for (const e of after.edits) {
    const old = editWas.get(e.id);
    if (!old) {
      lines.push(
        e.original
          ? `${pageWords(e.page)[0]!.toUpperCase()}${pageWords(e.page).slice(1)}: ${quoted(e.original)} now says ${e.text ? quoted(e.text) : 'nothing'}`
          : `New words on ${pageWords(e.page)}: ${quoted(e.text)}`,
      );
      continue;
    }
    const what: string[] = [];
    if (old.text !== e.text) what.push(e.text ? `now says ${quoted(e.text)}` : 'now says nothing');
    if (old.size !== e.size || old.font !== e.font || old.bold !== e.bold)
      what.push(`${DOCUMENT_EDITOR_WORDS.fonts[e.font]}, ${e.size} point${e.bold ? ', bold' : ''}`);
    if (old.color !== e.color || old.background !== e.background)
      what.push(`colours ${e.color} on ${e.background}`);
    if (!sameBox(old, e)) what.push('moved or resized');
    if (what.length)
      lines.push(
        `Words on ${pageWords(old.page)} ${quoted(old.original || old.text)}: ${what.join('; ')}`,
      );
  }
  for (const e of before.edits)
    if (!editNow.has(e.id))
      lines.push(
        e.original
          ? `${DOCUMENT_EDITOR_WORDS.putBack} on ${pageWords(e.page)}: ${quoted(e.original)}`
          : `Taken off: the added words on ${pageWords(e.page)}, ${quoted(e.text)}`,
      );
  return lines;
}
