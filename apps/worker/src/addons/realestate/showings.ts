/**
 * Showings of our listings in the worker (round five, step 8): who hears what, and when.
 *
 * - **Asked for** (`realestate.showing.requested`): the listing agent gets a Home card until it's answered; the
 *   seller gets an email to answer it in their portal, unless the listing confirms on its own.
 * - **Answered** (`realestate.showing.decided`): the card comes down and the buyer's agent hears by email. Once
 *   confirmed, two of the add-on's jobs wait: the access instructions to that agent alone, just before
 *   (`realestate.showing_access`), and the feedback link after (`realestate.showing_feedback`). Each looks again at
 *   where the showing stands when it runs, so a cancelled one sends nothing.
 * - **Feedback** (`realestate.showing.feedback_received`): the listing agent gets a quiet card, and ten minutes on the
 *   AI groups everything buyers said into themes (`realestate.showing_themes`), each quote checked against what was
 *   written.
 * - **ShowingTime's emails** (`message.received`): read into showings and feedback (./showingtime.ts), each to be
 *   checked by a person. ShowingTime does its own asking and sending, so nothing is emailed for those.
 *
 * Emails go out from the business through message.send, as the add-on, so they sit in the Inbox like any other.
 */
import { createHash, randomBytes } from 'node:crypto';
import { addressKey } from '@hfos/core/addons/realestate/homes';
import { listingPagePath } from '@hfos/core/addons/realestate/listing';
import { PROPERTY_TYPE_KEY } from '@hfos/core/addons/realestate/words';
import {
  showingFromEmail,
  showingSent,
  showingThemesSaved,
} from '@hfos/core/addons/realestate/ops/showings';
import {
  SHOWING_THEMES_SCHEMA,
  SHOWING_THEMES_SYSTEM,
  ShowingThemesAnswer,
  showingThemesPrompt,
} from '@hfos/core/addons/realestate/prompts';
import { showingWhen, type ShowingFeedback } from '@hfos/core/addons/realestate/showings';
import { executeCommand, localInstant } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { sendEmail } from '../../booking/deliver';
import { publicOrigin } from '../../hosting/origin';
import type { JobResult } from '../../jobs';
import { portalUrl } from '../../portal/links';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { isShowingTimeEmail, readShowingTimeEmail } from './showingtime';

export const SHOWING_ACCESS = 'realestate.showing_access';
export const SHOWING_FEEDBACK = 'realestate.showing_feedback';
export const SHOWING_THEMES = 'realestate.showing_themes';
/** Buyers' words are grouped this long after the last answer, so a run of them is read once. */
const THEMES_AFTER_MS = 10 * 60_000;
const HOUR = 3_600_000;

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
export const requestCardKey = (showingId: string) => `showing:${showingId}`;

interface ShowingRow extends Record<string, unknown> {
  readonly id: string;
  readonly deal_record_id: string;
  readonly source: 'page' | 'showingtime' | 'agent';
  readonly state: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly agent_name: string;
  readonly brokerage: string | null;
  readonly agent_email: string | null;
  readonly access_sent_at: Date | null;
  readonly feedback_asked_at: Date | null;
  readonly deal_name: string;
  readonly owner_user_id: string | null;
  readonly address: string | null;
  readonly slug: string | null;
  readonly page_state: string | null;
  readonly access: string | null;
  readonly access_hours: number | null;
  readonly feedback_hours: number | null;
  readonly business: string;
  readonly timezone: string;
}

