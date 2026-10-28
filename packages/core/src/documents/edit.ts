/**
 * Changing a template's definition (docs/documents.md), the same in the web's editor and the phone's: placing a
 * field or new words where the page was touched, moving and resizing them, the PDF's words typed over (26c), who
 * signs, and taking things off. Each is a change to the whole definition, so either editor keeps the one before it
 * for Undo. The Send screen uses the word changes for one customer's own copy (27a). Browser-safe.
 */
import {
  DOCUMENT_FIELD_TYPES,
  MAX_DOCUMENT_ROLES,
  newEditId,
  newFieldId,
  SENDER_ROLE,
  type DocumentDefinition,
  type DocumentEdit,
  type DocumentField,
  type DocumentFieldType,
  type DocumentFont,
  type DocumentPage,
  type DocumentRoleKind,
} from './definition';

/** What's picked on the page: a field, or words changed or added. */
export type DocumentPick = { readonly kind: 'field' | 'edit'; readonly id: string } | null;

/** A box on a page, in fractions of it from the top left. */
type Box = { x: number; y: number; w: number; h: number };

/** A new field's size in points, before it's dragged to fit. */
export const DOCUMENT_FIELD_SIZES: Readonly<Record<DocumentFieldType, readonly [number, number]>> =
  {
    signature: [170, 42],
    initials: [64, 36],
    date_signed: [110, 20],
    name: [170, 20],
    email: [190, 20],
    phone: [130, 20],
    text: [170, 20],
    long_text: [260, 64],
    number: [90, 20],
    date: [110, 20],
    checkbox: [16, 16],
    choice: [150, 20],
  };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 100_000) / 100_000;

/** A box of `w`×`h` points centred where the page was touched, kept on the page. */
export function boxOnPage(
  page: DocumentPage,
  pageIndex: number,
  at: { x: number; y: number },
  size: readonly [number, number],
) {
  const w = clamp(size[0] / page.width, 0.005, 1);
  const h = clamp(size[1] / page.height, 0.005, 1);
  return {
    page: pageIndex,
    x: round(clamp(at.x - w / 2, 0, 1 - w)),
    y: round(clamp(at.y - h / 2, 0, 1 - h)),
    w: round(w),
    h: round(h),
  };
}

/** A field of a kind for a role, where the page was touched. */
export function newDocumentField(
  type: DocumentFieldType,
  role: string,
  page: DocumentPage,
  pageIndex: number,
  at: { x: number; y: number },
): DocumentField {
  return {
    id: newFieldId(),
    type,
    role,
    ...boxOnPage(page, pageIndex, at, DOCUMENT_FIELD_SIZES[type]),
    required: type !== 'checkbox',
    label: '',
    fillFrom: null,
    options: type === 'choice' ? ['Yes', 'No'] : [],
    fontSize: 11,
  };
}

/** New words where the page was touched, to be typed. */
export function newDocumentTextBox(
  page: DocumentPage,
  pageIndex: number,
  at: { x: number; y: number },
): DocumentEdit {
  return {
    id: newEditId(),
    ...boxOnPage(page, pageIndex, at, [180, 18]),
    text: '',
    original: '',
    size: 11,
    font: 'sans',
    bold: false,
    color: '#000000',
    background: '#ffffff',
  };
}

/** A line of the PDF's words, typed over: the same words to start with, in their size, font and colours. */
export function typeOverLine(
  pageIndex: number,
  line: {
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly size: number;
    readonly font: DocumentFont;
    readonly bold: boolean;
  },
  colours: { readonly background: string; readonly color: string },
): DocumentEdit {
  return {
    id: newEditId(),
    page: pageIndex,
    x: line.x,
    y: line.y,
    w: line.w,
    h: line.h,
    text: line.text,
    original: line.text,
    size: Math.min(72, Math.max(4, line.size)),
    font: line.font,
    bold: line.bold,
    background: colours.background,
    color: colours.color,
  };
}

