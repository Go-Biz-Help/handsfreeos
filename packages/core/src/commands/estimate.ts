/**
 * Estimates: what a business quotes, and what the customer answers.
 *
 * A draft is written and rewritten wholesale — the header and every line together, against the revision the
 * editor loaded, the way `calendar.save` does — until it is sent. **Sending freezes it:** it takes the next
 * number from `app.document_counters` inside this transaction, stamps when it went out, and from then on its
 * number, its tax, its totals and its lines are that document's for life. A mistake is voided and reissued;
 * a voided number is kept and never used again.
 *
 * What the customer did is the worker's alone. `estimate.accept_online` and `decline_online` run for a
 * signed-out customer on `/e/<token>`, with the name they typed, the moment from the database's own clock, the
 * exact wording that was on screen and a hash of the lines and totals they were shown. A person may record a yes
 * given on the phone (`estimate.mark_accepted`) — in their own name, marked `staff`, never as the customer.
 */
import { eq, sql as dsql } from 'drizzle-orm';
import type { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { estimates } from '@hfos/db/schema';
import { requirePerson, workspaceTimezone } from '../crm/records';
import { HfosError } from '../errors';
import { FRESH_MINUTES } from '../mobile';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { acceptedWording, estimateMoveProblem, money, type EstimateStatus } from '../money/index';
import {
  DocumentRecordViewInput,
  DocumentViewOutput,
  EstimateAcceptOnlineInput,
  EstimateAcceptedOutput,
  EstimateConvertInput,
  EstimateConvertOutput,
  EstimateCreateInput,
  EstimateDeclineOnlineInput,
  EstimateMarkAcceptedInput,
  EstimateRefInput,
  EstimateSendInput,
  EstimateStateOutput,
  EstimateUpdateInput,
  EstimateVoidInput,
} from '../schemas/money';
import { invoiceCreate } from './invoice';
import {
  addDays,
  allocateDocumentNumber,
  assertDraft,
  assertRevision,
  presentOnly,
  businessToday,
  depositColumns,
  depositOf,
  depositTermsOf,
  documentHash,
  draftOf,
  expiresAtOf,
  isoAt,
  moneyIso,
  linesFor,
  linesIn,
  loadMoneySettings,
  requireEstimate,
  totalsColumns,
  writeLines,
  type EstimateRow,
} from './money-shared';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const stateOut = (row: EstimateRow, changed: boolean) => ({
  estimateId: row.id,
  status: row.status,
  number: row.number,
  revision: Math.round(Number(row.revision)),
  totalCents: Number(row.total_cents),
  changed,
});

/** What the estimate is about, on every event: the workflow triggers find the customer through `personId`. */
const subjectOf = (row: EstimateRow) => ({
  estimateId: row.id,
  personId: row.person_id,
  leadId: row.lead_id,
  number: row.number,
  totalCents: Number(row.total_cents),
});

/** How an estimate is named in the audit log: its number once it has one, else what it is for. */
const nameOf = (row: EstimateRow) => row.number ?? row.title ?? 'Estimate';

/** What a second go at the same thing is told. `estimateMoveProblem` says nothing about standing still. */
const ALREADY: Readonly<Record<EstimateStatus, string>> = {
  draft: 'That estimate is already a draft.',
  sent: 'That estimate has already gone out. Void it and reissue to send it again.',
  accepted: 'That estimate was already approved.',
  declined: 'That estimate was already declined.',
  expired: 'That estimate has already expired.',
  void: 'That estimate is already void.',
};

/** Where it may go from here, in the words step 2 wrote. */
function assertMove(row: EstimateRow, to: EstimateStatus): void {
  if (row.status === to) throw HfosError.rule('estimate_not_open', 409, ALREADY[to]);
  const problem = estimateMoveProblem(row.status, to);
  if (problem) throw HfosError.rule('estimate_not_open', 409, problem);
}

/** The lines and totals exactly as they stand, for the hash an acceptance is kept with. */
async function hashOf(ctx: CommandContext, row: EstimateRow): Promise<string> {
  const lines = (await linesFor(ctx.tx, 'estimate', [row.id])).get(row.id) ?? [];
  return documentHash(
    lines.map((l) => ({
      name: l.name,
      quantity: Number(l.quantity),
      unitPriceCents: Number(l.unit_price_cents),
      discountCents: Number(l.discount_cents),
      taxable: l.taxable,
    })),
    {
      subtotalCents: Number(row.subtotal_cents),
      discountCents: Number(row.discount_cents),
      taxCents: Number(row.tax_cents),
      totalCents: Number(row.total_cents),
    },
  );
}

// ---------- writing one ----------

/**
 * A new draft estimate, as a person starts one or as the AI teammate does once a person has approved it (M18).
 * `by` is who it is from: its assignee unless one is named, and who created it.
 */
export async function createEstimate(
  ctx: CommandContext,
  input: z.infer<typeof EstimateCreateInput>,
  by: string | null,
) {
  const ws = ctx.scope.workspaceId!;
  await requirePerson(ctx.tx, ws, input.personId);
  const settings = await loadMoneySettings(ctx.tx, ws);
  const draft = draftOf(input.lines, settings, {
    discount: input.discount,
    // Left out, the business's default deposit is what it asks for.
    deposit: input.deposit ?? settings.deposit,
  });
  const [row] = await ctx.tx
    .insert(estimates)
    .values({
      workspaceId: ws,
      // The Drizzle mirror leaves the column's own default off, so the database's generator is named here.
      publicRef: dsql`private.new_public_ref()`,
      personId: input.personId,
      leadId: input.leadId ?? null,
      assigneeUserId: input.assigneeUserId ?? by,
      title: input.title ?? null,
      notes: input.notes ?? (settings.notes.estimate || null),
      expiresOn: input.expiresOn ?? null,
      ...totalsColumns(draft),
      ...depositColumns(draft),
      createdBy: by,
    })
    .returning({ id: estimates.id });
  if (!row) throw HfosError.forbidden();
  await writeLines(ctx, 'estimate', row.id, input.lines);
  const fresh = await requireEstimate(ctx, row.id);
  await ctx.emit({
    type: 'estimate.created',
    entityType: 'estimate',
    entityId: fresh.id,
    payload: subjectOf(fresh),
    after: { total: money(Number(fresh.total_cents)), lines: input.lines.length },
  });
  return stateOut(fresh, true);
}

export const estimateCreate = defineCommand({
  name: 'estimate.create',
  description:
    'Start an estimate for a customer: its lines from the catalogue or typed by hand, a discount, and what to ask for up front if they say yes. It stays a draft until it is sent.',
  risk: 1,
  input: EstimateCreateInput,
  output: EstimateStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['estimate.created'],
  async handler(ctx, input) {
    return createEstimate(ctx, input, requireHuman(ctx).userId);
  },
});

export const estimateUpdate = defineCommand({
  name: 'estimate.update',
  description:
    'Save a draft estimate: its header and all of its lines at once, against the revision you loaded. Someone else’s save in between is kept and yours is refused. A sent estimate can’t be edited — void it and reissue.',
  risk: 1,
  input: EstimateUpdateInput,
  output: EstimateStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['estimate.updated'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const before = await requireEstimate(ctx, input.estimateId);
    assertDraft(before, 'estimate');
    assertRevision(before, input.baseRevision, {
      command: 'estimate.create',
      input: presentOnly({
        workspaceId: input.workspaceId,
        personId: input.personId,
        leadId: input.leadId,
        assigneeUserId: input.assigneeUserId,
        title: input.title,
        notes: input.notes,
        lines: input.lines,
        discount: input.discount,
        deposit: input.deposit,
        expiresOn: input.expiresOn,
      }),
    });
    if (input.personId !== before.person_id)
      throw HfosError.rule(
        'money_document_person',
        409,
        'An estimate stays with the customer it was written for. Make a new one instead.',
      );
    const settings = await loadMoneySettings(ctx.tx, ws);
    const draft = draftOf(input.lines, settings, {
      discount: input.discount,
      // Left out on a save, the deposit already on the document stands. A save that doesn't mention it never
      // quietly swaps a business's "$500 up front" for whatever the settings default happens to be.
      deposit: input.deposit ?? depositTermsOf(before),
    });
    await ctx.tx
      .update(estimates)
      .set({
        leadId: input.leadId ?? null,
        assigneeUserId: input.assigneeUserId ?? before.assignee_user_id,
        title: input.title ?? null,
        notes: input.notes ?? null,
        expiresOn: input.expiresOn ?? null,
        ...totalsColumns(draft),
        ...depositColumns(draft),
      })
      .where(eq(estimates.id, before.id));
    await writeLines(ctx, 'estimate', before.id, input.lines);
    const fresh = await requireEstimate(ctx, before.id);
    await ctx.emit({
      type: 'estimate.updated',
      entityType: 'estimate',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), lines: input.lines.length },
      before: { total: money(Number(before.total_cents)) },
      after: { total: money(Number(fresh.total_cents)), lines: input.lines.length },
    });
    return stateOut(fresh, true);
  },
});

