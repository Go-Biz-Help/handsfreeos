/**
 * Costs and estimates (docs/contractor.md, "Costs and estimates"): what each price list item costs, how the business
 * estimates, and the estimate builder. The builder writes an ordinary HandsFreeOS estimate through core's own
 * commands, so its number, its link, the customer's page, its invoice and its payments are all core's; what's kept
 * here is what core can't see: the job it's for, what each line costs, and an owner's or admin's OK.
 *
 * **The lowest margin** (the owner's decision 6): an estimate with an option under it, or with a labor or material
 * line nobody put a cost on, waits for an owner or admin to OK it before it's sent. An OK is for the estimate exactly
 * as it stood: any later save needs a fresh one. Core refuses to change or send an estimate built here from anywhere
 * else while the add-on runs (`estimate_built_elsewhere`), so the check can't be walked around.
 *
 * Costs never leave: they're on no event and no timeline line, and their tables are read only with
 * `contractor.costs` (the owner's decision 11).
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { estimateCreate, estimateSend, estimateUpdate } from '../../../commands/estimate';
import type { StoredEstimateOption } from '../../../commands/money-shared';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { executeCommandWithin, executeQueryWithin, scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { estimateGet as coreEstimateGet } from '../../../queries/money';
import type { MoneyLineInput } from '../../../schemas/money';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  checkMargin,
  costOption,
  DEFAULT_MARKUP_BP,
  DEFAULT_MIN_MARGIN_BP,
  defaultCostKind,
  marginBpOf,
  type CostedLine,
  type CostKind,
} from '../estimating';
import { contractorAddon } from '../manifest';
import {
  EstimateBuilderInput,
  EstimateBuilderOutput,
  EstimateFillJobInput,
  EstimateFillJobOutput,
  EstimateListInput,
  EstimateListOutput,
  EstimateOkInput,
  EstimateOkOutput,
  EstimateRefInput,
  EstimateSaveInput,
  EstimateSaveOutput,
  EstimateSendInput,
  EstimateSendOutput,
  EstimatingSaveInput,
  EstimatingSaveOutput,
  InWorkspace,
  ItemCostListOutput,
  ItemCostSetInput,
  ItemCostSetOutput,
  type Estimating,
  type EstimateLineInput,
  type MarginCheckOut,
} from '../schemas';
import {
  estimateCosts,
  estimateOks,
  estimates as links,
  estimating,
  itemCosts,
  money,
} from '../tables';
import { CONTRACTOR_WORDS as W, okNeededWords, REFUSALS } from '../words';
import { inWorkspace, jobLine, loadJob, pairsOf, type Ctx, type Job } from './common';
import { addEstimateMaterials, type EstimateMaterialLine } from './materials';

const estimatePath = (id: string) => `a/contractor/estimates/${id}`;
const idIn = (v: unknown, key: string) => String((v as Record<string, unknown>)[key] ?? '');
const mayApprove = (ctx: Ctx) => scopeCan(ctx.scope, 'contractor.approve' as Permission);

// ------------------------------------------------------------------------------------------------ what's shared

/** How the business estimates: what it saved, or what a new business starts with. */
export async function estimatingOf(ctx: Ctx): Promise<Estimating> {
  const [r] = await rows<{
    min_margin_bp: number;
    markup_bp: number;
    labor_rate_cents: number;
    labor_cost_cents: number;
  }>(
    ctx.tx,
    sql`select min_margin_bp, markup_bp, labor_rate_cents::float8 as labor_rate_cents,
          labor_cost_cents::float8 as labor_cost_cents
        from addon_contractor.estimating where workspace_id = ${ctx.scope.workspaceId!}`,
  );
  return {
    minMarginBp: r?.min_margin_bp ?? DEFAULT_MIN_MARGIN_BP,
    markupBp: r?.markup_bp ?? DEFAULT_MARKUP_BP,
    laborRateCents: Number(r?.labor_rate_cents ?? 0),
    laborCostCents: Number(r?.labor_cost_cents ?? 0),
  };
}

/** An estimate the builder wrote, as its operations need it: core's row and what's kept about it here. */
interface Built {
  readonly estimateId: string;
  readonly status: string;
  readonly personId: string;
  readonly leadId: string | null;
  /** Core's revision: when it last changed, in milliseconds. An OK is for one of these. */
  readonly revision: number;
  readonly number: string | null;
  /** Its price before tax, after any discount: the option its own lines are. */
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly options: readonly StoredEstimateOption[];
  readonly optionPosition: number | null;
  readonly jobId: string | null;
  readonly askedAt: string | null;
  readonly askedBy: string | null;
  readonly askedByName: string | null;
}

