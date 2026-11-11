/**
 * A job's life (docs/contractor.md, "Jobs"): starting one, changing what it is and who's on it, moving it along,
 * making a service call a project, its price and budget, and adding a property. Each change is a line on the job's
 * timeline in the add-on's words, and keeps its % done where ./progress.ts puts it.
 *
 * A job's customer and property are relationships on its record (`contractor_customer`, `contractor_site`), so core's
 * record pages show them; a new property's customer is its owner (`contractor_owner`).
 */
import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { customRecordCreate, customRecordUpdate } from '../../../commands/custom-record';
import { relationshipCreate, relationshipDelete } from '../../../commands/relationship';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand } from '../../server';
import { requiredItemsWords } from '../checklists';
import { contractorAddon } from '../manifest';
import { STATUSES_WITH_REASON, isOpen, type JobStatus } from '../progress';
import {
  JobChangeOutput,
  JobMakeProjectInput,
  JobMakeProjectOutput,
  JobOpenInput,
  JobOpenOutput,
  JobSetMoneyInput,
  JobSetPercentInput,
  JobSetPercentOutput,
  JobSetStatusInput,
  JobSetStatusOutput,
  JobTeamInput,
  JobUpdateInput,
  LIMITS,
  PropertyAddInput,
  PropertyAddOutput,
} from '../schemas';
import { jobs, money, phases, team, workOrderItems } from '../tables';
import { phasesForNewProject, TRADE_NAMES } from '../trades';
import { CONTRACTOR_WORDS as W, JOB_KIND_WORDS, JOB_STATUS_WORDS, REFUSALS } from '../words';
import { z } from 'zod';
import {
  customerName,
  inWorkspace,
  jobLine,
  keepPercent,
  kindIds,
  loadJob,
  pairsOf,
  phasesOf,
  propertyName,
  relationshipTypeId,
  requireCanWork,
  settingsOf,
  userName,
  type Job,
} from './common';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
const nameIn = (input: unknown) => String((input as { name?: unknown }).name ?? '');

/** Refuses a deadline before the start. */
function checkDates(startsOn: string | null | undefined, dueOn: string | null | undefined) {
  if (startsOn && dueOn && dueOn < startsOn)
    throw HfosError.rule('contractor_dates_backwards', 400, REFUSALS.datesBackwards);
}

/** Someone else in charge of a job needs an owner or admin (core's `records.assign`); yourself, anyone. */
async function checkLead(ctx: CommandContext, leadUserId: string | null) {
  if (!leadUserId) return;
  if (leadUserId !== userIdOf(ctx.actor) && !scopeCan(ctx.scope, 'records.assign'))
    throw HfosError.rule('contractor_lead_only', 403, REFUSALS.leadOnly);
  await requireCanWork(ctx, leadUserId);
}