/** Sends a draft estimate: its number, when it went, and the worker's text or email with the link. */
export async function sendEstimate(ctx: CommandContext, input: z.infer<typeof EstimateSendInput>) {
  const ws = ctx.scope.workspaceId!;
  const before = await requireEstimate(ctx, input.estimateId);
  // A second send is refused: an estimate that has gone out keeps its number and when it went.
  assertMove(before, 'sent');
  const lines = (await linesFor(ctx.tx, 'estimate', [before.id])).get(before.id) ?? [];
  if (!lines.length)
    throw HfosError.rule('money_document_empty', 409, 'Add a line before sending it.');
  const settings = await loadMoneySettings(ctx.tx, ws);
  const tz = await workspaceTimezone(ctx.tx, ws);
  // The counter row is locked and incremented here, so two people sending at once can't share a number.
  const { number } = await allocateDocumentNumber(ctx.tx, ws, 'estimate', settings);
  const expiresOn = before.expires_on ?? addDays(businessToday(tz), settings.estimateGoodForDays);
  await ctx.tx
    .update(estimates)
    .set({
      status: 'sent',
      number,
      expiresOn,
      // The guard replaces this with the database's own clock.
      sentAt: dsql`now()`,
    })
    .where(eq(estimates.id, before.id));
  const fresh = await requireEstimate(ctx, before.id);
  await ctx.emit({
    type: 'estimate.sent',
    entityType: 'estimate',
    entityId: fresh.id,
    payload: {
      ...subjectOf(fresh),
      publicRef: fresh.public_ref,
      linkVersion: fresh.link_version,
      channels: input.channels,
      message: input.message,
      expiresOn,
      depositCents: depositOf(fresh),
    },
    before: { status: before.status },
    after: {
      estimate: number,
      total: money(Number(fresh.total_cents)),
      sentBy: input.channels.join(', '),
    },
  });
  return stateOut(fresh, true);
}