/** Loads an estimate the builder wrote, locked for the change when asked; refused when it isn't one of its own. */
async function loadBuilt(ctx: Ctx, estimateId: string, lock = false): Promise<Built> {
  const forUpdate = lock ? sql` for update of e` : sql``;
  const [r] = await rows<{
    id: string;
    status: string;
    person_id: string;
    lead_id: string | null;
    revision: number;
    number: string | null;
    subtotal_cents: number;
    total_cents: number;
    options: StoredEstimateOption[] | null;
    option_position: number | null;
    addon_id: string | null;
    record_id: string | null;
    asked_at: string | null;
    asked_by: string | null;
    asked_by_name: string | null;
  }>(
    ctx.tx,
    sql`select e.id, e.status::text as status, e.person_id, e.lead_id,
          (extract(epoch from e.updated_at) * 1000)::float8 as revision, e.number,
          e.subtotal_cents::float8 as subtotal_cents, e.total_cents::float8 as total_cents, e.options,
          e.option_position, e.addon_id, x.record_id, x.asked_at::text as asked_at, x.asked_by,
          coalesce(nullif(btrim(u.full_name), ''), u.email::text) as asked_by_name
        from app.estimates e
        left join addon_contractor.estimates x on x.estimate_id = e.id
        left join app.users u on u.id = x.asked_by
        where e.id = ${estimateId} and e.workspace_id = ${ctx.scope.workspaceId!}${forUpdate}`,
  );
  if (!r) throw HfosError.notFound(REFUSALS.estimateGone);
  if (r.addon_id !== contractorAddon.id)
    throw HfosError.rule('contractor_estimate_not_here', 409, REFUSALS.estimateNotHere);
  return {
    estimateId: r.id,
    status: r.status,
    personId: r.person_id,
    leadId: r.lead_id,
    revision: Math.round(Number(r.revision)),
    number: r.number,
    subtotalCents: Number(r.subtotal_cents),
    totalCents: Number(r.total_cents),
    options: r.options ?? [],
    optionPosition: r.option_position,
    jobId: r.record_id,
    askedAt: r.asked_at,
    askedBy: r.asked_by,
    askedByName: r.asked_by_name,
  };
}

type CostRow = { option: number; line: number; kind: CostKind; unitCostCents: number | null };

/** What each line of an estimate costs, by option and the line's place in it. */
async function costRowsOf(ctx: Ctx, estimateId: string): Promise<CostRow[]> {
  const list = await rows<{
    option_position: number;
    line_position: number;
    kind: CostKind;
    unit_cost_cents: number | null;
  }>(
    ctx.tx,
    sql`select option_position, line_position, kind, unit_cost_cents::float8 as unit_cost_cents
        from addon_contractor.estimate_costs
        where estimate_id = ${estimateId} and workspace_id = ${ctx.scope.workspaceId!}
        order by option_position, line_position`,
  );
  return list.map((c) => ({
    option: c.option_position,
    line: c.line_position,
    kind: c.kind,
    unitCostCents: c.unit_cost_cents === null ? null : Number(c.unit_cost_cents),
  }));
}

/** A line with its cost beside it. A line nobody costed is a material with no cost, so it counts as unchecked. */
function costed(
  line: { quantity: number; unitPriceCents: number; discountCents: number },
  cost: CostRow | undefined,
): CostedLine {
  return {
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    discountCents: line.discountCents,
    kind: cost?.kind ?? 'material',
    unitCostCents: cost?.unitCostCents ?? null,
  };
}

/** The estimate's own lines (its one price, or the option they picked), each with its cost. */
async function ownLines(
  ctx: Ctx,
  estimateId: string,
  option: number,
  costs: readonly CostRow[],
): Promise<CostedLine[]> {
  const list = await rows<{
    position: number;
    quantity: number;
    unit_price_cents: number;
    discount_cents: number;
  }>(
    ctx.tx,
    sql`select position, quantity::float8 as quantity, unit_price_cents::float8 as unit_price_cents,
          discount_cents::float8 as discount_cents
        from app.estimate_lines where estimate_id = ${estimateId} order by position`,
  );
  return list.map((l) =>
    costed(
      {
        quantity: Number(l.quantity),
        unitPriceCents: Number(l.unit_price_cents),
        discountCents: Number(l.discount_cents),
      },
      costs.find((c) => c.option === option && c.line === l.position),
    ),
  );
}

/** Every option the customer could pick, costed: one for an estimate with one price. */
async function costedOptions(ctx: Ctx, b: Built, costs: readonly CostRow[]) {
  if (!b.options.length)
    return [
      {
        position: 1,
        name: null as string | null,
        costing: costOption(await ownLines(ctx, b.estimateId, 1, costs), b.subtotalCents),
      },
    ];
  return b.options.map((o, i) => ({
    position: i + 1,
    name: o.name as string | null,
    costing: costOption(
      o.lines.map((l, n) =>
        costed(
          l,
          costs.find((c) => c.option === i + 1 && c.line === n),
        ),
      ),
      o.totals.subtotalCents,
    ),
  }));
}

