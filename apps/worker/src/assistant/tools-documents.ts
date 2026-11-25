/**
 * Documents to sign, for the Assistant (docs/documents.md): a template made from a contract sent with the question,
 * changed a piece at a time and its fields placed by the AI, each on a card; a PDF's words read and its signed copy
 * opened; sending, voiding and reminding drawn on cards as their screens say them; and the screens' look-ups read in
 * the screens' words.
 *
 * - **As the person.** Each reads and changes through the kernel as them, so the template's and the document's own
 *   permissions decide, and a document about a customer they can't see isn't there for them.
 * - **A sent document never changes.** Only a template does; the cards say documents already sent aren't touched.
 * - **Nobody signs for anyone.** Nothing here signs, and a signer's link stays get_signing_link's, for that one signer.
 */
import {
  DEFAULT_REMIND_AFTER_DAYS,
  DEFAULT_REMIND_EVERY_DAYS,
  DOCUMENT_EDITOR_WORDS,
  DOCUMENT_FIELD_LABELS,
  DOCUMENT_SCREEN_WORDS,
  DocumentTemplateChange,
  FILL_SOURCES,
  HfosError,
  addPlacedFields,
  applyTemplateChange,
  blankDocumentDefinition,
  DocumentDefinition,
  documentBadge,
  documentDay,
  documentGet,
  documentList,
  documentPrefill,
  documentRemind,
  documentRoleName,
  documentSend,
  documentStepText,
  documentTemplateGet,
  documentTemplateIssues,
  documentVoid,
  fieldName,
  parseDocumentDefinition,
  signerIsUp,
  signerStatusLabel,
  templateChangeWords,
  type DocumentField,
  type DocumentGetOutput,
  type DocumentRole,
  type DocumentListOutput,
  type DocumentPrefillOutput,
  type DocumentSettings,
  type DocumentStepKind,
  type DocumentTemplateGetOutput,
  type DocumentValue,
  type FillSource,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { PDFDocument } from 'pdf-lib';
import type { z } from 'zod';
import { placeFields } from '../documents/place';
import { documentPages, PAGES_AT_ONCE, pdfPageSizes } from '../documents/pages';
import { STAGING_BUCKET, stagedPath } from '../housekeeping/assistant-staging';
import type { WorkerServices } from '../services';
import { ASSISTANT_PDF_PAGES } from './attachments';
import { atLabel, dayLabel } from './calendar-format';
import type { AssistantModelPicture, ToolContext, ToolOutcome } from './runtime';
import { command, query, rehearse } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';
import type { ScreenActionCard } from './tools-workflow';

type Args = Record<string, unknown>;
type Template = z.infer<typeof DocumentTemplateGetOutput>;
type Doc = z.infer<typeof DocumentGetOutput>;
type Prefill = z.infer<typeof DocumentPrefillOutput>;

const W = DOCUMENT_SCREEN_WORDS;
const E = DOCUMENT_EDITOR_WORDS;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const clip = (text: string, n = 120) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const days = (n: number) => plural(n, 'day');
const list = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const templatePath = (ctx: ToolContext, templateId: string) =>
  `/app/w/${ctx.workspaceId}/documents/templates/${templateId}`;
const documentPath = (ctx: ToolContext, documentId: string) =>
  `/app/w/${ctx.workspaceId}/documents/${documentId}`;

const templateOf = (db: Db, ctx: ToolContext, templateId: unknown) =>
  query<Template>(db, ctx, 'document_template.get', { templateId });
const documentOf = (db: Db, ctx: ToolContext, documentId: unknown) =>
  query<Doc>(db, ctx, 'document.get', { documentId });

/** The settings a template keeps, as When it's sent says them. */
function settingsWords(s: DocumentSettings, signers: number) {
  return {
    ...(signers > 1 ? { [W.whoSignsWhen]: s.order === 'together' ? W.together : W.inOrder } : {}),
    [W.askCode]: s.askCode ? 'on' : 'off',
    [W.reminders]:
      s.remindAfterDays === null || s.remindEveryDays === null
        ? 'off'
        : `the first after ${days(s.remindAfterDays)}, then every ${days(s.remindEveryDays)}`,
    [W.expireDays]: s.expireDays,
    [W.note]: s.message,
  };
}

const fillWords = (k: FillSource | null) =>
  k ? `${FILL_SOURCES[k].group}: ${FILL_SOURCES[k].label}` : null;

/** What's filled in a field, in words: a signature's picture is never read back, only whose it is. */
function valueWords(v: DocumentValue | undefined): string | boolean | null {
  if (!v) return null;
  switch (v.kind) {
    case 'text':
      return v.text;
    case 'check':
      return v.checked;
    case 'date':
      return documentDay(v.date);
    case 'signature':
      return `${v.how === 'drawn' ? 'Drawn' : 'Typed'} signature of ${v.name}`;
  }
}

/** A field as the editor's panel says it. */
const fieldRead = (d: DocumentDefinition, f: DocumentField, box: boolean) => ({
  id: f.id,
  type: f.type,
  kind: DOCUMENT_FIELD_LABELS[f.type],
  role: f.role,
  [E.whoFillsIn]: documentRoleName(d, f.role),
  page: f.page,
  ...(box ? { x: f.x, y: f.y, w: f.w, h: f.h } : {}),
  [E.asksFor]: f.label,
  [E.required]: f.required,
  fillFrom: f.fillFrom,
  ...(f.fillFrom ? { [E.fillFrom]: fillWords(f.fillFrom) } : {}),
  ...(f.type === 'choice' ? { options: f.options } : {}),
  fontSize: f.fontSize,
});

// ---------- the screens' look-ups, in the screens' words ----------

/** The most of a template, in characters of JSON, read whole: under what a screen's read holds. */
const WHOLE = 15_000;

/**
 * document_template.get as the editor shows it: what stops it going out first, then When it's sent, Who signs, each
 * field and each change to the PDF's words, with the keys and ids change_document_template takes. A long one comes
 * as an outline, and `page` reads one page's fields and words whole.
 */
export function templateRead(raw: unknown, page: unknown): unknown {
  const t = raw as Template;
  const d = parseDocumentDefinition(t.definition);
  const onPage = typeof page === 'number' ? page : null;
  const head = {
    id: t.id,
    name: t.name,
    revision: t.revision,
    [E.beforeItGoes]: t.issues.length ? t.issues.map((i) => i.message) : E.readyNothing,
    archived: !!t.archivedAt,
    documentsOut: t.documentsOut,
    updatedAt: t.updatedAt,
    pdf: t.source?.name ?? null,
    pages: d.pages.length,
    [E.whenSent]: settingsWords(d.settings, d.roles.length),
    [E.whoSigns]: d.roles.map((r) => ({
      key: r.key,
      label: r.label,
      kind: r.kind === 'team' ? E.kindTeam : E.kindCustomer,
      fields: d.fields.filter((f) => f.role === r.key).length,
    })),
  };
  const whole = (only: number | null) => ({
    ...head,
    ...(only !== null ? { page: only } : {}),
    fields: d.fields
      .filter((f) => only === null || f.page === only)
      .map((f) => fieldRead(d, f, true)),
    [E.pdfWords]: d.edits
      .filter((e) => only === null || e.page === only)
      .map(({ id, page: p, x, y, w, h, text, original, size, font, bold, color, background }) => ({
        id,
        page: p,
        x,
        y,
        w,
        h,
        text,
        original,
        size,
        font,
        bold,
        color,
        background,
      })),
    note: 'Pages are counted from 0, and a box is fractions of the page from its top left. change_document_template changes any of it by key or id; documents already sent never change.',
  });
  const read = whole(onPage);
  if (onPage !== null || JSON.stringify(read).length <= WHOLE) return read;
  return {
    ...head,
    fields: d.fields.map((f) => ({
      id: f.id,
      kind: DOCUMENT_FIELD_LABELS[f.type],
      role: f.role,
      page: f.page,
      ...(f.label ? { label: clip(f.label, 40) } : {}),
    })),
    [E.pdfWords]: d.edits.map((e) => ({
      id: e.id,
      page: e.page,
      text: clip(e.text, 60),
      ...(e.original ? { original: clip(e.original, 60) } : {}),
    })),
    note: 'This template is too long to read whole, so this is its outline: each field without its box or settings, and each change to the words cut short. Read one page whole with page (counted from 0). change_document_template changes any of it by key or id.',
  };
}

/**
 * document.get as its page shows it: its state and notes first, who signs and where each is, then What happened. The
 * notes say their day and time in the business's zone, as the page does in the person's.
 */
export function documentRead(raw: unknown, timeZone?: string): unknown {
  const d = raw as Doc;
  const def = parseDocumentDefinition(d.definition);
  const named = new Map(d.signers.map((s) => [s.id, s.name]));
  const values = d.values as Record<string, DocumentValue>;
  const at = (iso: string) => (timeZone ? atLabel(Date.parse(iso), timeZone) : iso);
  const day = (iso: string) => (timeZone ? dayLabel(Date.parse(iso), timeZone) : iso);
  const note =
    d.status === 'voided' && d.voidedAt
      ? W.voidedNote(at(d.voidedAt), d.voidReason)
      : d.status === 'declined' && d.declinedAt
        ? W.declinedNote(
            d.signers.find((s) => s.status === 'declined')?.name ?? null,
            at(d.declinedAt),
            d.signers.find((s) => s.status === 'declined')?.declineReason ?? null,
          )
        : d.status === 'expired' && d.expiredAt
          ? W.expiredNote(at(d.expiredAt))
          : d.status === 'completed'
            ? W.completedNote
            : d.finishing
              ? 'Everyone signed. The signed copy is being made.'
              : W.outOfTimeOn(day(d.expiresAt));
  return {
    id: d.id,
    name: d.name,
    state: documentBadge(d.status, d.finishing).label,
    note,
    about: d.about,
    sentAt: d.sentAt,
    sentBy: d.sentBy?.fullName ?? null,
    expiresAt: d.expiresAt,
    completedAt: d.completedAt,
    voidedAt: d.voidedAt,
    voidReason: d.voidReason,
    declinedAt: d.declinedAt,
    expiredAt: d.expiredAt,
    [W.whoSignsWhen]: d.signingOrder === 'together' ? W.together : W.inOrder,
    [W.reminders]:
      d.remindAfterDays === null || d.remindEveryDays === null
        ? 'off'
        : `the first after ${days(d.remindAfterDays)}, then every ${days(d.remindEveryDays)}`,
    [W.note]: d.message,
    canSend: d.canSend,
    [W.whoSigns]: d.signers.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.kind === 'copy' ? W.getsCopy : s.roleLabel,
      roleKey: s.roleKey,
      state: s.kind === 'copy' ? W.getsCopy : signerStatusLabel(s, d.signers),
      theirTurn: d.status === 'out' && !d.finishing && signerIsUp(s, d.signers),
      inPerson: s.inPerson,
      email: s.email,
      phone: s.phone,
      askCode: s.askCode,
      sentAt: s.sentAt,
      lastSentAt: s.lastSentAt,
      reminders: s.reminders,
      openedAt: s.openedAt,
      signedAt: s.signedAt,
      declinedAt: s.declinedAt,
      declineReason: s.declineReason,
    })),
    signedCopy: d.signed
      ? {
          name: d.signed.name,
          open: 'get_document_file opens it, and it’s on their Files, locked.',
        }
      : null,
    original: d.source ? { name: d.source.name } : null,
    [W.whatHappened]: d.steps.map((s) => ({
      at: s.at,
      what: documentStepText({
        kind: s.kind as DocumentStepKind,
        channel: s.channel,
        detail: s.detail,
      }),
      who: s.signerId ? (named.get(s.signerId) ?? null) : null,
      ...(s.ip ? { ip: s.ip } : {}),
      ...(s.device ? { device: s.device } : {}),
    })),
    filledIn: def.fields
      .filter((f) => values[f.id])
      .map((f) => ({
        field: fieldName(f),
        for: documentRoleName(def, f.role),
        page: f.page,
        value: valueWords(values[f.id]),
        by: d.valuesBy[f.id] ? (named.get(d.valuesBy[f.id]!) ?? null) : 'You, before it went',
      })),
    fields: def.fields.map((f) => ({
      id: f.id,
      kind: DOCUMENT_FIELD_LABELS[f.type],
      for: documentRoleName(def, f.role),
      page: f.page,
      label: f.label,
      required: f.required,
    })),
    wordsChanged: def.edits.map((e) => ({ page: e.page, text: e.text, original: e.original })),
  };
}

