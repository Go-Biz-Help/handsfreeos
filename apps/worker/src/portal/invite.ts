/**
 * The email that lets a client into their portal (Real Estate round two, core). It goes when someone in the
 * business lets them in or sends the link again (`portal.access_given`), from the business, through message.send,
 * so it sits in the client's conversation like any other email the business sends. The link is signed here,
 * because only the worker holds the key; on the business's own address when one is serving.
 */
import { rows, sql } from '@hfos/db/client';
import type { RequestMeta } from '@hfos/core/server';
import { sendEmail } from '../booking/deliver';
import type { EmailText } from '../booking/messages';
import type { EventHandler } from '../handlers/types';
import { publicOrigin } from '../hosting/origin';
import { portalUrl } from './links';

export function portalInviteEmail(input: {
  business: string;
  firstName: string;
  givenBy: string | null;
  link: string;
  resent: boolean;
}): EmailText {
  const who = input.givenBy ? `${input.givenBy} at ${input.business}` : input.business;
  return {
    subject: input.resent
      ? `Your portal link from ${input.business}`
      : `Your private portal with ${input.business}`,
    body: [
      `Hi ${input.firstName || 'there'},`,
      '',
      `${who} set up a private page for you: where things stand, your key dates, what’s on your to-do, and a way to send a message.`,
      '',
      `Open it here: ${input.link}`,
      '',
      'The first time you open it on a phone or computer, we’ll email you a 6-digit code to type in. No password needed.',
      '',
      'If you weren’t expecting this, you can ignore it.',
    ].join('\n'),
  };
}

type AccessRow = {
  public_ref: string;
  link_version: number;
  revoked_at: Date | null;
  first_name: string;
  email: string | null;
  business: string;
  given_by: string | null;
};

export const onPortalAccessGiven: EventHandler = async (ctx) => {
  const p = ctx.event.payload as { accessId?: string; linkVersion?: number; resent?: boolean };
  if (!p.accessId || !ctx.event.workspaceId || !ctx.event.organizationId) return;
  const [a] = await rows<AccessRow>(
    ctx.tx,
    sql`select a.public_ref, a.link_version, a.revoked_at, p.first_name, p.email, w.name as business,
          u.full_name as given_by
        from app.portal_access a
        join app.people p on p.id = a.person_id
        join app.workspaces w on w.id = a.workspace_id
        left join app.users u on u.id = a.given_by
        where a.id = ${p.accessId}`,
  );
  // Turned off since, or a newer link already on its way: nothing to send for this one.
  if (!a || a.revoked_at || a.link_version !== p.linkVersion || !a.email) return;
  const scope = { workspaceId: ctx.event.workspaceId, organizationId: ctx.event.organizationId };
  const origin = await publicOrigin(ctx.tx, scope.workspaceId, ctx.portalLinks.webUrl);
  const link = portalUrl(
    ctx.portalLinks,
    { publicRef: a.public_ref, accessId: p.accessId, linkVersion: a.link_version },
    origin,
  );
  const meta: RequestMeta = {
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
    channel: 'worker',
  };
  const sent = await sendEmail(
    ctx,
    scope,
    a.email,
    portalInviteEmail({
      business: a.business,
      firstName: a.first_name,
      givenBy: a.given_by,
      link,
      resent: !!p.resent,
    }),
    `portal-invite:${ctx.event.id}`,
    meta,
  );
  if ('refused' in sent)
    ctx.log.warn({ accessId: p.accessId, why: sent.refused }, 'portal invite not sent');
};
