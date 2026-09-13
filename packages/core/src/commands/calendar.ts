/**
 * Calendars: create from a preset, save a settings document as a new revision (with conflict, rule and
 * impact checks), restore an old revision, change status and the link. One calendar keeps its id, link,
 * appointments and history through every change; labels are only a description.
 */
import { and, eq, ne } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  calendarMembers,
  calendarResources,
  calendarRevisions,
  calendars,
  calendarServices,
  schedules,
} from '@hfos/db/schema';
import {
  appointmentSnapshot,
  cancelAppointment,
  requireAppointment,
  replaceStaff,
  staffIdsOf,
} from '../calendar/appointments';
import {
  checkPerson,
  loadAssignmentState,
  lockBooking,
  saveAssignmentState,
  type CheckData,
} from '../calendar/booking';
import type { CalendarCatalogs } from '../calendar/catalogs';
import { parseConfig, type CalendarConfig } from '../calendar/config';
import { diffConfigs } from '../calendar/diff';
import { chooseAssignment } from '../calendar/engine/strategies';
import {
  analyzeImpact,
  undecidedImpacts,
  type ImpactAnalysis,
  type ImpactDecision,
} from '../calendar/impact';
import { formatLabels, inferLabels } from '../calendar/labels';
import {
  dbNow,
  loadCalendar,
  loadCatalogs,
  loadCatalogService,
  loadStaffData,
  loadUpcomingSummary,
  upcomingAppointmentIds,
  userNames,
  workspaceZone,
  type LoadedCalendar,
} from '../calendar/load';
import { CALENDAR_PRESETS, configFromPreset } from '../calendar/presets';
import { hasBlockingIssues, validateCalendar, type CalendarIssue } from '../calendar/rules';
import { resolveTerms } from '../calendar/terms';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import {
  CalendarCreateInput,
  CalendarCreateOutput,
  CalendarRestoreRevisionInput,
  CalendarSaveInput,
  CalendarSaveOutput,
  CalendarSetSlugInput,
  CalendarSetSlugOutput,
  CalendarSetStatusInput,
  CalendarSetStatusOutput,
} from '../schemas/calendar';

const MIN = 60_000;
const DAY = 86_400_000;
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

// ---- Shared pieces ----

function issuesError(issues: readonly CalendarIssue[], message: string): HfosError {
  return new HfosError('rule_violation', 422, message, { issues }, 'calendar_issues');
}

/**
 * References to catalog rows that don't exist in this workspace are refused outright (a service or truck
 * that was archived, or a person who left, is a rule with a fix instead).
 */
function checkReferences(config: CalendarConfig, catalogs: CalendarCatalogs, prefix: string): void {
  const at = (path: string) => (prefix ? `${prefix}.${path}` : path);
  const issues: { path: string; message: string }[] = [];
  const services = new Set(catalogs.services.map((s) => s.id));
  const resources = new Set(catalogs.resources.map((r) => r.id));
  const territories = new Set(catalogs.territories.map((t) => t.id));
  config.services.items.forEach((item, i) => {
    if (!services.has(item.serviceId))
      issues.push({
        path: at(`services.items.${i}.serviceId`),
        message: 'That service doesn’t exist.',
      });
  });
  config.resources.required.forEach((r, i) => {
    if (!resources.has(r.resourceId))
      issues.push({
        path: at(`resources.required.${i}.resourceId`),
        message: 'That resource doesn’t exist.',
      });
  });
  config.territory.territoryIds.forEach((id, i) => {
    if (!territories.has(id))
      issues.push({
        path: at(`territory.territoryIds.${i}`),
        message: 'That territory doesn’t exist.',
      });
  });
  const lead = config.crm.createLead;
  if (lead && !catalogs.pipelines.some((p) => p.id === lead.pipelineId))
    issues.push({ path: at('crm.createLead.pipelineId'), message: 'That pipeline doesn’t exist.' });
  if (issues.length) throw HfosError.validation(issues);
}