/** document.list with each document's and signer's state as the Sent tab's badges say them. */
export function documentListRead(raw: unknown): unknown {
  const got = raw as z.infer<typeof DocumentListOutput>;
  return {
    ...got,
    documents: got.documents.map((d) => ({
      ...d,
      state: documentBadge(d.status, d.finishing).label,
      signers: d.signers.map((s) => ({
        ...s,
        state: s.kind === 'copy' ? W.getsCopy : signerStatusLabel(s, d.signers),
      })),
    })),
  };
}

/**
 * document.prefill as the Send screen shows it: what stops it going out and who each role suggests first, then what
 * fills in before it goes, When it's sent, and the template's word changes whole, as do_document_send's edits take
 * them.
 */
export function prefillRead(raw: unknown): unknown {
  const p = raw as Prefill;
  const d = parseDocumentDefinition(p.definition);
  const presets = p.presets as Record<string, DocumentValue>;
  return {
    templateId: p.templateId,
    name: p.name,
    [E.beforeItGoes]: p.issues.length ? p.issues.map((i) => i.message) : E.readyNothing,
    signers: p.signers.map((s) => ({ ...s, role: documentRoleName(d, s.roleKey) })),
    copies: p.copies,
    [W.note]: p.message,
    [E.whenSent]: settingsWords(d.settings, d.roles.length),
    [W.filledIn]: d.fields
      .filter((f) => f.role === 'sender' || presets[f.id])
      .map((f) => ({
        ...fieldRead(d, f, false),
        startsWith: valueWords(presets[f.id]),
      })),
    [E.pdfWords]: d.edits,
    note: 'Pass do_document_send each signer by roleKey, and values only for fields you fill in or change. Its edits replace these word changes whole for this customer: pass every one to keep, plus theirs.',
  };
}

