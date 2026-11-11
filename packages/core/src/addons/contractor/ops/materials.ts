/**
 * A job's materials (docs/contractor.md, "Materials"; the owner's decision 9): what the job needs and how much of
 * each is ordered, delivered, used, wasted and returned. One list per job; a material can be for one visit or for
 * any. What's missing, where a material stands and what the job has taken are worked out in ../materials.ts.
 *
 * **What one costs** is kept apart (`material_costs`), where row security lets only people who may see job costs
 * read or set it (the owner's decision 11). Someone who may fills it in from the price list item's cost as they
 * add a material; for everyone else the worker does it a moment later (`contractor.material.stamp_cost`). Costs
 * are on no event and no timeline line.
 *
 * Changing a material records what happened; it orders nothing. A job's materials change only while the job is
 * open, like its work orders.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { contractorAddon } from '../manifest';
import {
  amountWords,
  costMaterials,
  isMissing,
  leftOf,
  MATERIAL_COUNTS,
  materialState,
  materialWords,
  shortOf,
  type MaterialCounts,
} from '../materials';
import { isOpen } from '../progress';
import {
  LIMITS,
  MaterialAddInput,
  MaterialAddOutput,
  MaterialChangeOutput,
  MaterialCountInput,
  MaterialCountOutput,
  MaterialListInput,
  MaterialListOutput,
  MaterialRefInput,
  MaterialSetCostInput,
  MaterialSetCostOutput,
  MaterialStampCostInput,
  MaterialStampCostOutput,
  MaterialUpdateInput,
  type MaterialRow,
} from '../schemas';
import { materialCosts, materials } from '../tables';
import {
  CONTRACTOR_WORDS as W,
  JOB_STATUS_WORDS,
  materialChangeWords,
  materialsCountWords,
  REFUSALS,
} from '../words';
import { inWorkspace, jobLine, loadJob, madeWhileOpen, type Ctx, type Job } from './common';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
const pathOf = (io: unknown) => {
  const jobId = (io as { jobId?: unknown } | null)?.jobId;
  return typeof jobId === 'string' ? jobPath(jobId) : 'a/contractor';
};
const mayCost = (ctx: Ctx) => scopeCan(ctx.scope, 'contractor.costs' as Permission);

// ------------------------------------------------------------------------------------------------ reading

type MaterialSqlRow = {
  readonly id: string;
  readonly position: number;
  readonly name: string;
  readonly unit_label: string;
  readonly product_id: string | null;
  readonly appointment_id: string | null;
  readonly needed: number;
  readonly ordered: number;
  readonly delivered: number;
  readonly used: number;
  readonly wasted: number;
  readonly returned: number;
  readonly supplier: string | null;
  readonly expected_on: string | null;
  readonly note: string | null;
  readonly from_estimate: boolean;
  readonly updated_at: string;
};

function rowOut(m: MaterialSqlRow): MaterialRow {
  const counts: MaterialCounts = {
    needed: Number(m.needed),
    ordered: Number(m.ordered),
    delivered: Number(m.delivered),
    used: Number(m.used),
    wasted: Number(m.wasted),
    returned: Number(m.returned),
  };
  return {
    id: m.id,
    position: m.position,
    name: m.name,
    unitLabel: m.unit_label,
    productId: m.product_id,
    appointmentId: m.appointment_id,
    ...counts,
    short: shortOf(counts),
    left: leftOf(counts),
    state: materialState(counts),
    supplier: m.supplier,
    expectedOn: m.expected_on,
    note: m.note,
    fromEstimate: m.from_estimate,
    updatedAt: new Date(m.updated_at).toISOString(),
  };
}

/**
 * A job's materials, in order: all of them, or only what's needed on one visit (the ones for it, and the ones for
 * any visit). Never with what they cost.
 */