/** Phases' names once each, in order (the first spelling of each kept). */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names.map((x) => x.trim()).filter(Boolean)) {
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Adds phases at the end of a job's list, skipping any it already has by name; says how many it added. */
export async function addPhases(
  ctx: CommandContext,
  job: Pick<Job, 'recordId'>,
  names: readonly string[],
): Promise<number> {
  const have = await phasesOf(ctx, job.recordId);
  const taken = new Set(have.map((p) => p.name.toLowerCase()));
  const fresh = uniqueNames(names).filter((n) => !taken.has(n.toLowerCase()));
  if (have.length + fresh.length > LIMITS.phases)
    throw HfosError.rule('contractor_too_many_phases', 409, REFUSALS.tooManyPhases(LIMITS.phases));
  if (!fresh.length) return 0;
  const start = have.reduce((m, p) => Math.max(m, p.position + 1), 0);
  await ctx.tx.insert(phases).values(
    fresh.map((name, i) => ({
      workspaceId: ctx.scope.workspaceId!,
      recordId: job.recordId,
      position: start + i,
      name,
      createdBy: userIdOf(ctx.actor),
    })),
  );
  return fresh.length;
}

/** Makes a property, owned by the customer when there is one. */
async function newProperty(
  ctx: CommandContext,
  address: string,
  ownerPersonId: string | null,
): Promise<string> {
  const kinds = await kindIds(ctx);
  const made = await executeCommandWithin(ctx, customRecordCreate, {
    workspaceId: ctx.scope.workspaceId!,
    typeId: kinds.property,
    name: address,
    ...(ownerPersonId
      ? {
          relateTo: {
            relationshipTypeId: await relationshipTypeId(ctx, 'contractor_owner'),
            recordId: ownerPersonId,
            side: 'b' as const,
          },
        }
      : {}),
  });
  const propertyId = made.output.customRecordId;
  await ctx.emit({
    type: 'contractor.property.added',
    entityType: 'custom_record',
    entityId: propertyId,
    payload: { propertyId, ownerPersonId },
    after: { address },
  });
  return propertyId;
}

const siteOf = async (ctx: CommandContext, jobId: string, propertyId: string) =>
  executeCommandWithin(ctx, relationshipCreate, {
    workspaceId: ctx.scope.workspaceId!,
    relationshipTypeId: await relationshipTypeId(ctx, 'contractor_site'),
    aId: jobId,
    bId: propertyId,
  });

// ------------------------------------------------------------------------------------------------ starting one

export const jobOpen = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.open',
  description:
    'Start a job: a service call, or a project that starts with its phases, for a customer at one of their properties (or a new address), with its trade, job lead, start day and deadline.',
  risk: 1,
  input: JobOpenInput,
  output: JobOpenOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_open_job',
    description:
      'Start a job or a project for a customer, at one of their properties or a new address (kind: service or project). A project gets the business’s starter phases unless phases are given. Asks the person first.',
    autonomy: 'confirm',
    keywords: ['new job', 'start a project', 'service call', 'work order'],
    what: (input) => `Start “${nameIn(input)}”`,
    outcome: (output) => ({
      words: W.newJob.created(nameIn(output)),
      path: jobPath(String((output as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.job.opened', 'contractor.property.added'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = userIdOf(ctx.actor);
    if (input.propertyId && input.newPropertyAddress)
      throw HfosError.validation([{ path: 'propertyId', message: REFUSALS.propertyOrAddress }]);
    checkDates(input.startsOn, input.dueOn);
    const lead = input.leadUserId === undefined ? me : input.leadUserId;
    await checkLead(ctx, lead);
    const customer = input.customerPersonId ?? null;
    if (customer) await customerName(ctx, customer);
    if (input.propertyId) await propertyName(ctx, input.propertyId);
    const kinds = await kindIds(ctx);

    const made = await executeCommandWithin(ctx, customRecordCreate, {
      workspaceId: ws,
      typeId: kinds.job,
      name: input.name,
      ...(customer
        ? {
            relateTo: {
              relationshipTypeId: await relationshipTypeId(ctx, 'contractor_customer'),
              recordId: customer,
              side: 'b' as const,
            },
          }
        : {}),
    });
    const jobId = made.output.customRecordId;
    await ctx.tx.insert(jobs).values({
      recordId: jobId,
      workspaceId: ws,
      kind: input.kind,
      status: 'new',
      statusBy: me,
      trade: input.trade ?? null,
      details: input.details || null,
      startsOn: input.startsOn ?? null,
      dueOn: input.dueOn ?? null,
      leadUserId: lead,
      createdBy: me,
    });

    let propertyId = input.propertyId ?? null;
    if (input.newPropertyAddress)
      propertyId = await newProperty(ctx, input.newPropertyAddress, customer);
    if (propertyId) await siteOf(ctx, jobId, propertyId);

    let added = 0;
    if (input.kind === 'project') {
      const names = input.phases ?? phasesForNewProject(await settingsOf(ctx), input.trade);
      added = await addPhases(ctx, { recordId: jobId }, names);
    }
    const eventId = await ctx.emit({
      type: 'contractor.job.opened',
      entityType: 'custom_record',
      entityId: jobId,
      payload: {
        jobId,
        kind: input.kind,
        customerPersonId: customer,
        propertyId,
        leadUserId: lead,
      },
      after: {
        name: input.name,
        kind: JOB_KIND_WORDS[input.kind],
        trade: input.trade ? TRADE_NAMES[input.trade] : null,
        startsOn: input.startsOn ?? null,
        dueOn: input.dueOn ?? null,
        phases: added,
      },
    });
    await jobLine(
      ctx,
      jobId,
      input.kind === 'project' ? 'started the project' : 'started the job',
      { eventId, personId: customer },
    );
    return { jobId, name: input.name, propertyId, phases: added };
  },
});

// ------------------------------------------------------------------------------------------------ changing it

export const jobUpdate = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.update',
  description:
    'Change a job’s name, trade, work to do, start day, deadline, job lead, customer or property (an existing one, or a new address). Only what’s given changes; null clears it.',
  risk: 1,
  input: JobUpdateInput,
  output: JobChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_update_job',
    description:
      'Change a job’s name, trade, work to do, start day, deadline, job lead, customer or property. Only what’s given changes; null clears it. Asks the person first.',
    autonomy: 'confirm',
    what: 'Change the job’s details',
    outcome: (_output, input) => ({
      words: W.job.saved,
      path: jobPath(String((input as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.job.updated', 'contractor.property.added'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    if (input.propertyId && input.newPropertyAddress)
      throw HfosError.validation([{ path: 'propertyId', message: REFUSALS.propertyOrAddress }]);
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const startsOn = input.startsOn === undefined ? job.startsOn : input.startsOn;
    const dueOn = input.dueOn === undefined ? job.dueOn : input.dueOn;
    checkDates(startsOn, dueOn);

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const set: Partial<typeof jobs.$inferInsert> = {};
    const note = (key: string, from: unknown, to: unknown) => {
      before[key] = from;
      after[key] = to;
    };
    if (input.trade !== undefined && input.trade !== job.trade) {
      set.trade = input.trade;
      note('trade', job.trade && TRADE_NAMES[job.trade], input.trade && TRADE_NAMES[input.trade]);
    }
    if (input.details !== undefined && (input.details || null) !== job.details) {
      set.details = input.details || null;
      note('details', job.details, input.details || null);
    }
    if (startsOn !== job.startsOn) {
      set.startsOn = startsOn;
      note('startsOn', job.startsOn, startsOn);
    }
    if (dueOn !== job.dueOn) {
      set.dueOn = dueOn;
      note('dueOn', job.dueOn, dueOn);
    }
    if (input.leadUserId !== undefined && input.leadUserId !== job.leadUserId) {
      await checkLead(ctx, input.leadUserId);
      set.leadUserId = input.leadUserId;
      note(
        'lead',
        job.leadUserId && (await userName(ctx, job.leadUserId)),
        input.leadUserId && (await userName(ctx, input.leadUserId)),
      );
    }
    if (Object.keys(set).length)
      await ctx.tx
        .update(jobs)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(jobs.recordId, job.recordId), eq(jobs.workspaceId, ws)));

    if (input.name !== undefined && input.name !== job.name) {
      await executeCommandWithin(ctx, customRecordUpdate, {
        workspaceId: ws,
        customRecordId: job.recordId,
        name: input.name,
      });
      note('name', job.name, input.name);
    }

    const pairs = await pairsOf(ctx, job.recordId);
    if (
      input.customerPersonId !== undefined &&
      input.customerPersonId !== (pairs.customer?.personId ?? null)
    ) {
      if (input.customerPersonId) await customerName(ctx, input.customerPersonId);
      if (pairs.customer)
        await executeCommandWithin(ctx, relationshipDelete, {
          workspaceId: ws,
          relationshipId: pairs.customer.id,
        });
      if (input.customerPersonId)
        await executeCommandWithin(ctx, relationshipCreate, {
          workspaceId: ws,
          relationshipTypeId: await relationshipTypeId(ctx, 'contractor_customer'),
          aId: input.customerPersonId,
          bId: job.recordId,
        });
      note('customerPersonId', pairs.customer?.personId ?? null, input.customerPersonId);
    }
    const wantProperty =
      input.newPropertyAddress !== undefined
        ? await newProperty(
            ctx,
            input.newPropertyAddress,
            input.customerPersonId === undefined
              ? (pairs.customer?.personId ?? null)
              : input.customerPersonId,
          )
        : input.propertyId;
    if (wantProperty !== undefined && wantProperty !== (pairs.site?.propertyId ?? null)) {
      if (wantProperty && input.newPropertyAddress === undefined)
        await propertyName(ctx, wantProperty);
      if (pairs.site)
        await executeCommandWithin(ctx, relationshipDelete, {
          workspaceId: ws,
          relationshipId: pairs.site.id,
        });
      if (wantProperty) await siteOf(ctx, job.recordId, wantProperty);
      note('propertyId', pairs.site?.propertyId ?? null, wantProperty);
    }

    if (!Object.keys(after).length) return { jobId: job.recordId, changed: false };
    const eventId = await ctx.emit({
      type: 'contractor.job.updated',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, changed: Object.keys(after) },
      before,
      after,
    });
    await jobLine(ctx, job.recordId, 'changed the job’s details', { eventId });
    return { jobId: job.recordId, changed: true };
  },
});

// ------------------------------------------------------------------------------------------------ moving it along

/** The columns a status change sets: when, who, why, and when it was done. */
function statusColumns(ctx: CommandContext, status: JobStatus, reason: string | null) {
  return {
    status,
    statusAt: new Date(),
    statusBy: userIdOf(ctx.actor),
    statusReason: STATUSES_WITH_REASON.includes(status) ? reason : null,
    doneAt: status === 'done' ? new Date() : null,
  };
}

/** Moves a job to a status, with its % done kept and a line on its timeline. Shared with the worker's moves. */
export async function moveJob(
  ctx: CommandContext,
  job: Job,
  status: JobStatus,
  reason: string | null,
  because?: string,
): Promise<void> {
  const leavingDone = job.status === 'done' && status !== 'done';
  await ctx.tx
    .update(jobs)
    .set({
      ...statusColumns(ctx, status, reason),
      // A service call taken back out of Done isn't finished any more.
      ...(leavingDone && job.kind === 'service'
        ? { percentDone: Math.min(job.percentDone, 90) }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(jobs.recordId, job.recordId), eq(jobs.workspaceId, ctx.scope.workspaceId!)));
  await keepPercent(ctx, job);
  const eventId = await ctx.emit({
    type: 'contractor.job.status_changed',
    entityType: 'custom_record',
    entityId: job.recordId,
    payload: { jobId: job.recordId, from: job.status, status, ...(because ? { because } : {}) },
    before: { status: JOB_STATUS_WORDS[job.status] },
    after: { status: JOB_STATUS_WORDS[status], ...(reason ? { reason } : {}) },
  });
  await jobLine(
    ctx,
    job.recordId,
    `moved the job to ${JOB_STATUS_WORDS[status]}${because ? `: ${because}` : ''}`,
    { eventId, body: STATUSES_WITH_REASON.includes(status) ? reason : null },
  );
}

/**
 * The owner's decision 8: a job isn't Done while a required checklist item or photo is left on one of its visits'
 * work orders. Someone who may (`contractor.skip_checks`: owners and admins) marks it done anyway with a reason,
 * which is kept on each item passed over and on the job's timeline. A cancelled visit's items don't count, nor a
 * visit's in the Deleted bin (row security keeps those from everyone).
 */
async function requireReady(ctx: CommandContext, job: Job, skipReason: string | null) {
  const left = await rows<{
    id: string;
    label: string;
    kind: string;
    appointment_id: string;
    starts_at: string;
  }>(
    ctx.tx,
    sql`select i.id, i.label, i.kind, i.appointment_id, a.starts_at::text
        from addon_contractor.work_order_items i
        join app.appointments a on a.id = i.appointment_id
        where i.record_id = ${job.recordId} and i.workspace_id = ${ctx.scope.workspaceId!}
          and i.required and i.done_at is null and i.skipped_at is null and a.status <> 'cancelled'
        order by a.starts_at, i.position, i.created_at
        for update of i`,
  );
  if (!left.length) return;
  const maySkip = scopeCan(ctx.scope, 'contractor.skip_checks' as Permission);
  if (!skipReason)
    throw new HfosError(
      'rule_violation',
      409,
      REFUSALS.jobNotReady(
        job.name,
        left.map((l) => l.label),
        maySkip,
      ),
      {
        maySkip,
        left: left.map((l) => ({
          itemId: l.id,
          appointmentId: l.appointment_id,
          startsAt: new Date(l.starts_at).toISOString(),
          label: l.label,
          kind: l.kind,
        })),
      },
      'contractor_job_not_ready',
    );
  if (!maySkip) throw HfosError.rule('contractor_skip_not_allowed', 403, REFUSALS.skipNotAllowed);
  const now = new Date();
  await ctx.tx
    .update(workOrderItems)
    .set({ skippedAt: now, skippedBy: userIdOf(ctx.actor), skipReason, updatedAt: now })
    .where(
      inArray(
        workOrderItems.id,
        left.map((l) => l.id),
      ),
    );
  const eventId = await ctx.emit({
    type: 'contractor.job.checks_skipped',
    entityType: 'custom_record',
    entityId: job.recordId,
    payload: { jobId: job.recordId, items: left.length },
    after: { passedOver: left.map((l) => l.label).slice(0, 20), reason: skipReason },
  });
  await jobLine(
    ctx,
    job.recordId,
    `marked the job done with ${requiredItemsWords(left.length)} left`,
    { eventId, body: skipReason },
  );
}

export const jobSetStatus = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.set_status',
  description:
    'Move a job along: new, scheduled, in progress, on hold, done or cancelled. On hold and cancelled need a reason. Done waits on the required checklist items and photos on its work orders, unless an owner or admin gives a reason to pass them over.',
  risk: 1,
  input: JobSetStatusInput,
  output: JobSetStatusOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_job_status',
    description:
      'Move a job to new, scheduled, in_progress, on_hold, done or cancelled. on_hold and cancelled need a reason. done is refused while required checklist items or photos are left on its work orders (the refusal names them): finish them on the work order, or, only when the person asks to mark it done anyway and says why, pass skipReason (owners and admins). Asks the person first.',
    autonomy: 'confirm',
    what: (input) => {
      const { status: s, skipReason } = input as { status?: JobStatus; skipReason?: string };
      if (!s) return null;
      return s === 'done' && skipReason?.trim()
        ? `Mark the job done with required items left: ${skipReason.trim()}`
        : `Mark the job ${JOB_STATUS_WORDS[s].toLowerCase()}`;
    },
    outcome: (output, input) => {
      const s = (output as { status?: JobStatus }).status;
      return {
        words: s ? W.job.statusSet(JOB_STATUS_WORDS[s]) : W.job.saved,
        path: jobPath(String((input as { jobId?: unknown }).jobId ?? '')),
      };
    },
  },
  emits: ['contractor.job.status_changed', 'contractor.job.checks_skipped'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const reason = input.reason?.trim() || null;
    if (STATUSES_WITH_REASON.includes(input.status) && !reason)
      throw HfosError.rule(
        'contractor_reason_needed',
        400,
        REFUSALS.reasonNeeded(JOB_STATUS_WORDS[input.status]),
      );
    if (input.status === job.status && (reason ?? null) === (job.statusReason ?? null))
      return { jobId: job.recordId, status: job.status, changed: false };
    if (input.status === 'done') await requireReady(ctx, job, input.skipReason?.trim() || null);
    await moveJob(ctx, job, input.status, reason);
    return { jobId: job.recordId, status: input.status, changed: true };
  },
});

