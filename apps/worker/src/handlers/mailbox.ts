import { eq, inArray } from 'drizzle-orm';
import { mailboxConnections, users, workspaces } from '@hfos/db/schema';
import { mailboxReconnectEmail } from '../emails/templates';
import { scheduleSync } from '../mailbox/sync';
import { tenantOf } from '../services';
import { managers } from './telephony';
import type { EventHandler } from './types';

/** A mailbox connected, or someone pressed Sync now: check it right away. */
export const onMailboxSyncWanted: EventHandler = async (ctx) => {
  if (ctx.event.entityId) await scheduleSync(ctx.tx, tenantOf(ctx.scope), ctx.event.entityId);
};

/**
 * A mailbox lost access (a password reset, a revoked app, Google's weekly limit while in testing): one email
 * to the person who connected it, or to every owner and admin for a shared mailbox.
 */
export const onMailboxReauthRequired: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [box] = await ctx.tx
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, ctx.event.entityId ?? ''));
  if (!box || box.status !== 'reauth_required') return;
  const recipients =
    box.userId && !box.shared
      ? await ctx.tx
          .select({ email: users.email })
          .from(users)
          .where(inArray(users.id, [box.userId]))
      : (await managers(ctx.tx, scope.workspaceId)).map((u) => ({ email: u.email }));
  const [w] = await ctx.tx
    .select({ timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const content = mailboxReconnectEmail({
    provider: box.provider,
    account: box.accountEmail ?? 'your mailbox',
    lostAt: box.lastSyncedAt ?? box.updatedAt,
    timeZone: w?.timezone ?? 'America/Chicago',
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/email`,
  });
  for (const r of recipients)
    if (r.email) await ctx.mailer.send({ to: String(r.email), ...content });
};
