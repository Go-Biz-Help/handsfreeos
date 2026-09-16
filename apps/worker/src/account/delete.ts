/**
 * Deleting an account (M10), the worker's job. `account.delete` records the request in every business the person
 * could reach; each copy adds its business to one `account.delete` job, which waits a few seconds for the rest and
 * then, in order:
 *
 * 1. **Checks first.** The database's own anonymizing is tried and undone: a person who became a business's only owner
 *    since asking is left as they are (and logged), with nothing changed.
 * 2. **Each business.** The person comes off every calendar's team and every per-service override there through
 *    calendar.save (a new revision, as a person's save makes; their upcoming visits are kept as they are, so nothing
 *    reaches a customer on its own), and an active calendar that would be left unbookable is paused first. They come
 *    off each service's staff list through service.update, except a service they were the only one listed for (an
 *    empty list means "everyone", so it stays as it is: booking no longer offers them, because they are on no
 *    calendar's team). The mailboxes they connected are disconnected through mailbox.disconnect.
 * 3. **The profile** (private.anonymize_user): their memberships, cells, devices, receipts and Assistant chats go, their
 *    own calendar is disconnected, and the profile becomes "Former teammate". Everything they worked on stays.
 * 4. **Sign-in** (Supabase Auth, account/auth-admin.ts): every session ends, then sign-in is blocked for good.
 * 5. **A note in each business's log** (`account.deleted`), once.
 * Every step is safe to run again, so a retry carries on where the last try stopped.
 */
