/**
 * An add-on telling people something (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md step 5): a duty running late, a
 * deal at risk. The add-on's worker raises an alert under its own key and clears it when it's dealt with; core puts it
 * on Home (the `addon_alert` card), and on people's phones and in their email.
 *
 * - **Raising again updates it.** The same key is the same alert. When what it says changes (its fingerprint), it's
 *   news again: a snoozed card comes back, an acknowledgement is asked for again, and people are told again.
 * - **Who hears.** Everyone holding the permission it names, or just its audience when it names one, and never
 *   anyone who can't see its record (a private deal, step 4).
 * - **When.** Critical at any hour; the rest while the business is open (its open hours), so an at-risk duty found
 *   at 2 AM waits for the morning. `info` only goes on Home.
 * - **Each person's switches.** Push follows their `addons` switch, email their `addonEmail` one; Home always shows it.
 * - **Turning the add-on off** clears its alerts and cancels any notice still waiting (private.addon_cancel_work).
 *
 * The add-on decides the rest: which severity, when to raise it higher, who the top alerts go to.
 */
import {
  ADDON_ALERT_SEVERITY,
  addonRef,
  addOpenTime,
  openHoursOf,
  whenLabel,
  workspaceMessaging,
  type AddonAlertSeverity,
  type AddonManifest,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { createHash } from 'node:crypto';
import { addonAlertEmail } from '../emails/templates';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { queuePush } from '../push/queue';
import { tenantOf, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { scheduleAddonJob } from './queue';
import type { AddonScopeContext } from './types';

export const ADDON_ALERT_JOBS = {
  /** One per alert and what it says: the push and the email, now or when the business opens. */
  notify: 'addon_alert.notify',
} as const;

export interface AddonAlertInput {
  /** The add-on's own name for it ("duty:<id>:overdue"). The same key is the same alert. */
  readonly key: string;
  readonly severity: AddonAlertSeverity;
  readonly title: string;
  readonly detail?: string | null;
  /** A page of the add-on's: `/a/<its id>/…`. */
  readonly href: string;
  /** One of the add-on's own permissions: who may see it at all. */
  readonly permission: string;
  /** The record it's about. A private one (step 4) keeps it to the people who see that record. */
  readonly customRecordId?: string | null;
  readonly personId?: string | null;
  /** Exactly who it's for (at most 50), among those holding the permission. Empty: all of them. */
  readonly audienceUserIds?: readonly string[];
  readonly assigneeUserId?: string | null;
  readonly dueAt?: Date | null;
  /** It waits for someone to say they've seen it (Acknowledge on its card). */
  readonly needsAck?: boolean;
  /** Push and email as well as Home. Default: all but `info`. */
  readonly notify?: boolean;
  /** When it notifies, email too (to those who want add-on emails). Default: yes; false is a push only. */
  readonly email?: boolean;
}

export interface RaisedAlert {
  readonly alertId: string;
  /** New, back after being cleared, or saying something new: people are told (again). */
  readonly news: boolean;
}

const KEY = /^[\x21-\x7e]{1,200}$/;

/** What an alert says, as a digest: a change is news again. */
function fingerprintOf(input: AddonAlertInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.severity,
        input.title.trim(),
        input.detail?.trim() ?? '',
        input.dueAt?.toISOString() ?? '',
        input.needsAck === true,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/** Why an alert can't be raised as given (a programming error in the add-on, not something a person fixes). */
function problemWith(manifest: AddonManifest, input: AddonAlertInput): string | null {
  if (!KEY.test(input.key)) return 'its key must be 1 to 200 printable characters';
  if (!input.title.trim() || input.title.length > 200)
    return 'its title must be 1 to 200 characters';
  if ((input.detail?.length ?? 0) > 1000) return 'its detail must be at most 1,000 characters';
  if (input.href !== `/a/${manifest.id}` && !input.href.startsWith(`/a/${manifest.id}/`))
    return `it must open one of its own pages (/a/${manifest.id}/…)`;
  if (!manifest.permissions.some((p) => p.key === input.permission))
    return `${input.permission} isn't one of its permissions`;
  if ((input.audienceUserIds?.length ?? 0) > 50) return 'it names more than 50 people';
  return null;
}

/** An alert-changing moment in history: Home looks again at the card, and the add-on's purge redacts it. */
async function recordAlertEvent(
  ctx: AddonScopeContext,
  tx: Tx,
  type: 'addon_alert.raised' | 'addon_alert.updated' | 'addon_alert.cleared',
  alertId: string,
  payload: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  await recordSystemEvent(tx, {
    type,
    action: type,
    organizationId: ctx.scope.organizationId,
    workspaceId: ctx.scope.workspaceId,
    entityType: 'addon_alert',
    entityId: alertId,
    payload: { ...payload, _addon: addonRef(ctx.manifest), _broadcast: false },
    after,
    correlationId: ctx.meta.correlationId,
    causationId: ctx.meta.causationId ?? ctx.meta.correlationId,
    addonId: ctx.manifest.id,
  });
}

/**
 * Raises one of the add-on's alerts, or updates it under the same key. Runs only while the add-on may write here
 * (the table refuses otherwise), and queues its notice when it's news.
 */
export async function raiseAddonAlert(
  ctx: AddonScopeContext,
  input: AddonAlertInput,
): Promise<RaisedAlert> {
  const problem = problemWith(ctx.manifest, input);
  if (problem) throw new Error(`${ctx.manifest.id} can't raise that alert: ${problem}`);
  const fingerprint = fingerprintOf(input);
  const ws = ctx.scope.workspaceId;
  const addon = ctx.manifest.id;
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [before] = await rows<{ id: string; fingerprint: string; cleared: boolean }>(
      tx,
      sql`select id, fingerprint, cleared_at is not null as cleared from app.addon_alerts
          where workspace_id = ${ws} and addon_id = ${addon} and key = ${input.key}
          for update`,
    );
    const news = !before || before.cleared || before.fingerprint !== fingerprint;
    const audience = `{${[...new Set(input.audienceUserIds ?? [])].join(',')}}`;
    const [row] = await rows<{ id: string }>(
      tx,
      sql`insert into app.addon_alerts (workspace_id, addon_id, addon_generation, key, custom_record_id,
            person_id, severity, title, detail, href, permission, audience_user_ids, assignee_user_id, due_at,
            needs_ack, fingerprint)
          values (${ws}, ${addon}, ${ctx.generation}, ${input.key}, ${input.customRecordId ?? null},
            ${input.personId ?? null}, ${input.severity}, ${input.title.trim()}, ${input.detail?.trim() || null},
            ${input.href}, ${input.permission}, ${audience}::uuid[], ${input.assigneeUserId ?? null},
            ${input.dueAt?.toISOString() ?? null}, ${input.needsAck === true}, ${fingerprint})
          on conflict (workspace_id, addon_id, key) do update set
            addon_generation = excluded.addon_generation,
            -- Its record is the one it was first raised about: a key names one thing.
            custom_record_id = coalesce(app.addon_alerts.custom_record_id, excluded.custom_record_id),
            person_id = excluded.person_id, severity = excluded.severity, title = excluded.title,
            detail = excluded.detail, href = excluded.href, permission = excluded.permission,
            audience_user_ids = excluded.audience_user_ids, assignee_user_id = excluded.assignee_user_id,
            due_at = excluded.due_at, needs_ack = excluded.needs_ack, fingerprint = excluded.fingerprint,
            raised_at = case when app.addon_alerts.cleared_at is null then app.addon_alerts.raised_at
                             else now() end,
            -- News asks again for someone to say they've seen it.
            acknowledged_at = case when ${news} then null else app.addon_alerts.acknowledged_at end,
            acknowledged_by = case when ${news} then null else app.addon_alerts.acknowledged_by end,
            cleared_at = null, clear_reason = null
          returning id`,
    );
    const alertId = row!.id;
    await recordAlertEvent(
      ctx,
      tx,
      news ? 'addon_alert.raised' : 'addon_alert.updated',
      alertId,
      { key: input.key, severity: input.severity },
      { title: input.title.trim(), severity: input.severity },
    );
    if (news && (input.notify ?? input.severity !== 'info'))
      await scheduleAddonJob(
        tx,
        { id: addon, generation: ctx.generation },
        {
          kind: ADDON_ALERT_JOBS.notify,
          dedupeKey: `alert:${alertId}:${fingerprint}`,
          runAt: new Date(),
          payload: { alertId, fingerprint, email: input.email !== false },
          workspaceId: ws,
          organizationId: ctx.scope.organizationId,
        },
      );
    return { alertId, news };
  });
}

/**
 * Clears one of the add-on's alerts: its card closes, in the add-on's word for why (`done` counts as handled
 * today). Answers whether there was one to clear.
 */
export async function clearAddonAlert(
  ctx: AddonScopeContext,
  key: string,
  reason = 'done',
): Promise<boolean> {
  if (!/^[a-z][a-z_]{0,39}$/.test(reason))
    throw new Error(`${ctx.manifest.id} can't clear an alert "${reason}": use a word like done`);
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [row] = await rows<{ id: string }>(
      tx,
      sql`update app.addon_alerts set cleared_at = now(), clear_reason = ${reason}
          where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id} and key = ${key}
            and cleared_at is null
          returning id`,
    );
    if (!row) return false;
    await recordAlertEvent(ctx, tx, 'addon_alert.cleared', row.id, { key, reason }, { reason });
    return true;
  });
}