/** Whether an estimate can go out as it is, and what it's waiting on. */
async function checkOf(ctx: Ctx, b: Built): Promise<MarginCheckOut> {
  const { minMarginBp } = await estimatingOf(ctx);
  const options = await costedOptions(ctx, b, await costRowsOf(ctx, b.estimateId));
  const check = checkMargin(options, minMarginBp);
  const [ok] = await rows<{
    revision: number;
    ok_at: string;
    note: string | null;
    by: string | null;
  }>(
    ctx.tx,
    sql`select o.revision::float8 as revision, o.ok_at::text as ok_at, o.note,
          coalesce(nullif(btrim(u.full_name), ''), u.email::text) as by
        from addon_contractor.estimate_oks o left join app.users u on u.id = o.ok_by
        where o.estimate_id = ${b.estimateId} and o.workspace_id = ${ctx.scope.workspaceId!}`,
  );
  // An OK is for the estimate exactly as it stood: a save since then is a different estimate.
  const stands = !!ok && Number(ok.revision) === b.revision;
  return {
    options: options.map((o) => ({ position: o.position, name: o.name, ...o.costing })),
    lowest: check.lowest,
    minMarginBp: check.minMarginBp,
    uncosted: check.uncosted,
    needsOk: check.needsOk,
    ok: stands && ok ? { by: ok.by, at: new Date(ok.ok_at).toISOString(), note: ok.note } : null,
    asked: b.askedAt ? { by: b.askedByName, at: new Date(b.askedAt).toISOString() } : null,
    canSend: check.needsOk === null || stands,
  };
}

const notDraft = (b: Built, doing: Parameters<typeof REFUSALS.estimateNotDraft>[0]) =>
  b.status === 'draft'
    ? null
    : HfosError.rule('contractor_estimate_sent', 409, REFUSALS.estimateNotDraft(doing));

/** A builder's line as core takes it: everything but its cost. */
const coreLine = (l: EstimateLineInput): MoneyLineInput => ({
  productId: l.productId,
  name: l.name,
  description: l.description,
  quantity: l.quantity,
  unitLabel: l.unitLabel,
  unitPriceCents: l.unitPriceCents,
  taxable: l.taxable,
  discountCents: l.discountCents,
});

// ------------------------------------------------------------------------------------------------ the builder

export const estimateSave = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimate.save',
  description:
    'Write or save an estimate with what it costs to do: one option for one price, or two or three (good, better, best), each with every one of its lines, and each line’s kind (labor, material, other) and what one unit costs. It makes an ordinary HandsFreeOS estimate, for the job named and that job’s customer. It stays a draft, and is saved whole: what’s left out is cleared. For people who may see job costs and who may bill.',
  risk: 1,
  input: EstimateSaveInput,
  output: EstimateSaveOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_write_estimate',
    description:
      'Write an estimate with costs (leave estimateId out), or save over a draft one (estimateId, with everything it should now have). options: one for one price, or two or three named ones (Good, Better, Best), each with all its lines; a line has name, quantity, unitLabel, unitPriceCents, kind (labor by the hour, material, or other) and unitCostCents (what one costs the business). jobId is the job it’s for; its customer is who it goes to. Answers each option’s profit and margin, and whether it needs an owner’s or admin’s OK before it’s sent. It stays a draft. Asks the person first.',
    autonomy: 'confirm',
    what: 'Write the estimate',
    keywords: ['estimate', 'quote', 'bid', 'good better best', 'margin', 'markup'],
    outcome: (output) => ({
      words: (output as { created?: boolean }).created
        ? 'The estimate is written.'
        : W.builder.saved,
      path: estimatePath(idIn(output, 'estimateId')),
    }),
  },
  emits: ['contractor.estimate.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const many = input.options.length > 1;
    if (many && input.options.some((o) => !o.name))
      throw HfosError.rule('estimate_options', 409, REFUSALS.estimateOptionNames);
    // One option is one price: an ordinary estimate. Two or three are core's options, the first its own lines.
    const body = many
      ? {
          lines: [],
          options: input.options.map((o) => ({ name: o.name, lines: o.lines.map(coreLine) })),
        }
      : { lines: input.options[0]!.lines.map(coreLine), options: null };
    const header = {
      workspaceId: ws,
      title: input.title,
      notes: input.notes,
      discount: input.discount,
      deposit: input.deposit,
      expiresOn: input.expiresOn,
      ...body,
    };

    let job: Job | null = null;
    if (input.jobId) {
      job = await loadJob(ctx, input.jobId);
      if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    }

    let estimateId: string;
    let created = false;
    if (input.estimateId) {
      const before = await loadBuilt(ctx, input.estimateId, true);
      const refusal = notDraft(before, 'change');
      if (refusal) throw refusal;
      // Core checks the rest as it does for its own editor: the revision, the customer, who may bill.
      await executeCommandWithin(ctx, estimateUpdate, {
        ...header,
        estimateId: before.estimateId,
        personId: input.personId ?? before.personId,
        leadId: before.leadId,
        baseRevision: input.baseRevision ?? before.revision,
      });
      estimateId = before.estimateId;
    } else {
      const personId =
        input.personId ?? (job ? (await pairsOf(ctx, job.recordId)).customer?.personId : null);
      if (!personId)
        throw HfosError.rule('contractor_estimate_customer', 409, REFUSALS.estimateCustomer);
      const made = await executeCommandWithin(ctx, estimateCreate, { ...header, personId });
      estimateId = made.output.estimateId;
      created = true;
    }

    await ctx.tx
      .insert(links)
      .values({
        estimateId,
        workspaceId: ws,
        recordId: job?.recordId ?? null,
        createdBy: userIdOf(ctx.actor),
      })
      .onConflictDoUpdate({
        target: links.estimateId,
        set: {
          // Left out, the job it's for stays; null takes it off the job.
          ...(input.jobId !== undefined ? { recordId: job?.recordId ?? null } : {}),
          updatedAt: dsql`now()`,
        },
      });
    await ctx.tx.delete(estimateCosts).where(eq(estimateCosts.estimateId, estimateId));
    await ctx.tx.insert(estimateCosts).values(
      input.options.flatMap((o, i) =>
        o.lines.map((l, n) => ({
          estimateId,
          workspaceId: ws,
          optionPosition: i + 1,
          linePosition: n,
          kind: l.kind,
          unitCostCents: l.unitCostCents,
        })),
      ),
    );

    let fresh = await loadBuilt(ctx, estimateId);
    let check = await checkOf(ctx, fresh);
    // Nothing left to OK: an ask that's still open is over.
    if (check.needsOk === null && fresh.askedAt) {
      await ctx.tx
        .update(links)
        .set({ askedAt: null, askedBy: null })
        .where(eq(links.estimateId, estimateId));
      fresh = { ...fresh, askedAt: null, askedBy: null, askedByName: null };
      check = { ...check, asked: null };
    }
    const eventId = await ctx.emit({
      type: 'contractor.estimate.saved',
      entityType: 'estimate',
      entityId: estimateId,
      // No amounts and no costs: an event is read by more people than may see them.
      payload: {
        estimateId,
        jobId: fresh.jobId,
        options: input.options.length,
        created,
        waitingOk: !!check.asked && !check.canSend,
      },
    });
    if (created && fresh.jobId)
      await jobLine(ctx, fresh.jobId, 'started an estimate for this job', { eventId });
    return {
      estimateId,
      revision: fresh.revision,
      totalCents: fresh.totalCents,
      created,
      check,
    };
  },
});

