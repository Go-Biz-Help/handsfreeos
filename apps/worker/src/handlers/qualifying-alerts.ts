/**
 * The AI teammate's qualifying alerts (20261018000400), to the people its settings name ("Tell"): an email each, and a
 * push on the `qualifying` switch. Two moments share them:
 *
 * - **A file came in** for a file question (`file.received`, file-received.ts): the people the question names.
 * - **A lead qualified** (`lead.qualified`, here): the people "When a lead qualifies → Tell" names. That setting was
 *   saved and shown from M7 on but told nobody until now.
 *
 * Once per event: a marker event, written after the emails, stops a retry emailing anyone twice; the push goes in a
 * savepoint, so one that can't be queued never costs the emails. Whoever did it themselves (a person who recorded the
 * last answer) hears nothing about it.
 */
import {
  isWorkspaceUser,
  LeadQualification,
  loadTeammate,
  teammateConfigOf,
  uuidArray,
  type NotifyWho,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { leadQualifiedEmail, type EmailContent } from '../emails/templates';
import { errorMessage } from '../outbox';
import { personActor, personName } from '../push/moment';
import { queuePush, type PushMoment } from '../push/queue';
import { tenantOf, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { workspaceManagers } from './telephony';
import type { HandlerContext } from './types';

export interface Recipient {
  readonly id: string;
  readonly email: string;
}

/**
 * The people a "Tell" reaches who still work here: owners and admins, the lead's assignee, the customer's owner, or
 * the people it names. Never `except`, who did it themselves.
 */
export async function recipientsOf(
  tx: Tx,
  workspaceId: string,
  who: NotifyWho,
  about: { readonly leadId: string | null; readonly personId: string | null },
  except: string | null = null,
): Promise<Recipient[]> {
  const usersById = async (ids: readonly (string | null | undefined)[]) => {
    const here: string[] = [];
    for (const id of new Set(ids.filter((v): v is string => typeof v === 'string')))
      if (await isWorkspaceUser(tx, workspaceId, id)) here.push(id);
    if (!here.length) return [];
    return rows<{ id: string; email: string }>(
      tx,
      sql`select id, email::text as email from app.users where id = any(${uuidArray(here)}) order by email`,
    );
  };
  let people: Recipient[] = [];
  switch (who.kind) {
    case 'admins':
      people = (await workspaceManagers(tx, workspaceId)).map((u) => ({
        id: u.id,
        email: u.email,
      }));
      break;
    case 'users':
      people = await usersById(who.userIds.map((v) => (typeof v === 'string' ? v : null)));
      break;
    case 'lead_assignee': {
      if (!about.leadId) break;
      const [l] = await rows<{ assignee_user_id: string | null }>(
        tx,
        sql`select assignee_user_id from app.leads where id = ${about.leadId} and workspace_id = ${workspaceId}`,
      );
      people = await usersById([l?.assignee_user_id]);
      break;
    }
    case 'person_owner': {
      if (!about.personId) break;
      const [p] = await rows<{ owner_user_id: string | null }>(
        tx,
        sql`select owner_user_id from app.people where id = ${about.personId} and workspace_id = ${workspaceId}`,
      );
      people = await usersById([p?.owner_user_id]);
      break;
    }
  }
  return people.filter((p) => p.id !== except);
}

/** Whether this event's alert went out already (a retry). */
export async function toldAlready(ctx: HandlerContext, marker: string): Promise<boolean> {
  const [done] = await rows(
    ctx.tx,
    sql`select 1 from app.events where causation_id = ${ctx.event.id} and event_type = ${marker} limit 1`,
  );
  return !!done;
}

/** The push in a savepoint, then an email each, then the marker that says they went. */
export async function sendAlert(
  ctx: HandlerContext,
  scope: TenantScope,
  alert: {
    readonly marker: string;
    readonly action: string;
    readonly people: readonly Recipient[];
    readonly push: Omit<PushMoment, 'userIds'>;
    readonly mail: EmailContent;
    readonly after: Record<string, unknown>;
  },
): Promise<void> {
  const userIds = alert.people.map((p) => p.id);
  try {
    await ctx.tx.transaction((sp) => queuePush(sp, scope, { ...alert.push, userIds }));
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), action: alert.action }, 'could not queue a push');
  }
  const emailed: string[] = [];
  for (const p of alert.people)
    try {
      await ctx.mailer.send({ to: p.email, ...alert.mail });
      emailed.push(p.email);
    } catch (e) {
      ctx.log.warn({ err: errorMessage(e), userId: p.id, action: alert.action }, 'could not email');
    }
  await recordSystemEvent(ctx.tx, {
    type: alert.marker,
    action: alert.action,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    entityType: ctx.event.entityType,
    entityId: ctx.event.entityId,
    payload: { userIds, _broadcast: false },
    after: { emailed, ...alert.after },
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
}

// ---------- a lead qualified ----------

const QUALIFIED_TOLD = 'lead.qualified_told';

/** `lead.qualified`: whoever "When a lead qualifies → Tell" names hears, with the answers that qualified it. */
export async function onLeadQualified(ctx: HandlerContext): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const ws = scope.workspaceId;
  const leadId = ctx.event.entityId;
  if (!leadId) return;
  const teammate = await loadTeammate(ctx.tx, ws);
  const who = teammate ? teammateConfigOf(teammate).qualify.whenQualified.notify : null;
  if (!who || (await toldAlready(ctx, QUALIFIED_TOLD))) return;
  const [lead] = await rows<{
    title: string;
    person_id: string | null;
    company: string | null;
    qualification: unknown;
  }>(
    ctx.tx,
    sql`select l.title, l.person_id, c.name as company, l.qualification from app.leads l
        left join app.companies c on c.id = l.company_id
        where l.id = ${leadId} and l.workspace_id = ${ws}`,
  );
  if (!lead) return;
  const people = await recipientsOf(
    ctx.tx,
    ws,
    who,
    { leadId, personId: lead.person_id },
    personActor(ctx),
  );
  if (!people.length) return;
  const customer = (await personName(ctx.tx, lead.person_id)) ?? lead.company ?? 'A customer';
  const q = LeadQualification.safeParse(lead.qualification ?? {});
  const answers = q.success
    ? Object.values(q.data.answers)
        .sort((a, b) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt))
        .map((a) => ({ question: a.question, answer: a.answer }))
    : [];
  const path = `/app/w/${ws}/leads/${leadId}`;
  await sendAlert(ctx, scope, {
    marker: QUALIFIED_TOLD,
    action: 'lead.qualified_tell',
    people,
    push: {
      key: `qualified:${ctx.event.id}`,
      category: 'lead_qualified',
      title: `Qualified · ${customer}`,
      body: answers.length
        ? `${lead.title}: ${answers.map((a) => a.answer).join(' · ')}`
        : lead.title,
      path,
      refs: { leadId, ...(lead.person_id ? { personId: lead.person_id } : {}) },
    },
    mail: leadQualifiedEmail({
      customer,
      lead: lead.title,
      answers,
      teammate: teammate?.name ?? null,
      link: `${ctx.webUrl}${path}`,
    }),
    after: { lead: lead.title },
  });
}