import { and, eq, ne } from 'drizzle-orm';
import {
  accountNoteDeleted,
  calendarSave,
  calendarSetStatus,
  executeCommand,
  HfosError,
  mailboxDisconnect,
  parseConfig,
  serviceUpdate,
  type CalendarConfig,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { calendars } from '@hfos/db/schema';
import type { EventHandler } from '../handlers/types';
import { scheduleDebouncedJob, type JobContext, type JobHandler } from '../jobs';
import { systemActor, workerMeta, type TenantScope } from '../services';

export const ACCOUNT_JOBS = {
  /** One per person asking to delete their account. */
  delete: 'account.delete',
} as const;
export const accountDeleteJobKey = (userId: string): string => `account-delete:${userId}`;
/** The job's payload names each business as `ws:<workspace id>` → its organization id. */
export const BUSINESS_KEY = 'ws:';
/** How long the job waits for every business's copy of the request. */
const GATHER_MS = 5_000;

/** The address the profile and the sign-in keep (the same one private.anonymize_user writes). */
export const deletedEmailOf = (userId: string): string =>
  `deleted-${userId.replace(/-/g, '')}@deleted.handsfreeos.invalid`;

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** The rule a trigger raised (its `detail`), from a driver error. */
function pgDetail(e: unknown): string | undefined {
  let err: unknown = e;
  while (err instanceof Error && err.cause instanceof Error) err = err.cause;
  return (err as { detail?: string } | null)?.detail;
}

const businessesOf = (payload: Record<string, unknown>): TenantScope[] =>
  Object.entries(payload).flatMap(([key, organizationId]) => {
    const workspaceId = key.startsWith(BUSINESS_KEY) ? key.slice(BUSINESS_KEY.length) : null;
    return isUuid(workspaceId) && isUuid(organizationId) ? [{ workspaceId, organizationId }] : [];
  });

/**
 * Someone asked to delete their own account, recorded in one of their businesses: that business joins the one job,
 * which waits a few seconds more for the others.
 */
export const onAccountDeletionRequested: EventHandler = async (ctx) => {
  const userId = ((ctx.event.payload ?? {}) as Record<string, unknown>)['userId'];
  const { workspaceId, organizationId } = ctx.scope;
  // Only ever the person themselves.
  if (!isUuid(userId) || userId !== ctx.event.actorId || !workspaceId || !organizationId) return;
  await scheduleDebouncedJob(ctx.tx, {
    kind: ACCOUNT_JOBS.delete,
    dedupeKey: accountDeleteJobKey(userId),
    runAt: new Date(Date.now() + GATHER_MS),
    payload: { userId, [`${BUSINESS_KEY}${workspaceId}`]: organizationId },
    workspaceId: null,
    organizationId: null,
    mergePayload: true,
  });
};

const UNDO = Symbol('undo');

/** Whether anonymizing would be refused (the person is an only owner): tried, and always undone. */
async function onlyOwnerNow(ctx: JobContext, userId: string): Promise<boolean> {
  try {
    await asWorker(ctx.db, {}, async (tx) => {
      await tx.execute(sql`select private.anonymize_user(${userId})`);
      throw UNDO;
    });
  } catch (e) {
    if (e === UNDO || pgDetail(e) === 'user_not_found') return false;
    if (pgDetail(e) === 'last_owner') return true;
    throw e;
  }
  return false;
}

/** The calendar without the person: off its team and every service override, kept as a new revision. */
function withoutPerson(config: CalendarConfig, userId: string): CalendarConfig | null {
  const onTeam = config.team.members.some((m) => m.userId === userId);
  const onService = config.services.items.some((i) => i.overrides.userIds?.includes(userId));
  if (!onTeam && !onService) return null;
  return {
    ...config,
    team: { ...config.team, members: config.team.members.filter((m) => m.userId !== userId) },
    services: {
      ...config.services,
      items: config.services.items.map((i) =>
        i.overrides.userIds?.includes(userId)
          ? {
              ...i,
              overrides: {
                ...i.overrides,
                userIds: i.overrides.userIds.filter((u) => u !== userId),
              },
            }
          : i,
      ),
    },
  };
}

async function leaveCalendar(
  ctx: JobContext,
  scope: TenantScope,
  calendarId: string,
  userId: string,
  meta: RequestMeta,
): Promise<void> {
  const actor = systemActor(scope, userId);
  let decisions: Record<string, 'keep'> = { [`member:${userId}`]: 'keep' };
  for (let attempt = 0; attempt < 5; attempt++) {
    const [cal] = await asWorker(ctx.db, scope, (tx) =>
      tx
        .select({
          status: calendars.status,
          revision: calendars.revision,
          config: calendars.config,
        })
        .from(calendars)
        .where(and(eq(calendars.id, calendarId), eq(calendars.workspaceId, scope.workspaceId))),
    );
    const draft = cal ? withoutPerson(parseConfig(cal.config), userId) : null;
    if (!cal || !draft) return;
    try {
      await executeCommand(
        ctx.db,
        calendarSave,
        {
          workspaceId: scope.workspaceId,
          calendarId,
          baseRevision: cal.revision,
          draft,
          impactDecisions: decisions,
        },
        actor,
        meta,
      );
      return;
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      // Someone saved it in between: read it again.
      if (e.rule === 'revision_conflict') continue;
      // Their upcoming visits (and anything else the review lists) are kept as they are.
      if (e.rule === 'impact_review_required') {
        const impacts = ((e.details as { impacts?: { key: string }[] } | undefined)?.impacts ??
          []) as { key: string }[];
        decisions = { ...decisions, ...Object.fromEntries(impacts.map((i) => [i.key, 'keep'])) };
        continue;
      }
      // Left with nobody to book, an active calendar can't be saved: it is paused first, so booking stops.
      if (e.rule === 'calendar_issues' && cal.status === 'active') {
        await executeCommand(
          ctx.db,
          calendarSetStatus,
          { workspaceId: scope.workspaceId, calendarId, status: 'paused' },
          actor,
          meta,
        );
        continue;
      }
      throw e;
    }
  }
  throw new Error(`could not take a deleted account off calendar ${calendarId}`);
}

/** One business: off its calendars and service staff lists, and the person's mailboxes there disconnected. */
async function leaveBusiness(
  ctx: JobContext,
  scope: TenantScope,
  userId: string,
  meta: RequestMeta,
): Promise<void> {
  const ws = scope.workspaceId;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [exists] = await rows(tx, sql`select 1 from app.workspaces where id = ${ws}`);
    if (!exists) return null;
    const cals = await tx
      .select({ id: calendars.id })
      .from(calendars)
      .where(and(eq(calendars.workspaceId, ws), ne(calendars.status, 'archived')));
    const staffed = await rows<{ service_id: string; staff: string[] }>(
      tx,
      sql`select ss.service_id, array_agg(ss.user_id::text order by ss.user_id) as staff
          from app.service_staff ss join app.services s on s.id = ss.service_id
          where ss.workspace_id = ${ws} and s.archived_at is null
          group by ss.service_id
          having bool_or(ss.user_id = ${userId})`,
    );
    const mailboxes = await rows<{ id: string }>(
      tx,
      sql`select id from app.mailbox_connections
          where workspace_id = ${ws} and user_id = ${userId} and status <> 'disconnected'`,
    );
    return { cals, staffed, mailboxes };
  });
  // The business is gone: nothing to leave.
  if (!found) return;
  const actor = systemActor(scope, userId);
  for (const cal of found.cals) await leaveCalendar(ctx, scope, cal.id, userId, meta);
  for (const s of found.staffed) {
    const rest = s.staff.filter((u) => u !== userId);
    if (!rest.length) continue;
    await executeCommand(
      ctx.db,
      serviceUpdate,
      { workspaceId: ws, serviceId: s.service_id, staffUserIds: rest },
      actor,
      meta,
    );
  }
  for (const m of found.mailboxes)
    await executeCommand(
      ctx.db,
      mailboxDisconnect,
      { workspaceId: ws, connectionId: m.id },
      actor,
      meta,
    );
}