export const estimateAskOk = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimate.ask_ok',
  description:
    'Ask an owner or admin to OK an estimate that’s under the business’s lowest margin, or has lines with no cost, so it can be sent. They’re told on Home and their phones.',
  risk: 1,
  input: EstimateRefInput,
  output: EstimateOkOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_ask_estimate_ok',
    description:
      'Ask the business’s owners and admins to OK an estimate under the lowest margin (or with uncosted lines) so it can be sent. Does nothing when it needs no OK or already has one. Asks the person first.',
    autonomy: 'confirm',
    what: 'Ask for an OK on the estimate',
    outcome: (output, input) => ({
      words: (output as { changed?: boolean }).changed
        ? W.builder.ok.askedNow
        : 'It doesn’t need an OK as it is now.',
      path: estimatePath(idIn(input, 'estimateId')),
    }),
  },
  emits: ['contractor.estimate.ok_asked'],
  async handler(ctx, input) {
    const b = await loadBuilt(ctx, input.estimateId, true);
    const refusal = notDraft(b, 'ask about');
    if (refusal) throw refusal;
    const check = await checkOf(ctx, b);
    if (check.canSend || b.askedAt) return { estimateId: b.estimateId, changed: false };
    const by = userIdOf(ctx.actor);
    await ctx.tx
      .update(links)
      .set({ askedAt: dsql`now()`, askedBy: by, updatedAt: dsql`now()` })
      .where(eq(links.estimateId, b.estimateId));
    const eventId = await ctx.emit({
      type: 'contractor.estimate.ok_asked',
      entityType: 'estimate',
      entityId: b.estimateId,
      payload: { estimateId: b.estimateId, jobId: b.jobId, askedBy: by, reason: check.needsOk },
    });
    if (b.jobId) await jobLine(ctx, b.jobId, 'asked for an OK to send an estimate', { eventId });
    return { estimateId: b.estimateId, changed: true };
  },
});