export const estimateSend = defineCommand({
  name: 'estimate.send',
  description:
    'Send an estimate to the customer. It takes the next number, stamps when it went out and freezes: from here its number, its tax, its totals and its lines are what the customer was shown. The worker sends the text or the email with the link.',
  risk: 2,
  input: EstimateSendInput,
  output: EstimateStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['estimate.sent'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    requireHuman(ctx);
    return sendEstimate(ctx, input);
  },
});

export const estimateVoid = defineCommand({
  name: 'estimate.void',
  description:
    'Withdraw an estimate. Its number is kept and never used again — the gap is the record — and nothing about it can change afterwards.',
  risk: 2,
  input: EstimateVoidInput,
  output: EstimateStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['estimate.voided'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const before = await requireEstimate(ctx, input.estimateId);
    if (before.status === 'void') return stateOut(before, false);
    assertMove(before, 'void');
    await ctx.tx
      .update(estimates)
      .set({
        status: 'void',
        // The guard stamps the database's clock and insists the name is the caller's own.
        voidedAt: dsql`now()`,
        voidedBy: me,
        voidReason: input.reason ?? null,
      })
      .where(eq(estimates.id, before.id));
    const fresh = await requireEstimate(ctx, before.id);
    await ctx.emit({
      type: 'estimate.voided',
      entityType: 'estimate',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), reason: input.reason ?? null },
      before: { status: before.status },
      after: { estimate: nameOf(fresh), status: 'void', reason: input.reason ?? null },
    });
    return stateOut(fresh, true);
  },
});