// ---------- sending, voiding and reminding, on cards as the screens say them ----------

const settled = (template: DocumentSettings, given: Args): DocumentSettings => {
  const s = (given['settings'] ?? {}) as Partial<DocumentSettings>;
  return {
    ...template,
    ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)),
    // As document.send takes it: a note given, even an empty one, is in place of the template's.
    message: typeof given['message'] === 'string' ? given['message'].trim() : template.message,
  };
};

interface Member {
  userId: string;
  fullName: string;
  email: string;
}

async function teamNames(db: Db, ctx: ToolContext): Promise<Map<string, string>> {
  const t = await query<{ members: Member[]; organizationAdmins: Member[] }>(
    db,
    ctx,
    'workspace.members',
  );
  return new Map(
    [...t.members, ...t.organizationAdmins].map((m) => [m.userId, m.fullName || m.email]),
  );
}

async function customerOf(db: Db, ctx: ToolContext, personId: string) {
  return (
    await query<{ person: { fullName: string; email: string | null; phone: string | null } }>(
      db,
      ctx,
      'person.get',
      { personId },
    )
  ).person;
}

/** How a link reaches someone, as the Send screen says it. */
const linkWay = (email: string | null | undefined, phone: string | null | undefined) =>
  email && phone
    ? 'link by email and text'
    : email
      ? 'link by email'
      : phone
        ? 'link by text'
        : 'no way to send a link';

/**
 * One customer's word changes (27a) against the template's, since what's given replaces the template's whole: the
 * changes theirs alone, and any of the template's left out for them. Null when it comes to the template's own.
 */
function theirWords(d: DocumentDefinition, given: readonly Args[]): string | null {
  const template = new Map(d.edits.map((e) => [e.id, e]));
  const ids = new Set(given.map((e) => String(e['id'])));
  const own = given.filter((e) => {
    const was = template.get(String(e['id']));
    return !was || was.text !== String(e['text'] ?? '');
  }).length;
  const left = d.edits.filter((e) => !ids.has(e.id)).length;
  if (!own && !left) return null;
  return [
    ...(own ? [`${plural(own, 'change')} to the words, for them only.`] : []),
    ...(left
      ? [
          `${left} of the template’s changes to the words ${left === 1 ? 'is' : 'are'} left out for them, so the PDF’s own words show there.`,
        ]
      : []),
  ].join(' ');
}

