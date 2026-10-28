/**
 * Documents to sign (docs/documents.md): sending a template to the people who sign it, reminding them, and voiding
 * one; and what the worker records for them as they open, check their code, sign or decline, and when the signed copy
 * is filed. documents.send for the team's; the system's are the worker's alone.
 *
 * - **A sent document never changes** (answer 15a): it keeps the template's definition as it went, with that
 *   customer's own word changes (27a) and what the team filled in. A mistake is voided and a corrected one sent.
 * - **Whose turn it is** is the signers at the lowest position still to sign: one role at a time in order, everyone
 *   at once together. `document.sent` and `document.turn` name them, and the worker sends their links.
 * - **What a signer types fills blanks on the customer** (7a), through `person.update`, never writing over anything.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  documents,
  documentSigners,
  documentSteps,
  documentValues,
  files,
  people,
  users,
} from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import {
  fieldName,
  signerProblems,
  documentTemplateIssues,
  valueProblem,
} from '../documents/check';
import {
  DocumentDefinition,
  SENDER_ROLE,
  valueKindOf,
  WRITE_BACK_SOURCES,
  type DocumentDefinition as DocumentDefinitionT,
  type DocumentValue,
} from '../documents/definition';
import { dayIn, loadFillContext, presetsFor, type DocumentAbout } from '../documents/fill';
import {
  documentGone,
  loadDocument,
  loadTemplate,
  signersOf,
  signersUp,
  type DocumentRow,
  type DocumentSignerRow,
} from '../documents/load';
import { DOCUMENT_CODE_TRIES, DOCUMENT_CODE_MINUTES } from '../documents/words';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import {
  DocumentCodeCheckInput,
  DocumentCodeCheckOutput,
  DocumentCodeSentInput,
  DocumentCopiesSentInput,
  DocumentDeclineInput,
  DocumentFinishInput,
  DocumentLinkSentInput,
  DocumentLinkSentOutput,
  DocumentOkOutput,
  DocumentOpenInput,
  DocumentOpenOutput,
  DocumentRefInput,
  DocumentSendInput,
  DocumentSendOutput,
  DocumentSignInput,
  DocumentSignNowInput,
  DocumentSignNowOutput,
  DocumentSignOutput,
  DocumentVoidInput,
} from '../schemas/document';
import { personUpdate } from './person.update';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const asJson = (d: DocumentDefinitionT) => d as unknown as Record<string, unknown>;
const DAY_MS = 24 * 60 * 60_000;

/** The record a document is filed on, for its timeline lines. */
const aboutOf = (d: Pick<DocumentRow, 'personId' | 'companyId' | 'leadId' | 'customRecordId'>) => ({
  personId: d.personId,
  companyId: d.companyId,
  leadId: d.leadId,
  customRecordId: d.customRecordId,
});

const fullName = (p: { firstName: string; lastName: string }) =>
  [p.firstName, p.lastName].filter(Boolean).join(' ').trim();

/** A document still out, and not yet signed by everyone. */
function assertOut(row: DocumentRow): void {
  if (row.status === 'voided')
    throw HfosError.rule(
      'document_voided',
      409,
      `“${row.name}” was voided, so nothing more happens to it.`,
    );
  if (row.status === 'completed')
    throw HfosError.rule('document_completed', 409, `Everyone has signed “${row.name}” already.`);
  if (row.status === 'declined')
    throw HfosError.rule(
      'document_declined',
      409,
      `“${row.name}” was declined, so it can’t be signed. Send a corrected one if it’s still needed.`,
    );
  if (row.status === 'expired' || row.expiresAt.getTime() <= Date.now())
    throw HfosError.rule(
      'document_expired',
      409,
      `“${row.name}” ran out of time. Send it again if it’s still needed.`,
    );
}