export const estimateOk = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimate.ok',
  description:
    'OK an estimate that’s under the business’s lowest margin, or has lines with no cost, so it can be sent as it is now. Any later change to the estimate needs a fresh OK. For owners and admins.',
  risk: 2,
  input: EstimateOkInput,
  output: EstimateOkOutput,
  permission: 'contractor.approve',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_ok_estimate',
    description:
      'OK an estimate under the lowest margin (or with uncosted lines) so it can be sent exactly as it is now, with an optional note. Only owners and admins can. Asks the person first.',
    autonomy: 'confirm',
    what: 'OK the estimate to go out as it is',
    outcome: (output, input) => ({
      words: (output as { changed?: boolean }).changed
        ? W.builder.ok.givenNow
        : 'It doesn’t need an OK as it is now.',
      path: estimatePath(idIn(input, 'estimateId')),
    }),
  },
  emits: ['contractor.estimate.okayed'],
  async handler(ctx, input) {
    const b = await loadBuilt(ctx, input.estimateId, true);
    const refusal = notDraft(b, 'OK');
    if (refusal) throw refusal;
    const check = await checkOf(ctx, b);
    if (check.canSend) return { estimateId: b.estimateId, changed: false };
    const by = userIdOf(ctx.actor);
    const ok = { revision: b.revision, okBy: by, okAt: dsql`now()`, note: input.note || null };
    await ctx.tx
      .insert(estimateOks)
      .values({ estimateId: b.estimateId, workspaceId: ctx.scope.workspaceId!, ...ok })
      .onConflictDoUpdate({ target: estimateOks.estimateId, set: ok });
    await ctx.tx
      .update(links)
      .set({ askedAt: null, askedBy: null, updatedAt: dsql`now()` })
      .where(eq(links.estimateId, b.estimateId));
    const eventId = await ctx.emit({
      type: 'contractor.estimate.okayed',
      entityType: 'estimate',
      entityId: b.estimateId,
      payload: {
        estimateId: b.estimateId,
        jobId: b.jobId,
        okBy: by,
        askedBy: b.askedBy,
        reason: check.needsOk,
      },
    });
    if (b.jobId)
      await jobLine(ctx, b.jobId, 'OK’d an estimate to go out', {
        eventId,
        body: input.note || null,
      });
    return { estimateId: b.estimateId, changed: true };
  },
});

export const estimateSendBuilt = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimate.send',
  description:
    'Send an estimate the builder wrote to its customer, by text or email. Refused while it waits for an owner’s or admin’s OK: an option under the lowest margin, or a labor or material line with no cost. From there it’s an ordinary HandsFreeOS estimate: its number, its link and the customer’s page.',
  risk: 2,
  input: EstimateSendInput,
  output: EstimateSendOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_send_estimate',
    description:
      'Send an estimate built in Contractor Operations to its customer (channels: sms, email; an optional message). Refused while it needs an owner’s or admin’s OK. Asks the person first.',
    autonomy: 'confirm',
    what: 'Send the estimate to the customer',
    outcome: (_o, input) => ({
      words: W.builder.sent,
      path: estimatePath(idIn(input, 'estimateId')),
    }),
  },
  emits: ['contractor.estimate.sent'],
  async handler(ctx, input) {
    const b = await loadBuilt(ctx, input.estimateId, true);
    if (b.status === 'draft') {
      const check = await checkOf(ctx, b);
      if (!check.canSend)
        throw HfosError.rule(
          'contractor_margin_needs_ok',
          409,
          REFUSALS.marginNeedsOk(okNeededWords(check) ?? W.builder.ok.needed, mayApprove(ctx)),
        );
    }
    // Core does the sending, and says so in its own words when it has already gone.
    const sent = await executeCommandWithin(ctx, estimateSend, input);
    await ctx.tx
      .update(links)
      .set({ askedAt: null, askedBy: null, updatedAt: dsql`now()` })
      .where(eq(links.estimateId, b.estimateId));
    const eventId = await ctx.emit({
      type: 'contractor.estimate.sent',
      entityType: 'estimate',
      entityId: b.estimateId,
      payload: { estimateId: b.estimateId, jobId: b.jobId, number: sent.output.number },
    });
    if (b.jobId)
      await jobLine(
        ctx,
        b.jobId,
        `sent estimate ${sent.output.number ?? ''} to the customer`.replace(/\s+/g, ' '),
        { eventId },
      );
    return sent.output;
  },
});

/** An approved estimate's lines costed as materials, at the option the customer picked. */
async function materialLinesOf(
  ctx: Ctx,
  estimateId: string,
  option: number,
): Promise<EstimateMaterialLine[]> {
  const list = await rows<{
    position: number;
    name: string;
    quantity: number;
    unit_label: string | null;
    product_id: string | null;
    unit_cost_cents: number | null;
  }>(
    ctx.tx,
    sql`select l.position, l.name, l.quantity::float8 as quantity, l.unit_label, l.product_id,
          c.unit_cost_cents::float8 as unit_cost_cents
        from app.estimate_lines l
        join addon_contractor.estimate_costs c on c.estimate_id = l.estimate_id
          and c.option_position = ${option} and c.line_position = l.position and c.kind = 'material'
        where l.estimate_id = ${estimateId}
        order by l.position`,
  );
  return list.map((l) => ({
    line: l.position,
    name: l.name,
    quantity: Number(l.quantity),
    unitLabel: l.unit_label,
    productId: l.product_id,
    unitCostCents: l.unit_cost_cents === null ? null : Number(l.unit_cost_cents),
  }));
}

/**
 * The worker: the customer said yes to an estimate, so its job's price and budget are what was agreed. Every
 * approved estimate on the job counts (a change order adds to the first), each at the option they picked. The
 * estimate's material lines go onto the job's materials, once each (the owner's decision 9).
 */