/**
 * A yes the customer gave somewhere other than their own page, recorded as staff in the name of `by`: the person
 * who took it on the phone, or who approved the AI teammate's record of it (M18). Never as the customer.
 */
export async function recordStaffAcceptance(
  ctx: CommandContext,
  input: z.infer<typeof EstimateMarkAcceptedInput>,
  by: string,
) {
  const before = await requireEstimate(ctx, input.estimateId);
  assertMove(before, 'accepted');
  const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
  const hash = await hashOf(ctx, before);
  const wording = `Approved by ${input.name} — recorded by staff${input.note ? `: ${input.note}` : ''}`;
  // The guard checks accepted_by is the caller and writes accepted_at from the database's clock.
  await ctx.tx
    .update(estimates)
    .set({
      status: 'accepted',
      acceptedAt: dsql`now()`,
      acceptedVia: 'staff',
      acceptedBy: by,
      acceptedName: input.name,
      acceptedWording: wording,
      acceptedHash: hash,
    })
    .where(eq(estimates.id, before.id));
  const fresh = await requireEstimate(ctx, before.id);
  const at = isoAt(fresh.accepted_at!);
  await ctx.emit({
    type: 'estimate.accepted',
    entityType: 'estimate',
    entityId: fresh.id,
    payload: { ...subjectOf(fresh), via: 'staff', name: input.name, acceptedAt: at },
    before: { status: before.status },
    after: {
      estimate: nameOf(fresh),
      approved: acceptedWording(input.name, at, tz),
      by: 'staff',
    },
  });
  return {
    estimateId: fresh.id,
    status: fresh.status,
    acceptedAt: at,
    acceptedName: input.name,
    acceptedVia: 'staff' as const,
    acceptedHash: hash,
    wording,
  };
}

export const estimateMarkAccepted = defineCommand({
  name: 'estimate.mark_accepted',
  description:
    'Record that the customer said yes — on the phone, or in person. It is marked as recorded by staff, in your name, and never as the customer’s own approval.',
  risk: 2,
  input: EstimateMarkAcceptedInput,
  output: EstimateAcceptedOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['estimate.accepted'],
  async handler(ctx, input) {
    return recordStaffAcceptance(ctx, input, requireHuman(ctx).userId);
  },
});

export const estimateConvert = defineCommand({
  name: 'estimate.convert',
  description:
    'Turn an estimate into an invoice. The lines are copied as they were agreed and the deposit is carried through as what to ask for first; ask for the deposit on its own and it is raised as a one-line deposit invoice instead.',
  risk: 2,
  input: EstimateConvertInput,
  output: EstimateConvertOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['estimate.converted'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const e = await requireEstimate(ctx, input.estimateId);
    if (e.status !== 'accepted' && e.status !== 'sent')
      throw HfosError.rule(
        'estimate_not_answered',
        409,
        e.status === 'draft'
          ? 'Send the estimate before invoicing it.'
          : `A ${e.status} estimate can’t be invoiced. Make a new one instead.`,
      );
    const lines = (await linesFor(ctx.tx, 'estimate', [e.id])).get(e.id) ?? [];
    const depositCents = depositOf(e);
    if (input.purpose === 'deposit' && depositCents <= 0)
      throw HfosError.rule(
        'estimate_no_deposit',
        409,
        'This estimate doesn’t ask for a deposit. Invoice the whole job instead.',
      );
    const copied =
      input.purpose === 'deposit'
        ? [
            {
              productId: null,
              name: 'Deposit',
              description: `Deposit on ${nameOf(e)}`,
              quantity: 1,
              unitLabel: 'each',
              unitPriceCents: depositCents,
              // The tax is already in the estimate's total: a deposit against it is not taxed again.
              taxable: false,
              discountCents: 0,
            },
          ]
        : linesIn(lines);
    // The invoice is created through its own command, as this person: its rules, its events, its audit row.
    const made = await executeCommandWithin(ctx, invoiceCreate, {
      workspaceId: ws,
      personId: e.person_id,
      leadId: e.lead_id,
      assigneeUserId: e.assignee_user_id,
      title: e.title ?? undefined,
      lines: copied,
      // A deposit invoice has no document discount: the estimate's is already inside the figure.
      discount:
        input.purpose === 'deposit'
          ? { kind: 'none' as const }
          : e.discount_percent_bp !== null
            ? { kind: 'percent' as const, percentBp: e.discount_percent_bp }
            : Number(e.discount_cents) > 0
              ? { kind: 'amount' as const, amountCents: Number(e.discount_cents) }
              : { kind: 'none' as const },
      purpose: input.purpose,
      origin: 'estimate' as const,
      estimateId: e.id,
      connectionId: input.connectionId,
      dueOn: input.dueOn,
    });
    await ctx.emit({
      type: 'estimate.converted',
      entityType: 'estimate',
      entityId: e.id,
      payload: {
        ...subjectOf(e),
        invoiceId: made.output.invoiceId,
        purpose: input.purpose,
        depositCents,
      },
      after: {
        estimate: nameOf(e),
        invoiced: money(made.output.totalCents),
        ...(input.purpose === 'deposit' ? { deposit: money(depositCents) } : {}),
      },
    });
    return {
      estimateId: e.id,
      invoiceId: made.output.invoiceId,
      purpose: input.purpose,
      totalCents: made.output.totalCents,
      depositCents,
    };
  },
});

