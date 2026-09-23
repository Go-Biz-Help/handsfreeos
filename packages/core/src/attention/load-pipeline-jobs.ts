/**
 * The Action Center's loaders for Automations' pipeline and jobs cards (stage 3b): a deal whose stage is behind
 * what happened (`pipeline_mismatch`), the price a customer heard before going quiet (`quiet_after_price`), and
 * the visits behind the job cards (`job_unconfirmed`, `job_never_completed`, `job_no_address`). Server-only,
 * beside load.ts, which runs them.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { dealFacts } from '../automations/pipeline-load';
import { dealMoveOf } from '../automations/pipeline-roles';
import { automationSettingsOf } from '../automations/settings';
import { uuidArray } from '../calendar/load';
import { money } from '../money/format';
import type { LinkedLeadFacts } from './facts';
import type { AttentionFacts } from './registry';
import { JOB_NEVER_COMPLETED_UNTIL_DAYS } from './detectors/job-never-completed';
import { JOB_NO_ADDRESS_DAYS } from './detectors/job-no-address';
import { QUIET_AFTER_PRICE_UNTIL_DAYS } from './detectors/quiet-after-price';
import { whenLabel } from './wording';

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null, last: string | null): string | null =>
  `${first ?? ''} ${last ?? ''}`.trim() || null;

// ---------- deals ----------

export type DealState = AttentionFacts<'pipeline_mismatch'>['deal'];

/** Each open deal's stage and where what happened says it belongs (null when it's right). */
export async function loadDealStates(
  tx: Tx,
  workspaceId: string,
  leadIds: readonly string[],
  all: boolean,
  rawSettings: Readonly<Record<string, unknown>>,
): Promise<Map<string, DealState>> {
  const deals = await dealFacts(tx, workspaceId, all ? { all: true } : { leadIds });
  const roles = automationSettingsOf(rawSettings).pipeline.roles;
  const out = new Map<string, DealState>();
  for (const d of deals) {
    const move = dealMoveOf(d, d.stages, roles, d.evidence);
    out.set(d.leadId, {
      stageName: d.stages.find((s) => s.id === d.stageId)?.name ?? 'its stage',
      target: move
        ? {
            stageId: move.stage.id,
            stageName: move.stage.name,
            why: move.why,
            at: new Date(move.at).toISOString(),
          }
        : null,
    });
  }
  return out;
}

// ---------- prices ----------

export interface PriceState {
  readonly price: AttentionFacts<'quiet_after_price'>['price'];
  readonly heardFromAt: string | null;
}

const PRICE = /\$\s?\d[\d,]*(?:\.\d{2})?/;

