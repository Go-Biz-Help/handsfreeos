/**
 * A project's phases (docs/contractor.md, "Phases"): adding one (which makes a service call a project, the owner's
 * decision 2), changing its name, dates, status and % done, putting them in order, and removing one. Each change
 * keeps the job's % done as the average of its phases' (./progress.ts).
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import { contractorAddon } from '../manifest';
import { phasePercentFromStatus, phaseStatusFromPercent, type PhaseStatus } from '../progress';
import {
  JobChangeOutput,
  PhaseAddInput,
  PhaseAddOutput,
  PhaseChangeOutput,
  PhaseRemoveInput,
  PhaseReorderInput,
  PhaseUpdateInput,
} from '../schemas';
import { jobs, phases } from '../tables';
import { CONTRACTOR_WORDS as W, PHASE_STATUS_WORDS, REFUSALS } from '../words';
import { inWorkspace, jobLine, keepPercent, loadJob, phasesOf } from './common';
import { addPhases } from './jobs';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
const pathFromOutput = (output: unknown) =>
  jobPath(String((output as { jobId?: unknown }).jobId ?? ''));

/** A phase of this business, with its job locked for the change. */
async function loadPhase(ctx: CommandContext, phaseId: string) {
  const [p] = await ctx.tx
    .select()
    .from(phases)
    .where(and(eq(phases.id, phaseId), eq(phases.workspaceId, ctx.scope.workspaceId!)));
  if (!p) throw HfosError.notFound(REFUSALS.phaseGone);
  const job = await loadJob(ctx, p.recordId, { lock: true });
  if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
  return { phase: p, job };
}

const nameTaken = (e: unknown, name: string) => {
  if (isUniqueViolation(e, 'phases_name_idx'))
    throw HfosError.rule('contractor_phase_name_taken', 409, REFUSALS.phaseNameTaken(name));
  throw e;
};

export const phaseAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.phase.add',
  description:
    'Add a phase at the end of a job’s phases, with its start day and deadline. A service call with its first phase becomes a project.',
  risk: 1,
  input: PhaseAddInput,
  output: PhaseAddOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_phase',
    description:
      'Add a phase to a job (at the end), with its start day and deadline. A service call becomes a project.',
    outcome: (output) => ({ words: 'Phase added.', path: pathFromOutput(output) }),
  },
  emits: ['contractor.phase.added', 'contractor.job.made_project'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    if (input.startsOn && input.dueOn && input.dueOn < input.startsOn)
      throw HfosError.rule('contractor_dates_backwards', 400, REFUSALS.datesBackwards);
    const have = await phasesOf(ctx, job.recordId);
    if (have.some((p) => p.name.toLowerCase() === input.name.toLowerCase()))
      throw HfosError.rule('contractor_phase_name_taken', 409, REFUSALS.phaseNameTaken(input.name));
    await addPhases(ctx, job, [input.name]);
    const [made] = await ctx.tx
      .select()
      .from(phases)
      .where(
        and(
          eq(phases.recordId, job.recordId),
          dsql`lower(btrim(${phases.name})) = lower(btrim(${input.name}))`,
        ),
      );
    if (input.startsOn || input.dueOn)
      await ctx.tx
        .update(phases)
        .set({ startsOn: input.startsOn ?? null, dueOn: input.dueOn ?? null })
        .where(eq(phases.id, made!.id));
    const madeProject = job.kind === 'service';
    if (madeProject) {
      await ctx.tx
        .update(jobs)
        .set({ kind: 'project', updatedAt: new Date() })
        .where(eq(jobs.recordId, job.recordId));
      await ctx.emit({
        type: 'contractor.job.made_project',
        entityType: 'custom_record',
        entityId: job.recordId,
        payload: { jobId: job.recordId, phases: 1 },
      });
    }
    await keepPercent(ctx, { ...job, kind: 'project' });
    const eventId = await ctx.emit({
      type: 'contractor.phase.added',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, phaseId: made!.id },
      after: { phase: input.name, startsOn: input.startsOn ?? null, dueOn: input.dueOn ?? null },
    });
    await jobLine(
      ctx,
      job.recordId,
      madeProject
        ? `made the job a project with the phase “${input.name}”`
        : `added the phase “${input.name}”`,
      { eventId },
    );
    return { phaseId: made!.id, jobId: job.recordId, madeProject };
  },
});

