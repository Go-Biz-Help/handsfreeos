/**
 * Who an outreach campaign writes to: every customer with one of the picked tags, or an open deal in one of the
 * picked pipeline stages, and why any of them is left out (Chris, 2026-09-23):
 * - no phone, or they haven't said yes to texts (opted in) — a campaign is marketing, so "unknown" isn't enough;
 * - the business texted them in the last 14 days;
 * - they're mid-conversation (waiting on a reply) or have an open card on Home;
 * - they're booked in the next 30 days.
 * The same checks run again when each text goes, so a booking or a STOP in between still counts.
 *
 * An email campaign (Chris, 2026-09-23: anyone with an email who hasn't unsubscribed) leaves out only:
 * - no email address;
 * - they unsubscribed from this business's campaign email;
 * - their address bounced, complained or was stopped by hand (`app.email_suppressions`);
 * - another campaign emailed them in the last 14 days.
 *
 * A call campaign (Chris, 2026-09-23: only people who agreed to calls in writing) leaves out:
 * - no phone;
 * - no written consent to calls (`people.call_consent` isn't `opted_in`);
 * - another campaign called them in the last 14 days;
 * - they're mid-conversation or have an open card on Home, or they're booked in the next 30 days (as texts).
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import type { CampaignAudience, CampaignChannel, SkipReason } from '../schemas/campaign';

/** The most people one campaign writes to. */
export const CAMPAIGN_MAX_RECIPIENTS = 500;
export const TEXTED_RECENTLY_DAYS = 14;
export const BOOKED_SOON_DAYS = 30;
export const EMAILED_RECENTLY_DAYS = 14;
export const CALLED_RECENTLY_DAYS = 14;

export interface AudienceFacts {
  readonly hasPhone: boolean;
  readonly optedIn: boolean;
  readonly optedOut: boolean;
  readonly textedRecently: boolean;
  readonly inConversation: boolean;
  readonly bookedSoon: boolean;
}

/** The first reason someone is left out, or null when they're in. */
export function skipReasonOf(f: AudienceFacts): SkipReason | null {
  if (!f.hasPhone) return 'no_phone';
  if (!f.optedIn || f.optedOut) return 'not_opted_in';
  if (f.textedRecently) return 'texted_recently';
  if (f.inConversation) return 'in_conversation';
  if (f.bookedSoon) return 'booked_soon';
  return null;
}

export interface AudienceMember {
  readonly personId: string;
  readonly skipReason: SkipReason | null;
}

type Pick = { readonly audience: CampaignAudience } | { readonly personIds: readonly string[] };

/** The people a campaign picks: a list, or everyone with one of the tags or an open deal in one of the stages. */
function whichPeople(pick: Pick) {
  return 'personIds' in pick
    ? sql`p.id = any(${uuidArray([...pick.personIds])})`
    : sql`(exists (select 1 from app.record_tags rt
                   where rt.record_type = 'person' and rt.record_id = p.id
                     and rt.tag_id = any(${uuidArray([...pick.audience.tagIds])}))
           or exists (select 1 from app.leads l
                      where l.person_id = p.id and l.status = 'open' and l.archived_at is null
                        and l.stage_id = any(${uuidArray([...pick.audience.stageIds])})))`;
}

