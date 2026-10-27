/**
 * What the worker does about the affiliate program (20261027014000): it tells people.
 *
 * - A new application, or one sent again after being turned down: the staff who run the program get an email with
 *   what the person said and a link to Admin → Affiliates. A change while it waits tells nobody.
 * - Approved: the person gets their link and their share. Turned down: a short, kind note.
 *
 * These are HandsFreeOS's own events (`platform.*`), with no business in scope, so the people to tell come from
 * `private.affiliate_to_tell` and `private.affiliate_staff_to_tell`: the worker can't read app.users while it holds
 * no business. Each email is the handler's last step, so a retry sends again only if the send itself failed.
 */
import { affiliateLink, affiliateRateWords } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  affiliateAppliedEmail,
  affiliateApprovedEmail,
  affiliateTurnedDownEmail,
} from '../emails/templates';
import type { EventHandler, HandlerContext } from './types';

type Person = { email: string; first_name: string; name: string; code: string; status: string };

const affiliateOf = (ctx: HandlerContext, affiliateId: string) =>
  asWorker(ctx.db, {}, (tx) =>
    rows<Person>(
      tx,
      sql`select email, first_name, name, code, status from private.affiliate_to_tell(${affiliateId})`,
    ),
  ).then((r) => r[0] ?? null);

const idOf = (ctx: HandlerContext): string | null => {
  const { affiliateId } = ctx.event.payload as { affiliateId?: string };
  return affiliateId ?? null;
};

/** Somebody applied: the staff who decide hear about it. */
export const onAffiliateApplied: EventHandler = async (ctx) => {
  const { created, reapplied } = ctx.event.payload as { created?: boolean; reapplied?: boolean };
  const affiliateId = idOf(ctx);
  if (!affiliateId || !(created || reapplied)) return;
  const person = await affiliateOf(ctx, affiliateId);
  if (!person || person.status !== 'applied') return;
  const [said] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ pitch: string; links: string }>(
      tx,
      sql`select pitch, links from platform.affiliates where id = ${affiliateId}`,
    ),
  );
  const staff = await asWorker(ctx.db, {}, (tx) =>
    rows<{ email: string; first_name: string }>(
      tx,
      sql`select email, first_name from private.affiliate_staff_to_tell()`,
    ),
  );
  for (const to of staff) {
    const email = affiliateAppliedEmail({
      firstName: to.first_name,
      name: person.name,
      email: person.email,
      code: person.code,
      pitch: said?.pitch ?? '',
      links: said?.links ?? '',
      adminLink: `${ctx.webUrl}/admin/affiliates`,
    });
    await ctx.mailer.send({ to: to.email, ...email });
  }
  ctx.log.info({ affiliateId, told: staff.length }, 'affiliate application told to staff');
};

/** Approved: their link and their share. */
export const onAffiliateApproved: EventHandler = async (ctx) => {
  const affiliateId = idOf(ctx);
  if (!affiliateId) return;
  const person = await affiliateOf(ctx, affiliateId);
  if (!person || person.status !== 'approved') return;
  const [rate] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ rate_bp: number }>(
      tx,
      sql`select coalesce(a.rate_bp, s.rate_bp) as rate_bp
          from platform.affiliates a cross join platform.affiliate_settings s where a.id = ${affiliateId}`,
    ),
  );
  const email = affiliateApprovedEmail({
    firstName: person.first_name,
    link: affiliateLink(person.code),
    share: affiliateRateWords(rate?.rate_bp ?? 4000),
    pageLink: `${ctx.webUrl}/affiliate`,
  });
  await ctx.mailer.send({ to: person.email, ...email });
};

/** Turned down: a short note, sent only while that's still the decision. */
export const onAffiliateTurnedDown: EventHandler = async (ctx) => {
  const affiliateId = idOf(ctx);
  if (!affiliateId) return;
  const person = await affiliateOf(ctx, affiliateId);
  if (!person || person.status !== 'turned_down') return;
  await ctx.mailer.send({
    to: person.email,
    ...affiliateTurnedDownEmail({ firstName: person.first_name }),
  });
};

export const affiliateHandlers = {
  'platform.affiliate_applied': [onAffiliateApplied],
  'platform.affiliate_approved': [onAffiliateApproved],
  'platform.affiliate_turned_down': [onAffiliateTurnedDown],
};