// ---------- what the customer did ----------

export const estimateAcceptOnline = defineCommand({
  name: 'estimate.accept_online',
  description:
    'A customer approves an estimate on their own page (the worker runs this for them). It keeps the name they typed, the moment from the database’s clock, the exact wording they saw and a hash of the lines and totals they were shown. A second approval is refused.',
  risk: 2,
  input: EstimateAcceptOnlineInput,
  output: EstimateAcceptedOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['estimate.accepted'],
  actors: ['system'],
  async handler(ctx, input) {
    const before = await requireEstimate(ctx, input.estimateId);
    assertMove(before, 'accepted');
    const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    const expiresAt = expiresAtOf(before.expires_on, tz);
    if (expiresAt && Date.now() >= Date.parse(expiresAt))
      throw HfosError.rule(
        'estimate_expired',
        409,
        'This estimate has expired. Ask us for a new one and we’ll send it straight over.',
      );
    const hash = await hashOf(ctx, before);
    // Any non-empty name is taken: people type "Maria L.", and a hard match turns an approval into a call.
    await ctx.tx
      .update(estimates)
      .set({
        status: 'accepted',
        acceptedAt: dsql`now()`,
        acceptedVia: 'link',
        acceptedName: input.name,
        acceptedWording: input.wording,
        acceptedHash: hash,
        lastViewedAt: dsql`now()`,
        firstViewedAt: dsql`coalesce(${estimates.firstViewedAt}, now())`,
      })
      .where(eq(estimates.id, before.id));
    const fresh = await requireEstimate(ctx, before.id);
    const at = isoAt(fresh.accepted_at!);
    await ctx.emit({
      type: 'estimate.accepted',
      entityType: 'estimate',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), via: 'link', name: input.name, acceptedAt: at },
      before: { status: before.status },
      after: {
        estimate: nameOf(fresh),
        approved: acceptedWording(input.name, at, tz),
        by: 'customer',
      },
    });
    return {
      estimateId: fresh.id,
      status: fresh.status,
      acceptedAt: at,
      acceptedName: input.name,
      acceptedVia: 'link' as const,
      acceptedHash: hash,
      wording: input.wording,
    };
  },
});