/** Send “Lease” to sign?: who signs, in order, and how each one's link reaches them, then the settings. */
const sendCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const t = await templateOf(db, ctx, args['templateId']);
    const d = parseDocumentDefinition(t.definition);
    const team = await teamNames(db, ctx);
    const signers = (Array.isArray(args['signers']) ? args['signers'] : []) as Args[];
    const ordered = [...signers].sort(
      (a, b) =>
        d.roles.findIndex((r) => r.key === a['roleKey']) -
        d.roles.findIndex((r) => r.key === b['roleKey']),
    );
    const who = await Promise.all(
      ordered.map(async (s) => {
        const role = documentRoleName(d, String(s['roleKey']));
        const personId = str(s['personId']);
        if (personId) {
          const p = await customerOf(db, ctx, personId);
          return {
            label: role,
            value: `${p.fullName}, ${s['inPerson'] ? 'signs with you in person' : linkWay(p.email, p.phone)}`,
          };
        }
        const name = team.get(String(s['userId'])) ?? 'Someone on your team';
        return {
          label: role,
          value: `${name}, ${s['inPerson'] ? 'signs with you in person' : 'link by email'}`,
        };
      }),
    );
    const copies = await Promise.all(
      ((Array.isArray(args['copies']) ? args['copies'] : []) as Args[]).map(async (c) =>
        str(c['personId'])
          ? (await customerOf(db, ctx, String(c['personId']))).fullName
          : (team.get(String(c['userId'])) ?? 'Someone on your team'),
      ),
    );
    const s = settled(d.settings, args);
    const name = str(args['name']) ?? t.name;
    const words = Array.isArray(args['edits']) ? theirWords(d, args['edits'] as Args[]) : null;
    const values = Object.keys((args['values'] ?? {}) as Args).length;
    const fields = [
      ...(name !== t.name ? [{ label: W.template, value: t.name }] : []),
      ...who,
      ...(copies.length ? [{ label: W.copies, value: list(copies) }] : []),
      ...(signers.length > 1
        ? [{ label: W.whoSignsWhen, value: s.order === 'together' ? W.together : W.inOrder }]
        : []),
      ...(s.askCode ? [{ label: W.askCode, value: W.askCodeBody }] : []),
      {
        label: W.reminders,
        value:
          s.remindAfterDays === null || s.remindEveryDays === null
            ? 'Off'
            : `The first after ${days(s.remindAfterDays ?? DEFAULT_REMIND_AFTER_DAYS)}, then every ${days(s.remindEveryDays ?? DEFAULT_REMIND_EVERY_DAYS)}`,
      },
      { label: W.expireDays, value: String(s.expireDays) },
      ...(s.message ? [{ label: W.note, value: clip(s.message, 200) }] : []),
      ...(values ? [{ label: W.filledIn, value: `${plural(values, 'field')} you filled in` }] : []),
      ...(words ? [{ label: 'Their own words', value: `${words} ${E.templateStays}` }] : []),
    ];
    const inPersonOnly = signers.length > 0 && signers.every((x) => x['inPerson']);
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: `Send “${name}” to sign?`,
        fields,
        confirmLabel: W.sendIt,
        warnings: [
          {
            kind: 'caution',
            text: inPersonOnly
              ? 'It’s sent as soon as you confirm. Each signer signs with you, with Sign now on the document.'
              : 'It goes out as soon as you confirm: each signer gets their own private link when it’s their turn.',
          },
          ...(args['replacesDocumentId']
            ? [{ kind: 'note', text: 'It says it replaces the earlier one, which stays as it is.' }]
            : []),
        ],
      }),
      result: {
        waiting: true,
        sending: name,
        signers: who.map((w) => `${w.label}: ${w.value}`),
        ...(copies.length ? { copies } : {}),
      },
    };
  },
  async done(db, ctx, args, output) {
    const id = String(output['documentId']);
    const signers = (output['signers'] ?? []) as { kind: string; name: string }[];
    const many = signers.filter((s) => s.kind === 'signer').length > 1;
    return {
      outcome: `${many ? W.sentMany : W.sentOne} “${String(output['name'])}” is under Documents → Sent.`,
      href: documentPath(ctx, id),
      answer: output,
    };
  },
};

/** Void “Lease”?: who is told, and the reason they see. */
const voidCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const d = await documentOf(db, ctx, args['documentId']);
    const told = d.signers.filter(
      (s) => s.kind === 'signer' && s.sentAt && s.status !== 'declined',
    );
    const reason = str(args['reason']);
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: W.voidTitle(d.name),
        fields: [
          ...(d.about ? [{ label: W.about, value: d.about.name }] : []),
          {
            label: 'Told it’s voided',
            value: told.length ? list(told.map((s) => s.name)) : 'Nobody had their link yet',
          },
          { label: W.voidReason, value: reason ?? 'No reason given' },
        ],
        confirmLabel: W.voidIt,
        warnings: [{ kind: 'caution', text: W.voidBody }],
      }),
      result: { waiting: true, voiding: d.name, told: told.map((s) => s.name) },
    };
  },
  async done(db, ctx, args) {
    return { outcome: W.voided, href: documentPath(ctx, String(args['documentId'])) };
  },
};

/** Remind them?: whose turn it is, and how their link goes again. */
const remindCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const d = await documentOf(db, ctx, args['documentId']);
    // Whom document.remind sends to: whoever's turn it is and has had their link, or signs in person and can be
    // reached, for their first.
    const up = d.signers.filter(
      (s) =>
        signerIsUp(s, d.signers) &&
        s.status !== 'declined' &&
        (s.sentAt || (s.inPerson && (s.email || s.phone))),
    );
    const lines = up.map((s) => ({
      label: s.roleLabel ?? 'Signer',
      value: `${s.name}, ${s.sentAt ? `their ${linkWay(s.email, s.phone)} again` : `their first ${linkWay(s.email, s.phone)}`}`,
    }));
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: `Remind them to sign “${d.name}”?`,
        fields: lines,
        confirmLabel: W.remind,
        warnings: [{ kind: 'caution', text: 'It goes to them as soon as you confirm.' }],
      }),
      result: { waiting: true, reminding: up.map((s) => s.name), document: d.name },
    };
  },
  async done(db, ctx, args) {
    return { outcome: W.reminded, href: documentPath(ctx, String(args['documentId'])) };
  },
};