export const estimateFillJob = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimate.fill_job',
  description:
    'Worker: an approved estimate fills its job’s price and budget, and puts its materials on the job’s list.',
  risk: 0,
  input: EstimateFillJobInput,
  output: EstimateFillJobOutput,
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.job.money_set', 'contractor.materials.filled'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [link] = await rows<{ record_id: string | null }>(
      ctx.tx,
      sql`select record_id from addon_contractor.estimates
          where estimate_id = ${input.estimateId} and workspace_id = ${ws}`,
    );
    if (!link?.record_id) return null;
    const job = await loadJob(ctx, link.record_id, { lock: true });
    if (job.archived) return null;
    const approved = await rows<{ id: string; subtotal_cents: number; option: number }>(
      ctx.tx,
      sql`select e.id, e.subtotal_cents::float8 as subtotal_cents, coalesce(e.option_position, 1) as option
          from addon_contractor.estimates x join app.estimates e on e.id = x.estimate_id
          where x.record_id = ${job.recordId} and x.workspace_id = ${ws} and e.status = 'accepted'
          order by e.accepted_at`,
    );
    const picked = approved.find((e) => e.id === input.estimateId);
    if (!picked) return null;
    const sum = { priceCents: 0, laborCents: 0, materialsCents: 0, otherCents: 0, laborHours: 0 };
    for (const e of approved) {
      const lines = await ownLines(ctx, e.id, e.option, await costRowsOf(ctx, e.id));
      const c = costOption(lines, Number(e.subtotal_cents));
      sum.priceCents += c.priceCents;
      sum.laborCents += c.laborCents;
      sum.materialsCents += c.materialsCents;
      sum.otherCents += c.otherCents;
      sum.laborHours = Math.round((sum.laborHours + c.laborHours) * 100) / 100;
    }
    const by = userIdOf(ctx.actor);
    await ctx.tx
      .insert(money)
      .values({ recordId: job.recordId, workspaceId: ws, ...sum, updatedBy: by })
      .onConflictDoUpdate({
        target: money.recordId,
        set: { ...sum, updatedBy: by, updatedAt: dsql`now()` },
      });
    // The amounts stay off the event and the timeline: only people with job-cost access see them.
    const eventId = await ctx.emit({
      type: 'contractor.job.money_set',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        jobId: job.recordId,
        changed: Object.keys(sum),
        estimateId: input.estimateId,
        estimates: approved.length,
      },
    });
    await jobLine(
      ctx,
      job.recordId,
      'set the job’s price and budget from the estimate the customer approved',
      { eventId },
    );
    const added = await addEstimateMaterials(
      ctx,
      job,
      picked.id,
      await materialLinesOf(ctx, picked.id, picked.option),
    );
    return { jobId: job.recordId, estimates: approved.length, materials: added };
  },
});

// ------------------------------------------------------------------------------------------------ how it estimates

export const estimatingSave = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimating.save',
  description:
    'Set how the business estimates: its lowest margin (an estimate under it waits for an owner’s or admin’s OK), the markup a new line starts with, and what an hour of labor sells for and costs. Only what’s given changes. For owners and admins.',
  risk: 2,
  input: EstimatingSaveInput,
  output: EstimatingSaveOutput,
  permission: 'contractor.approve',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_estimating',
    description:
      'Set the business’s estimating rules: minMarginBp (the lowest margin, in basis points: 2000 is 20%), markupBp (a new line’s starting markup), laborRateCents and laborCostCents (an hour of labor’s price and cost). Only what’s given changes. Asks the person first.',
    autonomy: 'confirm',
    what: 'Change how estimates are priced and checked',
    outcome: () => ({ words: W.estimating.saved, path: 'a/contractor/settings' }),
  },
  emits: ['contractor.estimating.saved'],
  async handler(ctx, input) {
    const now = await estimatingOf(ctx);
    const next: Estimating = {
      minMarginBp: input.minMarginBp ?? now.minMarginBp,
      markupBp: input.markupBp ?? now.markupBp,
      laborRateCents: input.laborRateCents ?? now.laborRateCents,
      laborCostCents: input.laborCostCents ?? now.laborCostCents,
    };
    const changed = (Object.keys(now) as (keyof Estimating)[]).filter((k) => now[k] !== next[k]);
    if (!changed.length) return now;
    const by = userIdOf(ctx.actor);
    await ctx.tx
      .insert(estimating)
      .values({ workspaceId: ctx.scope.workspaceId!, ...next, updatedBy: by })
      .onConflictDoUpdate({
        target: estimating.workspaceId,
        set: { ...next, updatedBy: by, updatedAt: dsql`now()` },
      });
    await ctx.emit({
      type: 'contractor.estimating.saved',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      // The lowest margin is a rule, not a cost: history shows how it moved. Labor's cost stays off.
      payload: { changed },
      ...(changed.includes('minMarginBp')
        ? {
            before: { lowestMargin: `${now.minMarginBp / 100}%` },
            after: { lowestMargin: `${next.minMarginBp / 100}%` },
          }
        : {}),
    });
    return next;
  },
});

// ------------------------------------------------------------------------------------------------ item costs