export const jobSetPercent = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.set_percent',
  description:
    'Set how far along a service call is (0 to 100%). A project’s % done comes from its phases instead.',
  risk: 1,
  input: JobSetPercentInput,
  output: JobSetPercentOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_job_percent',
    description:
      'Set a service call’s % done (0 to 100). For a project, set its phases’ % done instead.',
    outcome: (output, input) => ({
      words: W.job.percentSet(Number((output as { percentDone?: unknown }).percentDone ?? 0)),
      path: jobPath(String((input as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.job.percent_set'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    if (job.kind === 'project' && (await phasesOf(ctx, job.recordId)).length)
      throw HfosError.rule('contractor_percent_on_project', 409, REFUSALS.percentOnProject);
    if (!isOpen(job.status))
      throw HfosError.rule(
        'contractor_job_closed',
        409,
        REFUSALS.closedJob(job.name, JOB_STATUS_WORDS[job.status]),
      );
    if (input.percentDone === job.percentDone)
      return { jobId: job.recordId, percentDone: job.percentDone };
    await ctx.tx
      .update(jobs)
      .set({ percentDone: input.percentDone, updatedAt: new Date() })
      .where(eq(jobs.recordId, job.recordId));
    await ctx.emit({
      type: 'contractor.job.percent_set',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, percentDone: input.percentDone },
      before: { percentDone: job.percentDone },
      after: { percentDone: input.percentDone },
    });
    return { jobId: job.recordId, percentDone: input.percentDone };
  },
});

// ------------------------------------------------------------------------------------------------ its team

const teamChanged = async (ctx: CommandContext, job: Job, userId: string, added: boolean) => {
  const who = (await userName(ctx, userId)) ?? 'Someone';
  const eventId = await ctx.emit({
    type: 'contractor.job.team_changed',
    entityType: 'custom_record',
    entityId: job.recordId,
    payload: { jobId: job.recordId, userId, added },
    after: { [added ? 'added' : 'removed']: who },
  });
  await jobLine(ctx, job.recordId, added ? `put ${who} on the job` : `took ${who} off the job`, {
    eventId,
  });
};

export const jobTeamAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.team_add',
  description: 'Put someone on the business’s team on a job’s team, beside its job lead.',
  risk: 1,
  input: JobTeamInput,
  output: JobChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_to_job_team',
    description: 'Put a team member on a job’s team (by their user id).',
    outcome: (_o, input) => ({
      words: 'They’re on the job now.',
      path: jobPath(String((input as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.job.team_changed'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    await requireCanWork(ctx, input.userId);
    const [{ n } = { n: 0 }] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_contractor.team where record_id = ${job.recordId}`,
    );
    const made = await ctx.tx
      .insert(team)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        recordId: job.recordId,
        userId: input.userId,
        addedBy: userIdOf(ctx.actor),
      })
      .onConflictDoNothing()
      .returning({ userId: team.userId });
    if (!made.length) return { jobId: job.recordId, changed: false };
    if (n >= LIMITS.team)
      throw HfosError.rule('contractor_team_full', 409, REFUSALS.teamFull(LIMITS.team));
    await teamChanged(ctx, job, input.userId, true);
    return { jobId: job.recordId, changed: true };
  },
});

export const jobTeamRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.team_remove',
  description: 'Take someone off a job’s team. The job and their work on it stay.',
  risk: 1,
  input: JobTeamInput,
  output: JobChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_from_job_team',
    description: 'Take a team member off a job’s team (by their user id).',
    outcome: (_o, input) => ({
      words: 'They’re off the job now.',
      path: jobPath(String((input as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.job.team_changed'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    const gone = await ctx.tx
      .delete(team)
      .where(and(eq(team.recordId, job.recordId), eq(team.userId, input.userId)))
      .returning({ userId: team.userId });
    if (!gone.length) return { jobId: job.recordId, changed: false };
    await teamChanged(ctx, job, input.userId, false);
    return { jobId: job.recordId, changed: true };
  },
});

// ------------------------------------------------------------------------------------------------ a project

export const jobMakeProject = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.make_project',
  description:
    'Make a service call a project: it gets its phases (the business’s starter phases unless they’re given), and its % done comes from them from now on.',
  risk: 1,
  input: JobMakeProjectInput,
  output: JobMakeProjectOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_make_project',
    description:
      'Turn a service call into a project with phases: the business’s starter phases, or the phases given in order. Asks the person first.',
    autonomy: 'confirm',
    what: 'Make it a project with phases',
    outcome: (_o, input) => ({
      words: W.job.phases.madeProject,
      path: jobPath(String((input as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.job.made_project'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const names = input.phases ?? phasesForNewProject(await settingsOf(ctx), job.trade);
    const added = await addPhases(ctx, job, names);
    if (job.kind === 'project' && !added) return { jobId: job.recordId, phases: 0 };
    await ctx.tx
      .update(jobs)
      .set({ kind: 'project', updatedAt: new Date() })
      .where(eq(jobs.recordId, job.recordId));
    await keepPercent(ctx, { ...job, kind: 'project' });
    const eventId = await ctx.emit({
      type: 'contractor.job.made_project',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, phases: added },
      before: { kind: JOB_KIND_WORDS[job.kind] },
      after: { kind: JOB_KIND_WORDS.project, phases: added },
    });
    await jobLine(ctx, job.recordId, 'made the job a project', { eventId });
    return { jobId: job.recordId, phases: added };
  },
});

// ------------------------------------------------------------------------------------------------ the money

export const jobSetMoney = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.set_money',
  description:
    'Set a job’s price to the customer and its budget: labor, materials and other costs (in cents), and labor hours. Only what’s given changes; null clears it. For people who may see job costs and profit.',
  risk: 1,
  input: JobSetMoneyInput,
  output: JobChangeOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_job_budget',
    description:
      'Set a job’s price and budget (priceCents, laborCents, materialsCents, otherCents, laborHours). Only what’s given changes; null clears it. Asks the person first.',
    autonomy: 'confirm',
    what: 'Set the job’s price and budget',
    outcome: (_o, input) => ({
      words: W.job.money.saved,
      path: jobPath(String((input as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.job.money_set'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const parts = {
      priceCents: input.priceCents,
      laborCents: input.laborCents,
      materialsCents: input.materialsCents,
      otherCents: input.otherCents,
      laborHours: input.laborHours,
    };
    const given = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
    if (!Object.keys(given).length) return { jobId: job.recordId, changed: false };
    await ctx.tx
      .insert(money)
      .values({
        recordId: job.recordId,
        workspaceId: ctx.scope.workspaceId!,
        ...given,
        updatedBy: userIdOf(ctx.actor),
      })
      .onConflictDoUpdate({
        target: money.recordId,
        set: { ...given, updatedBy: userIdOf(ctx.actor), updatedAt: dsql`now()` },
      });
    // The amounts stay off the event and the timeline: only people with job-cost access see them.
    const eventId = await ctx.emit({
      type: 'contractor.job.money_set',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, changed: Object.keys(given) },
    });
    await jobLine(ctx, job.recordId, 'set the job’s budget', { eventId });
    return { jobId: job.recordId, changed: true };
  },
});

// ------------------------------------------------------------------------------------------------ properties

export const propertyAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.property.add',
  description: 'Add a property by its address, owned by a customer when one is given.',
  risk: 1,
  input: PropertyAddInput,
  output: PropertyAddOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_property',
    description: 'Add a property (its address), owned by a customer when ownerPersonId is given.',
    outcome: (output) => ({
      words: `${nameIn(output)} is added.`,
      path: `customers/records/${String((output as { propertyId?: unknown }).propertyId ?? '')}`,
    }),
  },
  emits: ['contractor.property.added'],
  async handler(ctx, input) {
    const owner = input.ownerPersonId ?? null;
    if (owner) await customerName(ctx, owner);
    const propertyId = await newProperty(ctx, input.address, owner);
    return { propertyId, name: input.address };
  },
});

// ------------------------------------------------------------------------------------------------ the worker's

export const JobFollowVisitInput = z.object({
  workspaceId: z.uuid(),
  appointmentId: z.uuid(),
  /** `booked`: a visit was booked on the job. `started`: a tech pressed Started on it. */
  what: z.enum(['booked', 'started']),
});

/**
 * The worker: a visit on a job moved it along. A visit booked on a new job makes it Scheduled; a tech pressing
 * Started on one makes a new or scheduled job In progress. Nothing else moves on its own, and never backwards.
 */
export const jobFollowVisit = defineAddonCommand(contractorAddon, {
  name: 'contractor.job.follow_visit',
  description: 'Worker: a visit booked or started on a job moves the job along.',
  risk: 0,
  input: JobFollowVisitInput,
  output: JobSetStatusOutput.nullable(),
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.job.status_changed'],
  async handler(ctx, input) {
    const [a] = await rows<{ record_id: string | null; status: string }>(
      ctx.tx,
      sql`select custom_record_id as record_id, status::text from app.appointments
          where id = ${input.appointmentId} and workspace_id = ${ctx.scope.workspaceId!}`,
    );
    if (!a?.record_id || a.status === 'cancelled') return null;
    const [isJob] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select true as ok from addon_contractor.jobs where record_id = ${a.record_id}`,
    );
    if (!isJob) return null;
    const job = await loadJob(ctx, a.record_id, { lock: true });
    const next: JobStatus | null =
      input.what === 'booked'
        ? job.status === 'new'
          ? 'scheduled'
          : null
        : job.status === 'new' || job.status === 'scheduled'
          ? 'in_progress'
          : null;
    if (!next || job.archived) return null;
    await moveJob(
      ctx,
      job,
      next,
      null,
      input.what === 'booked' ? 'a visit was booked' : 'a visit was started',
    );
    return { jobId: job.recordId, status: next, changed: true };
  },
});
