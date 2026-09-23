/**
 * Settings → Automations' "Maintenance due" (stage 2c), on the real database with the fake carrier:
 * - a customer whose regular service comes round within two weeks gets a text in the business's words with a
 *   link that opens the booking page on that service; one not due yet, one overdue by more than a year, one
 *   already booked for it and one set to "never" get nothing;
 * - a plan member's text says it's in their plan, on the plan's schedule;
 * - a week on, a second text; a week after that, a card on Home, which clears when they book;
 * - customers already overdue go a few a day.
 */
import {
  appointmentCreate,
  appointmentSetStatus,
  automationsSaveSettings,
  defaultAutomationSettings,
  maintenanceForPerson,
  maintenanceSetSchedule,
  planCreate,
  serviceCreate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAINTENANCE_JOB, maintenanceJobKey } from '../src/automations/index';
import {
  admin,
  at,
  drain,
  iso,
  makeCalendar,
  makeWorld,
  query,
  readyTexting,
  run,
  setQuietHours,
  textsTo,
  type World,
} from './booking-world';
import { newCustomer } from './ai-team-world';

let w: World;
let serviceId: string;
let calendar: { id: string; slug: string };
const DAY = 86_400_000;

beforeAll(async () => {
  w = await makeWorld('maint');
  await readyTexting(w);
  await setQuietHours(w, null);
  const s = await run(w, serviceCreate, {
    workspaceId: w.workspaceId,
    name: 'AC tune-up',
    durations: [60],
    repeatMonths: 6,
  });
  serviceId = (s as { serviceId: string }).serviceId;
  calendar = await makeCalendar(w, 'Tune-ups', {
    services: { mode: 'one', items: [{ serviceId }] },
  });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

let slot = 2;
/** A customer who agreed to texts. */
async function customer(first: string) {
  const c = await newCustomer(w, first);
  await rows(
    admin(),
    sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${c.id}`,
  );
  return c;
}

/** A tune-up for them, done `daysAgo` days ago. */
async function doneVisit(personId: string, daysAgo: number): Promise<string> {
  const { appointmentId } = await run(w, appointmentCreate, {
    workspaceId: w.workspaceId,
    calendarId: calendar.id,
    serviceId,
    startsAt: iso(at(slot++, '09:00')),
    personId,
    notify: false,
  });
  await run(w, appointmentSetStatus, {
    workspaceId: w.workspaceId,
    appointmentId,
    status: 'completed',
  });
  const when = Date.now() - daysAgo * DAY;
  await rows(
    admin(),
    sql`update app.appointments set starts_at = ${iso(when)}::timestamptz,
          ends_at = ${iso(when + 3_600_000)}::timestamptz
        where id = ${appointmentId}`,
  );
  await drain(w);
  return appointmentId;
}

/** A tune-up booked ahead for them. */
async function bookAhead(personId: string): Promise<void> {
  await run(w, appointmentCreate, {
    workspaceId: w.workspaceId,
    calendarId: calendar.id,
    serviceId,
    startsAt: iso(at(slot++, '11:00')),
    personId,
    notify: false,
  });
  await drain(w);
}

async function runMaintenance(daysLater = 0): Promise<void> {
  await rows(
    admin(),
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${w.organizationId}, ${w.workspaceId}, ${MAINTENANCE_JOB}, ${maintenanceJobKey(w.workspaceId)},
          now(), '{}'::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = now()`,
  );
  if (daysLater)
    await rows(
      admin(),
      sql`update app.maintenance_reminders set
            first_sent_at = first_sent_at - make_interval(days => ${daysLater}),
            second_sent_at = second_sent_at - make_interval(days => ${daysLater})
          where workspace_id = ${w.workspaceId}`,
    );
  await drain(w);
}

const reminders = (phone: string) => textsTo(w, phone).filter((t) => t.body.includes('is due'));
const reminderOf = async (personId: string) => {
  const [r] = await rows<{ id: string; status: string; sent_count: number; due_on: string }>(
    admin(),
    sql`select id, status, sent_count, due_on::text as due_on from app.maintenance_reminders
        where person_id = ${personId} order by created_at desc limit 1`,
  );
  return r;
};

describe('maintenance due', () => {
  it('texts who is due with a link to book that service, and leaves the rest alone', async () => {
    const due = await customer('Ada'); // six months less a week ago: due in a week
    await doneVisit(due.id, 183 - 7);
    const early = await customer('Ben'); // a month ago
    await doneVisit(early.id, 30);
    const gone = await customer('Cy'); // twenty months ago: over a year overdue
    await doneVisit(gone.id, 600);
    const booked = await customer('Di'); // due, but booked already
    await doneVisit(booked.id, 180);
    await bookAhead(booked.id);
    const never = await customer('Ed'); // due, but not to be reminded
    await doneVisit(never.id, 180);
    await run(w, maintenanceSetSchedule, {
      workspaceId: w.workspaceId,
      personId: never.id,
      serviceId,
      every: 'never',
    });

    await runMaintenance();
    const [sent] = reminders(due.phone);
    expect(sent!.body).toContain('Your AC tune-up is due soon');
    expect(sent!.body).toContain(`/book/${w.site}/${calendar.slug}?service=${serviceId}`);
    for (const c of [early, gone, booked, never]) expect(reminders(c.phone)).toHaveLength(0);
    expect(await reminderOf(due.id)).toMatchObject({ status: 'reminding', sent_count: 1 });

    // Their page says so.
    const page = await query(w, maintenanceForPerson, {
      workspaceId: w.workspaceId,
      personId: due.id,
    });
    expect(page.items).toEqual([
      expect.objectContaining({
        serviceName: 'AC tune-up',
        everyMonths: 6,
        source: 'service',
        reminder: expect.objectContaining({ sentCount: 1, status: 'reminding' }),
      }),
    ]);

    // Run again the same day: nobody is asked twice.
    await runMaintenance();
    expect(reminders(due.phone)).toHaveLength(1);
  });

  it('texts again a week on, then asks a person with a card that clears when they book', async () => {
    const c = await customer('Flo');
    await doneVisit(c.id, 180);
    await runMaintenance();
    expect(reminders(c.phone)).toHaveLength(1);
    await runMaintenance(8);
    expect(reminders(c.phone)).toHaveLength(2);
    expect(await reminderOf(c.id)).toMatchObject({ sent_count: 2 });
    await runMaintenance(8);
    expect(reminders(c.phone)).toHaveLength(2);
    const r = await reminderOf(c.id);
    expect(r).toMatchObject({ status: 'card' });
    const cardOf = async () => {
      const [item] = await rows<{ state: string; resolution: string | null; title: string }>(
        admin(),
        sql`select state::text as state, resolution, title from app.attention_items
            where kind = 'maintenance_due' and subject_id = ${r!.id}`,
      );
      return item;
    };
    expect(await cardOf()).toMatchObject({ state: 'open', title: 'Flo Customer · AC tune-up' });
    // They book it: the card goes, and the reminder is marked booked on the next run.
    await bookAhead(c.id);
    expect(await cardOf()).toMatchObject({ state: 'resolved', resolution: 'booked' });
    await runMaintenance();
    expect(await reminderOf(c.id)).toMatchObject({ status: 'booked' });
  });

  it('reminds a plan member on the plan’s schedule, saying it’s included', async () => {
    const plan = await run(w, planCreate, {
      workspaceId: w.workspaceId,
      name: 'Comfort Club',
      priceCents: 1500,
      serviceId,
      visitEveryMonths: 12,
    });
    const c = await customer('Gus');
    // Six months ago: due for the service, but the plan says a year.
    await doneVisit(c.id, 180);
    await rows(
      admin(),
      sql`insert into app.subscriptions (workspace_id, plan_id, plan_name, person_id, status)
          values (${w.workspaceId}, ${plan.planId}, 'Comfort Club', ${c.id}, 'unmanaged')`,
    );
    await rows(
      admin(),
      sql`update app.subscriptions set status = 'active' where person_id = ${c.id}`,
    );
    await runMaintenance();
    expect(reminders(c.phone)).toHaveLength(0);
    // A year on from the visit, less a week: due, as the plan says.
    const d = await customer('Hal');
    await doneVisit(d.id, 365 - 7);
    await rows(
      admin(),
      sql`insert into app.subscriptions (workspace_id, plan_id, plan_name, person_id, status)
          values (${w.workspaceId}, ${plan.planId}, 'Comfort Club', ${d.id}, 'unmanaged')`,
    );
    await rows(
      admin(),
      sql`update app.subscriptions set status = 'active' where person_id = ${d.id}`,
    );
    await runMaintenance();
    const [sent] = reminders(d.phone);
    expect(sent!.body).toContain("it's included in your Comfort Club");
  });

  it('sends customers already overdue a few a day, most overdue first', async () => {
    const s = defaultAutomationSettings();
    await run(w, automationsSaveSettings, {
      workspaceId: w.workspaceId,
      settings: { ...s, maintenance: { ...s.maintenance, maxPerDay: 1 } },
    });
    try {
      // Nobody else waiting: earlier customers are all asked already.
      const a = await customer('Ivy');
      await doneVisit(a.id, 250);
      const b = await customer('Jo');
      await doneVisit(b.id, 300);
      await runMaintenance(2);
      // Jo is the more overdue; Ivy waits for tomorrow.
      expect([reminders(a.phone).length, reminders(b.phone).length]).toEqual([0, 1]);
    } finally {
      await run(w, automationsSaveSettings, { workspaceId: w.workspaceId, settings: s });
    }
  });
});