export async function materialsOf(
  ctx: Ctx,
  jobId: string,
  appointmentId?: string,
): Promise<MaterialRow[]> {
  const onVisit = appointmentId
    ? sql` and (m.appointment_id is null or m.appointment_id = ${appointmentId})`
    : sql``;
  const list = await rows<MaterialSqlRow>(
    ctx.tx,
    sql`select m.id, m.position, m.name, m.unit_label, m.product_id, m.appointment_id,
          m.needed::float8 as needed, m.ordered::float8 as ordered, m.delivered::float8 as delivered,
          m.used::float8 as used, m.wasted::float8 as wasted, m.returned::float8 as returned,
          m.supplier, m.expected_on::text as expected_on, m.note, (m.estimate_id is not null) as from_estimate,
          m.updated_at::text as updated_at
        from addon_contractor.materials m
        where m.record_id = ${jobId} and m.workspace_id = ${ctx.scope.workspaceId!}${onVisit}
        order by m.position, m.created_at, m.id`,
  );
  return list.map(rowOut);
}

export const materialList = defineAddonQuery(contractorAddon, {
  name: 'contractor.material.list',
  description:
    'A job’s materials: what it needs and how much of each is ordered, delivered, used, wasted and returned, what’s still short, and (for people who may see job costs) what they cost.',
  input: MaterialListInput,
  output: MaterialListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_materials',
    description:
      'A job’s materials (by job id; appointmentId keeps to what one visit needs): each with its material id, name, unit, the visit it’s for (null: any visit), how much is needed, ordered, delivered, used, wasted and returned, how much is still short and left over, where it stands (to_order, ordered, here, used), its supplier and the day it’s expected; how many aren’t all here yet; and, when the person may see job costs, what one of each costs and the totals.',
    keywords: ['materials', 'parts', 'supplies', 'what’s missing', 'to order'],
  },
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const list = await materialsOf(ctx, job.recordId, input.appointmentId);
    // Row security keeps these from anyone without `contractor.costs`: they aren't even asked for.
    const costs = mayCost(ctx)
      ? new Map(
          (
            await rows<{ material_id: string; unit_cost_cents: number }>(
              ctx.tx,
              sql`select material_id, unit_cost_cents::float8 as unit_cost_cents
                  from addon_contractor.material_costs
                  where record_id = ${job.recordId} and workspace_id = ${ctx.scope.workspaceId!}`,
            )
          ).map((c) => [c.material_id, Number(c.unit_cost_cents)]),
        )
      : null;
    const out = list.map((m) => ({ ...m, unitCostCents: costs?.get(m.id) ?? null }));
    return {
      jobId: job.recordId,
      materials: out,
      missing: out.filter(isMissing).length,
      canChange: isOpen(job.status),
      costing: costs ? costMaterials(out) : null,
    };
  },
});

// ------------------------------------------------------------------------------------------------ what's shared

/**
 * A job whose materials may change: here, not archived, and open (a closed job is read-only until it's moved back).
 * `late` lets through what someone counted on their phone while the job was still open, which reached HandsFreeOS
 * after it closed.
 */
async function jobForChange(
  ctx: CommandContext,
  jobId: string,
  opts: { readonly late?: boolean } = {},
): Promise<Job> {
  const job = await loadJob(ctx, jobId, { lock: true });
  if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
  if (!isOpen(job.status) && !(opts.late && (await madeWhileOpen(ctx, job))))
    throw HfosError.rule(
      'contractor_job_closed',
      409,
      REFUSALS.closedJob(job.name, JOB_STATUS_WORDS[job.status]),
    );
  return job;
}

/** A material for a change, with its job locked: refused when it's gone or its job is closed. */
async function materialForChange(
  ctx: CommandContext,
  materialId: string,
  opts: { readonly late?: boolean } = {},
) {
  const [found] = await ctx.tx
    .select({ recordId: materials.recordId })
    .from(materials)
    .where(and(eq(materials.id, materialId), eq(materials.workspaceId, ctx.scope.workspaceId!)));
  if (!found) throw HfosError.notFound(REFUSALS.materialGone);
  const job = await jobForChange(ctx, found.recordId, opts);
  // Read again under the job's lock: someone may have changed or removed it meanwhile.
  const [material] = await ctx.tx.select().from(materials).where(eq(materials.id, materialId));
  if (!material) throw HfosError.notFound(REFUSALS.materialGone);
  return { job, material };
}

