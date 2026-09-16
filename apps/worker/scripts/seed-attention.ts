/**
 * Milestone 8 demo data for Lone Star (design/m8): the Action Center Dale sees the moment he signs in.
 *
 * Almost all of it is already there by the time this runs — the CRM's leads without a next action and its
 * overdue tasks, the leads that have gone quiet, the customers waiting in the inbox, Ava's reply waiting for an
 * OK, and tomorrow's visits nobody has confirmed. This module adds the two the story starts with, sorts out
 * which visits are confirmed, and then sweeps the business, so nothing waits for the worker's first hourly
 * sweep:
 * - **Maria Lopez, the hot lead.** Her website form opens a lead (Speed to lead can't text her: she never said
 *   texts were OK), then she texts herself: a new AC, and she's ready to book. Nobody has answered. The card
 *   turns urgent after 10 minutes, and its urgent email goes to Dale.
 * - **Carla Ruiz, the new lead nobody answered.** Her form came in three days ago with a number and no email,
 *   and no permission to text, so nothing automatic reached her either.
 * - **Four one-on-one visits tomorrow that nobody has confirmed** (Rachel Stein's is the fourth, booked here),
 *   which fold into one "Unconfirmed appointments" card. Each has a confirmation request waiting out its cancel
 *   window — except Mike Johnson's, which HandsFreeOS won't send while he's waiting on a reply, and says so.
 * - **Thursday's four are settled**, three ways: HandsFreeOS asked Quincy Adams and he replied C (that's the row
 *   under "Handled by HandsFreeOS", and the thank-you text); Priya marked Greg Thompson and Hannah Nguyen
 *   confirmed; and Linda Park pressed Confirm on her booking page.
 *
 * Settings stay at their defaults on purpose: confirmation requests on, follow-up nudges off until an owner has
 * read the wording and chosen "Looks good, turn on" in Settings → Action Center.
 *
 * Nothing HandsFreeOS sends is due when the seed finishes: every waiting confirmation request is an hour out,
 * or waits for quiet hours to end. The seed checks that before it returns.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  appointmentCreate,
  attendeeConfirm,
  attendeeConfirmOnline,
  conversationAssign,
  executeCommand,
  leadCreate,
  localDateOf,
  localInstant,
  messageReceive,
  personCreate,
  phoneUpdateSettings,
  quietHoursState,
  type CommandDef,
  type HumanActor,
  type QuietHoursWindow,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { autoJobKey, sweepBusiness } from '../src/attention/index';
import type { OutboxDeps } from '../src/outbox';
import { systemActor, workerMeta } from '../src/services';
import { LONE_STAR_NUMBER, settle } from './seed-messaging';

export interface SeedAttentionDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services and loop settings, as the seed built them. */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeedAttentionWorkspace {
  readonly id: string;
  readonly organizationId: string;
  readonly dale: TestUser;
  readonly priya: TestUser;
}

const MINUTE = 60_000;
const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE).toISOString();