/**
 * Rewrites the relational mirrors of a settings document: members (people still on the team), services,
 * resources, and the calendar's hours as its row in `schedules`.
 */
async function writeMirrors(
  tx: Tx,
  workspaceId: string,
  calendarId: string,
  config: CalendarConfig,
  catalogs: CalendarCatalogs,
  actorId: string,
): Promise<void> {
  const active = new Set(catalogs.team.filter((p) => p.active).map((p) => p.userId));
  await tx.delete(calendarMembers).where(eq(calendarMembers.calendarId, calendarId));
  const members = config.team.members.filter((m) => active.has(m.userId));
  if (members.length)
    await tx.insert(calendarMembers).values(
      members.map((m) => ({
        workspaceId,
        calendarId,
        userId: m.userId,
        weight: m.weight,
        priority: m.priority,
        required: m.required,
      })),
    );
  await tx.delete(calendarServices).where(eq(calendarServices.calendarId, calendarId));
  if (config.services.mode !== 'none' && config.services.items.length)
    await tx.insert(calendarServices).values(
      config.services.items.map((item, position) => ({
        workspaceId,
        calendarId,
        serviceId: item.serviceId,
        position,
        overrides: item.overrides as Record<string, unknown>,
      })),
    );
  await tx.delete(calendarResources).where(eq(calendarResources.calendarId, calendarId));
  if (config.resources.required.length)
    await tx.insert(calendarResources).values(
      config.resources.required.map((r) => ({
        workspaceId,
        calendarId,
        resourceId: r.resourceId,
        quantity: r.quantity,
      })),
    );
  const own = and(
    eq(schedules.workspaceId, workspaceId),
    eq(schedules.ownerKind, 'calendar'),
    eq(schedules.ownerId, calendarId),
  );
  if (config.schedule.hours)
    await tx
      .insert(schedules)
      .values({
        workspaceId,
        ownerKind: 'calendar',
        ownerId: calendarId,
        weekly: config.schedule.hours,
        createdBy: actorId,
      })
      .onConflictDoUpdate({
        target: [schedules.workspaceId, schedules.ownerKind, schedules.ownerId],
        set: { weekly: config.schedule.hours },
      });
  else await tx.delete(schedules).where(own!);
}