/** Moves or resizes a box by a change in fractions of the page, kept on it. */
export function movedBox<T extends Box>(box: T, how: 'move' | 'resize', dx: number, dy: number): T {
  if (how === 'move')
    return {
      ...box,
      x: round(clamp(box.x + dx, 0, 1 - box.w)),
      y: round(clamp(box.y + dy, 0, 1 - box.h)),
    };
  return {
    ...box,
    w: round(clamp(box.w + dx, 0.005, 1 - box.x)),
    h: round(clamp(box.h + dy, 0.005, 1 - box.y)),
  };
}

/** Whether a line of words is mostly under words already changed: it can't be typed over twice. */
export function coveredBy(a: Box, b: Box): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 && (w * h) / (a.w * a.h) > 0.5;
}

export const withField = (
  d: DocumentDefinition,
  id: string,
  fn: (f: DocumentField) => DocumentField,
): DocumentDefinition => ({
  ...d,
  fields: d.fields.map((f) => (f.id === id ? fn(f) : f)),
});

export const withEdit = (
  d: DocumentDefinition,
  id: string,
  fn: (e: DocumentEdit) => DocumentEdit,
): DocumentDefinition => ({
  ...d,
  edits: d.edits.map((e) => (e.id === id ? fn(e) : e)),
});

/** What's picked, taken off: a field (and anything filled in it), or words changed or added. */
export const withoutPick = (
  d: DocumentDefinition,
  s: NonNullable<DocumentPick>,
): DocumentDefinition =>
  s.kind === 'field'
    ? { ...d, fields: d.fields.filter((f) => f.id !== s.id), presets: withoutKey(d.presets, s.id) }
    : { ...d, edits: d.edits.filter((e) => e.id !== s.id) };

function withoutKey<T>(o: Record<string, T>, key: string): Record<string, T> {
  if (!(key in o)) return o;
  const { [key]: _gone, ...rest } = o;
  return rest;
}

/** Field types a role can have: the business before it sends never signs. */
export const fieldTypesFor = (role: string): readonly DocumentFieldType[] =>
  role === SENDER_ROLE
    ? DOCUMENT_FIELD_TYPES.filter(
        (t) => t !== 'signature' && t !== 'initials' && t !== 'date_signed',
      )
    : DOCUMENT_FIELD_TYPES;

/** Kinds that never fill in from HandsFreeOS: what's signed, the day signed, and a tick. */
export const NO_FILL_TYPES: readonly DocumentFieldType[] = [
  'signature',
  'initials',
  'date_signed',
  'checkbox',
];

/** A field changed to another kind: what doesn't fit the new kind comes off. */
export function retypedField(field: DocumentField, type: DocumentFieldType): DocumentField {
  return {
    ...field,
    type,
    fillFrom: NO_FILL_TYPES.includes(type) ? null : field.fillFrom,
    options: type === 'choice' && field.options.length < 2 ? ['Yes', 'No'] : field.options,
  };
}

/** Each signer's colour on the page, in their order; the business's own is slate. */
const ROLE_COLOURS = [
  '#2563eb',
  '#db2777',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#65a30d',
  '#c026d3',
  '#0d9488',
];
export function documentRoleColour(definition: DocumentDefinition, role: string): string {
  if (role === SENDER_ROLE) return '#475569';
  const i = definition.roles.findIndex((r) => r.key === role);
  return ROLE_COLOURS[(i < 0 ? 0 : i) % ROLE_COLOURS.length]!;
}

/** The role a field is for, as the editor names it. */
export const documentRoleName = (d: DocumentDefinition, key: string): string =>
  key === SENDER_ROLE
    ? DOCUMENT_EDITOR_WORDS.sender
    : (d.roles.find((r) => r.key === key)?.label ?? key);

// ---------- who signs ----------

/** A role key that isn't taken: `customer_2`, `team_1`. */
export function newDocumentRoleKey(definition: DocumentDefinition, kind: DocumentRoleKind): string {
  for (let n = 1; ; n++) {
    const key = n === 1 && kind === 'team' ? 'team' : `${kind}_${n}`;
    if (!definition.roles.some((r) => r.key === key)) return key;
  }
}