/** Keyed by the commands themselves, so they stay screen actions (the coverage test reads quoted names). */
export const documentScreenCards: Readonly<Record<string, ScreenActionCard>> = {
  [documentSend.name]: sendCard,
  [documentVoid.name]: voidCard,
  [documentRemind.name]: remindCard,
};

/** The screens' look-ups this file says in the screens' words, by query. */
export const documentReads: Readonly<
  Record<string, (got: unknown, args: Args, timeZone: string) => unknown>
> = {
  [documentGet.name]: (got, _args, timeZone) => documentRead(got, timeZone),
  [documentList.name]: (got) => documentListRead(got),
  [documentTemplateGet.name]: (got, args) => templateRead(got, args['page']),
  [documentPrefill.name]: (got) => prefillRead(got),
};

// ---------- a template changed a piece at a time ----------

const changeOf = (args: Args) => {
  const parsed = DocumentTemplateChange.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    throw HfosError.validation(issues, issues[0]?.message ?? 'Some of that change doesn’t fit.');
  }
  return parsed.data;
};

const archived = (name: string) =>
  HfosError.rule(
    'document_template_archived',
    409,
    `“${name}” is archived, so it can’t change. Restore it first under Documents → Templates, Archived.`,
  );

/** Change lines as a card's fields: eight at most, then how many more. */
function changeFields(lines: readonly string[]) {
  const shown =
    lines.length > 8
      ? [...lines.slice(0, 7), `And ${plural(lines.length - 7, 'more change')}`]
      : lines;
  return shown.map((value, i) => ({ label: i === 0 ? 'Change' : 'Then', value }));
}

const changeDocumentTemplate: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const t = await templateOf(db, ctx, args['templateId']);
    if (t.archivedAt) throw archived(t.name);
    const before = parseDocumentDefinition(t.definition);
    const after = applyTemplateChange(before, changeOf(args));
    const lines = templateChangeWords(before, after);
    if (!lines.length)
      throw HfosError.validation(
        [],
        `That leaves “${t.name}” as it is. Say what to change: a setting, who signs, a field or the words.`,
      );
    await rehearse(db, ctx, 'document_template.save', {
      templateId: t.id,
      baseRevision: t.revision,
      definition: after,
    });
    const gone = before.roles.filter(
      (r) =>
        !after.roles.some((x) => x.key === r.key) && before.fields.some((f) => f.role === r.key),
    );
    const issues = documentTemplateIssues(after, !!t.source);
    return {
      card: settingsCard(toolCallId, 'change_document_template', {
        title: `Change “${t.name}”?`,
        fields: changeFields(lines),
        confirmLabel: 'Save the template',
        warnings: [
          { kind: 'note', text: 'Documents already sent aren’t touched.' },
          ...(gone.length
            ? [
                {
                  kind: 'caution',
                  text: `${list(gone.map((r) => r.label))} come${gone.length === 1 ? 's' : ''} off Who signs, with every field of theirs.`,
                },
              ]
            : []),
          ...(issues.length
            ? [{ kind: 'caution', text: `Not ready to send after this: ${issues[0]!.message}` }]
            : []),
        ],
      }),
      result: { waiting: true, template: t.name, changes: lines },
    };
  },
  async commit(db, ctx, args) {
    // Over the template as it is now: what the card showed changing is all that changes.
    const t = await templateOf(db, ctx, args['templateId']);
    if (t.archivedAt) throw archived(t.name);
    const before = parseDocumentDefinition(t.definition);
    const after = applyTemplateChange(before, changeOf(args));
    const saved = await command<{
      revision: number;
      changed: boolean;
      issues: { message: string }[];
    }>(db, ctx, 'document_template.save', {
      templateId: t.id,
      baseRevision: t.revision,
      definition: after,
    });
    const lines = templateChangeWords(before, after);
    return {
      outcome: saved.changed
        ? `Saved “${t.name}”${saved.issues.length ? `. Before it can go out: ${saved.issues[0]!.message}` : '. Documents already sent aren’t touched.'}`
        : `“${t.name}” already had that, so nothing changed.`,
      href: templatePath(ctx, t.id),
      command: 'document_template.save',
      answer: { templateId: t.id, revision: saved.revision, changes: lines, issues: saved.issues },
    };
  },
};

// ---------- Place fields for me ----------

/** The template the AI can place fields on: there, not archived, with its PDF. */
async function placeable(db: Db, ctx: ToolContext, templateId: unknown): Promise<Template> {
  const t = await templateOf(db, ctx, templateId);
  if (t.archivedAt) throw archived(t.name);
  if (!t.source)
    throw HfosError.rule(
      'document_template_no_pdf',
      409,
      `“${t.name}” has no PDF yet. Add one on the template (Documents → Templates, then press it), then the AI can place its fields.`,
    );
  return t;
}

const noAi = () =>
  HfosError.rule(
    'ai_not_configured',
    503,
    'The AI can’t place fields from here just now. Press Place fields for me on the template instead, or try again in a minute.',
  );