/** A link name for a new calendar: the name, made unique among current and retired links. */
async function freeSlug(tx: Tx, workspaceId: string, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/g, '') || 'calendar';
  const taken = new Set(
    (
      await rows<{ slug: string }>(
        tx,
        sql`select slug from app.calendars where workspace_id = ${workspaceId}
            union select slug from app.calendar_slugs where workspace_id = ${workspaceId}`,
      )
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const catalogIds = (...configs: CalendarConfig[]) =>
  configs.flatMap((c) => c.team.members.map((m) => m.userId));

// ---- Impact actions ----

interface ImpactActions {
  reassigned: string[];
  cancelled: string[];
  kept: string[];
}

/**
 * Moves one person's upcoming appointment to someone else on the (new) team who is free then with no
 * warnings, chosen by the calendar's strategy. Returns false when nobody is (it stays as it was).
 */
async function reassignAway(
  ctx: CommandContext,
  calendar: LoadedCalendar,
  appointmentId: string,
  fromUserId: string,
  now: number,
  activeIds: ReadonlySet<string>,
): Promise<boolean> {
  const ws = calendar.workspaceId;
  const { config } = calendar;
  const appt = await requireAppointment(ctx.tx, ws, appointmentId);
  const staffIds = await staffIdsOf(ctx.tx, appt.id);
  const service = appt.serviceId ? await loadCatalogService(ctx.tx, ws, appt.serviceId) : null;
  const terms = resolveTerms(config, service);
  const pool = config.team.members
    .map((m) => m.userId)
    .filter(
      (u) =>
        activeIds.has(u) &&
        !staffIds.includes(u) &&
        (terms.eligibleUserIds === null || terms.eligibleUserIds.includes(u)),
    );
  if (!pool.length) return false;
  const span = {
    start: appt.startsAt.getTime(),
    end: appt.endsAt.getTime(),
    before: appt.bufferBefore * MIN,
    after: appt.bufferAfter * MIN,
  };
  const staff = await loadStaffData(
    ctx.tx,
    ws,
    pool,
    { start: span.start - span.before - DAY, end: span.end + span.after + DAY },
    {
      workspaceZone: await workspaceZone(ctx.tx, ws),
      includeExternal: config.integrations.checkStaffCalendars,
      excludeAppointmentIds: [appt.id],
    },
  );
  const data: CheckData = {
    now,
    config,
    staff,
    resources: new Map(),
    calendarWindows: null,
    serviceWindows: null,
    serviceName: null,
    names: await userNames(ctx.tx, pool),
  };
  const clean = pool.filter((u) => {
    const c = checkPerson(data, u, span);
    return !c.overlap && c.warnings.length === 0;
  });
  if (!clean.length) return false;
  const state = await loadAssignmentState(ctx.tx, calendar.id);
  const single: CalendarConfig = {
    ...config,
    team: {
      ...config.team,
      crewSize: 1,
      assignment: config.team.assignment === 'collective' ? 'round_robin' : config.team.assignment,
    },
  };
  const picked = chooseAssignment(
    { start: span.start, end: span.end, userIds: clean, seatsLeft: 1, sessionId: null },
    single,
    state,
    { now },
  );
  const to = picked.userIds[0]!;
  const nextStaff = staffIds.map((u) => (u === fromUserId ? to : u));
  const before = await appointmentSnapshot(ctx.tx, appt);
  try {
    await ctx.tx.transaction(async (sp) => {
      await replaceStaff(sp, ws, appt.id, nextStaff);
      await saveAssignmentState(sp, ws, calendar.id, state, picked.nextState);
    });
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === '23P01' || code === '40P01') return false;
    throw e;
  }
  const names = await userNames(ctx.tx, [fromUserId, to]);
  const eventId = await ctx.emit({
    type: 'appointment.reassigned',
    entityType: 'appointment',
    entityId: appt.id,
    payload: {
      calendarId: calendar.id,
      fromUserIds: [fromUserId],
      toUserIds: [to],
      reason: 'calendar_change',
      notify: true,
    },
    before: { title: appt.title, staff: before.staff },
    after: {
      ...(await appointmentSnapshot(ctx.tx, appt)),
      from: names.get(fromUserId),
      to: names.get(to),
    },
  });
  void eventId;
  return true;
}

async function runImpactActions(
  ctx: CommandContext,
  calendar: LoadedCalendar,
  analysis: ImpactAnalysis,
  decisions: Readonly<Record<string, ImpactDecision>>,
  now: number,
  activeIds: ReadonlySet<string>,
): Promise<ImpactActions> {
  const actions: ImpactActions = { reassigned: [], cancelled: [], kept: [] };
  for (const impact of analysis.impacts) {
    const decision = decisions[impact.key] ?? 'keep';
    if (impact.code === 'seats_below_booked') {
      actions.kept.push(...(impact.appointmentIds ?? []));
      continue;
    }
    const ids = await upcomingAppointmentIds(ctx.tx, calendar.id, now, {
      userId: impact.userId,
      resourceId: impact.resourceId,
    });
    for (const id of ids) {
      if (decision === 'cancel_and_notify') {
        const appt = await requireAppointment(ctx.tx, calendar.workspaceId, id);
        await cancelAppointment(ctx, appt, {
          reason: 'The calendar changed',
          notify: true,
          by: 'calendar_change',
        });
        actions.cancelled.push(id);
      } else if (
        decision === 'reassign' &&
        impact.userId &&
        (await reassignAway(ctx, calendar, id, impact.userId, now, activeIds))
      )
        actions.reassigned.push(id);
      else actions.kept.push(id);
    }
  }
  return actions;
}

// ---- The save path (save and restore) ----

interface SaveArgs {
  readonly calendarId: string;
  readonly baseRevision: number;
  readonly draft: CalendarConfig;
  readonly name?: string;
  readonly description?: string | null;
  readonly color?: string;
  readonly timezone?: string | null;
  readonly impactDecisions: Readonly<Record<string, ImpactDecision>>;
  readonly restoredFrom?: number;
}

async function saveCalendar(ctx: CommandContext, args: SaveArgs) {
  const me = requireHuman(ctx).userId;
  const ws = ctx.scope.workspaceId!;
  // The booking lock first: bookings on this calendar wait while its settings change, and the impact
  // review sees every appointment that exists.
  await lockBooking(ctx.tx, args.calendarId);
  const current = await loadCalendar(ctx.tx, ws, args.calendarId, { forUpdate: true });
  if (current.revision !== args.baseRevision)
    throw new HfosError(
      'conflict',
      409,
      'Someone saved this calendar in the meantime. Reload to see their changes.',
      { revision: current.revision },
      'revision_conflict',
    );
  const prev = current.config;
  const next = args.draft;
  const zone =
    args.timezone === undefined
      ? current.timeZone
      : (args.timezone ?? (await workspaceZone(ctx.tx, ws)));
  const catalogs = await loadCatalogs(ctx.tx, ws, {
    timeZone: zone,
    extraUserIds: catalogIds(prev, next),
  });
  checkReferences(next, catalogs, 'draft');
  const now = await dbNow(ctx.tx);
  const issues = validateCalendar(next, catalogs, now);
  if (current.status === 'active' && hasBlockingIssues(issues))
    throw issuesError(issues, 'Fix the settings conflicts before saving an active calendar.');
  const analysis = analyzeImpact(
    prev,
    next,
    await loadUpcomingSummary(ctx.tx, current.id, now),
    catalogs,
  );
  if (undecidedImpacts(analysis, args.impactDecisions).length)
    throw new HfosError(
      'conflict',
      409,
      'Some upcoming appointments are affected. Choose what happens to them.',
      { impacts: analysis.impacts },
      'impact_review_required',
    );

  const details: Partial<typeof calendars.$inferInsert> = {};
  const detailLines: string[] = [];
  if (args.name !== undefined && args.name !== current.name) {
    details.name = args.name;
    detailLines.push(`Name: ${current.name} → ${args.name}`);
  }
  if (args.description !== undefined && (args.description ?? null) !== current.description) {
    details.description = args.description ?? null;
    detailLines.push('Description changed');
  }
  if (args.color !== undefined && args.color !== current.color) {
    details.color = args.color;
    detailLines.push('Color changed');
  }
  if (args.timezone !== undefined && (args.timezone ?? null) !== current.ownTimezone) {
    details.timezone = args.timezone ?? null;
    detailLines.push(`Time zone: ${current.timeZone} → ${zone}`);
  }
  const diff = [
    ...(args.restoredFrom ? [`Restored revision ${args.restoredFrom}`] : []),
    ...detailLines,
    ...diffConfigs(prev, next, catalogs),
  ];
  const labels = inferLabels(next);
  if (!diff.length)
    return {
      calendarId: current.id,
      revision: current.revision,
      labels,
      issues,
      diff,
      actions: { reassigned: [], cancelled: [], kept: [] },
    };

  const revision = current.revision + 1;
  await ctx.tx
    .update(calendars)
    .set({
      ...details,
      config: next as unknown as Record<string, unknown>,
      configVersion: next.version,
      public: next.public,
      labels: [...labels.tags],
      revision,
    })
    .where(eq(calendars.id, current.id));
  await writeMirrors(ctx.tx, ws, current.id, next, catalogs, me);
  await ctx.tx.insert(calendarRevisions).values({
    workspaceId: ws,
    calendarId: current.id,
    revision,
    config: next as unknown as Record<string, unknown>,
    configVersion: next.version,
    labels: [...labels.tags],
    diffSummary: diff as unknown as Record<string, unknown>[],
    changedBy: me,
  });
  const name = details.name ?? current.name;
  await ctx.emit({
    type: 'calendar.updated',
    entityType: 'calendar',
    entityId: current.id,
    payload: {
      labelsBefore: current.labels,
      labelsAfter: labels.tags,
      revision,
      diff,
      ...(args.restoredFrom ? { restoredFrom: args.restoredFrom } : {}),
    },
    before: { name: current.name, revision: current.revision, labels: current.labels.join(', ') },
    after: { name, revision, labels: formatLabels(labels), changes: diff },
  });
  const updated: LoadedCalendar = {
    ...current,
    ...details,
    name,
    config: next,
    public: next.public,
    revision,
    labels: labels.tags,
    timeZone: zone,
  } as LoadedCalendar;
  const active = new Set(catalogs.team.filter((p) => p.active).map((p) => p.userId));
  const actions = await runImpactActions(ctx, updated, analysis, args.impactDecisions, now, active);
  return { calendarId: current.id, revision, labels, issues, diff, actions };
}

// ---- Commands ----

export const calendarCreate = defineCommand({
  name: 'calendar.create',
  description:
    'Create a calendar from an answer to "How do you want this calendar to work?". It starts as a draft; the preset only fills in settings.',
  risk: 1,
  input: CalendarCreateInput,
  output: CalendarCreateOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['calendar.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const zone = input.timezone ?? (await workspaceZone(ctx.tx, ws));
    const config = configFromPreset(input.preset, {
      me,
      teammates: input.teammates,
      services: input.services,
      resources: input.resources,
    });
    const catalogs = await loadCatalogs(ctx.tx, ws, {
      timeZone: zone,
      extraUserIds: catalogIds(config),
    });
    const active = new Set(catalogs.team.filter((p) => p.active).map((p) => p.userId));
    const strangers = input.teammates.filter((u) => !active.has(u));
    if (strangers.length)
      throw HfosError.validation(
        input.teammates
          .map((u, i) => ({ u, i }))
          .filter(({ u }) => !active.has(u))
          .map(({ i }) => ({ path: `teammates.${i}`, message: 'That person isn’t on this team.' })),
      );
    checkReferences(config, catalogs, '');
    const issues = validateCalendar(config, catalogs, await dbNow(ctx.tx));
    const labels = inferLabels(config);
    const slug = await freeSlug(ctx.tx, ws, input.name);
    const [row] = await ctx.tx
      .insert(calendars)
      .values({
        workspaceId: ws,
        name: input.name,
        description: input.description ?? null,
        ...(input.color ? { color: input.color } : {}),
        slug,
        status: 'draft',
        public: config.public,
        config: config as unknown as Record<string, unknown>,
        configVersion: config.version,
        revision: 1,
        labels: [...labels.tags],
        ownerUserId: me,
        timezone: input.timezone ?? null,
        createdBy: me,
      })
      .returning({ id: calendars.id });
    if (!row) throw HfosError.forbidden();
    await writeMirrors(ctx.tx, ws, row.id, config, catalogs, me);
    const preset = CALENDAR_PRESETS.find((p) => p.key === input.preset)!;
    await ctx.tx.insert(calendarRevisions).values({
      workspaceId: ws,
      calendarId: row.id,
      revision: 1,
      config: config as unknown as Record<string, unknown>,
      configVersion: config.version,
      labels: [...labels.tags],
      diffSummary: [`Created from ${preset.name}`] as unknown as Record<string, unknown>[],
      changedBy: me,
    });
    await ctx.emit({
      type: 'calendar.created',
      entityType: 'calendar',
      entityId: row.id,
      payload: { name: input.name, preset: input.preset, labels: labels.tags },
      after: {
        name: input.name,
        slug,
        status: 'draft',
        labels: formatLabels(labels),
        preset: preset.name,
      },
    });
    return { calendarId: row.id, slug, revision: 1, labels, issues };
  },
});

export const calendarSave = defineCommand({
  name: 'calendar.save',
  description:
    'Save a calendar’s settings as a new revision. Refuses a stale draft (revision_conflict), setting conflicts on an active calendar (422), and changes that touch upcoming appointments until each has a decision (impact_review_required).',
  risk: 2,
  input: CalendarSaveInput,
  output: CalendarSaveOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['calendar.updated', 'appointment.reassigned', 'appointment.cancelled'],
  async handler(ctx, input) {
    return saveCalendar(ctx, input);
  },
});

export const calendarRestoreRevision = defineCommand({
  name: 'calendar.restore_revision',
  description:
    'Restore an earlier revision of a calendar’s settings. It is saved again as a new revision, with the same checks as a save.',
  risk: 2,
  input: CalendarRestoreRevisionInput,
  output: CalendarSaveOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['calendar.updated', 'appointment.reassigned', 'appointment.cancelled'],
  async handler(ctx, input) {
    const [rev] = await ctx.tx
      .select({ config: calendarRevisions.config })
      .from(calendarRevisions)
      .where(
        and(
          eq(calendarRevisions.calendarId, input.calendarId),
          eq(calendarRevisions.workspaceId, ctx.scope.workspaceId!),
          eq(calendarRevisions.revision, input.revision),
        ),
      );
    if (!rev) throw HfosError.notFound('Revision not found.');
    return saveCalendar(ctx, {
      calendarId: input.calendarId,
      baseRevision: input.baseRevision,
      draft: parseConfig(rev.config),
      impactDecisions: input.impactDecisions,
      restoredFrom: input.revision,
    });
  },
});

export const calendarSetStatus = defineCommand({
  name: 'calendar.set_status',
  description:
    'Activate, pause, archive or return a calendar to draft. Activating needs its settings free of conflicts.',
  risk: 1,
  input: CalendarSetStatusInput,
  output: CalendarSetStatusOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['calendar.status_changed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadCalendar(ctx.tx, ws, input.calendarId, { forUpdate: true });
    const catalogs = await loadCatalogs(ctx.tx, ws, {
      timeZone: current.timeZone,
      extraUserIds: catalogIds(current.config),
    });
    const issues = validateCalendar(current.config, catalogs, await dbNow(ctx.tx));
    if (current.status === input.status)
      return { calendarId: current.id, status: current.status, issues };
    if (input.status === 'active' && hasBlockingIssues(issues))
      throw issuesError(issues, 'Fix the settings conflicts before turning this calendar on.');
    await ctx.tx
      .update(calendars)
      .set({ status: input.status })
      .where(eq(calendars.id, current.id));
    await ctx.emit({
      type: 'calendar.status_changed',
      entityType: 'calendar',
      entityId: current.id,
      payload: { from: current.status, to: input.status },
      before: { name: current.name, status: current.status },
      after: { name: current.name, status: input.status },
    });
    return { calendarId: current.id, status: input.status, issues };
  },
});

export const calendarSetSlug = defineCommand({
  name: 'calendar.set_slug',
  description:
    'Change a calendar’s link name. The old link keeps working; /book/c/<id> never changes.',
  risk: 1,
  input: CalendarSetSlugInput,
  output: CalendarSetSlugOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: ['calendar.slug_changed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadCalendar(ctx.tx, ws, input.calendarId, { forUpdate: true });
    if (current.slug === input.slug)
      return { calendarId: current.id, slug: current.slug, previousSlug: current.slug };
    const [clash] = await ctx.tx
      .select({ id: calendars.id })
      .from(calendars)
      .where(
        and(
          eq(calendars.workspaceId, ws),
          eq(calendars.slug, input.slug),
          ne(calendars.id, current.id),
        ),
      );
    const taken = () => HfosError.conflict('Another calendar uses that link.', 'slug_taken');
    if (clash) throw taken();
    try {
      await ctx.tx.update(calendars).set({ slug: input.slug }).where(eq(calendars.id, current.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw taken();
      throw e;
    }
    await ctx.emit({
      type: 'calendar.slug_changed',
      entityType: 'calendar',
      entityId: current.id,
      payload: { from: current.slug, to: input.slug },
      before: { name: current.name, slug: current.slug },
      after: { name: current.name, slug: input.slug },
    });
    return { calendarId: current.id, slug: input.slug, previousSlug: current.slug };
  },
});