/** Someone else who signs, last in the order: "Customer 2", or "Us" for the business's own. */
export function withRoleAdded(
  d: DocumentDefinition,
  kind: DocumentRoleKind,
): { definition: DocumentDefinition; key: string } {
  if (d.roles.length >= MAX_DOCUMENT_ROLES) return { definition: d, key: d.roles.at(-1)!.key };
  const key = newDocumentRoleKey(d, kind);
  const customers = d.roles.filter((r) => r.kind === 'customer').length;
  const label = kind === 'team' ? 'Us' : customers ? `Customer ${customers + 1}` : 'Customer';
  return { definition: { ...d, roles: [...d.roles, { key, label, kind }] }, key };
}

export const withRoleChanged = (
  d: DocumentDefinition,
  key: string,
  patch: { label?: string; kind?: DocumentRoleKind },
): DocumentDefinition => ({
  ...d,
  roles: d.roles.map((r) => (r.key === key ? { ...r, ...patch } : r)),
});

/** A role signing earlier (-1) or later (1). */
export function withRoleMoved(d: DocumentDefinition, key: string, by: -1 | 1): DocumentDefinition {
  const i = d.roles.findIndex((r) => r.key === key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= d.roles.length) return d;
  const roles = [...d.roles];
  [roles[i], roles[j]] = [roles[j]!, roles[i]!];
  return { ...d, roles };
}

/** A role taken off, with its fields. */
export const withoutRole = (d: DocumentDefinition, key: string): DocumentDefinition => ({
  ...d,
  roles: d.roles.filter((r) => r.key !== key),
  fields: d.fields.filter((f) => f.role !== key),
});

// ---------- the words ----------