/** The facts for a list of people (or everyone the audience picks), as of `now`. */
export async function audienceFacts(
  tx: Tx,
  workspaceId: string,
  pick: Pick,
  now: Date,
  opts: { readonly exceptCampaignId?: string } = {},
): Promise<Map<string, AudienceFacts>> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const which = whichPeople(pick);
  const list = await rows<{
    id: string;
    has_phone: boolean;
    opted_in: boolean;
    opted_out: boolean;
    texted_recently: boolean;
    in_conversation: boolean;
    booked_soon: boolean;
  }>(
    tx,
    sql`select p.id, p.phone_e164 is not null as has_phone, p.sms_consent = 'opted_in' as opted_in,
          (p.sms_consent = 'opted_out' or exists (
            select 1 from app.opt_outs o
            where o.workspace_id = p.workspace_id and o.counterpart_e164 = p.phone_e164 and o.opted_out)) as opted_out,
          exists (
            select 1 from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.person_id = p.id and m.channel = 'sms' and m.direction = 'outbound'
              and m.occurred_at > ${at} - ${`${TEXTED_RECENTLY_DAYS} days`}::interval
              ${
                opts.exceptCampaignId
                  ? sql`and m.id not in (select r.message_id from app.campaign_recipients r
                                         where r.campaign_id = ${opts.exceptCampaignId}
                                           and r.message_id is not null)`
                  : sql``
              }) as texted_recently,
          (exists (select 1 from app.conversations c
                   where c.person_id = p.id and c.status = 'open' and c.awaiting_reply_since is not null)
           or exists (select 1 from app.attention_items a
                      where a.person_id = p.id and a.state in ('open', 'snoozed'))) as in_conversation,
          exists (select 1 from app.appointment_attendees aa join app.appointments ap on ap.id = aa.appointment_id
                  where aa.person_id = p.id and ap.status = 'scheduled'
                    and ap.starts_at > ${at} and ap.starts_at < ${at} + ${`${BOOKED_SOON_DAYS} days`}::interval)
            as booked_soon
        from app.people p
        where p.workspace_id = ${workspaceId} and p.archived_at is null and ${which}
        order by p.created_at
        limit ${CAMPAIGN_MAX_RECIPIENTS}`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        hasPhone: r.has_phone,
        optedIn: r.opted_in,
        optedOut: r.opted_out,
        textedRecently: r.texted_recently,
        inConversation: r.in_conversation,
        bookedSoon: r.booked_soon,
      },
    ]),
  );
}

export interface EmailAudienceFacts {
  readonly hasEmail: boolean;
  readonly unsubscribed: boolean;
  /** Bounced, complained, or stopped by hand. */
  readonly stopped: boolean;
  readonly emailedRecently: boolean;
}

/** The first reason someone is left out of an email campaign, or null when they're in. */
export function emailSkipReasonOf(f: EmailAudienceFacts): SkipReason | null {
  if (!f.hasEmail) return 'no_email';
  if (f.unsubscribed) return 'unsubscribed';
  if (f.stopped) return 'email_stopped';
  if (f.emailedRecently) return 'emailed_recently';
  return null;
}

/** The email facts for a list of people (or everyone the audience picks), as of `now`. */
export async function emailAudienceFacts(
  tx: Tx,
  workspaceId: string,
  pick: Pick,
  now: Date,
  opts: { readonly exceptCampaignId?: string } = {},
): Promise<Map<string, EmailAudienceFacts>> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const list = await rows<{
    id: string;
    has_email: boolean;
    unsubscribed: boolean;
    stopped: boolean;
    emailed_recently: boolean;
  }>(
    tx,
    sql`select p.id, nullif(btrim(p.email::text), '') is not null as has_email,
          exists (select 1 from app.email_unsubscribes u
                  where u.workspace_id = p.workspace_id and u.address = lower(p.email::text)) as unsubscribed,
          exists (select 1 from app.email_suppressions s
                  where s.workspace_id = p.workspace_id and s.address = lower(p.email::text)
                    and s.released_at is null) as stopped,
          exists (
            select 1 from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.person_id = p.id and m.channel = 'email' and m.direction = 'outbound'
              and m.campaign_recipient_id is not null
              and m.occurred_at > ${at} - ${`${EMAILED_RECENTLY_DAYS} days`}::interval
              ${
                opts.exceptCampaignId
                  ? sql`and m.campaign_recipient_id not in (select r.id from app.campaign_recipients r
                                                             where r.campaign_id = ${opts.exceptCampaignId})`
                  : sql``
              }) as emailed_recently
        from app.people p
        where p.workspace_id = ${workspaceId} and p.archived_at is null and ${whichPeople(pick)}
        order by p.created_at
        limit ${CAMPAIGN_MAX_RECIPIENTS}`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        hasEmail: r.has_email,
        unsubscribed: r.unsubscribed,
        stopped: r.stopped,
        emailedRecently: r.emailed_recently,
      },
    ]),
  );
}