export const itemCostSet = defineAddonCommand(contractorAddon, {
  name: 'contractor.item_cost.set',
  description:
    'Set what one of a price list item costs the business, and how it’s costed (labor by the hour, a material, or other); null takes the cost off. The builder fills a line’s cost from it. For people who may see job costs.',
  risk: 1,
  input: ItemCostSetInput,
  output: ItemCostSetOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_item_cost',
    description:
      'Set what one of a price list item costs the business (productId, costCents; null takes it off) and its kind (labor, material or other). Asks the person first.',
    autonomy: 'confirm',
    what: 'Set what a price list item costs',
    outcome: () => ({ words: 'The cost is saved.', path: 'a/contractor/costs' }),
  },
  emits: ['contractor.item_cost.set'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [p] = await rows<{ id: string; kind: string }>(
      ctx.tx,
      sql`select id, kind::text as kind from app.products
          where id = ${input.productId} and workspace_id = ${ws} and archived_at is null`,
    );
    if (!p) throw HfosError.notFound(REFUSALS.productGone);
    const [before] = await ctx.tx
      .select({ kind: itemCosts.kind, costCents: itemCosts.costCents })
      .from(itemCosts)
      .where(and(eq(itemCosts.productId, p.id), eq(itemCosts.workspaceId, ws)));
    const by = userIdOf(ctx.actor);
    if (input.costCents === null) {
      if (!before) return { productId: p.id, changed: false };
      await ctx.tx.delete(itemCosts).where(eq(itemCosts.productId, p.id));
    } else {
      const kind = input.kind ?? before?.kind ?? defaultCostKind(p.kind);
      if (before && before.kind === kind && Number(before.costCents) === input.costCents)
        return { productId: p.id, changed: false };
      await ctx.tx
        .insert(itemCosts)
        .values({
          productId: p.id,
          workspaceId: ws,
          kind,
          costCents: input.costCents,
          updatedBy: by,
        })
        .onConflictDoUpdate({
          target: itemCosts.productId,
          set: { kind, costCents: input.costCents, updatedBy: by, updatedAt: dsql`now()` },
        });
    }
    await ctx.emit({
      type: 'contractor.item_cost.set',
      entityType: 'product',
      entityId: p.id,
      payload: { productId: p.id, cleared: input.costCents === null },
    });
    return { productId: p.id, changed: true };
  },
});

// ------------------------------------------------------------------------------------------------ what its pages read

export const estimateBuilder = defineAddonQuery(contractorAddon, {
  name: 'contractor.estimate.get',
  description:
    'One estimate as its builder needs it: the estimate itself, what each line costs, each option’s profit and margin, whether it’s waiting for an owner’s or admin’s OK, the job it’s for, and how the business estimates. With no estimate named, what a new one for a job starts from. For people who may see job costs.',
  input: EstimateBuilderInput,
  output: EstimateBuilderOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_get_estimate',
    description:
      'One estimate built in Contractor Operations (estimateId): its lines and options, what each line costs, each option’s cost, profit and margin, whether it needs or has an owner’s or admin’s OK, and its job. Or, with jobId alone, the customer a new estimate for that job would go to.',
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const may = { approve: mayApprove(ctx), bill: scopeCan(ctx.scope, 'money.bill') };
    const jobOf = async (jobId: string | null) => {
      if (!jobId) return null;
      const [j] = await rows<{ id: string; name: string }>(
        ctx.tx,
        sql`select r.id, r.name from addon_contractor.jobs j join app.custom_records r on r.id = j.record_id
            where j.record_id = ${jobId} and j.workspace_id = ${ws}`,
      );
      return j ?? null;
    };
    if (!input.estimateId) {
      const job = await jobOf(input.jobId ?? null);
      if (input.jobId && !job) throw HfosError.notFound(REFUSALS.jobGone);
      const customer = job ? (await pairsOf(ctx, job.id)).customer : null;
      const [person] = customer
        ? await rows<{ id: string; full_name: string; email: string | null; phone: string | null }>(
            ctx.tx,
            sql`select id,
                  coalesce(nullif(btrim(concat_ws(' ', first_name, last_name)), ''), email::text, phone_e164, 'Customer')
                    as full_name,
                  email::text as email, phone
                from app.people where id = ${customer.personId} and workspace_id = ${ws} and archived_at is null`,
          )
        : [];
      return {
        estimate: null,
        costs: [],
        job,
        person: person
          ? { id: person.id, fullName: person.full_name, email: person.email, phone: person.phone }
          : null,
        check: null,
        estimating: await estimatingOf(ctx),
        may,
      };
    }
    const b = await loadBuilt(ctx, input.estimateId);
    const { estimate } = await executeQueryWithin(ctx, coreEstimateGet, {
      workspaceId: ws,
      estimateId: b.estimateId,
    });
    return {
      estimate,
      costs: await costRowsOf(ctx, b.estimateId),
      job: await jobOf(b.jobId),
      person: estimate.person,
      check: await checkOf(ctx, b),
      estimating: await estimatingOf(ctx),
      may,
    };
  },
});