const placeTemplateFields: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const t = await placeable(db, ctx, args['templateId']);
    if (!deps?.services?.ai.provider) throw noAi();
    const d = parseDocumentDefinition(t.definition);
    return {
      card: settingsCard(toolCallId, 'place_template_fields', {
        title: `${E.placeForMe} on “${t.name}”?`,
        fields: [
          { label: 'PDF', value: `${t.source!.name}, ${W.pages(d.pages.length)}` },
          { label: E.whoSigns, value: d.roles.map((r) => r.label).join(', then ') },
          {
            label: 'Fields there now',
            value: d.fields.length
              ? `${plural(d.fields.length, 'field')}. They stay, and a spot that already has one is skipped.`
              : 'None yet',
          },
        ],
        confirmLabel: E.placeForMe,
        warnings: [
          {
            kind: 'note',
            text: 'The AI reads the PDF and places a field on each line, box and label that looks like one. It counts toward your daily AI limit. Check each field and who it’s for after.',
          },
        ],
      }),
      result: { waiting: true, template: t.name, signers: d.roles.map((r) => r.label) },
    };
  },
  async commit(db, ctx, args, extra) {
    const s = extra.services;
    if (!s?.ai.provider) throw noAi();
    const t = await placeable(db, ctx, args['templateId']);
    const before = parseDocumentDefinition(t.definition);
    // As the phone's Place fields for me: no spots sent, so the worker finds them on the template's own PDF.
    const { fields } = await placeFields(
      { httpDb: db, store: s.store, ai: s.ai, log: s.log, wallet: s.wallet },
      ctx.actor,
      { workspaceId: ctx.workspaceId, templateId: t.id, roles: before.roles },
    );
    const placed = addPlacedFields(before, fields);
    if (!placed.added)
      return {
        outcome: fields.length ? E.placedAlready : E.placedNone,
        href: templatePath(ctx, t.id),
        command: 'document_template.save',
        answer: { templateId: t.id, added: 0 },
      };
    const saved = await command<{ revision: number; issues: { message: string }[] }>(
      db,
      ctx,
      'document_template.save',
      { templateId: t.id, baseRevision: t.revision, definition: placed.definition },
    );
    const added = placed.definition.fields.filter((f) => !before.fields.some((b) => b.id === f.id));
    return {
      outcome: E.placed(placed.added),
      href: templatePath(ctx, t.id),
      command: 'document_template.save',
      answer: {
        templateId: t.id,
        revision: saved.revision,
        added: added.map((f) => fieldRead(placed.definition, f, false)),
        ...(placed.skipped ? { skipped: placed.skipped } : {}),
        ...(saved.issues.length ? { [E.beforeItGoes]: saved.issues.map((i) => i.message) } : {}),
      },
    };
  },
};

// ---------- a new template, from a contract sent with the question ----------

/** A page of a template made from photos: US Letter, in points. */
const LETTER = { width: 612, height: 792 } as const;

/** Photos of a contract's pages as one PDF: a Letter page each, its photo as big as fits, in the order sent. */
export async function photosAsPdf(pictures: readonly AssistantModelPicture[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (const picture of pictures) {
    const image = await pdf.embedJpg(Buffer.from(picture.data, 'base64'));
    const page = pdf.addPage([LETTER.width, LETTER.height]);
    const scale = Math.min(LETTER.width / image.width, LETTER.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: (LETTER.width - width) / 2,
      y: (LETTER.height - height) / 2,
      width,
      height,
    });
  }
  return Buffer.from(await pdf.save());
}

/** The contract a new template is made from, as the card shows it. */
interface Contract {
  readonly from: 'file' | 'pictures';
  readonly bytes: Buffer;
  readonly pages: number;
  /** The card's PDF row. */
  readonly label: string;
}

const which = (args: Args): 'file' | 'pictures' | null =>
  typeof args['fromFile'] === 'number' ? 'file' : args['fromPictures'] === true ? 'pictures' : null;

/** The PDF or the photos sent with this question, ready to keep; null when it's made with no PDF yet. */
async function contractOf(ctx: ToolContext, args: Args): Promise<Contract | null> {
  if (typeof args['fromFile'] === 'number' && args['fromPictures'] === true)
    throw HfosError.validation(
      [{ path: 'fromPictures', message: 'From the file or the pictures, one of them.' }],
      'Make it from the file or from the pictures, one of them.',
    );
  if (which(args) === 'file') {
    const sent = ctx.files ?? [];
    const file = sent[(args['fromFile'] as number) - 1];
    if (!file)
      throw HfosError.validation(
        [{ path: 'fromFile', message: 'No such file.' }],
        sent.length
          ? `Only ${plural(sent.length, 'file')} came with this question.`
          : 'No file came with this question. Ask them to send the contract as a PDF with their question.',
      );
    if (file.kind !== 'pdf')
      throw HfosError.rule(
        'document_template_not_pdf',
        400,
        `${file.name} isn’t a PDF, and a template is made from one. Save it as a PDF and send that.`,
      );
    if (file.of)
      throw HfosError.rule(
        'document_template_too_long',
        400,
        `${file.name} has ${file.of} pages, more than the ${ASSISTANT_PDF_PAGES} the Assistant reads at once. Make the template from it under Documents → New template instead.`,
      );
    return {
      from: 'file',
      bytes: Buffer.from(file.data, 'base64'),
      pages: file.pages,
      label: `${file.name}, ${W.pages(file.pages)}`,
    };
  }
  if (which(args) === 'pictures') {
    const pictures = ctx.pictures ?? [];
    if (!pictures.length)
      throw HfosError.validation(
        [{ path: 'fromPictures', message: 'No picture came.' }],
        'No picture came with this question. Ask them to send a photo of each page, or the contract as a PDF.',
      );
    return {
      from: 'pictures',
      bytes: await photosAsPdf(pictures),
      pages: pictures.length,
      label: `Made from ${plural(pictures.length, 'photo')}, a page each`,
    };
  }
  return null;
}