export interface CallAudienceFacts {
  readonly hasPhone: boolean;
  readonly callConsent: boolean;
  readonly calledRecently: boolean;
  readonly inConversation: boolean;
  readonly bookedSoon: boolean;
}

/** The first reason someone is left out of a call campaign, or null when they're in. */
export function callSkipReasonOf(f: CallAudienceFacts): SkipReason | null {
  if (!f.hasPhone) return 'no_phone';
  if (!f.callConsent) return 'no_call_consent';
  if (f.calledRecently) return 'called_recently';
  if (f.inConversation) return 'in_conversation';
  if (f.bookedSoon) return 'booked_soon';
  return null;
}

/** The call facts for a list of people (or everyone the audience picks), as of `now`. */
export async function callAudienceFacts(
  tx: Tx,
  workspaceId: string,
  pick: Pick,
  now: Date,
  opts: { readonly exceptCampaignId?: string } = {},
): Promise<Map<string, CallAudienceFacts>> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const list = await rows<{
    id: string;
    has_phone: boolean;
    call_consent: boolean;
    called_recently: boolean;
    in_conversation: boolean;
    booked_soon: boolean;
  }>(
    tx,
    sql`select p.id, p.phone_e164 is not null as has_phone, p.call_consent = 'opted_in' as call_consent,
          exists (
            select 1 from app.ai_calls ac
            where ac.person_id = p.id and ac.purpose = 'campaign'
              and ac.status in ('queued', 'calling', 'done')
              and ac.created_at > ${at} - ${`${CALLED_RECENTLY_DAYS} days`}::interval
              ${
                opts.exceptCampaignId
                  ? sql`and (ac.campaign_recipient_id is null or ac.campaign_recipient_id not in (
                          select r.id from app.campaign_recipients r where r.campaign_id = ${opts.exceptCampaignId}))`
                  : sql``
              }) as called_recently,
          (exists (select 1 from app.conversations c
                   where c.person_id = p.id and c.status = 'open' and c.awaiting_reply_since is not null)
           or exists (select 1 from app.attention_items a
                      where a.person_id = p.id and a.state in ('open', 'snoozed'))) as in_conversation,
          exists (select 1 from app.appointment_attendees aa join app.appointments ap on ap.id = aa.appointment_id
                  where aa.person_id = p.id and ap.status = 'scheduled'
                    and ap.starts_at > ${at} and ap.starts_at < ${at} + ${`${BOOKED_SOON_DAYS} days`}::interval)
            as booked_soon
        from app.people p
        where p.workspace_id = ${workspaceId} and p.archived_at is null and ${whichPeople(pick)}
        order by p.created_at
        limit ${CAMPAIGN_MAX_RECIPIENTS}`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        hasPhone: r.has_phone,
        callConsent: r.call_consent,
        calledRecently: r.called_recently,
        inConversation: r.in_conversation,
        bookedSoon: r.booked_soon,
      },
    ]),
  );
}

/** Everyone the audience picks, each with the reason they're left out (or none). */
export async function campaignAudience(
  tx: Tx,
  workspaceId: string,
  audience: CampaignAudience,
  now: Date,
  channel: CampaignChannel = 'sms',
): Promise<AudienceMember[]> {
  if (channel === 'call') {
    const facts = await callAudienceFacts(tx, workspaceId, { audience }, now);
    return [...facts.entries()].map(([personId, f]) => ({
      personId,
      skipReason: callSkipReasonOf(f),
    }));
  }
  if (channel === 'email') {
    const facts = await emailAudienceFacts(tx, workspaceId, { audience }, now);
    return [...facts.entries()].map(([personId, f]) => ({
      personId,
      skipReason: emailSkipReasonOf(f),
    }));
  }
  const facts = await audienceFacts(tx, workspaceId, { audience }, now);
  return [...facts.entries()].map(([personId, f]) => ({ personId, skipReason: skipReasonOf(f) }));
}

/** Seconds between two texts at a pace. */
export const secondsBetween = (perHour: number): number =>
  Math.max(1, Math.round(3600 / Math.max(1, perHour)));