export const phaseUpdate = defineAddonCommand(contractorAddon, {
  name: 'contractor.phase.update',
  description:
    'Change a phase: its name, start day, deadline, status (not started, started, done) or % done. Done is 100%; 100% is done.',
  risk: 1,
  input: PhaseUpdateInput,
  output: PhaseChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  // Moved along on the job with no signal: it's kept on the phone and sent when there is some.
  offline: 'anytime',
  ai: {
    tool: 'contractor_update_phase',
    description:
      'Change a phase’s name, start day, deadline, status (not_started, in_progress, done) or % done.',
    outcome: (output) => ({ words: W.job.saved, path: pathFromOutput(output) }),
  },
  emits: ['contractor.phase.updated'],
  async handler(ctx, input) {
    const { phase, job } = await loadPhase(ctx, input.phaseId);
    const startsOn = input.startsOn === undefined ? phase.startsOn : input.startsOn;
    const dueOn = input.dueOn === undefined ? phase.dueOn : input.dueOn;
    if (startsOn && dueOn && dueOn < startsOn)
      throw HfosError.rule('contractor_dates_backwards', 400, REFUSALS.datesBackwards);
    // Status and % move together: a status sets the %, a % sets the status, and both given keep the status.
    let status = phase.status as PhaseStatus;
    let percent = phase.percentDone;
    if (input.status !== undefined) {
      status = input.status;
      percent = phasePercentFromStatus(status, input.percentDone ?? phase.percentDone);
    } else if (input.percentDone !== undefined) {
      percent = input.percentDone;
      status = phaseStatusFromPercent(percent);
    }
    const set: Partial<typeof phases.$inferInsert> = {};
    if (input.name !== undefined && input.name !== phase.name) set.name = input.name;
    if (startsOn !== phase.startsOn) set.startsOn = startsOn;
    if (dueOn !== phase.dueOn) set.dueOn = dueOn;
    if (status !== phase.status) {
      set.status = status;
      set.doneAt = status === 'done' ? changeMoment(ctx.meta) : null;
    }
    if (percent !== phase.percentDone) set.percentDone = percent;
    if (!Object.keys(set).length)
      return { phaseId: phase.id, jobId: job.recordId, jobPercentDone: job.percentDone };
    try {
      await ctx.tx
        .update(phases)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(phases.id, phase.id));
    } catch (e) {
      nameTaken(e, input.name ?? phase.name);
    }
    const jobPercentDone = await keepPercent(ctx, job);
    const eventId = await ctx.emit({
      type: 'contractor.phase.updated',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, phaseId: phase.id, changed: Object.keys(set) },
      before: {
        phase: phase.name,
        status: PHASE_STATUS_WORDS[phase.status as PhaseStatus],
        percentDone: phase.percentDone,
      },
      after: {
        phase: set.name ?? phase.name,
        status: PHASE_STATUS_WORDS[status],
        percentDone: percent,
      },
    });
    // Only a phase's start and finish go on the job's timeline; a % in between doesn't.
    if (set.status === 'done' || (set.status === 'in_progress' && phase.status === 'not_started'))
      await jobLine(
        ctx,
        job.recordId,
        set.status === 'done'
          ? `finished the phase “${set.name ?? phase.name}”`
          : `started the phase “${set.name ?? phase.name}”`,
        { eventId },
      );
    return { phaseId: phase.id, jobId: job.recordId, jobPercentDone };
  },
});

export const phaseRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.phase.remove',
  description:
    'Remove a phase from a project, with its dates and % done. The job and everything else on it stay.',
  risk: 2,
  input: PhaseRemoveInput,
  output: PhaseChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_phase',
    description:
      'Remove a phase from a project, with its dates and % done. The job stays. Asks the person first.',
    autonomy: 'confirm',
    what: 'Remove the phase',
    outcome: (output) => ({ words: 'Phase removed.', path: pathFromOutput(output) }),
  },
  emits: ['contractor.phase.removed'],
  async handler(ctx, input) {
    const { phase, job } = await loadPhase(ctx, input.phaseId);
    await ctx.tx.delete(phases).where(eq(phases.id, phase.id));
    const jobPercentDone = await keepPercent(ctx, job);
    const eventId = await ctx.emit({
      type: 'contractor.phase.removed',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, phaseId: phase.id },
      before: {
        phase: phase.name,
        status: PHASE_STATUS_WORDS[phase.status as PhaseStatus],
        percentDone: phase.percentDone,
        startsOn: phase.startsOn,
        dueOn: phase.dueOn,
      },
    });
    await jobLine(ctx, job.recordId, `removed the phase “${phase.name}”`, { eventId });
    return { phaseId: phase.id, jobId: job.recordId, jobPercentDone };
  },
});

export const phaseReorder = defineAddonCommand(contractorAddon, {
  name: 'contractor.phase.reorder',
  description:
    'Put a job’s phases in a new order: every one of its phases, once each, first to last.',
  risk: 1,
  input: PhaseReorderInput,
  output: JobChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_reorder_phases',
    description:
      'Put a job’s phases in a new order: give every one of its phase ids, first to last.',
    outcome: (output) => ({ words: W.job.saved, path: pathFromOutput(output) }),
  },
  emits: ['contractor.phases.reordered'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    const have = await phasesOf(ctx, job.recordId);
    const ids = new Set(input.phaseIds);
    if (
      ids.size !== input.phaseIds.length ||
      ids.size !== have.length ||
      have.some((p) => !ids.has(p.id))
    )
      throw HfosError.rule('contractor_phase_order', 400, REFUSALS.phaseOrder);
    const was = have.map((p) => p.id);
    if (was.every((id, i) => id === input.phaseIds[i]))
      return { jobId: job.recordId, changed: false };
    for (const [i, id] of input.phaseIds.entries())
      await ctx.tx
        .update(phases)
        .set({ position: i, updatedAt: new Date() })
        .where(eq(phases.id, id));
    const names = new Map(have.map((p) => [p.id, p.name]));
    await ctx.emit({
      type: 'contractor.phases.reordered',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, phaseIds: input.phaseIds },
      before: { order: was.map((id) => names.get(id)) },
      after: { order: input.phaseIds.map((id) => names.get(id)) },
    });
    return { jobId: job.recordId, changed: true };
  },
});