/** Who signs, as given, each with a key of its own; one customer when none are given. */
export function signersOf(args: Args): DocumentRole[] {
  const given = Array.isArray(args['signers'])
    ? (args['signers'] as { label: string; kind: 'customer' | 'team' }[])
    : [];
  if (!given.length) return blankDocumentDefinition().roles;
  const taken = new Set<string>(['sender']);
  const roles = given.map((s) => {
    const base =
      s.label
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^[^a-z]+/, '')
        .slice(0, 30)
        .replace(/_+$/, '') || (s.kind === 'team' ? 'team' : 'customer');
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
    taken.add(key);
    return { key, label: s.label.trim(), kind: s.kind };
  });
  const parsed = DocumentDefinition.safeParse({ ...blankDocumentDefinition(), roles });
  if (!parsed.success)
    throw HfosError.validation(
      [{ path: 'signers', message: parsed.error.issues[0]?.message ?? 'That doesn’t fit.' }],
      parsed.error.issues[0]?.message ?? 'Who signs doesn’t fit a template.',
    );
  return parsed.data.roles;
}

const signerWords = (roles: readonly DocumentRole[]) =>
  roles.map((r) => (r.kind === 'team' ? `${r.label} (your team)` : r.label)).join(', then ');

const noStore = () =>
  HfosError.rule(
    'documents_unavailable',
    503,
    'A template can’t be made from a file here just now. Make it under Documents → New template instead, or try again in a minute.',
  );

const fileGone = () =>
  HfosError.rule(
    'assistant_file_gone',
    410,
    'The contract from that question isn’t kept anymore, so the template wasn’t made. Send it again with your question.',
  );

/** A file name of the template's own name, for its PDF. */
const pdfName = (name: string) => `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Contract'}.pdf`;

const makeDocumentTemplate: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const name = str(args['name']) ?? '';
    const contract = await contractOf(ctx, args);
    const roles = signersOf(args);
    await rehearse(db, ctx, 'document_template.create', { name });
    // What's sent is gone after this answer: the PDF waits for Confirm where only the worker reaches it.
    if (contract) {
      if (!deps?.services?.store) throw noStore();
      await deps.services.store.upload(
        STAGING_BUCKET,
        stagedPath(ctx.workspaceId, toolCallId),
        contract.bytes,
        'application/pdf',
        { upsert: true },
      );
    }
    const placing = contract?.from === 'file' && !!deps?.services?.ai.provider;
    return {
      card: settingsCard(toolCallId, 'make_document_template', {
        title: `Make the template “${name}”?`,
        fields: [
          { label: 'Name', value: name },
          { label: 'PDF', value: contract?.label ?? 'None yet: add it on the template' },
          { label: E.whoSigns, value: signerWords(roles) },
          {
            label: 'Fields',
            value: !contract
              ? ''
              : placing
                ? 'The AI places one on each line, box and label that looks like one'
                : contract.from === 'pictures'
                  ? 'Added on the template: a photo has no lines the AI can find'
                  : 'Added on the template',
          },
        ],
        confirmLabel: 'Make the template',
        warnings: [
          { kind: 'note', text: 'Nothing goes to a customer: sending it is its own step.' },
          ...(placing
            ? [
                {
                  kind: 'note',
                  text: 'Placing the fields counts toward your daily AI limit. Check each one and who it’s for after.',
                },
              ]
            : []),
        ],
      }),
      result: {
        waiting: true,
        template: name,
        pages: contract?.pages ?? 0,
        signers: roles.map((r) => r.label),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const s = extra.services ?? null;
    const name = str(args['name']) ?? '';
    const roles = signersOf(args);
    const from = which(args);
    const staged = from ? stagedPath(ctx.workspaceId, extra.toolCallId) : null;
    let bytes: Buffer | null = null;
    if (staged) {
      if (!s) throw noStore();
      bytes = await s.store.download(STAGING_BUCKET, staged).catch(() => null);
      if (!bytes) throw fileGone();
    }
    try {
      const made = await command<{ templateId: string; revision: number }>(
        db,
        ctx,
        'document_template.create',
        { name },
      );
      const templateId = made.templateId;
      let revision = made.revision;
      let pages: { width: number; height: number }[] = [];
      let pdfProblem: string | null = null;
      if (bytes && s) {
        try {
          // As New template does with a PDF: reserved, uploaded, confirmed, then its pages read in.
          const sizes = await pdfPageSizes(bytes);
          const spot = await command<{ fileId: string; bucket: string; objectPath: string }>(
            db,
            ctx,
            'document_template.begin_upload',
            {
              templateId,
              name: pdfName(name),
              mimeType: 'application/pdf',
              sizeBytes: bytes.length,
            },
          );
          await s.store.upload(spot.bucket, spot.objectPath, bytes, 'application/pdf');
          await command(db, ctx, 'file.confirm', { fileId: spot.fileId });
          const set = await command<{ revision: number }>(db, ctx, 'document_template.set_source', {
            templateId,
            fileId: spot.fileId,
            pages: sizes,
            baseRevision: revision,
          });
          revision = set.revision;
          pages = sizes;
        } catch (e) {
          pdfProblem = e instanceof HfosError ? e.message : 'It didn’t upload.';
        }
      }
      let definition = DocumentDefinition.parse({ ...blankDocumentDefinition(), roles, pages });
      let placed = 0;
      // Said when the AI placed nothing: why, and what to do instead.
      let placeNote = 'The AI found no fields to place, so add them on the template.';
      if (pages.length && from === 'file') {
        if (!s?.ai.provider)
          placeNote =
            'The AI can’t place fields just now. Press Place fields for me on the template later, or add them yourself.';
        else
          try {
            const { fields } = await placeFields(
              { httpDb: db, store: s.store, ai: s.ai, log: s.log, wallet: s.wallet },
              ctx.actor,
              { workspaceId: ctx.workspaceId, templateId, roles },
            );
            const added = addPlacedFields(definition, fields);
            definition = added.definition;
            placed = added.added;
          } catch (e) {
            // Nothing that looks like a field is the note as it is; a limit says itself; the rest, try again later.
            if (
              e instanceof HfosError &&
              (e.rule === 'budget_reached' || e.rule === 'wallet_empty')
            )
              placeNote = `${e.message} Add the fields on the template instead.`;
            else if (!(e instanceof HfosError && e.code === 'validation'))
              placeNote =
                'The AI couldn’t place the fields just now. Press Place fields for me on the template later, or add them yourself.';
          }
      }
      const ownSigners = JSON.stringify(roles) !== JSON.stringify(blankDocumentDefinition().roles);
      if (ownSigners || placed) {
        const saved = await command<{ revision: number }>(db, ctx, 'document_template.save', {
          templateId,
          baseRevision: revision,
          definition,
        });
        revision = saved.revision;
      }
      const lead = `Made the template “${name}”`;
      const outcome = pdfProblem
        ? `${lead}, but its PDF didn’t go on: ${pdfProblem} Add the PDF on the template.`
        : !pages.length
          ? `${lead}. Add its PDF on the template, then place the fields.`
          : from === 'pictures'
            ? `${lead} from ${plural(pages.length, 'photo')}, a page each. Add the fields on the template.`
            : `${lead} with its ${plural(pages.length, 'page')}. ${placed ? E.placed(placed) : placeNote}`;
      return {
        outcome,
        href: templatePath(ctx, templateId),
        command: 'document_template.create',
        answer: {
          templateId,
          revision,
          pages: pages.length,
          fieldsPlaced: placed,
          signers: roles.map((r) => r.label),
        },
      };
    } finally {
      if (staged && s) await s.store.remove(STAGING_BUCKET, staged).catch(() => undefined);
    }
  },
};