/** A no from the customer: on their own page, or told to the AI teammate and approved by a person (M18). */
export async function declineEstimate(
  ctx: CommandContext,
  input: z.infer<typeof EstimateDeclineOnlineInput>,
  opts: { readonly onTheirPage: boolean },
) {
  const before = await requireEstimate(ctx, input.estimateId);
  assertMove(before, 'declined');
  await ctx.tx
    .update(estimates)
    .set({
      status: 'declined',
      declinedAt: dsql`now()`,
      declinedReason: input.reason,
      // Declining on their page is seeing it; a no in a conversation says nothing about the page.
      ...(opts.onTheirPage
        ? {
            lastViewedAt: dsql`now()`,
            firstViewedAt: dsql`coalesce(${estimates.firstViewedAt}, now())`,
          }
        : {}),
    })
    .where(eq(estimates.id, before.id));
  const fresh = await requireEstimate(ctx, before.id);
  await ctx.emit({
    type: 'estimate.declined',
    entityType: 'estimate',
    entityId: fresh.id,
    payload: {
      ...subjectOf(fresh),
      name: input.name,
      reason: input.reason,
      declinedAt: moneyIso(fresh.declined_at),
    },
    before: { status: before.status },
    after: { estimate: nameOf(fresh), status: 'declined', reason: input.reason },
  });
  return stateOut(fresh, true);
}

export const estimateDeclineOnline = defineCommand({
  name: 'estimate.decline_online',
  description:
    'A customer declines an estimate on their own page, with a reason if they give one (the worker runs this for them).',
  risk: 2,
  input: EstimateDeclineOnlineInput,
  output: EstimateStateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['estimate.declined'],
  actors: ['system'],
  async handler(ctx, input) {
    return declineEstimate(ctx, input, { onTheirPage: true });
  },
});

export const estimateRecordView = defineCommand({
  name: 'estimate.record_view',
  description:
    'Worker: the customer opened their estimate. The first time is kept as well as the latest, so “opened, not answered” is a fact and not a guess.',
  risk: 0,
  input: DocumentRecordViewInput,
  output: DocumentViewOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['estimate.viewed'],
  actors: ['system'],
  async handler(ctx, input) {
    const before = await requireEstimate(ctx, input.documentId);
    const first = before.first_viewed_at === null;
    const [row] = await rows<{
      first_viewed_at: Date | string | null;
      last_viewed_at: Date | string;
    }>(
      ctx.tx,
      sql`update app.estimates
          set first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now()
          where id = ${before.id} returning first_viewed_at, last_viewed_at`,
    );
    if (!row) throw HfosError.notFound('That estimate isn’t there.');
    // Only the first open is news: a customer refreshing their own page is not an event.
    if (first)
      await ctx.emit({
        type: 'estimate.viewed',
        entityType: 'estimate',
        entityId: before.id,
        payload: {
          ...subjectOf(before),
          firstViewedAt: moneyIso(row.first_viewed_at),
        },
        after: { estimate: nameOf(before), opened: true },
        broadcast: true,
      });
    return {
      documentId: before.id,
      firstViewedAt: moneyIso(row.first_viewed_at),
      lastViewedAt: isoAt(row.last_viewed_at),
      changed: first,
    };
  },
});

/** Worker: an estimate nobody answered has stopped being good. It is reissued, never chased. */
export const estimateExpire = defineCommand({
  name: 'estimate.expire',
  description:
    'Worker: an estimate stayed good until its date and nobody answered. It stops being open, and the business reissues it rather than chasing it.',
  risk: 0,
  input: EstimateRefInput,
  output: EstimateStateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['estimate.expired'],
  actors: ['system'],
  async handler(ctx, input) {
    const before = await requireEstimate(ctx, input.estimateId);
    if (before.status !== 'sent') return stateOut(before, false);
    const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    const expiresAt = expiresAtOf(before.expires_on, tz);
    if (!expiresAt || Date.now() < Date.parse(expiresAt)) return stateOut(before, false);
    await ctx.tx.update(estimates).set({ status: 'expired' }).where(eq(estimates.id, before.id));
    const fresh = await requireEstimate(ctx, before.id);
    await ctx.emit({
      type: 'estimate.expired',
      entityType: 'estimate',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), expiresOn: fresh.expires_on },
      before: { status: 'sent' },
      after: { estimate: nameOf(fresh), status: 'expired' },
    });
    return stateOut(fresh, true);
  },
});

export const estimateCommands = [
  estimateCreate,
  estimateUpdate,
  estimateSend,
  estimateMarkAccepted,
  estimateConvert,
  estimateVoid,
  estimateAcceptOnline,
  estimateDeclineOnline,
  estimateRecordView,
  estimateExpire,
] as const;
