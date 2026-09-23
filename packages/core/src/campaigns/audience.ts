/**
 * Who an outreach campaign writes to: every customer with one of the picked tags, or an open deal in one of the
 * picked pipeline stages, and why any of them is left out (Chris, 2026-09-23):
 * - no phone, or they haven't said yes to texts (opted in) — a campaign is marketing, so "unknown" isn't enough;
 * - the business texted them in the last 14 days;
 * - they're mid-conversation (waiting on a reply) or have an open card on Home;
 * - they're booked in the next 30 days.
 * The same checks run again when each text goes, so a booking or a STOP in between still counts.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import type { CampaignAudience, SkipReason } from '../schemas/campaign';

/** The most people one campaign writes to. */
export const CAMPAIGN_MAX_RECIPIENTS = 500;
export const TEXTED_RECENTLY_DAYS = 14;
export const BOOKED_SOON_DAYS = 30;

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

/** The facts for a list of people (or everyone the audience picks), as of `now`. */
export async function audienceFacts(
  tx: Tx,
  workspaceId: string,
  pick: { readonly audience: CampaignAudience } | { readonly personIds: readonly string[] },
  now: Date,
  opts: { readonly exceptCampaignId?: string } = {},
): Promise<Map<string, AudienceFacts>> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const which =
    'personIds' in pick
      ? sql`p.id = any(${uuidArray([...pick.personIds])})`
      : sql`(exists (select 1 from app.record_tags rt
                     where rt.record_type = 'person' and rt.record_id = p.id
                       and rt.tag_id = any(${uuidArray([...pick.audience.tagIds])}))
             or exists (select 1 from app.leads l
                        where l.person_id = p.id and l.status = 'open' and l.archived_at is null
                          and l.stage_id = any(${uuidArray([...pick.audience.stageIds])})))`;
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

/** Everyone the audience picks, each with the reason they're left out (or none). */
export async function campaignAudience(
  tx: Tx,
  workspaceId: string,
  audience: CampaignAudience,
  now: Date,
): Promise<AudienceMember[]> {
  const facts = await audienceFacts(tx, workspaceId, { audience }, now);
  return [...facts.entries()].map(([personId, f]) => ({ personId, skipReason: skipReasonOf(f) }));
}

/** Seconds between two texts at a pace. */
export const secondsBetween = (perHour: number): number =>
  Math.max(1, Math.round(3600 / Math.max(1, perHour)));