/** Refuses a visit that isn't one of the job's own. */
async function requireVisitOnJob(ctx: Ctx, job: Job, appointmentId: string): Promise<void> {
  const [a] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.appointments
        where id = ${appointmentId} and workspace_id = ${ctx.scope.workspaceId!}
          and custom_record_id = ${job.recordId}`,
  );
  if (!a)
    throw HfosError.rule(
      'contractor_material_visit_elsewhere',
      409,
      REFUSALS.materialVisitElsewhere(job.name),
    );
}

/** How many materials the job has, and the place the next one takes. */
async function roomOn(ctx: Ctx, jobId: string): Promise<{ count: number; next: number }> {
  const [r] = await rows<{ n: number; next: number }>(
    ctx.tx,
    sql`select count(*)::int as n, coalesce(max(position) + 1, 0)::int as next
        from addon_contractor.materials where record_id = ${jobId}`,
  );
  return { count: r?.n ?? 0, next: Math.min(r?.next ?? 0, 9999) };
}

const countsOf = (m: MaterialCounts): MaterialCounts => ({
  needed: m.needed,
  ordered: m.ordered,
  delivered: m.delivered,
  used: m.used,
  wasted: m.wasted,
  returned: m.returned,
});

// ------------------------------------------------------------------------------------------------ changing

export const materialAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.material.add',
  description:
    'Add a material to a job: what it is, how much the job needs, and optionally the visit it’s for, how much is ordered or delivered already, its supplier and the day it’s expected. Picked from the price list, it takes the item’s name, unit and cost.',
  risk: 1,
  input: MaterialAddInput,
  output: MaterialAddOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_material',
    description:
      'Add a material to a job’s list (by job id): its name (or productId for a price list item, which gives the name, unit and cost), unitLabel (each, ft, box), needed, and optionally appointmentId (the visit it’s for; left out means any visit), ordered, delivered, supplier, expectedOn and a note. It records what the job needs; it orders nothing. unitCostCents only when the person may see job costs.',
    outcome: (output, input) => ({
      words: W.materials.added((output as { name?: string } | null)?.name ?? 'It'),
      path: pathOf(input),
    }),
  },
  emits: ['contractor.material.added'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const costs = mayCost(ctx);
    if (input.unitCostCents !== undefined && !costs)
      throw HfosError.rule(
        'contractor_material_cost_not_allowed',
        403,
        REFUSALS.materialCostNotAllowed,
      );
    const job = await jobForChange(ctx, input.jobId);
    let product: { id: string; name: string; unit_label: string | null } | null = null;
    if (input.productId) {
      // The price list is read by people who see the business's money (core's rule, held by row security).
      if (!scopeCan(ctx.scope, 'money.read'))
        throw HfosError.rule(
          'contractor_material_no_price_list',
          403,
          REFUSALS.materialNoPriceList,
        );
      const [p] = await rows<{ id: string; name: string; unit_label: string | null }>(
        ctx.tx,
        sql`select id, name, unit_label from app.products
            where id = ${input.productId} and workspace_id = ${ws} and archived_at is null`,
      );
      if (!p) throw HfosError.notFound(REFUSALS.productGone);
      product = p;
    }
    const name = (input.name ?? product?.name ?? '').trim().slice(0, LIMITS.materialName);
    if (!name)
      throw HfosError.rule('contractor_material_name_needed', 400, REFUSALS.materialNameNeeded);
    const unitLabel =
      (input.unitLabel ?? product?.unit_label ?? '').trim().slice(0, LIMITS.unitLabel) || 'each';
    if (input.appointmentId) await requireVisitOnJob(ctx, job, input.appointmentId);
    const room = await roomOn(ctx, job.recordId);
    if (room.count >= LIMITS.materials)
      throw HfosError.rule(
        'contractor_too_many_materials',
        409,
        REFUSALS.tooManyMaterials(LIMITS.materials),
      );
    const by = userIdOf(ctx.actor);
    const [made] = await ctx.tx
      .insert(materials)
      .values({
        workspaceId: ws,
        recordId: job.recordId,
        position: room.next,
        name,
        unitLabel,
        productId: product?.id ?? null,
        appointmentId: input.appointmentId ?? null,
        needed: input.needed,
        ordered: input.ordered,
        delivered: input.delivered,
        supplier: input.supplier || null,
        expectedOn: input.expectedOn ?? null,
        note: input.note || null,
        createdBy: by,
        updatedBy: by,
      })
      .returning({ id: materials.id });
    const materialId = made!.id;
    // Its cost: what the person gave, else the price list item's. Only someone who may see costs reads either.
    let unitCostCents = input.unitCostCents ?? null;
    if (unitCostCents === null && costs && product) {
      const [c] = await rows<{ cost_cents: number }>(
        ctx.tx,
        sql`select cost_cents::float8 as cost_cents from addon_contractor.item_costs
            where product_id = ${product.id} and workspace_id = ${ws}`,
      );
      unitCostCents = c ? Number(c.cost_cents) : null;
    }
    if (unitCostCents !== null)
      await ctx.tx.insert(materialCosts).values({
        materialId,
        workspaceId: ws,
        recordId: job.recordId,
        unitCostCents,
        updatedBy: by,
      });
    const eventId = await ctx.emit({
      type: 'contractor.material.added',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        materialId,
        jobId: job.recordId,
        appointmentId: input.appointmentId ?? null,
        productId: product?.id ?? null,
        // The worker fills in the price list item's cost for someone who can't see costs.
        needsCost: !costs && !!product,
      },
      after: { material: name, needed: amountWords(input.needed, unitLabel) },
    });
    await jobLine(
      ctx,
      job.recordId,
      `added ${materialWords(input.needed, unitLabel, name)} to the materials`,
      { eventId },
    );
    return { materialId, jobId: job.recordId, name };
  },
});

export const materialUpdate = defineAddonCommand(contractorAddon, {
  name: 'contractor.material.update',
  description:
    'Change a material on a job: how much is needed, ordered, delivered, used, wasted or returned, its name and unit, the visit it’s for, its supplier, the day it’s expected and its note. It records what happened; it orders nothing.',
  risk: 1,
  input: MaterialUpdateInput,
  output: MaterialChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_update_material',
    description:
      'Change a material on a job (by material id, from contractor_list_materials): needed, ordered, delivered, used, wasted and returned are each the total so far, not an amount to add. Also its name, unitLabel, appointmentId (null: any visit), supplier, expectedOn and note (null clears). Each left out stays as it is. It records what happened; it orders nothing.',
    outcome: (output) => ({ words: W.materials.saved, path: pathOf(output) }),
  },
  emits: ['contractor.material.updated'],
  async handler(ctx, input) {
    const { job, material: m } = await materialForChange(ctx, input.materialId);
    if (input.appointmentId) await requireVisitOnJob(ctx, job, input.appointmentId);
    const orNow = <T>(given: T | undefined, now: T): T => (given === undefined ? now : given);
    const next = {
      name: orNow(input.name, m.name),
      unitLabel: orNow(input.unitLabel, m.unitLabel),
      appointmentId: orNow(input.appointmentId, m.appointmentId),
      needed: orNow(input.needed, m.needed),
      ordered: orNow(input.ordered, m.ordered),
      delivered: orNow(input.delivered, m.delivered),
      used: orNow(input.used, m.used),
      wasted: orNow(input.wasted, m.wasted),
      returned: orNow(input.returned, m.returned),
      supplier: input.supplier === undefined ? m.supplier : input.supplier || null,
      expectedOn: orNow(input.expectedOn, m.expectedOn),
      note: input.note === undefined ? m.note : input.note || null,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== m[k]);
    const state = materialState(next);
    if (!changed.length) return { materialId: m.id, jobId: job.recordId, changed: false, state };
    await ctx.tx
      .update(materials)
      .set({ ...next, updatedBy: userIdOf(ctx.actor), updatedAt: new Date() })
      .where(eq(materials.id, m.id));
    const words = materialChangeWords(next.name, next.unitLabel, countsOf(m), countsOf(next));
    const moved = MATERIAL_COUNTS.filter((k) => next[k] !== m[k]);
    const eventId = await ctx.emit({
      type: 'contractor.material.updated',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        materialId: m.id,
        jobId: job.recordId,
        changed,
        appointmentId: next.appointmentId,
        // The visit it was for before, so what that visit is missing is looked at again too.
        wasAppointmentId: m.appointmentId,
      },
      before: {
        material: m.name,
        ...Object.fromEntries(moved.map((k) => [k, amountWords(m[k], m.unitLabel)])),
      },
      after: {
        material: next.name,
        ...Object.fromEntries(moved.map((k) => [k, amountWords(next[k], next.unitLabel)])),
      },
    });
    if (words) await jobLine(ctx, job.recordId, `updated the materials: ${words}`, { eventId });
    return { materialId: m.id, jobId: job.recordId, changed: true, state };
  },
});

/** A count after some more: never under nothing or over the most a count holds, to three decimal places. */
const countAfter = (now: number, more: number | undefined): number =>
  Math.min(LIMITS.quantity, Math.max(0, Math.round((now + (more ?? 0)) * 1000) / 1000));

export const materialCount = defineAddonCommand(contractorAddon, {
  name: 'contractor.material.count',
  description:
    'Count a material on the job: how much more of it was used, wasted or sent back since the last count. Each adds to what’s counted so far, so two people counting both add up.',
  risk: 1,
  input: MaterialCountInput,
  output: MaterialCountOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  // Counted on the job with no signal: it's kept on the phone and sent when there is some.
  offline: 'anytime',
  ai: {
    tool: 'contractor_count_material',
    description:
      'Add to how much of a material (by material id, from contractor_list_materials) was used, wasted or returned: each is how much more since the last count, not the total, and below 0 takes some back. For a total, or for needed, ordered and delivered, use contractor_update_material. It records what happened; it orders nothing.',
    keywords: ['used', 'wasted', 'returned', 'materials used'],
    outcome: (output) => ({ words: W.materials.saved, path: pathOf(output) }),
  },
  emits: ['contractor.material.updated'],
  async handler(ctx, input) {
    const { job, material: m } = await materialForChange(ctx, input.materialId, { late: true });
    const next = {
      used: countAfter(m.used, input.used),
      wasted: countAfter(m.wasted, input.wasted),
      returned: countAfter(m.returned, input.returned),
    };
    const after = { ...countsOf(m), ...next };
    const state = materialState(after);
    const moved = (['used', 'wasted', 'returned'] as const).filter((k) => next[k] !== m[k]);
    const out = (changed: boolean) => ({
      materialId: m.id,
      jobId: job.recordId,
      changed,
      state,
      ...next,
    });
    if (!moved.length) return out(false);
    await ctx.tx
      .update(materials)
      .set({ ...next, updatedBy: userIdOf(ctx.actor), updatedAt: new Date() })
      .where(eq(materials.id, m.id));
    const eventId = await ctx.emit({
      type: 'contractor.material.updated',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        materialId: m.id,
        jobId: job.recordId,
        changed: moved,
        appointmentId: m.appointmentId,
        wasAppointmentId: m.appointmentId,
      },
      before: {
        material: m.name,
        ...Object.fromEntries(moved.map((k) => [k, amountWords(m[k], m.unitLabel)])),
      },
      after: {
        material: m.name,
        ...Object.fromEntries(moved.map((k) => [k, amountWords(next[k], m.unitLabel)])),
      },
    });
    const words = materialChangeWords(m.name, m.unitLabel, countsOf(m), after);
    if (words) await jobLine(ctx, job.recordId, `updated the materials: ${words}`, { eventId });
    return out(true);
  },
});

export const materialRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.material.remove',
  description:
    'Take a material off a job’s list, with everything counted for it and its cost. The rest of the job stays.',
  risk: 2,
  input: MaterialRefInput,
  output: MaterialChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_material',
    description:
      'Take a material off a job’s list (by material id). What was counted for it (ordered, delivered, used) and its cost go with it and can’t be brought back. Asks the person first.',
    autonomy: 'confirm',
    what: 'Take a material off the job',
    outcome: (output) => ({ words: 'It’s off the job’s materials.', path: pathOf(output) }),
  },
  emits: ['contractor.material.removed'],
  async handler(ctx, input) {
    const { job, material: m } = await materialForChange(ctx, input.materialId);
    // Its cost goes with it (the table's own cascade).
    await ctx.tx.delete(materials).where(eq(materials.id, m.id));
    const eventId = await ctx.emit({
      type: 'contractor.material.removed',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { materialId: m.id, jobId: job.recordId, appointmentId: m.appointmentId },
      before: { material: m.name, needed: amountWords(m.needed, m.unitLabel) },
    });
    await jobLine(ctx, job.recordId, `took ${m.name} off the materials`, { eventId });
    return { materialId: m.id, jobId: job.recordId, changed: true, state: null };
  },
});

export const materialSetCost = defineAddonCommand(contractorAddon, {
  name: 'contractor.material.set_cost',
  description:
    'Set what one of a job’s material costs the business; null takes the cost off. For people who may see job costs.',
  risk: 1,
  input: MaterialSetCostInput,
  output: MaterialSetCostOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_material_cost',
    description:
      'Set what one unit of a material on a job costs the business (by material id; unitCostCents, null takes it off). The job’s cost of materials follows from it. Asks the person first.',
    autonomy: 'confirm',
    what: 'Set what a material costs',
    outcome: (output) => ({ words: W.materials.costSaved, path: pathOf(output) }),
  },
  emits: ['contractor.material.cost_set'],
  async handler(ctx, input) {
    const { job, material: m } = await materialForChange(ctx, input.materialId);
    const [now] = await ctx.tx
      .select({ unitCostCents: materialCosts.unitCostCents })
      .from(materialCosts)
      .where(eq(materialCosts.materialId, m.id));
    const before = now ? Number(now.unitCostCents) : null;
    if (before === input.unitCostCents)
      return { materialId: m.id, jobId: job.recordId, changed: false };
    const by = userIdOf(ctx.actor);
    if (input.unitCostCents === null)
      await ctx.tx.delete(materialCosts).where(eq(materialCosts.materialId, m.id));
    else
      await ctx.tx
        .insert(materialCosts)
        .values({
          materialId: m.id,
          workspaceId: ctx.scope.workspaceId!,
          recordId: job.recordId,
          unitCostCents: input.unitCostCents,
          updatedBy: by,
        })
        .onConflictDoUpdate({
          target: materialCosts.materialId,
          set: { unitCostCents: input.unitCostCents, updatedBy: by, updatedAt: dsql`now()` },
        });
    // The amount stays off the event: only people with job-cost access see it.
    await ctx.emit({
      type: 'contractor.material.cost_set',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { materialId: m.id, jobId: job.recordId, cleared: input.unitCostCents === null },
    });
    return { materialId: m.id, jobId: job.recordId, changed: true };
  },
});

/**
 * The worker: a material picked from the price list by someone who can't see costs gets the item's cost, so the
 * job's costing is whole whoever added it. Does nothing when it has a cost already, or the item has none.
 */
export const materialStampCost = defineAddonCommand(contractorAddon, {
  name: 'contractor.material.stamp_cost',
  description: 'Worker: a material added from the price list gets the item’s cost.',
  risk: 0,
  input: MaterialStampCostInput,
  output: MaterialStampCostOutput,
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.material.cost_set'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [m] = await rows<{ id: string; record_id: string; cost_cents: number | null }>(
      ctx.tx,
      sql`select m.id, m.record_id, c.cost_cents::float8 as cost_cents
          from addon_contractor.materials m
          left join addon_contractor.item_costs c on c.product_id = m.product_id and c.workspace_id = m.workspace_id
          where m.id = ${input.materialId} and m.workspace_id = ${ws}`,
    );
    if (!m) return null;
    if (m.cost_cents === null) return { materialId: m.id, stamped: false };
    const made = await ctx.tx
      .insert(materialCosts)
      .values({
        materialId: m.id,
        workspaceId: ws,
        recordId: m.record_id,
        unitCostCents: Number(m.cost_cents),
        updatedBy: userIdOf(ctx.actor),
      })
      .onConflictDoNothing()
      .returning({ materialId: materialCosts.materialId });
    if (!made.length) return { materialId: m.id, stamped: false };
    await ctx.emit({
      type: 'contractor.material.cost_set',
      entityType: 'custom_record',
      entityId: m.record_id,
      payload: { materialId: m.id, jobId: m.record_id, cleared: false, from: 'price_list' },
    });
    return { materialId: m.id, stamped: true };
  },
});

// ------------------------------------------------------------------------------------------------ from an estimate

/** A material line of an approved estimate, with what one costs when the builder was told. */
export interface EstimateMaterialLine {
  /** Its place in the estimate, from 0. */
  readonly line: number;
  readonly name: string;
  readonly quantity: number;
  readonly unitLabel: string | null;
  readonly productId: string | null;
  readonly unitCostCents: number | null;
}

/**
 * An approved estimate's material lines go onto its job's materials, once each (the list remembers the estimate and
 * the line), as far as the job has room. Run by the worker with the estimate's fill, so it writes each one's cost
 * too. Says how many were added now.
 */
export async function addEstimateMaterials(
  ctx: CommandContext,
  job: Job,
  estimateId: string,
  lines: readonly EstimateMaterialLine[],
): Promise<number> {
  const wanted = lines.filter((l) => l.quantity > 0 && l.line >= 0 && l.line <= 199);
  if (!wanted.length) return 0;
  const ws = ctx.scope.workspaceId!;
  const room = await roomOn(ctx, job.recordId);
  const by = userIdOf(ctx.actor);
  const fits = wanted.slice(0, Math.max(0, LIMITS.materials - room.count));
  if (!fits.length) return 0;
  const made = await ctx.tx
    .insert(materials)
    .values(
      fits.map((l, i) => ({
        workspaceId: ws,
        recordId: job.recordId,
        position: Math.min(room.next + i, 9999),
        name: l.name.trim().slice(0, LIMITS.materialName) || 'Material',
        unitLabel: (l.unitLabel ?? '').trim().slice(0, LIMITS.unitLabel) || 'each',
        productId: l.productId,
        needed: Math.min(Math.round(l.quantity * 1000) / 1000, LIMITS.quantity),
        estimateId,
        estimateLine: l.line,
        createdBy: by,
        updatedBy: by,
      })),
    )
    // Already there from an earlier run: left as people have changed it since.
    .onConflictDoNothing()
    .returning({ id: materials.id, estimateLine: materials.estimateLine });
  const costs = made.flatMap((m) => {
    const cost = fits.find((l) => l.line === m.estimateLine)?.unitCostCents ?? null;
    return cost === null
      ? []
      : [
          {
            materialId: m.id,
            workspaceId: ws,
            recordId: job.recordId,
            unitCostCents: Math.min(Math.round(cost), LIMITS.unitCostCents),
            updatedBy: by,
          },
        ];
  });
  if (costs.length) await ctx.tx.insert(materialCosts).values(costs).onConflictDoNothing();
  if (!made.length) return 0;
  const eventId = await ctx.emit({
    type: 'contractor.materials.filled',
    entityType: 'custom_record',
    entityId: job.recordId,
    payload: { jobId: job.recordId, estimateId, added: made.length },
  });
  await jobLine(
    ctx,
    job.recordId,
    `added ${materialsCountWords(made.length)} from the estimate the customer approved`,
    { eventId },
  );
  return made.length;
}