/** `account.delete`: the whole deletion, in the order the module comment gives. */
export const deleteAccountJob: JobHandler = async (ctx) => {
  const userId = ctx.job.payload['userId'];
  if (!isUuid(userId)) return;
  const businesses = businessesOf(ctx.job.payload);
  if (!ctx.authAdmin)
    throw new Error(
      'Deleting an account needs SUPABASE_URL and SUPABASE_SECRET_KEY on the worker, to end sessions and block sign-in',
    );
  const meta = workerMeta(null, ctx.job.id);
  if (await onlyOwnerNow(ctx, userId)) {
    ctx.log.error(
      { userId },
      'an account deletion was not done: the person is now a business’s only owner',
    );
    return;
  }
  for (const b of businesses) await leaveBusiness(ctx, b, userId, meta);
  await asWorker(ctx.db, {}, (tx) =>
    tx.execute(sql`select private.anonymize_user(${userId})`),
  ).catch((e: unknown) => {
    if (pgDetail(e) !== 'user_not_found') throw e;
  });
  await ctx.authAdmin.signOutEverywhere(userId);
  await ctx.authAdmin.blockSignIn(userId, deletedEmailOf(userId));
  for (const b of businesses) {
    const [noted] = await asWorker(ctx.db, b, (tx) =>
      rows(
        tx,
        sql`select 1 from app.events
            where workspace_id = ${b.workspaceId} and event_type = 'account.deleted' and entity_id = ${userId}
            limit 1`,
      ),
    );
    if (noted) continue;
    try {
      await executeCommand(
        ctx.db,
        accountNoteDeleted,
        { workspaceId: b.workspaceId, userId },
        systemActor(b),
        meta,
      );
    } catch (e) {
      // A business deleted in the meantime has nowhere to note it.
      ctx.log.warn(
        { userId, workspaceId: b.workspaceId, err: e },
        'could not note a deleted account',
      );
    }
  }
};

export const accountJobs = {
  [ACCOUNT_JOBS.delete]: deleteAccountJob,
};
