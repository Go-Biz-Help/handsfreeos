/**
 * Automations' "Re-engage dead leads" (off until an owner reads the message and turns it on): once a day, at
 * 10 AM where the business is, one text in the business's own words to open leads nobody has been in touch with
 * for months (`settings.automations.reengage`: 90 days, at most 20 a day, never again within 180 days).
 *
 * It leaves alone anyone it shouldn't write to out of the blue:
 * - no agreement to texts, a STOP, or no business number ready (message.send and reachOf refuse);
 * - anyone with a message either way since it went cold (someone is talking to them after all);
 * - an AI draft waiting for them, or a workflow running for them;
 * - a lead re-engaged within the cooldown.
 * Lost leads are never touched, only open ones (Chris's call). A reply lands in the inbox like any other, where
 * the AI teammate or a person picks it up. Each one sent is an event on the lead (`lead.reengaged`), which is what
 * the cooldown reads.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  automationSettingsOf,
  defaultNumber,
  formatPhone,
  localDateOf,
  localInstant,
  reengageOn,
  renderNudge,
  STOP_WORDING,
  userNames,
  uuidArray,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { clientIdFor, quietEndAt, reachOf, sendText, wasSent } from '../booking/deliver';
import type { BusinessPlanner } from '../attention/jobs';
import type { JobHandler } from '../jobs';
import { tenantOf, workerMeta } from '../services';
import { recordSystemEvent } from '../system-event';

export const REENGAGE_JOB = 'automations.reengage';
export const reengageJobKey = (workspaceId: string): string => `reengage:${workspaceId}`;
/** When it goes, where the business is: mid-morning, well clear of quiet hours. */
export const REENGAGE_AT = '10:00';
const DAY = 86_400_000;
/** Businesses per statement (four parameters each, well under Postgres's limit). */
const PLAN_CHUNK = 2000;

/** The next 10 AM where the business is, after `now`. */
export function nextReengageAt(now: number, timeZone: string): number {
  const today = localDateOf(now, timeZone);
  const at = localInstant(today, REENGAGE_AT, timeZone);
  return at > now ? at : localInstant(addDays(today, 1), REENGAGE_AT, timeZone);
}

/** Every business has its daily re-engage job waiting (it does nothing while the switch is off). */
export const ensureReengage: BusinessPlanner = async (tx, businesses, now) => {
  for (let i = 0; i < businesses.length; i += PLAN_CHUNK) {
    const chunk = businesses.slice(i, i + PLAN_CHUNK);
    const keys = chunk.map((b) => sql`${reengageJobKey(b.workspaceId)}`);
    const times = chunk.map((b) => sql`${new Date(nextReengageAt(now, b.timeZone)).toISOString()}`);
    await tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select b.org, b.ws, ${REENGAGE_JOB}, b.key, b.at::timestamptz, '{}'::jsonb
          from unnest(${uuidArray(chunk.map((b) => b.workspaceId))},
            ${uuidArray(chunk.map((b) => b.organizationId))},
            array[${sql.join(keys, sql`, `)}]::text[],
            array[${sql.join(times, sql`, `)}]::text[]) as b(ws, org, key, at)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    );
  }
};

interface ColdLead extends Record<string, unknown> {
  lead_id: string;
  title: string;
  person_id: string;
  first_name: string;
  phone_e164: string;
  sms_consent: 'unknown' | 'opted_in' | 'opted_out';
  assignee_user_id: string | null;
}