export const documentConfirmTools: Record<string, SettingsConfirmTool> = {
  make_document_template: makeDocumentTemplate,
  change_document_template: changeDocumentTemplate,
  place_template_fields: placeTemplateFields,
};

// ---------- a PDF's words, and the signed copy ----------

/** How long a link to a document's PDF works. */
const FILE_LINK_SECONDS = 300;

const notHere = () =>
  HfosError.rule(
    'documents_unavailable',
    503,
    'That can’t be read from here just now. Open it on its page in Documents instead, or try again in a minute.',
  );

/** The ones that read the worker's file store, as the editor's pages and Open the signed copy do. */
export const documentServiceTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args, services: WorkerServices | null) => Promise<ToolOutcome>
> = {
  /** "What does section 4 of the lease say?", or the box of a line to change. */
  async get_document_pages(db, ctx, args, services) {
    if (!services) throw notHere();
    const templateId = str(args['templateId']);
    const documentId = str(args['documentId']);
    if (!templateId === !documentId)
      throw HfosError.validation(
        [{ path: 'templateId', message: 'Say which template or document.' }],
        'Say which template or document, one of them.',
      );
    const from = typeof args['from'] === 'number' ? Math.max(0, Math.trunc(args['from'])) : 0;
    const count = Math.min(
      PAGES_AT_ONCE,
      Math.max(1, typeof args['count'] === 'number' ? Math.trunc(args['count']) : 2),
    );
    const got = await documentPages({ httpDb: db, store: services.store }, ctx.actor, {
      workspaceId: ctx.workspaceId,
      ...(templateId ? { templateId } : { documentId: documentId! }),
      from,
      count,
    });
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    const next = from + got.pages.length;
    return {
      result: {
        pageCount: got.pageCount,
        pages: got.pages.map((p) => ({
          page: p.page,
          lines: p.lines.map((l) => ({
            text: l.text,
            x: round(l.x),
            y: round(l.y),
            w: round(l.w),
            h: round(l.h),
            size: Math.round(l.size * 10) / 10,
            font: l.font,
            bold: l.bold,
            color: l.color,
            background: l.background,
          })),
        })),
        ...(next < got.pageCount ? { more: `Pages ${next} on: ask again with from ${next}.` } : {}),
        note: 'Pages are counted from 0, and each box is fractions of the page from its top left. To change a line, give its page, box and colours, with its text as original and the new words as text.',
      },
    };
  },
  /** "Send me the signed lease": Open the signed copy, as the person. */
  async get_document_file(db, ctx, args, services) {
    if (!services) throw notHere();
    const d = await documentOf(db, ctx, args['documentId']);
    const which = args['which'] === 'original' ? 'original' : 'signed';
    const file = which === 'signed' ? d.signed : d.source;
    if (!file)
      throw which === 'signed'
        ? HfosError.rule(
            'document_not_signed',
            409,
            d.finishing
              ? `Everyone has signed “${d.name}”. The signed copy is being made, so ask again in a minute.`
              : `“${d.name}” isn’t signed by everyone yet, so there’s no signed copy. The original PDF it was sent from can be opened instead.`,
          )
        : HfosError.notFound(`The PDF “${d.name}” was sent from isn’t there anymore.`);
    const link = await services.store.signedUrl(file.bucket, file.objectPath, FILE_LINK_SECONDS);
    return {
      result: {
        for: `${which === 'signed' ? 'The signed copy of' : 'The original of'} “${d.name}”`,
        file: file.name,
        link,
        note:
          which === 'signed'
            ? 'It works for 5 minutes and opens the file to whoever has it, so give it only to the person asking. The signed copy is also on their Files, locked, with its proof page at the end.'
            : 'It works for 5 minutes and opens the file to whoever has it, so give it only to the person asking.',
      },
    };
  },
};

/** What the panel says while each one runs. */
export const documentStepLabels: Record<string, string> = {
  make_document_template: 'Getting the new template ready',
  change_document_template: 'Getting the template change ready',
  place_template_fields: 'Getting the fields ready to place',
  get_document_pages: 'Reading the PDF',
  get_document_file: 'Opening the PDF',
};
