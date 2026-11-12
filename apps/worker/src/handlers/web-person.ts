/**
 * "Email your web person" (the owner, 2026-11-12): what a business's website needs before the carriers approve its
 * texting, each fix in its own text file (core's website-fixes.ts), emailed to whoever looks after the site.
 *
 * Sent from HandsFreeOS's own address in the business's name ("Shop Your Solar via HandsFreeOS"), because the web
 * person doesn't know us; replies go to whoever pressed Send, who is copied in so they have what went. The files are
 * written now, from the business as it is when it goes: `registration.email_web_person` already refused what couldn't
 * be written, so a refusal here means something changed in between, and the email isn't sent half right.
 */
import {
  HfosError,
  refuseUnwritable,
  WEBSITE_FIX_IDS,
  webPersonEmail,
  websiteFixFactsFrom,
  websiteFixFiles,
  websiteFixSourcesOf,
  type WebsiteFixId,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { escapeHtml } from '../emails/templates';
import { publicOrigin } from '../hosting/origin';
import { tenantOf } from '../services';
import type { EventHandler } from './types';

interface Payload {
  readonly to?: string;
  readonly name?: string | null;
  readonly fixes?: readonly string[];
  readonly formId?: string | null;
  readonly note?: string | null;
}

/** The email's words as HTML: each paragraph its own, line breaks kept. */
function asHtml(text: string, business: string): string {
  const paras = text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="font-size: 15px; line-height: 1.5;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
  return `<div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; background: #ffffff; max-width: 560px; padding: 32px 36px;">${paras}<p style="font-size: 13px; color: #5b616a; line-height: 1.5;">Sent for ${escapeHtml(business)} through HandsFreeOS.</p></div>`;
}

export const onWebPersonEmailed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.event.payload as Payload;
  const to = p.to?.trim();
  const fixes = WEBSITE_FIX_IDS.filter((id): id is WebsiteFixId => !!p.fixes?.includes(id));
  if (!to || fixes.length === 0) return;

  const [sender] = ctx.event.actorId
    ? await rows<{ email: string; full_name: string | null }>(
        ctx.tx,
        sql`select email::text as email, full_name from app.users where id = ${ctx.event.actorId}`,
      )
    : [];
  if (!sender) {
    ctx.log.warn({ eventId: ctx.event.id }, 'web person email: nobody to send it for');
    return;
  }

  let facts;
  try {
    const sources = await websiteFixSourcesOf(ctx.tx, scope.workspaceId, fixes, p.formId ?? null);
    facts = websiteFixFactsFrom(sources, {
      app: ctx.webUrl,
      pages: await publicOrigin(ctx.tx, scope.workspaceId, ctx.webUrl),
    });
    refuseUnwritable(facts, fixes);
  } catch (e) {
    // Changed since it was asked for (the form unpublished, say): trying again won't help, and half right is worse.
    if (!(e instanceof HfosError)) throw e;
    ctx.log.warn({ eventId: ctx.event.id, err: e.message }, 'web person email not sent');
    return;
  }
  const files = websiteFixFiles(facts, fixes);
  const mail = webPersonEmail({
    business: facts.business,
    recipientName: p.name ?? null,
    sender: { name: sender.full_name ?? '', email: sender.email },
    files,
    note: p.note ?? null,
  });
  await ctx.mailer.send({
    to,
    subject: mail.subject,
    text: mail.text,
    html: asHtml(mail.text, facts.business),
    fromName: `${facts.business} via HandsFreeOS`,
    replyTo: sender.email,
    cc: [sender.email],
    attachments: files.map((f) => ({
      filename: f.filename,
      content: Buffer.from(f.text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    })),
  });
};