/** "$450" from "It would be $ 450.00 all in", or null. */
export function priceIn(text: string | null): string | null {
  const m = text ? PRICE.exec(text) : null;
  if (!m) return null;
  const digits = m[0].replace(/[$\s,]/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return money(Math.round(n * 100));
}

/**
 * For each open deal with a customer: the latest price they heard since it opened (a quote, or a dollar amount in
 * a text, an email or a call, within the last thirty days), and the last time they wrote or called in.
 */
export async function loadPrices(
  tx: Tx,
  workspaceId: string,
  leads: readonly {
    readonly id: string;
    readonly personId: string | null;
    readonly createdAt: string;
  }[],
  now: Date,
): Promise<Map<string, PriceState>> {
  const withPerson = leads.filter((l) => l.personId);
  if (withPerson.length === 0) return new Map();
  const since = new Date(now.getTime() - QUIET_AFTER_PRICE_UNTIL_DAYS * 86_400_000).toISOString();
  const list = await rows<{
    id: string;
    quote_at: Date | null;
    quote_cents: number | null;
    quote_open: boolean | null;
    said_at: Date | null;
    said_text: string | null;
    said_channel: string | null;
    call_at: Date | null;
    call_text: string | null;
    heard_at: Date | null;
  }>(
    tx,
    sql`select l.id,
          q.sent_at as quote_at, q.total_cents::float8 as quote_cents, q.status = 'sent' as quote_open,
          m.created_at as said_at, m.body_text as said_text, m.channel::text as said_channel,
          k.started_at as call_at, k.transcript as call_text,
          greatest(
            (select max(i.created_at) from app.messages i join app.conversations c on c.id = i.conversation_id
              where c.person_id = l.person_id and i.direction = 'inbound'),
            (select max(ic.started_at) from app.calls ic
              where ic.person_id = l.person_id and ic.direction = 'inbound' and ic.answered_at is not null)
          ) as heard_at
        from app.leads l
        left join lateral (
          select e.sent_at, e.total_cents, e.status from app.estimates e
          where e.workspace_id = l.workspace_id and e.sent_at is not null and e.status <> 'void'
            and (e.lead_id = l.id or (e.lead_id is null and e.person_id = l.person_id))
            and e.sent_at > l.created_at and e.sent_at > ${since}::timestamptz
          order by e.sent_at desc limit 1
        ) q on true
        left join lateral (
          select o.created_at, o.body_text, o.channel from app.messages o
          join app.conversations c on c.id = o.conversation_id
          where c.person_id = l.person_id and o.direction = 'outbound'
            and o.status not in ('failed', 'undelivered', 'bounced')
            and o.body_text ~ '\\$\\s?[0-9]'
            and o.created_at > l.created_at and o.created_at > ${since}::timestamptz
          order by o.created_at desc limit 1
        ) m on true
        left join lateral (
          select kc.started_at, kc.transcript from app.calls kc
          where kc.person_id = l.person_id and kc.answered_at is not null
            and kc.transcript ~ '\\$\\s?[0-9]'
            and kc.started_at > l.created_at and kc.started_at > ${since}::timestamptz
          order by kc.started_at desc limit 1
        ) k on true
        where l.workspace_id = ${workspaceId} and l.id = any(${uuidArray(withPerson.map((l) => l.id))})`,
  );
  const out = new Map<string, PriceState>();
  for (const r of list) {
    const options: NonNullable<PriceState['price']>[] = [];
    if (r.quote_at && r.quote_cents !== null)
      options.push({
        at: iso(r.quote_at)!,
        amount: money(Number(r.quote_cents)),
        via: 'quote',
        open: !!r.quote_open,
      });
    const said = priceIn(r.said_text);
    if (r.said_at && said)
      options.push({
        at: iso(r.said_at)!,
        amount: said,
        via: r.said_channel === 'email' ? 'email' : 'text',
        open: true,
      });
    const heard = priceIn(r.call_text);
    if (r.call_at && heard)
      options.push({ at: iso(r.call_at)!, amount: heard, via: 'call', open: true });
    const latest = options.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
    out.set(r.id, { price: latest, heardFromAt: iso(r.heard_at) });
  }
  return out;
}

// ---------- jobs ----------

export interface JobInfo {
  readonly appointment: AttentionFacts<'job_unconfirmed'>['appointment'];
  readonly title: string;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly lead: LinkedLeadFacts | null;
  readonly assigneeUserId: string | null;
  readonly locationKind: AttentionFacts<'job_no_address'>['locationKind'];
  readonly hasAddress: boolean;
}

/**
 * Visits by id, and in a sweep every one-on-one or group booking (not classes) still scheduled whose time passed
 * within the last thirty days, or that starts within the next few days.
 */
export async function loadJobs(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
  timeZone: string,
): Promise<Map<string, JobInfo>> {
  if (!all && ids.length === 0) return new Map();
  const nowIso = now.toISOString();
  const list = await rows<{
    id: string;
    status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
    starts_at: Date;
    ends_at: Date;
    title: string;
    location_kind: string | null;
    location_address: string | null;
    person_id: string | null;
    first_name: string | null;
    last_name: string | null;
    person_address: boolean;
    assignee: string | null;
    lead_id: string | null;
    lead_value: number | null;
    lead_status: 'open' | 'won' | 'lost' | null;
  }>(
    tx,
    sql`select a.id, a.status::text as status, a.starts_at, a.ends_at, a.title,
          a.location ->> 'kind' as location_kind, a.location ->> 'address' as location_address,
          first.person_id, first.first_name, first.last_name,
          exists (select 1 from app.appointment_attendees aa join app.people p on p.id = aa.person_id
            where aa.appointment_id = a.id and aa.status <> 'cancelled'
              and nullif(btrim(coalesce(p.address_line1, '')), '') is not null) as person_address,
          coalesce((select s.user_id from app.appointment_staff s
            where s.appointment_id = a.id and s.role = 'host' order by s.user_id limit 1),
            (select s.user_id from app.appointment_staff s where s.appointment_id = a.id
              order by s.user_id limit 1),
            a.owner_user_id) as assignee,
          a.lead_id, l.value_cents::float8 as lead_value, l.status::text as lead_status
        from app.appointments a
        left join lateral (
          select aa.person_id, p.first_name, p.last_name from app.appointment_attendees aa
          join app.people p on p.id = aa.person_id
          where aa.appointment_id = a.id and aa.status <> 'cancelled'
          order by aa.created_at limit 1
        ) first on true
        left join app.leads l on l.id = a.lead_id
        where a.workspace_id = ${workspaceId}
          and (a.id = any(${uuidArray(ids)})
            ${
              all
                ? sql`or (a.status = 'scheduled' and a.kind = 'booking' and first.person_id is not null and (
                    (a.ends_at <= ${nowIso}::timestamptz
                      and a.ends_at > ${nowIso}::timestamptz - ${`${JOB_NEVER_COMPLETED_UNTIL_DAYS} days`}::interval)
                    or (a.starts_at > ${nowIso}::timestamptz
                      and a.starts_at <= ${nowIso}::timestamptz + ${`${JOB_NO_ADDRESS_DAYS + 1} days`}::interval)))`
                : sql``
            })`,
  );
  const kinds = new Set(['customer_address', 'business', 'virtual', 'phone']);
  return new Map(
    list.map((r) => {
      const startsAt = iso(r.starts_at)!;
      return [
        r.id,
        {
          appointment: {
            id: r.id,
            status: r.status,
            startsAt,
            endsAt: iso(r.ends_at)!,
            label: `${r.title} · ${whenLabel(Date.parse(startsAt), timeZone)}`,
          },
          title: r.title,
          personId: r.person_id,
          personName: nameOf(r.first_name, r.last_name),
          lead:
            r.lead_id && r.lead_status
              ? { id: r.lead_id, valueCents: Number(r.lead_value ?? 0), status: r.lead_status }
              : null,
          assigneeUserId: r.assignee,
          locationKind: (r.location_kind && kinds.has(r.location_kind)
            ? r.location_kind
            : null) as JobInfo['locationKind'],
          hasAddress: !!r.location_address?.trim() || r.person_address,
        },
      ] as const;
    }),
  );
}