async function showingOf(ctx: AddonScopeContext, showingId: string): Promise<ShowingRow | null> {
  const [s] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<ShowingRow>(
      tx,
      sql`select s.id, s.deal_record_id, s.source, s.state, s.starts_at, s.ends_at, s.agent_name, s.brokerage,
                 s.agent_email, s.access_sent_at, s.feedback_asked_at, r.name as deal_name, r.owner_user_id,
                 (select pr.name from app.relationships rel
                    join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = ${PROPERTY_TYPE_KEY}
                    join app.custom_records pr on pr.id = rel.b_custom_record_id
                   where rel.a_custom_record_id = r.id order by rel.created_at desc limit 1) as address,
                 l.slug, l.page_state, l.showing_access as access, l.showing_access_hours as access_hours,
                 l.showing_feedback_hours as feedback_hours, w.name as business, w.timezone
          from addon_realestate.showings s
          join app.custom_records r on r.id = s.deal_record_id
          join app.workspaces w on w.id = s.workspace_id
          left join addon_realestate.listings l on l.deal_record_id = s.deal_record_id
          where s.id = ${showingId} and s.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!s) return null;
  // Times come back from SQL as text.
  const at = (v: Date | string | null) => (v ? new Date(v) : null);
  return {
    ...s,
    starts_at: at(s.starts_at)!,
    ends_at: at(s.ends_at)!,
    access_sent_at: at(s.access_sent_at),
    feedback_asked_at: at(s.feedback_asked_at),
  };
}

const streetOf = (s: Pick<ShowingRow, 'address' | 'deal_name'>) =>
  s.address?.split(',')[0]?.trim() || s.deal_name;

/** The business's site name, for the listing page's links. */
async function siteOf(ctx: AddonScopeContext): Promise<{ site: string | null; origin: string }> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [b] = await rows<{ slug: string }>(
      tx,
      sql`select slug::text from app.booking_sites where workspace_id = ${ctx.scope.workspaceId}`,
    );
    return {
      site: b?.slug ?? null,
      origin: await publicOrigin(tx, ctx.scope.workspaceId, ctx.webUrl),
    };
  });
}

const email = (
  ctx: AddonScopeContext,
  to: string,
  content: { subject: string; body: string },
  key: string,
) => sendEmail(ctx, ctx.scope, to, content, key, ctx.meta, ctx.actor);

// ---------- asked for ----------

export async function showingRequested(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const id = str(p['showingId']);
  if (!id) return;
  const s = await showingOf(ctx, id);
  if (!s || s.state !== 'requested') return;
  const when = showingWhen(s.starts_at, s.timezone);
  const who = `${s.agent_name}${s.brokerage ? ` (${s.brokerage})` : ''}`;
  const sellers = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      person_id: string;
      first_name: string;
      email: string | null;
      access_id: string | null;
      public_ref: string | null;
      link_version: number | null;
    }>(
      tx,
      sql`select p.id as person_id, p.first_name, p.email::text as email, a.id as access_id, a.public_ref,
                 a.link_version
          from app.relationships rel
          join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
          join app.people p on p.id = rel.a_person_id
          left join app.portal_access a on a.person_id = p.id and a.workspace_id = p.workspace_id
            and a.revoked_at is null
          where rel.b_custom_record_id = ${s.deal_record_id}
          order by rel.created_at`,
    ),
  );
  const inPortal = sellers.filter((x) => x.email && x.access_id && x.public_ref);
  const seller = sellers[0]?.first_name ?? 'the seller';
  await raiseAddonAlert(ctx, {
    key: requestCardKey(s.id),
    severity: 'attention',
    title: `Showing request on ${streetOf(s)}: ${who}, ${when}`.slice(0, 200),
    detail: inPortal.length
      ? `Waiting on ${seller} in their portal. You can answer for them on Showings.`
      : `${seller} isn’t in their portal yet, so answer it for them on Showings.`,
    href: `/a/realestate/deals/${s.deal_record_id}/showings`,
    permission: 'realestate.use',
    customRecordId: s.deal_record_id,
    audienceUserIds: s.owner_user_id ? [s.owner_user_id] : [],
    assigneeUserId: s.owner_user_id,
    dueAt: s.starts_at,
  });
  if (p['fromEmail'] || s.source === 'showingtime') return;
  const { origin } = await siteOf(ctx);
  for (const x of inPortal) {
    const link = portalUrl(
      ctx.portalLinks,
      { publicRef: x.public_ref!, accessId: x.access_id!, linkVersion: x.link_version ?? 1 },
      origin,
    );
    const sent = await email(
      ctx,
      x.email!,
      {
        subject: `A showing request for ${streetOf(s)}: ${when}`,
        body: [
          `Hi ${x.first_name || 'there'},`,
          '',
          `${who} would like to show ${streetOf(s)} to their buyers ${when}.`,
          '',
          `Say yes, no or another time in your portal: ${link}`,
          '',
          `${s.business}`,
        ].join('\n'),
      },
      // One per showing and seller, in message.send's 64 characters.
      `showing-ask:${createHash('sha256').update(`${s.id}:${x.person_id}`).digest('hex').slice(0, 40)}`,
    );
    if ('refused' in sent)
      ctx.log.warn({ showingId: s.id, why: sent.refused }, 'showing request email not sent');
  }
}

// ---------- answered ----------

async function arm(ctx: AddonScopeContext, kind: string, showingId: string, runAt: Date) {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind,
        dedupeKey: `${kind}:${showingId}`,
        runAt,
        payload: { showingId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

export async function showingDecided(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const id = str(p['showingId']);
  if (!id) return;
  await clearAddonAlert(ctx, requestCardKey(id), 'done');
  const s = await showingOf(ctx, id);
  if (!s || s.source === 'showingtime') return;
  const when = showingWhen(s.starts_at, s.timezone);
  const street = streetOf(s);
  const note = str(p['note']);
  if (s.state === 'confirmed') {
    const accessAt = new Date(s.starts_at.getTime() - (s.access_hours ?? 1) * HOUR);
    const feedbackAt = new Date(s.ends_at.getTime() + (s.feedback_hours ?? 1) * HOUR);
    if (s.access) await arm(ctx, SHOWING_ACCESS, s.id, accessAt);
    await arm(ctx, SHOWING_FEEDBACK, s.id, feedbackAt);
  }
  if (!s.agent_email || !['confirmed', 'declined', 'cancelled'].includes(s.state)) return;
  const { site, origin } = await siteOf(ctx);
  const page =
    site && s.slug && s.page_state === 'published'
      ? `${origin}${listingPagePath(site, s.slug)}/showing`
      : null;
  const content =
    s.state === 'confirmed'
      ? {
          subject: `Confirmed: your showing of ${street}, ${when}`,
          body: [
            `Hi ${s.agent_name},`,
            '',
            `Your showing of ${street} ${when} is confirmed.`,
            s.access
              ? `How to get in comes by email ${s.access_hours ? `${s.access_hours} hour${s.access_hours === 1 ? '' : 's'} before` : 'just before'}.`
              : 'The listing agent will tell you how to get in.',
            'Afterwards we’ll ask how it went. It takes two minutes.',
            '',
            s.business,
          ].join('\n'),
        }
      : {
          subject: `${s.state === 'declined' ? 'Not that time' : 'Cancelled'}: your showing of ${street}, ${when}`,
          body: [
            `Hi ${s.agent_name},`,
            '',
            s.state === 'declined'
              ? `The seller can’t do ${when} for ${street}.`
              : `Your showing of ${street} ${when} is cancelled.`,
            ...(note ? ['', note] : []),
            ...(page ? ['', `Pick another time here: ${page}`] : []),
            '',
            s.business,
          ].join('\n'),
        };
  const sent = await email(ctx, s.agent_email, content, `showing-${s.state}:${s.id}`);
  if ('refused' in sent)
    ctx.log.warn({ showingId: s.id, why: sent.refused }, 'showing email not sent');
}

// ---------- just before, and after ----------

export async function showingAccessJob(ctx: AddonJobContext): Promise<JobResult> {
  const id = str(ctx.job.payload['showingId']);
  const s = id ? await showingOf(ctx, id) : null;
  // Cancelled, already sent, or nobody to send it to: nothing to do.
  if (!s || s.state !== 'confirmed' || s.access_sent_at || !s.access || !s.agent_email) return;
  if (s.ends_at.getTime() < ctx.now) return;
  const when = showingWhen(s.starts_at, s.timezone);
  const sent = await email(
    ctx,
    s.agent_email,
    {
      subject: `How to get into ${streetOf(s)} for your showing, ${when}`,
      body: [
        `Hi ${s.agent_name},`,
        '',
        `For your showing of ${streetOf(s)} ${when}:`,
        '',
        s.access,
        '',
        'Please keep this to yourself and your buyers, and leave the home as you found it.',
        '',
        s.business,
      ].join('\n'),
    },
    `showing-access:${s.id}`,
  );
  if ('refused' in sent) {
    ctx.log.warn({ showingId: s.id, why: sent.refused }, 'showing access email not sent');
    return;
  }
  await executeCommand(
    ctx.db,
    showingSent,
    { workspaceId: ctx.scope.workspaceId, showingId: s.id, what: 'access' },
    ctx.actor,
    ctx.meta,
  );
}

export async function showingFeedbackJob(ctx: AddonJobContext): Promise<JobResult> {
  const id = str(ctx.job.payload['showingId']);
  const s = id ? await showingOf(ctx, id) : null;
  if (!s || !['confirmed', 'done'].includes(s.state) || s.feedback_asked_at) return;
  const { site, origin } = await siteOf(ctx);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const link =
    site && s.slug && s.page_state === 'published'
      ? `${origin}${listingPagePath(site, s.slug)}/showing-feedback/${token}`
      : null;
  if (s.agent_email && link) {
    const sent = await email(
      ctx,
      s.agent_email,
      {
        subject: `How did ${streetOf(s)} show?`,
        body: [
          `Hi ${s.agent_name},`,
          '',
          `Thanks for showing ${streetOf(s)} ${showingWhen(s.starts_at, s.timezone)}. How did it go? Two minutes, and it goes to the listing agent:`,
          '',
          link,
          '',
          s.business,
        ].join('\n'),
      },
      `showing-feedback:${s.id}`,
    );
    if ('refused' in sent)
      ctx.log.warn({ showingId: s.id, why: sent.refused }, 'showing feedback email not sent');
  }
  // Over either way: with no link to send, the agent records what they hear.
  await executeCommand(
    ctx.db,
    showingSent,
    {
      workspaceId: ctx.scope.workspaceId,
      showingId: s.id,
      what: 'feedback',
      ...(s.agent_email && link ? { tokenHash } : {}),
    },
    ctx.actor,
    ctx.meta,
  );
}

// ---------- what buyers said ----------

export async function showingFeedbackReceived(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const id = str(p['showingId']);
  const dealId = ctx.event.entityId;
  if (!id || !dealId) return;
  const s = await showingOf(ctx, id);
  if (!s) return;
  const interest = typeof p['interest'] === 'number' ? `: ${p['interest']} of 5` : '';
  await raiseAddonAlert(ctx, {
    key: `showing_feedback:${s.id}`,
    severity: 'info',
    title: `Feedback on ${streetOf(s)} from ${s.agent_name}${interest}`.slice(0, 200),
    detail: 'On Showings. Share it with the seller when you’re ready.',
    href: `/a/realestate/deals/${dealId}/showings`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: s.owner_user_id ? [s.owner_user_id] : [],
    assigneeUserId: s.owner_user_id,
  });
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: SHOWING_THEMES,
        dedupeKey: `${SHOWING_THEMES}:${dealId}`,
        runAt: new Date(Date.now() + THEMES_AFTER_MS),
        payload: { dealId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

/** `realestate.showing_themes`: everything buyers said on a listing, grouped by the AI, every quote theirs. */
export async function showingThemesJob(ctx: AddonJobContext): Promise<JobResult> {
  const dealId = str(ctx.job.payload['dealId']);
  if (!dealId) return;
  const answers = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ feedback: ShowingFeedback }>(
      tx,
      sql`select feedback from addon_realestate.showings
          where workspace_id = ${ctx.scope.workspaceId} and deal_record_id = ${dealId}
            and feedback is not null
          order by feedback_at desc limit 60`,
    ),
  );
  const said = answers
    .map((a) => ({ liked: a.feedback.liked ?? null, pause: a.feedback.pause ?? null }))
    .filter((a) => a.liked || a.pause);
  if (!said.length) return;
  let value: ShowingThemesAnswer;
  try {
    ({ value } = await askStructured(ctx, ctx.scope, {
      system: SHOWING_THEMES_SYSTEM,
      messages: [{ role: 'user', content: showingThemesPrompt(said) }],
      schema: SHOWING_THEMES_SCHEMA,
      zod: ShowingThemesAnswer,
      maxTokens: 900,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    }));
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try; anything else leaves the counts to speak for themselves.
    if (e.retryable && ctx.attempt < 3) throw e;
    ctx.log.warn({ dealId, err: e.message }, 'showing themes not grouped');
    return;
  }
  await executeCommand(
    ctx.db,
    showingThemesSaved,
    {
      workspaceId: ctx.scope.workspaceId,
      dealId,
      // Core keeps only quotes that are in what they wrote.
      themes: value,
    },
    ctx.actor,
    ctx.meta,
  );
}

// ---------- ShowingTime's emails ----------

/** `message.received`: a ShowingTime email about one of our listings, read into its showings. */
export async function showingTimeEmail(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  if (p['channel'] !== 'email' || ctx.event.entityType !== 'message' || !ctx.event.entityId) return;
  const messageId = ctx.event.entityId;
  const [m] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      from_address: string | null;
      subject: string | null;
      body_text: string | null;
      tz: string;
    }>(
      tx,
      sql`select m.from_address, m.subject, m.body_text, w.timezone as tz
          from app.messages m join app.workspaces w on w.id = m.workspace_id
          where m.id = ${messageId} and m.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!m || !isShowingTimeEmail(m.from_address, m.subject)) return;
  // The business can turn reading them off (Deal settings → Connections).
  const [on] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ on: boolean | null }>(
      tx,
      sql`select (settings ->> 'showingTimeEmails')::boolean as on from app.addon_installations
          where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}`,
    ),
  );
  if (on?.on === false) return;
  const read = readShowingTimeEmail(m.subject, m.body_text);
  if (!read) return;
  // The listing it's about: one of ours, by its address.
  const key = addressKey(read.address.split(',')[0] ?? read.address);
  const deals = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ deal_id: string; address: string }>(
      tx,
      sql`select r.id as deal_id, pr.name as address
          from addon_realestate.deals d
          join app.custom_records r on r.id = d.record_id and r.archived_at is null
          join app.relationships rel on rel.a_custom_record_id = r.id
          join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = ${PROPERTY_TYPE_KEY}
          join app.custom_records pr on pr.id = rel.b_custom_record_id
          where d.workspace_id = ${ctx.scope.workspaceId} and d.side = 'listing' and d.outcome is null`,
    ),
  );
  const deal = deals.find((d) => addressKey(d.address.split(',')[0] ?? d.address) === key);
  if (!deal) return;
  const startsAt =
    read.date && read.from
      ? new Date(localInstant(read.date, read.from, m.tz)).toISOString()
      : null;
  const endsAt =
    read.date && read.to ? new Date(localInstant(read.date, read.to, m.tz)).toISOString() : null;
  await executeCommand(
    ctx.db,
    showingFromEmail,
    {
      workspaceId: ctx.scope.workspaceId,
      dealId: deal.deal_id,
      messageId,
      kind: read.kind,
      ...(read.reference ? { externalId: `showingtime:${read.reference}` } : {}),
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt && startsAt && endsAt > startsAt ? { endsAt } : {}),
      ...(read.agentName ? { agentName: read.agentName.slice(0, 120) } : {}),
      ...(read.brokerage ? { brokerage: read.brokerage.slice(0, 120) } : {}),
      ...(read.agentEmail ? { agentEmail: read.agentEmail.slice(0, 254) } : {}),
      ...(read.agentPhone ? { agentPhone: read.agentPhone.slice(0, 40) } : {}),
      ...(read.feedback
        ? {
            feedback: {
              ...read.feedback,
              liked: read.feedback.liked?.slice(0, 1000) ?? null,
              pause: read.feedback.pause?.slice(0, 1000) ?? null,
            },
          }
        : {}),
    },
    ctx.actor,
    ctx.meta,
  );
}