/** `automations.reengage`: one business's texts for the day, then the next 10 AM. */
export const reengageJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const now = ctx.now;
  const plan = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await rows<{
      name: string;
      timezone: string;
      settings: Record<string, unknown> | null;
    }>(
      tx,
      sql`select name, timezone, settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    if (!ws) return null;
    const timeZone = ws.timezone || 'UTC';
    const s = automationSettingsOf(ws.settings);
    const next = new Date(nextReengageAt(now, timeZone));
    if (!reengageOn(s)) return { next, leads: [] as ColdLead[], ws, settings: s };
    const r = s.reengage;
    const coldSince = new Date(now - r.afterDays * DAY).toISOString();
    const cooledSince = new Date(now - r.cooldownDays * DAY).toISOString();
    const today = new Date(now - DAY).toISOString();
    const [sentToday] = await rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from app.events
          where workspace_id = ${scope.workspaceId} and event_type = 'lead.reengaged'
            and created_at > ${today}::timestamptz`,
    );
    const room = Math.max(0, r.maxPerDay - (sentToday?.n ?? 0));
    if (room === 0) return { next, leads: [] as ColdLead[], ws, settings: s };
    const leads = await rows<ColdLead>(
      tx,
      sql`select l.id as lead_id, l.title, p.id as person_id, p.first_name, p.phone_e164,
            p.sms_consent::text as sms_consent, l.assignee_user_id
          from app.leads l join app.people p on p.id = l.person_id
          where l.workspace_id = ${scope.workspaceId} and l.status = 'open' and l.archived_at is null
            and p.archived_at is null and p.phone_e164 is not null
            -- Only people who agreed to texts and never said STOP, so they don't use up the day's cap.
            and p.sms_consent = 'opted_in'
            and not exists (select 1 from app.opt_outs o where o.workspace_id = l.workspace_id
              and o.counterpart_e164 = p.phone_e164 and o.opted_out)
            and coalesce(l.last_contact_at, l.created_at) < ${coldSince}::timestamptz
            -- Cold for real: no message either way with them since (whatever the lead's last contact says).
            and not exists (select 1 from app.conversations c
              join app.messages msg on msg.conversation_id = c.id
              where c.workspace_id = l.workspace_id and c.person_id = p.id
                and msg.occurred_at > ${coldSince}::timestamptz)
            and not exists (select 1 from app.ai_teammate_drafts d
              join app.conversations c on c.id = d.conversation_id
              where c.person_id = p.id and d.status = 'pending')
            and not exists (select 1 from app.workflow_runs wr
              where wr.workspace_id = l.workspace_id and wr.person_id = p.id and wr.status = 'running')
            -- Not again within the cooldown.
            and not exists (select 1 from app.events e
              where e.workspace_id = l.workspace_id and e.entity_type = 'lead' and e.entity_id = l.id
                and e.event_type = 'lead.reengaged' and e.created_at > ${cooledSince}::timestamptz)
          order by coalesce(l.last_contact_at, l.created_at) desc
          limit ${room}`,
    );
    return { next, leads, ws, settings: s };
  });
  // The business is gone (its jobs go with it).
  if (!plan) return;
  const done = { rescheduleAt: plan.next };
  if (!plan.leads.length) return done;
  const m = await asWorker(ctx.db, scope, async (tx) => ({
    number: await defaultNumber(tx, scope.workspaceId),
    messaging: await workspaceMessaging(tx, scope.workspaceId),
    names: await userNames(
      tx,
      plan.leads.map((l) => l.assignee_user_id).filter((id): id is string => !!id),
    ),
  }));
  // Quiet hours at 10 AM means a business with unusual hours: try again when they end.
  const tz = m.messaging.timezone || 'UTC';
  const end = quietEndAt(m.messaging.settings.quietHours, tz, now);
  if (end !== null) return { rescheduleAt: new Date(end + 15 * 60_000) };
  const day = localDateOf(now, tz);
  for (const lead of plan.leads) {
    const reach = await asWorker(ctx.db, scope, (tx) =>
      reachOf(
        tx,
        scope.workspaceId,
        {
          phone: lead.phone_e164,
          email: null,
          smsOk: false,
          personConsent: lead.sms_consent,
        },
        { text: true, email: false },
      ),
    );
    if (reach.text !== null) continue;
    const sender = lead.assignee_user_id ? m.names.get(lead.assignee_user_id) : null;
    const rendered = renderNudge(plan.settings.reengage.template, {
      firstName: lead.first_name,
      businessName: plan.ws.name,
      leadTitle: lead.title,
      senderName: sender?.split(/\s+/)[0] ?? null,
      businessPhone: m.number ? formatPhone(m.number.e164) : null,
    });
    if (rendered.missing.length) continue;
    const text =
      reach.firstText && !/\bSTOP\b/.test(rendered.text)
        ? `${rendered.text} ${STOP_WORDING}`
        : rendered.text;
    const meta = workerMeta(null, ctx.job.id);
    const sent = await sendText(
      ctx,
      scope,
      lead.phone_e164,
      text,
      clientIdFor('reengage', lead.lead_id, day),
      meta,
    );
    if (!wasSent(sent)) continue;
    await asWorker(ctx.db, scope, (tx) =>
      recordSystemEvent(tx, {
        type: 'lead.reengaged',
        action: 'automations.reengage',
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        entityType: 'lead',
        entityId: lead.lead_id,
        payload: { personId: lead.person_id, messageId: sent.messageId, _broadcast: false },
        after: { reengaged: lead.title },
        correlationId: meta.correlationId ?? randomUUID(),
        causationId: ctx.job.id,
      }),
    );
  }
  return done;
};