/** The editor's words, the web's and the phone's. */
export const DOCUMENT_EDITOR_WORDS = {
  sender: 'You, before sending',
  whoSigns: 'Who signs',
  addFor: (role: string) => `Add for ${role}`,
  pdfWords: 'The PDF’s words',
  changeWords: 'Change words',
  addWords: 'Add words',
  addCustomer: 'Customer',
  addTeam: 'Someone on your team',
  roleLabel: 'What they’re called',
  roleKind: 'Who they are',
  kindCustomer: 'A customer',
  kindTeam: 'Someone on your team',
  signsEarlier: 'Signs earlier',
  signsLater: 'Signs later',
  takeRoleOff: (label: string) => `Take ${label} off`,
  takeRoleOffAsk: (label: string, fields: number) =>
    `Take ${label} off? Their ${fields === 1 ? 'field goes' : `${fields} fields go`} too.`,
  // What's picked.
  whoFillsIn: 'Who fills it in',
  kind: 'Kind',
  asksFor: 'What it asks for',
  dateSignedNote: 'Fills itself in with the day they sign.',
  required: 'Has to be filled in',
  fillFrom: 'Fill in from HandsFreeOS',
  fillNothing: 'Nothing, they type it',
  fillCanChange: 'They can change it before they sign.',
  choices: 'Choices, one to a line',
  textSize: 'Text size',
  takeOff: 'Take it off',
  changedWords: 'Changed words',
  addedWords: 'Added words',
  was: 'Was: ',
  nowSays: 'Now says',
  words: 'Words',
  emptyTakesOut: 'Left empty, the words are taken out.',
  font: 'Font',
  size: 'Size',
  bold: 'Bold',
  fonts: { sans: 'Plain', serif: 'Serif', mono: 'Typewriter' },
  wordsColour: 'Words',
  behindColour: 'Behind',
  putBack: 'Put the original words back',
  // The template.
  beforeItGoes: 'Before it can go out',
  readyNothing: 'Nothing. It’s ready to send.',
  whenSent: 'When it’s sent',
  ownersChange: 'Owners and admins change templates.',
  saving: 'Saving',
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  placeForMe: 'Place fields for me',
  placing: 'Placing fields',
  undo: 'Undo',
  swapPdf: 'Swap the PDF',
  swapAsk: 'Swap the PDF for this one? Fields and word changes on pages it doesn’t have come off.',
  makeCopy: 'Make a copy',
  restore: 'Restore',
  archive: 'Archive',
  copied: 'Copied. You’re in the copy now.',
  archivedDone: 'Archived. Documents already sent aren’t touched.',
  restored: 'Restored.',
  conflict: 'Someone saved this template in the meantime, so your last change wasn’t saved.',
  loadTheirs: 'Load their changes',
  addPdfTitle: 'Add the PDF this template is made from',
  addPdfBody:
    'Your contract, agreement or form, as a PDF up to 25 MB. Then you put fields on it for each person who signs, and you can change any of its words.',
  choosePdf: 'Choose a PDF',
  newTemplate: 'New template',
  newTemplateBody:
    'Start from the PDF of your contract or agreement. Next, you put fields on it for each person who signs.',
  nameIt: 'Name the template.',
  namePlaceholder: 'Service agreement',
  makeIt: 'Make the template',
  pdfLater: 'Up to 25 MB. You can also add it later.',
  pdfAdded: (removed: number, swapped: boolean) =>
    removed
      ? `PDF added. ${removed === 1 ? 'One thing' : `${removed} things`} on pages it doesn’t have came off.`
      : swapped
        ? 'PDF swapped.'
        : 'PDF added. Now put fields on it for each signer.',
  placed: (n: number) =>
    `Placed ${n === 1 ? 'one field' : `${n} fields`}. Check each one and who it’s for.`,
  placedAlready: 'The fields the AI found are already there.',
  placedNone: 'The AI didn’t find any fields to place. Add them yourself.',
  // Checking a PDF before it's added.
  notPdf: (name: string) => `${name} isn’t a PDF. Save it as a PDF first, then add it.`,
  tooBig: (name: string) => `${name} is over 25 MB. Make it smaller, then add it.`,
  noPages: (name: string) => `${name} has no pages.`,
  tooManyPages: (name: string, n: number) =>
    `${name} has ${n} pages. A template can have up to 100.`,
  didntUpload: (name: string) => `${name} didn’t upload. Check your connection and try again.`,
  // Changing one customer's words when sending (27a).
  forOnly: (name: string) => `Change the words for ${name} only`,
  templateStays: 'The template stays as it is.',
  changesSoFar: (n: number) => (n > 0 ? `${n} ${n === 1 ? 'change' : 'changes'} so far.` : ''),
  pageOf: (n: number, count: number) => `Page ${n} of ${count}`,
  /** The phone's own words, where the phone does a thing its own way: a tap for a click, a sheet for a panel. */
  phone: {
    templateTitle: 'Template',
    addField: 'Add a field',
    pickKind: 'What goes on the page',
    hintField: (kind: string) => `Tap the page where the ${kind.toLowerCase()} goes.`,
    hintWords: 'Tap the words on the page you want to change.',
    hintTextbox: 'Tap where the new words go.',
    hintPicked: 'Drag it to move it, or tap it again for its settings.',
    stop: 'Stop',
    settings: 'Settings',
    done: 'Done',
    move: 'Move it',
    resize: 'Size',
    wider: 'Wider',
    narrower: 'Narrower',
    taller: 'Taller',
    shorter: 'Shorter',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    pagesFailed: 'The pages didn’t load. Check your signal and try again.',
    tryAgain: 'Try again',
    seePages: 'See the pages',
    noFields:
      'Nothing’s placed yet. Add fields for each person who signs, or let the AI place them.',
    issuesTitle: 'Before it can go out',
    colourHint: 'A colour is #RRGGBB.',
    templatesNeedSignal: 'Templates need signal. They show here again once you’re back on.',
    changeWords: 'Change the words',
    name: 'Name',
    rename: 'Rename',
    saveName: 'Save the name',
    more: 'More',
    cancel: 'Cancel',
    makeOne: 'Make one from the PDF of a contract or agreement you send often with New template.',
  },
} as const;

/** A PDF up to this size makes a template. */
export const TEMPLATE_PDF_MAX_BYTES = 25 * 1024 * 1024;
