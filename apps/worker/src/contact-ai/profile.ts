/**
 * What the AI reads about one customer before it decides their tags and details (0107): who they are, the tags on
 * them now and who put each on, their deals, visits, money, forms and notes, and their conversations and calls,
 * newest last. Everything the customer or the team wrote is quoted as data.
 *
 * It also works out the text a detail must be found in (`trustedText`): what the customer and the team wrote or
 * said, never a website chat whose visitor didn't prove who they are, and never what the AI teammate wrote.
 */
import {
  formatPhone,
  otherEmailsOf,
  otherPhonesOf,
  type ContactAiSnapshot,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';

/** The most messages it reads, and how much of each. */
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 600;
const MAX_TRANSCRIPT_CHARS = 2000;
const MAX_CONVERSATION_CHARS = 14_000;

export interface ProfileLine {
  /** When, as the business reads it. */
  readonly at: string;
  /** Who: "the customer", "the team", "the AI teammate", "a website visitor (not verified)". */
  readonly who: string;
  /** How: text, email, website chat, call. */
  readonly how: string;
  readonly words: string;
}

export interface ContactProfile {
  readonly personId: string;
  readonly archived: boolean;
  readonly snapshot: ContactAiSnapshot;
  /** Plain facts about them, a line each (quoted where a person wrote them). */
  readonly facts: readonly string[];
  /** Their deals, visits, money and forms, a line each. */
  readonly history: readonly string[];
  readonly conversation: readonly ProfileLine[];
  readonly notes: readonly string[];
  /** Where a detail the AI writes must be found (see the file's header). */
  readonly trustedText: string;
  /** Whether there is anything to go on beyond their name. */
  readonly hasHistory: boolean;
}

interface PersonRow extends Record<string, unknown> {
  first_name: string;
  last_name: string;
  email: string | null;
  phone_e164: string | null;
  other_emails: unknown;
  other_phones: unknown;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  source: string | null;
  notes: string | null;
  company: string | null;
  custom: Record<string, unknown> | null;
  created_at: Date;
  archived: boolean;
  tz: string | null;
}

const clip = (s: string | null | undefined, max: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const money = (cents: number | string | null): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(cents ?? 0) / 100);

function dayIn(at: Date | string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** The customer, as the AI reads them; null when they aren't in this business. */
export async function loadContactProfile(
  tx: Tx,
  workspaceId: string,
  personId: string,
): Promise<ContactProfile | null> {
  const [p] = await rows<PersonRow>(
    tx,
    sql`select p.first_name, p.last_name, p.email::text as email, p.phone_e164, p.other_emails, p.other_phones,
          p.address_line1, p.address_line2, p.city, p.state, p.postal_code, p.source, p.notes, c.name as company,
          p.custom, p.created_at, p.archived_at is not null as archived, w.timezone as tz
        from app.people p join app.workspaces w on w.id = p.workspace_id
        left join app.companies c on c.id = p.company_id
        where p.id = ${personId} and p.workspace_id = ${workspaceId}`,
  );
  if (!p) return null;
  const tz = p.tz || 'UTC';
  const day = (at: Date | string) => dayIn(at, tz);

  const tags = await rows<{ id: string; name: string; by_person: boolean }>(
    tx,
    sql`select t.id, t.name::text as name, rt.created_by is not null as by_person
        from app.record_tags rt join app.tags t on t.id = rt.tag_id
        where rt.workspace_id = ${workspaceId} and rt.record_type = 'person' and rt.record_id = ${personId}
        order by t.name`,
  );
  const custom = p.custom ?? {};
  const fields = (
    await rows<{ id: string; label: string }>(
      tx,
      sql`select f.id, f.label from app.custom_fields f
          where f.workspace_id = ${workspaceId} and f.entity = 'person' and f.archived_at is null
          order by f.position limit 60`,
    )
  )
    .filter((f) => custom[f.id] !== undefined && custom[f.id] !== null && custom[f.id] !== '')
    .slice(0, 30)
    .map((f) => ({ label: f.label, value: custom[f.id] }));
  const snapshot: ContactAiSnapshot = {
    firstName: p.first_name,
    lastName: p.last_name,
    email: p.email,
    phoneE164: p.phone_e164,
    otherEmails: otherEmailsOf(p.other_emails),
    otherPhones: otherPhonesOf(p.other_phones),
    address: {
      line1: p.address_line1,
      line2: p.address_line2,
      city: p.city,
      state: p.state,
      postalCode: p.postal_code,
    },
    tags: tags.map((t) => ({ id: t.id, name: t.name, byPerson: t.by_person })),
  };

  const address = [p.address_line1, p.address_line2, p.city, p.state, p.postal_code]
    .filter(Boolean)
    .join(', ');
  const facts = [
    `Name: ${[p.first_name, p.last_name].filter(Boolean).join(' ') || 'unknown'}`,
    `Email: ${p.email ?? 'none'}`,
    `Phone: ${p.phone_e164 ? formatPhone(p.phone_e164) : 'none'}`,
    ...(snapshot.otherEmails.length
      ? [`Other emails: ${snapshot.otherEmails.map((e) => e.email).join(', ')}`]
      : []),
    ...(snapshot.otherPhones.length
      ? [`Other numbers: ${snapshot.otherPhones.map((o) => formatPhone(o.phone)).join(', ')}`]
      : []),
    `Address: ${address || 'none'}`,
    ...(p.company ? [`Company: ${p.company}`] : []),
    ...(p.source ? [`Came from: ${p.source}`] : []),
    `Customer since: ${day(p.created_at)}`,
    `Tags now: ${
      tags.length
        ? tags
            .map(
              (t) => `${t.name} (${t.by_person ? 'put on by the team' : 'put on by HandsFreeOS'})`,
            )
            .join(', ')
        : 'none'
    }`,
    ...fields.map(
      (f) =>
        `${f.label}: ${clip(typeof f.value === 'string' ? f.value : JSON.stringify(f.value), 200)}`,
    ),
  ];

  const history: string[] = [];
  const leads = await rows<{
    title: string;
    status: string;
    stage: string | null;
    value_cents: string | number;
    source: string | null;
    created_at: Date;
    won_at: Date | null;
    lost_at: Date | null;
    lost_reason: string | null;
  }>(
    tx,
    sql`select l.title, l.status, s.name as stage, l.value_cents, l.source, l.created_at, l.won_at, l.lost_at,
          l.lost_reason
        from app.leads l left join app.pipeline_stages s on s.id = l.stage_id
        where l.workspace_id = ${workspaceId} and l.person_id = ${personId} and l.archived_at is null
        order by l.created_at desc limit 10`,
  );
  for (const l of leads)
    history.push(
      `Deal “${clip(l.title, 120)}”: ${
        l.status === 'won'
          ? `won ${l.won_at ? day(l.won_at) : ''}`
          : l.status === 'lost'
            ? `lost ${l.lost_at ? day(l.lost_at) : ''}${l.lost_reason ? ` (${clip(l.lost_reason, 120)})` : ''}`
            : `open, in ${l.stage ?? 'a stage'}`
      }, ${money(l.value_cents)}, opened ${day(l.created_at)}${l.source ? `, from ${l.source}` : ''}`,
    );
  const visits = await rows<{
    title: string | null;
    service: string | null;
    starts_at: Date;
    status: string;
    seat: string;
  }>(
    tx,
    sql`select a.title, sv.name as service, a.starts_at, a.status, aa.status as seat
        from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
        left join app.services sv on sv.id = a.service_id
        where aa.workspace_id = ${workspaceId} and aa.person_id = ${personId}
        order by a.starts_at desc limit 10`,
  );
  for (const v of visits)
    history.push(
      `Visit ${day(v.starts_at)}: ${clip(v.service ?? v.title ?? 'appointment', 100)} (${
        v.seat === 'cancelled' || v.status === 'cancelled'
          ? 'cancelled'
          : v.seat === 'no_show' || v.status === 'no_show'
            ? 'no-show'
            : v.status === 'completed' || v.seat === 'attended'
              ? 'done'
              : new Date(v.starts_at).getTime() > Date.now()
                ? 'booked'
                : 'happened'
      })`,
    );
  const [bills] = await rows<{
    paid: string | number;
    owed: string | number;
    invoices: number;
    paid_count: number;
  }>(
    tx,
    sql`select coalesce(sum(amount_paid_cents - amount_refunded_cents), 0) as paid,
          coalesce(sum(balance_cents) filter (where status in ('sent', 'partly_paid', 'overdue')), 0) as owed,
          count(*)::int as invoices, count(*) filter (where status = 'paid')::int as paid_count
        from app.invoices where workspace_id = ${workspaceId} and person_id = ${personId} and status <> 'void'
          and status <> 'draft'`,
  );
  if (bills && bills.invoices > 0)
    history.push(
      `Money: paid ${money(bills.paid)} in all (${bills.paid_count} of ${bills.invoices} invoices paid), ${money(bills.owed)} owed now`,
    );
  const estimates = await rows<{
    title: string | null;
    status: string;
    total_cents: string | number;
    at: Date;
  }>(
    tx,
    sql`select title, status, total_cents, coalesce(sent_at, created_at) as at from app.estimates
        where workspace_id = ${workspaceId} and person_id = ${personId} and status not in ('draft', 'void')
        order by created_at desc limit 5`,
  );
  for (const e of estimates)
    history.push(
      `Quote ${day(e.at)}: ${clip(e.title ?? 'estimate', 100)}, ${money(e.total_cents)}, ${e.status}`,
    );
  const plans = await rows<{ plan_name: string; status: string }>(
    tx,
    sql`select plan_name, status from app.subscriptions
        where workspace_id = ${workspaceId} and person_id = ${personId} and status <> 'draft'
        order by created_at desc limit 5`,
  );
  for (const s of plans) history.push(`Plan: ${clip(s.plan_name, 100)} (${s.status})`);
  const forms = await rows<{ response_id: string; form: string; at: Date; answers: string | null }>(
    tx,
    sql`select r.id as response_id, f.name as form, r.completed_at as at,
          (select string_agg(a.question_title || ': ' || coalesce(a.text_value, array_to_string(a.choice_labels, ', '),
             a.number_value::text, a.value::text), E'\n' order by a.answered_at)
           from app.form_answers a where a.response_id = r.id) as answers
        from app.form_responses r join app.forms f on f.id = r.form_id
        where r.workspace_id = ${workspaceId} and r.person_id = ${personId} and r.status = 'completed'
        order by r.completed_at desc limit 3`,
  );
  const trusted: string[] = [];
  for (const f of forms) {
    history.push(`Form “${clip(f.form, 100)}” filled in ${day(f.at)}:\n${clip(f.answers, 1500)}`);
    if (f.answers) trusted.push(f.answers);
  }

  const notes = await rows<{ body: string | null; at: Date }>(
    tx,
    sql`select body, occurred_at as at from app.activities
        where workspace_id = ${workspaceId} and person_id = ${personId} and kind = 'note' and body is not null
        order by occurred_at desc limit 10`,
  );
  const noteLines = notes.map((n) => `${day(n.at)}: ${clip(n.body, 400)}`);
  for (const n of notes) if (n.body) trusted.push(n.body);
  if (p.notes) {
    noteLines.unshift(`On file: ${clip(p.notes, 800)}`);
    trusted.push(p.notes);
  }

  const messages = await rows<{
    at: Date;
    channel: 'sms' | 'email' | 'chat';
    direction: 'inbound' | 'outbound';
    subject: string | null;
    body: string | null;
    by_person: boolean;
    by_ai: boolean;
    verified: boolean;
  }>(
    tx,
    sql`select * from (
          select m.created_at as at, m.channel, m.direction, m.subject, m.body_text as body,
            m.sent_by is not null as by_person, m.sent_by_teammate_id is not null as by_ai,
            c.channel <> 'chat' or exists (select 1 from app.chat_visitors v
              where v.conversation_id = c.id and v.verified_person_id = ${personId}) as verified
          from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.workspace_id = ${workspaceId} and c.person_id = ${personId}
            and coalesce(m.body_text, '') <> ''
          order by m.created_at desc limit ${MAX_MESSAGES}) x
        order by x.at`,
  );
  const calls = await rows<{
    at: Date;
    direction: 'inbound' | 'outbound';
    seconds: number | null;
    voicemail: boolean;
    transcript: string | null;
  }>(
    tx,
    sql`select started_at as at, direction, duration_seconds as seconds, is_voicemail as voicemail, transcript
        from app.calls where workspace_id = ${workspaceId} and person_id = ${personId}
        order by started_at desc limit 5`,
  );
  const HOW = { sms: 'text', email: 'email', chat: 'website chat' } as const;
  const lines: (ProfileLine & { t: number })[] = [
    ...messages.map((m) => {
      const words = [m.subject, m.body].filter(Boolean).join('\n');
      const who =
        m.direction === 'inbound'
          ? m.verified
            ? 'the customer'
            : 'a website visitor (not verified)'
          : m.by_ai
            ? 'the AI teammate'
            : m.by_person
              ? 'the team'
              : 'HandsFreeOS (automatic)';
      if (m.verified && (m.direction === 'inbound' || m.by_person)) trusted.push(words);
      return {
        t: new Date(m.at).getTime(),
        at: day(m.at),
        who,
        how: HOW[m.channel] ?? m.channel,
        words: clip(words, MAX_MESSAGE_CHARS),
      };
    }),
    ...calls.map((c) => {
      if (c.transcript) trusted.push(c.transcript);
      return {
        t: new Date(c.at).getTime(),
        at: day(c.at),
        who: c.direction === 'inbound' ? 'the customer' : 'the team',
        how: c.voicemail ? 'voicemail' : 'call',
        words: c.transcript
          ? clip(c.transcript, MAX_TRANSCRIPT_CHARS)
          : `(${c.seconds ? `${Math.round(c.seconds / 60) || 1} min` : 'no answer'}, no transcript)`,
      };
    }),
  ].sort((a, b) => a.t - b.t);
  // Newest kept when it all won't fit.
  let budget = MAX_CONVERSATION_CHARS;
  const kept: ProfileLine[] = [];
  for (let i = lines.length - 1; i >= 0 && budget > 0; i--) {
    const l = lines[i]!;
    budget -= l.words.length + 40;
    kept.unshift({ at: l.at, who: l.who, how: l.how, words: l.words });
  }

  return {
    personId,
    archived: p.archived,
    snapshot,
    facts,
    history,
    conversation: kept,
    notes: noteLines,
    trustedText: trusted.join('\n'),
    hasHistory:
      history.length + kept.length + noteLines.length > 0 || !!p.source || fields.length > 0,
  };
}
