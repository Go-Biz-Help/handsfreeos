/**
 * HandsFreeOS support asked to see a business's private records (Real Estate, step 4). The request comes from
 * support's look, a platform event with no business scope, so this reaches into the business the way the look's
 * own audit line does: owners and admins, and the main person on any private record, are emailed to answer.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import { supportAccessRequestedEmail } from '../emails/templates';
import type { EventHandler } from './types';

interface RequestedPayload {
  workspaceId?: string;
  requestId?: string;
  note?: string;
  by?: string;
}

export const onSupportAccessRequested: EventHandler = async (ctx) => {
  const p = ctx.event.payload as RequestedPayload;
  if (!p.workspaceId || !p.requestId) throw new Error('support_access.requested needs a business');
  const [found] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ name: string; organization_id: string; staff: string }>(
      tx,
      sql`select w.name, w.organization_id,
            coalesce(nullif(s.display_name, ''), nullif(u.full_name, ''), 'HandsFreeOS support') as staff
          from app.workspaces w
          left join app.users u on u.id = ${p.by ?? null}::uuid
          left join platform.staff s on s.user_id = u.id
          where w.id = ${p.workspaceId}::uuid`,
    ),
  );
  if (!found) return;
  const scope = { workspaceId: p.workspaceId, organizationId: found.organization_id };
  const people = await asWorker(ctx.db, scope, (tx) =>
    rows<{ email: string }>(
      tx,
      sql`select distinct u.email::text as email from app.users u
          where u.id in (
            select wm.user_id from app.workspace_memberships wm
            where wm.workspace_id = ${p.workspaceId}::uuid and wm.role in ('owner', 'admin')
            union
            select r.owner_user_id from app.custom_records r
            where r.workspace_id = ${p.workspaceId}::uuid and r.kept_to_team and r.owner_user_id is not null
              and r.archived_at is null)
            and private.works_in(u.id, ${p.workspaceId}::uuid)`,
    ),
  );
  const mail = supportAccessRequestedEmail({
    business: found.name,
    staff: found.staff,
    note: p.note ?? '',
    link: `${ctx.webUrl}/app/w/${p.workspaceId}/settings/support-access`,
  });
  for (const person of people) await ctx.mailer.send({ to: person.email, ...mail });
};