// ---------- telling people ----------

type AlertRow = {
  id: string;
  addon_id: string;
  severity: AddonAlertSeverity;
  title: string;
  detail: string | null;
  href: string;
  permission: string;
  audience_user_ids: string[];
  custom_record_id: string | null;
  person_id: string | null;
  due_at: Date | string | null;
  needs_ack: boolean;
  acknowledged_at: Date | string | null;
  fingerprint: string;
  notified_fingerprint: string | null;
  cleared_at: Date | string | null;
};

type Listener = {
  id: string;
  email: string;
  wants_email: boolean;
};

/** Everyone the alert is for: its permission, its audience, and its record's privacy, in this business. */
async function listenersOf(tx: Tx, ws: string, a: AlertRow): Promise<Listener[]> {
  return rows<Listener>(
    tx,
    sql`select u.id, u.email::text as email,
          coalesce((u.settings -> 'notifications' ->> 'addonEmail')::boolean, true) as wants_email
        from app.users u
        join app.workspace_access wa on wa.user_id = u.id and wa.workspace_id = ${ws}
        where u.deleted_at is null
          and ${a.permission} = any (wa.permissions)
          and (cardinality(${`{${a.audience_user_ids.join(',')}}`}::uuid[]) = 0
               or u.id = any (${`{${a.audience_user_ids.join(',')}}`}::uuid[]))
          and (${a.custom_record_id}::uuid is null or private.user_sees_record(u.id, ${a.custom_record_id}::uuid))
        order by u.id`,
  );
}