/** A signer of the business's, for the worker's commands. */
async function loadSigner(
  ctx: CommandContext,
  signerId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{ signer: DocumentSignerRow; doc: DocumentRow; definition: DocumentDefinitionT }> {
  const q = ctx.tx
    .select()
    .from(documentSigners)
    .where(
      and(
        eq(documentSigners.id, signerId),
        eq(documentSigners.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  const [signer] = opts.forUpdate ? await q.for('update') : await q;
  if (!signer) throw documentGone();
  const { row, definition } = await loadDocument(
    ctx.tx,
    ctx.scope.workspaceId!,
    signer.documentId,
    {
      forUpdate: opts.forUpdate,
    },
  );
  return { signer, doc: row, definition };
}

async function addStep(
  ctx: CommandContext,
  doc: DocumentRow,
  step: {
    kind: (typeof documentSteps.$inferInsert)['kind'];
    signerId?: string | null;
    channel?: 'email' | 'sms' | 'portal' | 'page' | null;
    ip?: string | null;
    device?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.tx.insert(documentSteps).values({
    workspaceId: doc.workspaceId,
    documentId: doc.id,
    signerId: step.signerId ?? null,
    kind: step.kind,
    channel: step.channel ?? null,
    ip: step.ip ?? null,
    device: step.device ?? null,
    detail: step.detail ?? {},
    byUserId: ctx.actor.type === 'human' ? ctx.actor.userId : null,
  });
}

async function timeline(
  ctx: CommandContext,
  doc: DocumentRow,
  subtype: string,
  eventId: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await logSystemActivity(ctx, {
    subtype,
    ...aboutOf(doc),
    body: doc.name,
    meta: { documentId: doc.id, ...meta },
    eventId,
  });
}

// ---------- sending ----------

interface Recipient {
  readonly personId: string | null;
  readonly userId: string | null;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

async function personRecipient(ctx: CommandContext, personId: string): Promise<Recipient> {
  const [p] = await ctx.tx
    .select({
      id: people.id,
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      phone: people.phoneE164,
      binItemId: people.binItemId,
      erasedAt: people.erasedAt,
    })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.workspaceId, ctx.scope.workspaceId!)));
  if (!p || p.erasedAt)
    throw HfosError.notFound(
      'One of the people you picked isn’t there anymore, or you can’t see them. Refresh and pick again.',
    );
  const name = fullName(p) || p.email || 'Customer';
  if (p.binItemId)
    throw HfosError.rule(
      'document_signer_deleted',
      409,
      `${name} is in the Deleted bin. Restore them first, or pick someone else.`,
    );
  return { personId: p.id, userId: null, name, email: p.email, phone: p.phone };
}

async function userRecipient(ctx: CommandContext, userId: string): Promise<Recipient> {
  const [member] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.workspace_has_user(${ctx.scope.workspaceId!}::uuid, ${userId}::uuid) as ok`,
  );
  const [u] = member?.ok
    ? await ctx.tx
        .select({ fullName: users.fullName, email: users.email, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, userId))
    : [];
  if (!u || u.deletedAt)
    throw HfosError.notFound(
      'One of the people from your team you picked isn’t on this business anymore. Pick someone else.',
    );
  return { personId: null, userId, name: u.fullName || u.email, email: u.email, phone: null };
}

export const documentSend = defineCommand({
  name: 'document.send',
  description:
    'Send a document template to sign: who it’s about (a customer, company, lead or record), who signs as each of its roles (customers, and someone from the team for a team role), who gets a copy, and what the team fills in. Each signer gets their own private link by email and text, in turn or all at once.',
  risk: 2,
  input: DocumentSendInput,
  output: DocumentSendOutput,
  permission: 'documents.send',
  scope: inWorkspace,
  emits: ['document.sent'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const template = await loadTemplate(ctx.tx, ws, input.templateId);
    if (template.row.archivedAt)
      throw HfosError.rule(
        'document_template_archived',
        409,
        `“${template.row.name}” is archived. Restore it on Documents → Templates first, or pick another.`,
      );
    const [issue] = documentTemplateIssues(template.definition, !!template.row.sourceFileId);
    if (issue)
      throw HfosError.rule(
        'document_template_not_ready',
        409,
        `“${template.row.name}” isn’t ready to send. ${issue.message}`,
      );
    const [source] = await ctx.tx
      .select({
        id: files.id,
        status: files.status,
        deletedAt: files.deletedAt,
        sha256: files.sha256,
      })
      .from(files)
      .where(eq(files.id, template.row.sourceFileId!));
    if (!source || source.deletedAt || source.status !== 'ready')
      throw HfosError.rule(
        'document_no_pdf',
        409,
        `“${template.row.name}” has lost its PDF. Add it again on the template, then send it.`,
      );

    // This customer's copy: the template, with their own word changes (27a) and the send's settings.
    const settings = { ...template.definition.settings, ...input.settings };
    if (input.message !== undefined) settings.message = input.message;
    const base = DocumentDefinition.parse({
      ...template.definition,
      edits: input.edits ?? template.definition.edits,
      settings,
      presets: {},
    });

    // Every role signed by exactly one person of the right kind.
    const byRole = new Map(input.signers.map((s) => [s.roleKey, s]));
    if (byRole.size !== input.signers.length)
      throw HfosError.validation(
        [{ path: 'signers', message: 'Pick one person for each role.' }],
        'Pick one person for each role.',
      );
    for (const s of input.signers)
      if (!base.roles.some((r) => r.key === s.roleKey))
        throw HfosError.validation(
          [{ path: 'signers', message: 'That role isn’t on this template.' }],
          'One of the signers is for a role this template doesn’t have. Refresh and pick again.',
        );
    const signers: (Recipient & {
      roleKey: string;
      label: string;
      kind: 'customer' | 'team';
      position: number;
      inPerson: boolean;
    })[] = [];
    for (const [i, role] of base.roles.entries()) {
      const pick = byRole.get(role.key);
      if (!pick)
        throw HfosError.validation(
          [{ path: 'signers', message: `Pick who signs as ${role.label}.` }],
          `Pick who signs as ${role.label}.`,
        );
      if (role.kind === 'team' && !pick.userId)
        throw HfosError.validation(
          [{ path: 'signers', message: `${role.label} is someone from your team.` }],
          `${role.label} signs for the business. Pick someone from your team.`,
        );
      if (role.kind === 'customer' && !pick.personId)
        throw HfosError.validation(
          [{ path: 'signers', message: `${role.label} is a customer.` }],
          `${role.label} is a customer. Pick them from your contacts, or add them first.`,
        );
      const who = pick.personId
        ? await personRecipient(ctx, pick.personId)
        : await userRecipient(ctx, pick.userId!);
      // Someone signing in person needs no link (answer 13a); they get the signed copy if they can be reached.
      if (!who.email && !who.phone && !pick.inPerson)
        throw HfosError.rule(
          'document_signer_unreachable',
          409,
          `${who.name} has no email or mobile number, so their link can’t reach them. Add one on their page, or tick “With you now” to have them sign on your device.`,
        );
      signers.push({
        ...who,
        roleKey: role.key,
        label: role.label,
        kind: role.kind,
        position: settings.order === 'order' ? i : 0,
        inPerson: pick.inPerson,
      });
    }
    const copies: Recipient[] = [];
    for (const c of input.copies) {
      const who = c.personId
        ? await personRecipient(ctx, c.personId)
        : await userRecipient(ctx, c.userId!);
      if (!who.email)
        throw HfosError.rule(
          'document_copy_unreachable',
          409,
          `${who.name} has no email address, so the signed copy can’t reach them. Add one, or take them off the copies.`,
        );
      if (!copies.some((x) => x.personId === who.personId && x.userId === who.userId))
        copies.push(who);
    }

    // The fill-ins, and what the team typed over them.
    const about: DocumentAbout = input.about;
    const fill = await loadFillContext(ctx.tx, ws, about, {
      estimateId: input.estimateId,
      senderUserId: me,
    });
    for (const [id, value] of Object.entries(input.values)) {
      const field = base.fields.find((f) => f.id === id);
      if (!field)
        throw HfosError.validation(
          [{ path: `values.${id}`, message: 'That field isn’t on this template.' }],
          'One of the fields you filled in isn’t on this template anymore. Refresh and try again.',
        );
      if (
        field.type === 'date_signed' ||
        valueKindOf(field.type) === 'signature' ||
        value.kind !== valueKindOf(field.type)
      )
        throw HfosError.validation(
          [{ path: `values.${id}`, message: `${fieldName(field)} isn’t filled in that way.` }],
          `${fieldName(field)} isn’t filled in that way. Refresh and try again.`,
        );
    }
    const presets = presetsFor(base, fill, input.values);
    for (const f of base.fields.filter((x) => x.role === SENDER_ROLE)) {
      const problem = valueProblem(f, presets[f.id]);
      if (problem)
        throw HfosError.validation(
          [{ path: `values.${f.id}`, message: problem }],
          `${problem} It’s yours to fill in before it goes.`,
        );
    }
    const signerPresets = Object.fromEntries(
      Object.entries(presets).filter(
        ([id]) => base.fields.find((f) => f.id === id)?.role !== SENDER_ROLE,
      ),
    );
    const definition = DocumentDefinition.parse({ ...base, presets: signerPresets });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.expireDays * DAY_MS);
    const name = input.name ?? template.row.name;
    const [doc] = await ctx.tx
      .insert(documents)
      .values({
        workspaceId: ws,
        templateId: template.row.id,
        name,
        status: 'out',
        definition: asJson(definition),
        definitionVersion: definition.version,
        sourceFileId: source.id,
        personId: about.personId ?? null,
        companyId: about.companyId ?? null,
        leadId: about.leadId ?? null,
        customRecordId: about.customRecordId ?? null,
        signingOrder: settings.order,
        message: settings.message || null,
        sentBy: me,
        sentAt: now,
        expiresAt,
        remindAfterDays: settings.remindAfterDays,
        remindEveryDays: settings.remindAfterDays === null ? null : settings.remindEveryDays,
        sourceSha256: source.sha256 ?? null,
      })
      .returning();
    if (!doc) throw HfosError.forbidden();
    const inserted = await ctx.tx
      .insert(documentSigners)
      .values([
        ...signers.map((s) => ({
          workspaceId: ws,
          documentId: doc.id,
          kind: 'signer' as const,
          roleKey: s.roleKey,
          roleLabel: s.label,
          position: s.position,
          personId: s.personId,
          userId: s.userId,
          name: s.name.slice(0, 160),
          email: s.email,
          phoneE164: s.phone,
          askCode: settings.askCode && s.kind === 'customer',
          inPerson: s.inPerson,
        })),
        ...copies.map((c) => ({
          workspaceId: ws,
          documentId: doc.id,
          kind: 'copy' as const,
          roleKey: null,
          roleLabel: null,
          position: 0,
          personId: c.personId,
          userId: c.userId,
          name: c.name.slice(0, 160),
          email: c.email,
          phoneE164: null,
        })),
      ])
      .returning();
    const senderValues = base.fields
      .filter((f) => f.role === SENDER_ROLE && presets[f.id])
      .map((f) => ({
        workspaceId: ws,
        documentId: doc.id,
        fieldId: f.id,
        value: presets[f.id]! as unknown,
      }));
    if (senderValues.length) await ctx.tx.insert(documentValues).values(senderValues);
    await addStep(ctx, doc, {
      kind: 'prepared',
      detail: {
        template: template.row.name,
        ...(input.replacesDocumentId ? { replaces: input.replacesDocumentId } : {}),
      },
    });
    const up = signersUp(inserted);
    const eventId = await ctx.emit({
      type: 'document.sent',
      entityType: 'document',
      entityId: doc.id,
      payload: {
        documentId: doc.id,
        name,
        templateId: template.row.id,
        signerIds: up.map((s) => s.id),
        signers: inserted.filter((s) => s.kind === 'signer').map((s) => s.name),
        ...(input.replacesDocumentId ? { replaces: input.replacesDocumentId } : {}),
      },
      after: { name, status: 'out', signers: inserted.length, expiresAt: expiresAt.toISOString() },
    });
    await timeline(ctx, doc, 'document_sent', eventId);
    return {
      documentId: doc.id,
      name,
      expiresAt: expiresAt.toISOString(),
      signers: inserted.map((s) => ({
        signerId: s.id,
        kind: s.kind as 'signer' | 'copy',
        roleKey: s.roleKey,
        name: s.name,
        status: s.status as 'waiting',
      })),
    };
  },
});

export const documentRemind = defineCommand({
  name: 'document.remind',
  description:
    'Remind whoever still has to sign a document now: their link goes again by email and text. Someone who was to sign in person gets their link for the first time.',
  risk: 2,
  input: DocumentRefInput,
  output: DocumentOkOutput,
  permission: 'documents.send',
  scope: inWorkspace,
  emits: ['document.reminder_asked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    requireHuman(ctx);
    const { row } = await loadDocument(ctx.tx, ws, input.documentId, { forUpdate: true });
    assertOut(row);
    if (row.allSignedAt)
      throw HfosError.rule(
        'document_finishing',
        409,
        `Everyone has signed “${row.name}”. The signed copy is on its way.`,
      );
    // Whose turn it is: a reminder of their link, or, for someone signing in person, their first link after all.
    const up = signersUp(await signersOf(ctx.tx, row.id)).filter((s) => s.status !== 'declined');
    const due = up.filter((s) => s.sentAt || (s.inPerson && (s.email || s.phoneE164)));
    if (!due.length) {
      const unreachable = up.find((s) => s.inPerson && !s.sentAt);
      if (unreachable)
        throw HfosError.rule(
          'document_signer_unreachable',
          409,
          `${unreachable.name} signs with you in person and has no email or mobile number, so a link can’t reach them. Use Sign now when you’re together.`,
        );
      throw HfosError.rule(
        'document_nobody_to_remind',
        409,
        `Nobody’s link for “${row.name}” has gone out yet. It goes on its own in a moment.`,
      );
    }
    const recent = due.find(
      (s) => s.lastSentAt && Date.now() - s.lastSentAt.getTime() < 60 * 60_000,
    );
    if (recent)
      throw HfosError.rule(
        'document_reminded_recently',
        409,
        `${recent.name} was sent their link less than an hour ago. Give them a little time, then remind them.`,
      );
    await ctx.emit({
      type: 'document.reminder_asked',
      entityType: 'document',
      entityId: row.id,
      payload: { documentId: row.id, name: row.name, signerIds: due.map((s) => s.id) },
      after: { reminded: due.map((s) => s.name) },
    });
    return { documentId: row.id, changed: true };
  },
});

export const documentVoid = defineCommand({
  name: 'document.void',
  description:
    'Void a document still out for signing: nobody can sign it anymore, and anyone who had their link is told. Send a corrected one after.',
  risk: 2,
  input: DocumentVoidInput,
  output: DocumentOkOutput,
  permission: 'documents.send',
  scope: inWorkspace,
  emits: ['document.voided'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const { row } = await loadDocument(ctx.tx, ws, input.documentId, { forUpdate: true });
    if (row.status === 'voided') return { documentId: row.id, changed: false };
    if (row.status !== 'out')
      throw HfosError.rule(
        'document_not_out',
        409,
        `“${row.name}” isn’t out for signing anymore, so there’s nothing to void.`,
      );
    if (row.allSignedAt)
      throw HfosError.rule(
        'document_finishing',
        409,
        `Everyone has signed “${row.name}”, so it can’t be voided. The signed copy is on its way.`,
      );
    const now = new Date();
    const [updated] = await ctx.tx
      .update(documents)
      .set({ status: 'voided', voidedAt: now, voidedBy: me, voidReason: input.reason || null })
      .where(eq(documents.id, row.id))
      .returning();
    await addStep(ctx, row, {
      kind: 'voided',
      detail: input.reason ? { reason: input.reason } : {},
    });
    const told = (await signersOf(ctx.tx, row.id)).filter(
      (s) => s.kind === 'signer' && s.sentAt && s.status !== 'declined',
    );
    const eventId = await ctx.emit({
      type: 'document.voided',
      entityType: 'document',
      entityId: row.id,
      payload: {
        documentId: row.id,
        name: row.name,
        reason: input.reason || null,
        signerIds: told.map((s) => s.id),
      },
      before: { status: 'out' },
      after: { status: 'voided', reason: input.reason || null },
    });
    await timeline(
      ctx,
      updated ?? row,
      'document_voided',
      eventId,
      input.reason ? { reason: input.reason } : {},
    );
    return { documentId: row.id, changed: true };
  },
});

/**
 * Sign now (answer 13a): the team member hands their phone or tablet to a signer whose turn it is, and they sign it
 * there. Recorded as a step by the team member; a code the template asks for is checked by handing it over, since
 * they say who's holding it. The worker's `/v1/documents/link` then gives the screen their link to open.
 */
export const documentSignNow = defineCommand({
  name: 'document.sign_now',
  description:
    'Sign now in person: hand this device to someone whose turn it is to sign, so they sign it here. Their code isn’t asked: whoever hands it over says it’s them.',
  risk: 2,
  input: DocumentSignNowInput,
  output: DocumentSignNowOutput,
  permission: 'documents.send',
  scope: inWorkspace,
  emits: ['document.handed_over'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    // As the person: a signer of a document about someone they can't see isn't there.
    const [found] = await ctx.tx
      .select({ documentId: documentSigners.documentId })
      .from(documentSigners)
      .where(and(eq(documentSigners.id, input.signerId), eq(documentSigners.workspaceId, ws)));
    if (!found) throw documentGone();
    const { row } = await loadDocument(ctx.tx, ws, found.documentId, { forUpdate: true });
    assertOut(row);
    if (row.allSignedAt)
      throw HfosError.rule(
        'document_finishing',
        409,
        `Everyone has signed “${row.name}”. The signed copy is on its way.`,
      );
    const all = await signersOf(ctx.tx, row.id);
    const signer = all.find((s) => s.id === input.signerId);
    if (!signer || signer.kind !== 'signer') throw documentGone();
    if (signer.status === 'signed')
      throw HfosError.rule('document_signer_done', 409, `${signer.name} has signed it already.`);
    if (signer.status === 'declined')
      throw HfosError.rule(
        'document_declined',
        409,
        `${signer.name} declined to sign it, so it’s closed. Send a corrected one if it’s still needed.`,
      );
    if (!signersUp(all).some((s) => s.id === signer.id)) {
      const first = signersUp(all)[0];
      throw HfosError.rule(
        'document_not_their_turn',
        409,
        `It isn’t ${signer.name}’s turn yet.${first ? ` ${first.name} signs first.` : ''}`,
      );
    }
    const codeChecked = signer.askCode && !signer.codeCheckedAt;
    if (codeChecked)
      await ctx.tx
        .update(documentSigners)
        .set({ codeCheckedAt: new Date() })
        .where(eq(documentSigners.id, signer.id));
    const [u] = await ctx.tx
      .select({ fullName: users.fullName, email: users.email })
      .from(users)
      .where(eq(users.id, me));
    const by = u?.fullName?.trim() || u?.email || 'Someone from the team';
    await addStep(ctx, row, {
      kind: 'in_person',
      signerId: signer.id,
      detail: { by, ...(signer.userId === me ? { self: true } : {}) },
    });
    await ctx.emit({
      type: 'document.handed_over',
      entityType: 'document',
      entityId: row.id,
      payload: { documentId: row.id, signerId: signer.id, name: row.name, signer: signer.name },
      after: { handedTo: signer.name, codeChecked },
    });
    return { documentId: row.id, signerId: signer.id, codeChecked };
  },
});

// ---------- the worker, for the people signing ----------

export const documentLinkSent = defineCommand({
  name: 'document.link_sent',
  description: 'Worker: a signer’s link (or a reminder of it) went out, and how it reached them.',
  risk: 1,
  input: DocumentLinkSentInput,
  output: DocumentLinkSentOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.link_sent'],
  actors: ['system'],
  async handler(ctx, input) {
    const { signer, doc } = await loadSigner(ctx, input.signerId, { forUpdate: true });
    if (doc.status !== 'out' || signer.status === 'signed' || signer.status === 'declined')
      return { signerId: signer.id, changed: false };
    const now = new Date();
    const channels = [...new Set([...signer.sentByChannels, ...input.channels])];
    await ctx.tx
      .update(documentSigners)
      .set({
        status: signer.status === 'waiting' && input.channels.length ? 'sent' : signer.status,
        sentAt: signer.sentAt ?? (input.channels.length ? now : null),
        // A reminder that reached nobody still counts as tried, so the next waits its turn rather than an hour.
        lastSentAt:
          input.channels.length || input.reminder > signer.reminders ? now : signer.lastSentAt,
        reminders: Math.max(signer.reminders, input.reminder),
        sentByChannels: channels,
      })
      .where(eq(documentSigners.id, signer.id));
    for (const channel of input.channels)
      await addStep(ctx, doc, {
        kind: input.reminder > 0 ? 'reminded' : 'sent',
        signerId: signer.id,
        channel,
      });
    await ctx.emit({
      type: 'document.link_sent',
      entityType: 'document',
      entityId: doc.id,
      payload: { signerId: signer.id, channels: input.channels, reminder: input.reminder },
      after: { signer: signer.name, channels: input.channels },
    });
    return { signerId: signer.id, changed: true };
  },
});

export const documentOpen = defineCommand({
  name: 'document.open',
  description:
    'Worker: a signer opened their link, or opened it from their portal (which checks a code the template asks for: signing in there was a code to them).',
  risk: 1,
  input: DocumentOpenInput,
  output: DocumentOpenOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.opened', 'document.code_checked'],
  actors: ['system'],
  async handler(ctx, input) {
    const { signer, doc } = await loadSigner(ctx, input.signerId, { forUpdate: true });
    if (doc.status !== 'out') return { signerId: signer.id, first: false };
    const now = new Date();
    const still = signer.status !== 'signed' && signer.status !== 'declined';
    if (input.channel === 'portal' && still && signer.askCode && !signer.codeCheckedAt) {
      await ctx.tx
        .update(documentSigners)
        .set({ codeCheckedAt: now, codeHash: null, codeExpiresAt: null })
        .where(eq(documentSigners.id, signer.id));
      await addStep(ctx, doc, {
        kind: 'code_checked',
        signerId: signer.id,
        channel: 'portal',
        ip: input.ip,
        device: input.device,
      });
      await ctx.emit({
        type: 'document.code_checked',
        entityType: 'document',
        entityId: doc.id,
        payload: { signerId: signer.id, by: 'portal' },
        after: { signer: signer.name },
      });
    }
    if (signer.openedAt) return { signerId: signer.id, first: false };
    await ctx.tx
      .update(documentSigners)
      .set({
        openedAt: now,
        status: signer.status === 'sent' || signer.status === 'waiting' ? 'opened' : signer.status,
      })
      .where(eq(documentSigners.id, signer.id));
    await addStep(ctx, doc, {
      kind: 'opened',
      signerId: signer.id,
      channel: input.channel,
      ip: input.ip,
      device: input.device,
    });
    await ctx.emit({
      type: 'document.opened',
      entityType: 'document',
      entityId: doc.id,
      payload: { documentId: doc.id, signerId: signer.id, name: doc.name, signer: signer.name },
      after: { opened: signer.name },
    });
    return { signerId: signer.id, first: true };
  },
});

export const documentCodeSent = defineCommand({
  name: 'document.code_sent',
  description:
    'Worker: a 6-digit code went to a signer before they open it; only its hash is kept.',
  risk: 1,
  input: DocumentCodeSentInput,
  output: DocumentOkOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.code_sent'],
  actors: ['system'],
  async handler(ctx, input) {
    const { signer, doc } = await loadSigner(ctx, input.signerId, { forUpdate: true });
    assertOut(doc);
    await ctx.tx
      .update(documentSigners)
      .set({
        codeHash: input.codeHash,
        codeExpiresAt: new Date(Date.now() + DOCUMENT_CODE_MINUTES * 60_000),
        codeTries: 0,
      })
      .where(eq(documentSigners.id, signer.id));
    await addStep(ctx, doc, { kind: 'code_sent', signerId: signer.id, channel: input.channel });
    await ctx.emit({
      type: 'document.code_sent',
      entityType: 'document',
      entityId: doc.id,
      payload: { signerId: signer.id, channel: input.channel },
      after: { signer: signer.name, channel: input.channel },
    });
    return { documentId: doc.id, changed: true };
  },
});

export const documentCodeCheck = defineCommand({
  name: 'document.code_check',
  description: 'Worker: a signer typed their code. Five tries, for ten minutes.',
  risk: 1,
  input: DocumentCodeCheckInput,
  output: DocumentCodeCheckOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.code_checked'],
  actors: ['system'],
  async handler(ctx, input) {
    const { signer, doc } = await loadSigner(ctx, input.signerId, { forUpdate: true });
    assertOut(doc);
    if (signer.codeCheckedAt) return { ok: true, triesLeft: DOCUMENT_CODE_TRIES };
    const live =
      signer.codeHash && signer.codeExpiresAt && signer.codeExpiresAt.getTime() > Date.now();
    if (!live || signer.codeTries >= DOCUMENT_CODE_TRIES) return { ok: false, triesLeft: 0 };
    if (signer.codeHash !== input.codeHash) {
      await ctx.tx
        .update(documentSigners)
        .set({ codeTries: signer.codeTries + 1 })
        .where(eq(documentSigners.id, signer.id));
      return { ok: false, triesLeft: Math.max(0, DOCUMENT_CODE_TRIES - signer.codeTries - 1) };
    }
    await ctx.tx
      .update(documentSigners)
      .set({ codeCheckedAt: new Date(), codeHash: null, codeExpiresAt: null })
      .where(eq(documentSigners.id, signer.id));
    await addStep(ctx, doc, {
      kind: 'code_checked',
      signerId: signer.id,
      channel: 'page',
      ip: input.ip,
      device: input.device,
    });
    await ctx.emit({
      type: 'document.code_checked',
      entityType: 'document',
      entityId: doc.id,
      payload: { signerId: signer.id },
      after: { signer: signer.name },
    });
    return { ok: true, triesLeft: DOCUMENT_CODE_TRIES };
  },
});

/** Answer 7a: what the customer signing typed fills their blanks, and never writes over anything. */
async function fillCustomerBlanks(
  ctx: CommandContext,
  signer: DocumentSignerRow,
  definition: DocumentDefinitionT,
  values: Readonly<Record<string, DocumentValue>>,
): Promise<void> {
  if (!signer.personId) return;
  const [p] = await ctx.tx
    .select({
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      phone: people.phoneE164,
    })
    .from(people)
    .where(eq(people.id, signer.personId));
  if (!p) return;
  const typed = (source: string): string | null => {
    const f = definition.fields.find(
      (x) =>
        x.role === signer.roleKey &&
        x.fillFrom === source &&
        WRITE_BACK_SOURCES.includes(x.fillFrom),
    );
    const v = f ? values[f.id] : undefined;
    return v?.kind === 'text' && v.text.trim() ? v.text.trim() : null;
  };
  const update: { firstName?: string; lastName?: string; email?: string; phone?: string } = {};
  const whole = typed('customer.name');
  if (!p.firstName && !p.lastName && whole) {
    const [first, ...rest] = whole.split(/\s+/);
    update.firstName = (first ?? '').slice(0, 80);
    if (rest.length) update.lastName = rest.join(' ').slice(0, 80);
  }
  const first = typed('customer.first_name');
  if (!p.firstName && first && !update.firstName) update.firstName = first.slice(0, 80);
  const last = typed('customer.last_name');
  if (!p.lastName && last && !update.lastName) update.lastName = last.slice(0, 80);
  const email = typed('customer.email');
  if (!p.email && email) update.email = email;
  const phone = typed('customer.phone');
  if (!p.phone && phone) update.phone = phone;
  if (!Object.keys(update).length) return;
  try {
    await executeCommandWithin(ctx, personUpdate, {
      workspaceId: ctx.scope.workspaceId!,
      personId: signer.personId,
      ...update,
    });
  } catch (e) {
    // A blank that won't take (an email another customer has, say) is left blank: the signature still counts.
    if (!(e instanceof HfosError)) throw e;
  }
}

export const documentSign = defineCommand({
  name: 'document.sign',
  description:
    'Worker: a signer agreed to sign electronically, filled in their fields and signed. Whoever is next gets their link; when everyone has, the signed copy is made.',
  risk: 1,
  input: DocumentSignInput,
  output: DocumentSignOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.signed', 'document.turn', 'document.all_signed'],
  actors: ['system'],
  async handler(ctx, input) {
    const { signer, doc, definition } = await loadSigner(ctx, input.signerId, { forUpdate: true });
    assertOut(doc);
    if (signer.kind !== 'signer' || !signer.roleKey) throw documentGone();
    if (signer.status === 'signed')
      throw HfosError.rule('document_already_signed', 409, `You’ve signed “${doc.name}” already.`);
    if (signer.status === 'declined')
      throw HfosError.rule(
        'document_declined',
        409,
        `You declined “${doc.name}”, so it can’t be signed.`,
      );
    const all = await signersOf(ctx.tx, doc.id);
    if (!signersUp(all).some((s) => s.id === signer.id))
      throw HfosError.rule(
        'document_not_your_turn',
        409,
        'It isn’t your turn to sign yet. We’ll send you a link when it is.',
      );
    if (signer.askCode && !signer.codeCheckedAt)
      throw HfosError.rule('document_code_needed', 403, 'Enter the code we sent you first.');

    // Only their own fields, and the day it was signed fills itself.
    const theirs = definition.fields.filter((f) => f.role === signer.roleKey);
    const values: Record<string, DocumentValue> = {};
    for (const f of theirs) {
      const v = input.values[f.id];
      if (v) values[f.id] = v;
    }
    const tz = await rows<{ timezone: string }>(
      ctx.tx,
      sql`select timezone from app.workspaces where id = ${doc.workspaceId}`,
    );
    const today = dayIn(tz[0]?.timezone || 'America/Chicago');
    for (const f of theirs)
      if (f.type === 'date_signed') values[f.id] = { kind: 'date', date: today };
    const problems = signerProblems(definition, signer.roleKey, values);
    if (problems.length)
      throw new HfosError(
        'validation',
        400,
        problems[0]!.message,
        problems,
        'document_fields_missing',
      );

    const now = new Date();
    const entries = Object.entries(values).filter(
      ([, v]) => !(v.kind === 'text' && !v.text.trim()),
    );
    if (entries.length)
      await ctx.tx.insert(documentValues).values(
        entries.map(([fieldId, value]) => ({
          workspaceId: doc.workspaceId,
          documentId: doc.id,
          fieldId,
          signerId: signer.id,
          value: value as unknown,
          filledAt: now,
        })),
      );
    await ctx.tx
      .update(documentSigners)
      .set({
        status: 'signed',
        signedAt: now,
        agreedAt: now,
        agreedWording: input.agreedWording,
        openedAt: signer.openedAt ?? now,
        ip: input.ip,
        device: input.device,
      })
      .where(eq(documentSigners.id, signer.id));
    await addStep(ctx, doc, {
      kind: 'agreed',
      signerId: signer.id,
      channel: 'page',
      ip: input.ip,
      device: input.device,
    });
    await addStep(ctx, doc, {
      kind: 'signed',
      signerId: signer.id,
      channel: 'page',
      ip: input.ip,
      device: input.device,
    });
    await fillCustomerBlanks(ctx, signer, definition, values);

    const after = all.map((s) => (s.id === signer.id ? { ...s, status: 'signed' as const } : s));
    const up = signersUp(after);
    const allSigned = up.length === 0;
    const signedEvent = await ctx.emit({
      type: 'document.signed',
      entityType: 'document',
      entityId: doc.id,
      payload: {
        documentId: doc.id,
        signerId: signer.id,
        name: doc.name,
        signer: signer.name,
        allSigned,
      },
      after: { signed: signer.name },
    });
    await timeline(ctx, doc, 'document_signed', signedEvent, { signer: signer.name });
    if (allSigned) {
      await ctx.tx.update(documents).set({ allSignedAt: now }).where(eq(documents.id, doc.id));
      await ctx.emit({
        type: 'document.all_signed',
        entityType: 'document',
        entityId: doc.id,
        payload: { documentId: doc.id, name: doc.name },
        after: { allSigned: true },
      });
      return { signerId: signer.id, allSigned, next: [] };
    }
    // The next role's turn when nobody else at this one is still to sign.
    const next = up.filter((s) => s.status === 'waiting');
    if (next.length && up[0]!.position !== signer.position)
      await ctx.emit({
        type: 'document.turn',
        entityType: 'document',
        entityId: doc.id,
        payload: { documentId: doc.id, name: doc.name, signerIds: next.map((s) => s.id) },
        after: { next: next.map((s) => s.name) },
      });
    return { signerId: signer.id, allSigned, next: next.map((s) => s.id) };
  },
});

export const documentDecline = defineCommand({
  name: 'document.decline',
  description: 'Worker: a signer declined to sign, with their reason. The document stops there.',
  risk: 1,
  input: DocumentDeclineInput,
  output: DocumentOkOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.declined'],
  actors: ['system'],
  async handler(ctx, input) {
    const { signer, doc } = await loadSigner(ctx, input.signerId, { forUpdate: true });
    if (signer.status === 'declined') return { documentId: doc.id, changed: false };
    assertOut(doc);
    if (signer.status === 'signed' || signer.kind !== 'signer')
      throw HfosError.rule('document_already_signed', 409, `You’ve signed “${doc.name}” already.`);
    const now = new Date();
    await ctx.tx
      .update(documentSigners)
      .set({
        status: 'declined',
        declinedAt: now,
        declineReason: input.reason,
        ip: input.ip,
        device: input.device,
      })
      .where(eq(documentSigners.id, signer.id));
    const [updated] = await ctx.tx
      .update(documents)
      .set({ status: 'declined', declinedAt: now })
      .where(eq(documents.id, doc.id))
      .returning();
    await addStep(ctx, doc, {
      kind: 'declined',
      signerId: signer.id,
      channel: 'page',
      ip: input.ip,
      device: input.device,
      detail: input.reason ? { reason: input.reason } : {},
    });
    const eventId = await ctx.emit({
      type: 'document.declined',
      entityType: 'document',
      entityId: doc.id,
      payload: {
        documentId: doc.id,
        name: doc.name,
        signerId: signer.id,
        signer: signer.name,
        reason: input.reason,
        sentBy: doc.sentBy,
      },
      before: { status: 'out' },
      after: { status: 'declined', reason: input.reason },
    });
    await timeline(ctx, updated ?? doc, 'document_declined', eventId, {
      signer: signer.name,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { documentId: doc.id, changed: true };
  },
});

export const documentExpire = defineCommand({
  name: 'document.expire',
  description: 'Worker: a document still out ran out of time.',
  risk: 1,
  input: DocumentRefInput,
  output: DocumentOkOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.expired'],
  actors: ['system'],
  async handler(ctx, input) {
    const { row } = await loadDocument(ctx.tx, ctx.scope.workspaceId!, input.documentId, {
      forUpdate: true,
    });
    if (row.status !== 'out' || row.allSignedAt || row.expiresAt.getTime() > Date.now())
      return { documentId: row.id, changed: false };
    const now = new Date();
    const [updated] = await ctx.tx
      .update(documents)
      .set({ status: 'expired', expiredAt: now })
      .where(eq(documents.id, row.id))
      .returning();
    await addStep(ctx, row, { kind: 'expired' });
    const eventId = await ctx.emit({
      type: 'document.expired',
      entityType: 'document',
      entityId: row.id,
      payload: { documentId: row.id, name: row.name, sentBy: row.sentBy },
      before: { status: 'out' },
      after: { status: 'expired' },
    });
    await timeline(ctx, updated ?? row, 'document_expired', eventId);
    return { documentId: row.id, changed: true };
  },
});

export const documentFinish = defineCommand({
  name: 'document.finish',
  description:
    'Worker: the signed copy, with its proof page, is filed on the record it’s about and locked. The document is done.',
  risk: 1,
  input: DocumentFinishInput,
  output: DocumentOkOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.completed'],
  actors: ['system'],
  async handler(ctx, input) {
    const { row } = await loadDocument(ctx.tx, ctx.scope.workspaceId!, input.documentId, {
      forUpdate: true,
    });
    if (row.status === 'completed') return { documentId: row.id, changed: false };
    if (row.status !== 'out' || !row.allSignedAt)
      throw HfosError.rule(
        'document_not_signed',
        409,
        `“${row.name}” isn’t signed by everyone yet.`,
      );
    const now = new Date();
    const [updated] = await ctx.tx
      .update(documents)
      .set({
        status: 'completed',
        completedAt: now,
        signedFileId: input.signedFileId,
        sourceSha256: input.sourceSha256,
        signedSha256: input.signedSha256,
      })
      .where(eq(documents.id, row.id))
      .returning();
    await addStep(ctx, row, { kind: 'completed', detail: { sha256: input.signedSha256 } });
    const eventId = await ctx.emit({
      type: 'document.completed',
      entityType: 'document',
      entityId: row.id,
      payload: {
        documentId: row.id,
        name: row.name,
        signedFileId: input.signedFileId,
        sentBy: row.sentBy,
      },
      before: { status: 'out' },
      after: { status: 'completed', signedSha256: input.signedSha256 },
    });
    await timeline(ctx, updated ?? row, 'document_completed', eventId, {
      fileId: input.signedFileId,
    });
    return { documentId: row.id, changed: true };
  },
});

export const documentCopiesSent = defineCommand({
  name: 'document.copies_sent',
  description: 'Worker: the signed copy went to everyone on a document, and how.',
  risk: 1,
  input: DocumentCopiesSentInput,
  output: DocumentOkOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['document.copies_sent'],
  actors: ['system'],
  async handler(ctx, input) {
    const { row } = await loadDocument(ctx.tx, ctx.scope.workspaceId!, input.documentId);
    const ids = input.sent.map((s) => s.signerId);
    const known = ids.length
      ? new Set(
          (
            await ctx.tx
              .select({ id: documentSigners.id })
              .from(documentSigners)
              .where(and(eq(documentSigners.documentId, row.id), inArray(documentSigners.id, ids)))
          ).map((r) => r.id),
        )
      : new Set<string>();
    for (const s of input.sent)
      if (known.has(s.signerId))
        for (const channel of s.channels)
          await addStep(ctx, row, { kind: 'copy_sent', signerId: s.signerId, channel });
    await ctx.emit({
      type: 'document.copies_sent',
      entityType: 'document',
      entityId: row.id,
      payload: { documentId: row.id, to: input.sent.length },
      after: { copies: input.sent.length },
    });
    return { documentId: row.id, changed: true };
  },
});

export const documentCommands = [
  documentSend,
  documentRemind,
  documentVoid,
  documentSignNow,
  documentLinkSent,
  documentOpen,
  documentCodeSent,
  documentCodeCheck,
  documentSign,
  documentDecline,
  documentExpire,
  documentFinish,
  documentCopiesSent,
] as const;