export const estimateList = defineAddonQuery(contractorAddon, {
  name: 'contractor.estimate.list',
  description:
    'The estimates built in Contractor Operations, newest first: all of them, one job’s, or only the drafts waiting for an owner’s or admin’s OK. Each with its status, customer, total, options, job and whether an OK was asked for or given. No costs.',
  input: EstimateListInput,
  output: EstimateListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_estimates',
    description:
      'List the estimates built in Contractor Operations (jobId for one job’s; waitingOk for the drafts waiting on an owner’s or admin’s OK), each with its number, status, customer, total, how many options it offers, the option picked, its job, and whether an OK was asked for or stands.',
    keywords: ['estimates', 'quotes', 'waiting for ok', 'margin approval'],
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // Core's own read rules decide which estimates the person asking sees at all.
    const list = await rows<{
      id: string;
      number: string | null;
      status: string;
      title: string | null;
      customer: string;
      total_cents: number;
      option_count: number;
      option_name: string | null;
      job_id: string | null;
      job_name: string | null;
      asked_at: string | null;
      asked_by: string | null;
      ok_stands: boolean;
      created_at: string;
    }>(
      ctx.tx,
      sql`select e.id, e.number, e.status::text as status, e.title,
            coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email::text, 'Customer') as customer,
            e.total_cents::float8 as total_cents, coalesce(jsonb_array_length(e.options), 0) as option_count,
            case when e.status = 'accepted' then e.options -> (e.option_position - 1) ->> 'name' end as option_name,
            x.record_id as job_id, r.name as job_name, x.asked_at::text as asked_at,
            coalesce(nullif(btrim(u.full_name), ''), u.email::text) as asked_by,
            coalesce(o.revision = round(extract(epoch from e.updated_at) * 1000), false) as ok_stands,
            e.created_at::text as created_at
          from addon_contractor.estimates x
          join app.estimates e on e.id = x.estimate_id
          left join app.people p on p.id = e.person_id
          left join app.custom_records r on r.id = x.record_id
          left join app.users u on u.id = x.asked_by
          left join addon_contractor.estimate_oks o on o.estimate_id = x.estimate_id
          where x.workspace_id = ${ws}
            and (${input.jobId ?? null}::uuid is null or x.record_id = ${input.jobId ?? null}::uuid)
            and (not ${input.waitingOk}::boolean or (e.status = 'draft' and x.asked_at is not null))
          order by e.created_at desc, e.id
          limit 200`,
    );
    return {
      estimates: list.map((e) => ({
        id: e.id,
        number: e.number,
        status: e.status,
        title: e.title,
        customer: e.customer,
        totalCents: Number(e.total_cents),
        optionCount: e.option_count,
        optionName: e.option_name,
        job: e.job_id ? { id: e.job_id, name: e.job_name ?? 'Job' } : null,
        asked: e.asked_at ? { by: e.asked_by, at: new Date(e.asked_at).toISOString() } : null,
        okStands: e.ok_stands,
        createdAt: new Date(e.created_at).toISOString(),
      })),
    };
  },
});

export const itemCostList = defineAddonQuery(contractorAddon, {
  name: 'contractor.item_cost.list',
  description:
    'The business’s price list with what each item costs it: its price, its cost, how it’s costed (labor, material, other) and the margin between them. For people who may see job costs.',
  input: InWorkspace,
  output: ItemCostListOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_item_costs',
    description:
      'The price list with each item’s cost to the business: its productId, name, price, cost (null when nobody has said), kind (labor, material, other) and margin.',
    keywords: ['item costs', 'price list costs', 'what does it cost us'],
  },
  async handler(ctx) {
    const list = await rows<{
      id: string;
      name: string;
      description: string | null;
      kind: 'product' | 'service' | 'fee';
      unit_label: string;
      unit_price_cents: number;
      taxable: boolean;
      cost_kind: CostKind | null;
      cost_cents: number | null;
    }>(
      ctx.tx,
      sql`select p.id, p.name, p.description, p.kind::text as kind, p.unit_label,
            p.unit_price_cents::float8 as unit_price_cents, p.taxable, c.kind as cost_kind,
            c.cost_cents::float8 as cost_cents
          from app.products p
          left join addon_contractor.item_costs c on c.product_id = p.id
          where p.workspace_id = ${ctx.scope.workspaceId!} and p.archived_at is null
          order by lower(p.name), p.id
          limit 1000`,
    );
    return {
      items: list.map((p) => {
        const cost = p.cost_cents === null ? null : Number(p.cost_cents);
        const price = Number(p.unit_price_cents);
        return {
          productId: p.id,
          name: p.name,
          description: p.description,
          productKind: p.kind,
          unitLabel: p.unit_label,
          unitPriceCents: price,
          taxable: p.taxable,
          kind: p.cost_kind ?? defaultCostKind(p.kind),
          costCents: cost,
          marginBp: cost === null ? null : marginBpOf(price, cost),
        };
      }),
    };
  },
});
