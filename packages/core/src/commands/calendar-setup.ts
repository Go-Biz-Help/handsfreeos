/**
 * The guided calendar setup's last screen (the owner, 22 Nov 2026, picks C1 a to C4 b): Make this calendar carries
 * out every answer together. Services added in question 3 are made, and ones changed there change everywhere; a room
 * or equipment named in question 3 is made; then the calendar, its settings, its dates, and opening it for booking.
 * Each part runs as its own command (service.create, calendar.create, calendar.save, session.publish,
 * calendar.set_status), with all its own rules, so nothing here goes around them. Answers that are wrong are refused
 * before anything is made, in the setup's own words.
 */
import { and, eq } from 'drizzle-orm';
import { guidedSetupDrafts } from '@hfos/db/schema';
import type { CatalogService } from '../calendar/catalogs';
import { localInstant } from '../calendar/engine/zoned';
import { loadCatalogs, workspaceZone } from '../calendar/load';
import { ownPersonOrNull } from '../crm/records';
import { HfosError } from '../errors';
import {
  calendarSetupConfig,
  calendarSetupContextFrom,
  calendarSetupKind,
  calendarSetupProblems,
  calendarSetupWhat,
  CalendarSetupSaveInput,
  CalendarSetupSaveOutput,
  type CalendarSetupSaveOutput as SaveOutput,
  type CalendarSetupService,
} from '../guided-setup/calendar';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { calendarCreate, calendarSave, calendarSetStatus } from './calendar';
import { resourceCreate, serviceCreate, serviceUpdate } from './calendar-catalog';
import { sessionPublish } from './appointment';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** What question 3 changed on a service the business has: only those parts are saved. */
function serviceChanges(row: CalendarSetupService, now: CatalogService) {
  const out: { durations?: number[]; priceCents?: number | null; staffUserIds?: string[] } = {};
  // A service with several lengths keeps them: the setup shows them, and Services is where they change.
  if (now.durations.length <= 1 && now.durations[0] !== row.minutes) out.durations = [row.minutes];
  if ((now.priceCents ?? null) !== row.priceCents) out.priceCents = row.priceCents;
  if (!sameSet(now.eligibleUserIds, row.userIds)) out.staffUserIds = [...row.userIds];
  return out;
}

const issueWords = (e: HfosError): string[] => {
  const issues = (e.details as { issues?: { severity: string; message: string }[] } | undefined)
    ?.issues;
  const errors = (issues ?? []).filter((i) => i.severity === 'error').map((i) => `${i.message}.`);
  return errors.length ? errors : [e.message];
};

export const calendarSetupSave = defineCommand({
  name: 'calendar_setup.save',
  description:
    'Make a calendar from the guided calendar setup’s answers, as its Make this calendar does: services added in question 3 are made (and ones changed there change everywhere), a room or equipment named there is made, then the calendar with every answer, its dates for an event, and it opens for booking when open is true. Nothing is made when an answer is wrong.',
  risk: 2,
  input: CalendarSetupSaveInput,
  output: CalendarSetupSaveOutput,
  permission: 'calendars.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const userId = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const a = input.answers;
    const zone = await workspaceZone(ctx.tx, ws);
    const catalogs = await loadCatalogs(ctx.tx, ws, { timeZone: zone });
    const me = await ownPersonOrNull(ctx.tx, ws, userId);
    const setup = calendarSetupContextFrom(catalogs, {
      businessName: '',
      businessAddress: null,
      me,
    });

    const problems = calendarSetupProblems(a, setup, Date.now());
    const needsAccount = problems.find((p) => p.rule === 'needs_payment_account');
    if (needsAccount) throw HfosError.rule('needs_payment_account', 409, needsAccount.message);
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({ path: `answers.${p.field}`, message: p.message })),
        problems[0]!.message,
      );
    const kind = a.kind!;
    const shape = calendarSetupKind(kind);

    // Question 3: the services, made or changed first, so the calendar can name them.
    const serviceIds: Record<string, string> = {};
    let servicesMade = 0;
    if (calendarSetupWhat(a) === 'services')
      for (const row of a.services.filter((s) => s.on)) {
        const staff = shape.who ? row.userIds.filter((u) => a.people.includes(u)) : row.userIds;
        if (!row.id) {
          const made = await executeCommandWithin(ctx, serviceCreate, {
            workspaceId: ws,
            name: row.name.trim(),
            durations: [row.minutes],
            priceCents: row.priceCents,
            staffUserIds: staff,
          });
          serviceIds[row.key] = made.output.serviceId;
          servicesMade += 1;
          continue;
        }
        const now = catalogs.services.find((s) => s.id === row.id);
        if (!now) continue;
        serviceIds[row.key] = row.id;
        const changes = serviceChanges({ ...row, userIds: staff }, now);
        if (Object.keys(changes).length)
          await executeCommandWithin(ctx, serviceUpdate, {
            workspaceId: ws,
            serviceId: row.id,
            ...changes,
          });
      }

    let resourceId: string | null = null;
    if (calendarSetupWhat(a) === 'resource') {
      resourceId = a.resource.id;
      if (!resourceId) {
        const made = await executeCommandWithin(ctx, resourceCreate, {
          workspaceId: ws,
          name: a.resource.name.trim(),
        });
        resourceId = made.output.resourceId;
      }
    }

    // The calendar: made from the kind's starting point, then given every answer as one save.
    const made = await executeCommandWithin(ctx, calendarCreate, {
      workspaceId: ws,
      name: a.name.trim(),
      preset: shape.preset,
      teammates: shape.who ? a.people : [],
      services: Object.values(serviceIds),
      resources: resourceId ? [resourceId] : [],
    });
    const calendarId = made.output.calendarId;
    if (kind !== 'scratch')
      await executeCommandWithin(ctx, calendarSave, {
        workspaceId: ws,
        calendarId,
        baseRevision: made.output.revision,
        draft: calendarSetupConfig(a, setup, { services: serviceIds, resourceId }),
      });

    // An event's dates. Each publishes by itself: one that can't says why, and the rest still go up.
    const dates: SaveOutput['dates'] = [];
    if (shape.when === 'dates')
      for (const d of a.dates) {
        const startsAt = new Date(localInstant(d.date, d.time, zone)).toISOString();
        try {
          await executeCommandWithin(ctx, sessionPublish, {
            workspaceId: ws,
            calendarId,
            startsAt,
            ...(shape.who && a.people.length ? { userIds: a.people.slice(0, 10) } : {}),
            acknowledgeWarnings: true,
          });
          dates.push({ startsAt, published: true, why: null });
        } catch (e) {
          if (!(e instanceof HfosError)) throw e;
          dates.push({ startsAt, published: false, why: e.message });
        }
      }

    // Open for booking, when they ticked it. What still stops it is said, and it stays a draft.
    let status: 'draft' | 'active' = 'draft';
    let blocked: string[] = [];
    if (a.open && kind !== 'scratch')
      try {
        await executeCommandWithin(ctx, calendarSetStatus, {
          workspaceId: ws,
          calendarId,
          status: 'active',
        });
        status = 'active';
      } catch (e) {
        if (!(e instanceof HfosError) || e.rule !== 'calendar_issues') throw e;
        blocked = issueWords(e);
      }

    // The answers are spent: coming back starts a new calendar.
    await ctx.tx
      .delete(guidedSetupDrafts)
      .where(and(eq(guidedSetupDrafts.workspaceId, ws), eq(guidedSetupDrafts.setup, 'calendar')));

    return { calendarId, slug: made.output.slug, status, blocked, servicesMade, dates };
  },
});