/**
 * `addon_alert.notify`: the push and email for one alert, as it says now. Skipped when it was cleared, acknowledged,
 * says something newer (that one's own notice follows), or was already told. Anything but critical waits for the
 * business to open.
 */
export function addonAlertNotifyJob(catalog: readonly AddonManifest[]): JobHandler {
  return async (ctx) => {
    const alertId = String(ctx.job.payload['alertId'] ?? '');
    const fingerprint = String(ctx.job.payload['fingerprint'] ?? '');
    const scope: TenantScope = tenantOf(ctx.scope);
    return asWorker(ctx.db, scope, async (tx) => {
      const [a] = await rows<AlertRow>(
        tx,
        sql`select id, addon_id, severity, title, detail, href, permission, audience_user_ids, custom_record_id,
              person_id, due_at, needs_ack, acknowledged_at, fingerprint, notified_fingerprint, cleared_at
            from app.addon_alerts where id = ${alertId} and workspace_id = ${scope.workspaceId}
            for update`,
      );
      if (!a || a.cleared_at || a.acknowledged_at) return;
      if (a.fingerprint !== fingerprint || a.notified_fingerprint === fingerprint) return;
      const m = await workspaceMessaging(tx, scope.workspaceId);
      const tz = m.timezone || 'UTC';
      if (a.severity !== 'critical') {
        const opensAt = addOpenTime(openHoursOf(m.rawSettings), tz, ctx.now, 0);
        if (opensAt > ctx.now) return { rescheduleAt: new Date(opensAt) };
      }
      const addon = catalog.find((c) => c.id === a.addon_id)?.name ?? 'An add-on';
      const listeners = await listenersOf(tx, scope.workspaceId, a);
      const path = `/app/w/${scope.workspaceId}${a.href}`;
      const due = a.due_at ? new Date(a.due_at).getTime() : null;
      const dueWords =
        due === null ? null : `${due > ctx.now ? 'Due' : 'Was due'} ${whenLabel(due, tz)}.`;
      const mail = addonAlertEmail({
        business: m.name,
        addon,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        due: dueWords,
        needsAck: a.needs_ack,
        link: `${ctx.webUrl}${path}`,
      });
      let failures = 0;
      let emailed = 0;
      const emailToo = ctx.job.payload['email'] !== false;
      for (const l of listeners.filter((x) => emailToo && x.wants_email))
        try {
          await ctx.mailer.send({ to: l.email, ...mail });
          emailed++;
        } catch (e) {
          failures++;
          ctx.log.warn(
            { err: errorMessage(e), userId: l.id },
            'could not send an add-on alert email',
          );
        }
      // Nobody could be reached: the job's retries try again rather than marking it told.
      if (emailed === 0 && failures > 0) throw new Error('could not send the add-on alert email');

      // The push commits with the mark below: a retry that finds it never pushes again.
      const pushed = await queuePush(tx, scope, {
        key: `addon_alert:${a.id}:${fingerprint}`,
        category: 'addon_alert',
        userIds: listeners.map((l) => l.id),
        title: a.title,
        about: addon,
        body: a.detail?.trim() || dueWords || ADDON_ALERT_SEVERITY[a.severity].label,
        path,
        refs: { alertId: a.id, ...(a.person_id ? { personId: a.person_id } : {}) },
        collapseId: `alert-${a.id}`,
      });
      await rows(
        tx,
        sql`update app.addon_alerts set notified_fingerprint = ${fingerprint}, notified_at = now()
            where id = ${a.id}`,
      );
      ctx.log.info({ alertId: a.id, emailed, pushed }, 'told people about an add-on alert');
    });
  };
}