export async function seedAttention(
  d: SeedAttentionDeps,
  ws: SeedAttentionWorkspace,
): Promise<{
  hotLead: string;
  unconfirmed: number;
  confirmed: number;
  handled: number;
  confirmedByText: boolean;
  seconds: number;
}> {
  const started = Date.now();
  const workspaceId = ws.id;
  const scope = { workspaceId, organizationId: ws.organizationId };
  const w = { admin: d.admin, worker: d.worker, since: d.since };

  const as = async <I extends z.ZodType, O extends z.ZodType>(
    who: TestUser,
    command: CommandDef<I, O>,
    input: z.input<I>,
  ): Promise<z.infer<O>> =>
    (await executeCommand(d.api, command, input, d.actor(who), d.meta())).output;
  /** As HandsFreeOS itself, the way the worker's own routes run a command. */
  const system = async <I extends z.ZodType, O extends z.ZodType>(
    command: CommandDef<I, O>,
    input: z.input<I>,
    channel: RequestMeta['channel'] = 'api',
  ): Promise<z.infer<O>> =>
    (
      await executeCommand(d.worker.db, command, input, systemActor(scope), {
        ...workerMeta(),
        channel,
      })
    ).output;
  const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await rows<T>(d.admin, query))[0];

  const [business] = await rows<{ timezone: string }>(
    d.admin,
    sql`select timezone from app.workspaces where id = ${workspaceId}`,
  );
  const tz = business?.timezone ?? 'America/Chicago';
  const today = localDateOf(Date.now(), tz);

  // ---------- the hot lead ----------

  d.step(
    'Lone Star: Maria Lopez asks for a new AC through the website form, then texts: ready to book',
  );
  // The form asks for a phone, not an email, and she didn't say texts were OK: "Speed to lead" has no way to
  // write to her, so its first step is skipped and nobody — person or machine — has reached her.
  const maria = await system(personCreate, {
    workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    phone: '+17135550190',
    source: 'Website form',
    ignoreDuplicates: true,
  });
  const mariaLead = await system(leadCreate, {
    workspaceId,
    personId: maria.personId,
    title: 'New AC install',
    valueCents: 1_850_000,
    assigneeUserId: ws.dale.id,
    source: 'Website form',
  });
  // Her form came in a quarter of an hour ago, so the card is past its ten minutes and counts as urgent.
  await rows(
    d.admin,
    sql`update app.leads set created_at = now() - interval '13 minutes',
          stage_entered_at = now() - interval '13 minutes'
        where id = ${mariaLead.leadId}`,
  );
  // "Speed to lead" starts on every new lead. With no way to write to her its first step is skipped, so the lead
  // still has no first response and the card can say nobody has been in touch.
  await settle(w);

  const mariaText = await system(messageReceive, {
    workspaceId,
    provider: 'fake' as const,
    providerMessageId: `SMseed${randomUUID().replace(/-/g, '')}`,
    from: '+17135550190',
    to: LONE_STAR_NUMBER,
    body: "Hi, I filled in your form. Our AC finally died and the house is 84. We're ready to book — can someone come out today to quote a new unit?",
    occurredAt: ago(11),
  });
  // Dale has the conversation, so Ava leaves it to him — but nobody has answered Maria yet.
  await as(ws.dale, conversationAssign, {
    workspaceId,
    conversationId: mariaText.conversationId,
    assigneeUserId: ws.dale.id,
  });
  await settle(w);

  // ---------- the lead nobody answered ----------

  d.step('Lone Star: Carla Ruiz’s website form from three days ago, which nobody has answered');
  const carla = await system(personCreate, {
    workspaceId,
    firstName: 'Carla',
    lastName: 'Ruiz',
    phone: '+17135550191',
    source: 'Website form',
    ignoreDuplicates: true,
  });
  const carlaLead = await system(leadCreate, {
    workspaceId,
    personId: carla.personId,
    title: 'AC replacement · upstairs',
    valueCents: 680_000,
    source: 'Website form',
  });
  await rows(
    d.admin,
    sql`update app.leads set created_at = now() - interval '3 days',
          stage_entered_at = now() - interval '3 days'
        where id = ${carlaLead.leadId}`,
  );
  await settle(w);

  // ---------- tomorrow's visits ----------

  d.step('Lone Star: a fourth visit tomorrow, so four customers haven’t confirmed yet');
  const calendar = await one<{ id: string }>(
    sql`select id from app.calendars where workspace_id = ${workspaceId} and name like 'Dale%calendar'`,
  );
  const rachel = await one<{ id: string }>(
    sql`select id from app.people where workspace_id = ${workspaceId}
        and first_name = 'Rachel' and last_name = 'Stein'`,
  );
  if (calendar && rachel)
    await as(ws.dale, appointmentCreate, {
      workspaceId,
      calendarId: calendar.id,
      startsAt: new Date(localInstant(addDays(today, 1), '15:00', tz)).toISOString(),
      durationMinutes: 60,
      personId: rachel.id,
      title: 'Estimate visit',
      notes: 'Waiting room split system. Measure the return before the committee meets.',
      acknowledgeWarnings: true,
      notify: false,
    });
  await settle(w);

  // ---------- Thursday's visits, each settled its own way ----------

  const seatOf = async (name: string) => {
    const [first, ...last] = name.split(' ');
    return one<{ id: string; manage_version: number; starts_at: string }>(
      sql`select t.id, t.manage_version, p.starts_at::text as starts_at
          from app.appointment_attendees t
          join app.appointments p on p.id = t.appointment_id
          join app.people pe on pe.id = t.person_id
          where t.workspace_id = ${workspaceId} and pe.first_name = ${first}
            and pe.last_name = ${last.join(' ')} and t.status = 'booked'
            and p.status = 'scheduled' and p.capacity = 1 and p.starts_at > now()
          order by p.starts_at limit 1`,
    );
  };
  /** The open "Not confirmed" item for a seat. */
  const itemOf = async (attendeeId: string) =>
    one<{ id: string }>(
      sql`select id from app.attention_items where workspace_id = ${workspaceId}
          and kind = 'unconfirmed_appointment' and subject_id = ${attendeeId}`,
    );
  /**
   * HandsFreeOS's confirmation request for this customer goes now, instead of at the end of its cancel window.
   * Answers with what the item did: `sent` when the message really went out.
   */
  const askNow = async (name: string): Promise<string | null> => {
    const seat = await seatOf(name);
    if (!seat) return null;
    const item = await itemOf(seat.id);
    if (!item) return null;
    const moved = await rows(
      d.admin,
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${workspaceId} and dedupe_key = ${autoJobKey(item.id)}
            and status = 'pending'
          returning id`,
    );
    if (moved.length === 0) return null;
    await settle(w);
    const after = await one<{ auto_state: string | null; skip: string | null }>(
      sql`select auto_state::text as auto_state, auto_skip_reason as skip from app.attention_items
          where id = ${item.id}`,
    );
    return after?.auto_state ?? null;
  };
  const textIn = async (name: string, body: string, minutesAgo: number): Promise<void> => {
    const person = await one<{ phone_e164: string | null }>(
      sql`select phone_e164 from app.people where workspace_id = ${workspaceId}
          and first_name = ${name.split(' ')[0]} and last_name = ${name.split(' ').slice(1).join(' ')}`,
    );
    if (!person?.phone_e164) return;
    await system(messageReceive, {
      workspaceId,
      provider: 'fake' as const,
      providerMessageId: `SMseed${randomUUID().replace(/-/g, '')}`,
      from: person.phone_e164,
      to: LONE_STAR_NUMBER,
      body,
      occurredAt: ago(minutesAgo),
    });
    await settle(w);
  };

  // A text waits for quiet hours to end, so at night the seed opens texting hours for a moment — as the workflow
  // seed does for its runs — and puts them back afterwards.
  const phone = await one<{ timezone: string; quiet: QuietHoursWindow | null }>(
    sql`select timezone, settings -> 'telephony' -> 'quietHours' as quiet
        from app.workspaces where id = ${workspaceId}`,
  );
  const window: QuietHoursWindow = phone?.quiet ?? { enabled: true, start: '20:00', end: '08:00' };
  const quiet = quietHoursState(window, phone?.timezone ?? tz);
  if (quiet.quiet) {
    d.step(
      `It’s ${quiet.localTime} in Houston, in Lone Star’s quiet hours: texting hours open while HandsFreeOS asks`,
    );
    await as(ws.dale, phoneUpdateSettings, {
      workspaceId,
      quietHours: { ...window, enabled: false },
    });
  }
  let asked: string | null = null;
  let confirmedByText = false;
  try {
    d.step('Lone Star: HandsFreeOS asks Quincy Adams to confirm Thursday’s visit');
    asked = await askNow('Quincy Adams');
    if (asked === 'sent') {
      d.step('Lone Star: Quincy replies C, and gets HandsFreeOS’s thank-you text');
      await textIn('Quincy Adams', 'C', 4);
      confirmedByText = !(await seatOf('Quincy Adams'));
    }
  } finally {
    if (quiet.quiet) {
      await as(ws.dale, phoneUpdateSettings, { workspaceId, quietHours: window });
      d.step('Lone Star: quiet hours back on');
    }
  }

  d.step(
    'Lone Star: Priya marks Greg Thompson and Hannah Nguyen confirmed; Linda Park confirms on her booking page',
  );
  for (const name of ['Greg Thompson', 'Hannah Nguyen']) {
    const seat = await seatOf(name);
    if (seat)
      await as(ws.priya, attendeeConfirm, { workspaceId, attendeeId: seat.id, confirmed: true });
  }
  const linda = await seatOf('Linda Park');
  if (linda)
    await system(
      attendeeConfirmOnline,
      { workspaceId, attendeeId: linda.id, manageVersion: linda.manage_version },
      'booking_page',
    );
  await settle(w);

  // ---------- everything the Action Center knows, up to date ----------

  d.step('Lone Star: the Action Center looks at the whole business, as its hourly sweep does');
  await asWorker(d.worker.db, scope, (tx) =>
    sweepBusiness(tx, scope, Date.now(), {
      correlationId: randomUUID(),
      causationId: randomUUID(),
    }),
  );
  await settle(w);

  // Nothing HandsFreeOS would send is due: every request waits out its hour, or waits for quiet hours to end.
  const [due] = await rows<{ n: number }>(
    d.admin,
    sql`select count(*)::int as n from app.scheduled_jobs
        where workspace_id = ${workspaceId} and kind = 'attention.auto_handle'
          and status = 'pending' and run_at <= now() + interval '30 minutes'`,
  );
  if (due?.n)
    throw new Error(
      `${due.n} automatic message(s) would go out within half an hour of the seed (app.scheduled_jobs, kind attention.auto_handle).`,
    );

  const counts = await one<{
    unconfirmed: number;
    confirmed: number;
    handled: number;
    hot: number;
    unanswered: number;
  }>(
    sql`select
          (select count(*)::int from app.attention_items
            where workspace_id = ${workspaceId} and kind = 'unconfirmed_appointment' and state = 'open') as unconfirmed,
          (select count(*)::int from app.appointment_attendees t join app.appointments p on p.id = t.appointment_id
            where t.workspace_id = ${workspaceId} and t.confirmed_at is not null and p.starts_at > now()) as confirmed,
          (select count(*)::int from app.attention_items
            where workspace_id = ${workspaceId} and state = 'handled') as handled,
          (select count(*)::int from app.attention_items
            where workspace_id = ${workspaceId} and kind = 'hot_lead' and state = 'open'
              and lead_id = ${mariaLead.leadId} and urgent_from is not null) as hot,
          (select count(*)::int from app.attention_items
            where workspace_id = ${workspaceId} and kind = 'unanswered_lead' and state = 'open') as unanswered`,
  );
  if (!counts?.hot)
    throw new Error(
      'Maria Lopez’s lead should be waiting on Home as an urgent hot lead, and isn’t.',
    );
  if (!counts.unanswered)
    throw new Error(
      'Carla Ruiz’s lead should be waiting on Home as a lead nobody answered, and isn’t.',
    );
  if (asked !== 'sent' || !counts.handled)
    throw new Error(
      `No confirmation request went out (${asked ?? 'nothing to send'}), so "Handled by HandsFreeOS" would be empty.`,
    );

  return {
    hotLead: 'Maria Lopez · New AC install',
    unconfirmed: counts.unconfirmed,
    confirmed: counts.confirmed,
    handled: counts.handled,
    confirmedByText,
    seconds: (Date.now() - started) / 1000,
  };
}
