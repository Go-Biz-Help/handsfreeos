/**
 * Settings → Automations' daily briefings (stage 3a), on the real database with Mailpit:
 * - the morning email opens with today's jobs (the unconfirmed ones say so) and who to call today (an overdue
 *   follow-up, one due later today) before whatever else needs them;
 * - the end-of-day email reaches owners and admins only, at the business's own time, with the day in numbers,
 *   today's jobs nobody marked done and what's still open; once a day, and not to someone who turned it off.
 */
import {
  addDays,
  appointmentCreate,
  appointmentSetStatus,
  automationsSaveSettings,
  defaultAutomationSettings,
  localDateOf,
  localInstant,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENING_JOB, eveningJobKey } from '../src/automations/index';
import {
  attentionWorld,
  filedCustomer,
  runSweep,
  typedLead,
  type AttentionWorld,
} from './attention-world';
import {
  admin,
  at,
  CHI,
  drain,
  iso,
  mailTo,
  makeCalendar,
  post,
  run,
  runDue,
  waitForMail,
} from './booking-world';

let w: AttentionWorld;
let calendar: { id: string; slug: string };
const HOUR = 3_600_000;

beforeAll(async () => {
  w = await attentionWorld('brief');
  calendar = await makeCalendar(w, 'AC tune-up');
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const today = () => localDateOf(Date.now(), CHI);
/** A moment today where the business is. */
const todayAt = (clock: string) => localInstant(today(), clock, CHI);

/** A visit for them today at `clock`: booked on a later day, then moved to today. */
async function jobToday(personId: string, clock: string): Promise<string> {
  const { appointmentId } = await run(w, appointmentCreate, {
    workspaceId: w.workspaceId,
    calendarId: calendar.id,
    startsAt: iso(at(3, '09:00')),
    personId,
    notify: false,
  });
  const start = todayAt(clock);
  await rows(
    admin(),
    sql`update app.appointments set starts_at = ${iso(start)}::timestamptz,
          ends_at = ${iso(start + HOUR)}::timestamptz where id = ${appointmentId}`,
  );
  await drain(w);
  return appointmentId;
}

describe('the morning email', () => {
  it('opens with today’s jobs and who to call', async () => {
    const ana = await filedCustomer(w, 'Ana');
    await jobToday(ana.id, '00:05');
    // A follow-up two days overdue: an Action Center item, and a call to make.
    const bo = await filedCustomer(w, 'Bo');
    const overdue = await typedLead(w, bo.id, 'Bo: furnace quote', { nextActionInDays: 5 });
    await rows(
      admin(),
      sql`update app.leads set next_action_at = now() - interval '2 days' where id = ${overdue}`,
    );
    // One due later today (halfway to midnight), not yet an item.
    const cy = await filedCustomer(w, 'Cy');
    const later = await typedLead(w, cy.id, 'Cy: water heater', { nextActionInDays: 5 });
    const midnight = localInstant(addDays(today(), 1), '00:00', CHI);
    const dueAt = Date.now() + Math.max(60_000, (midnight - Date.now()) / 2);
    await rows(
      admin(),
      sql`update app.leads set next_action_at = ${iso(dueAt)}::timestamptz where id = ${later}`,
    );
    await drain(w);
    await runSweep(w);

    const res = await post(w, '/test/attention/digest', { workspaceId: w.workspaceId });
    expect(res.statusCode, res.body).toBe(200);
    await drain(w);
    const mail = await waitForMail(w.owner.email, '1 job today');
    expect(mail.subject).toContain('to make');
    expect(mail.text).toContain('Today’s jobs');
    expect(mail.text).toMatch(/12:05 AM · Ana \w+ · AC tune-up \(not confirmed\)/);
    expect(mail.text).toContain('Who to call today');
    expect(mail.text).toContain('Bo');
    if (dueAt < midnight) expect(mail.text).toContain('Follow-up due: Cy');
  });
});

describe('the end-of-day email', () => {
  const setEvening = (patch: Partial<{ eveningAt: string }>, on = true) => {
    const s = defaultAutomationSettings();
    return run(w, automationsSaveSettings, {
      workspaceId: w.workspaceId,
      settings: {
        ...s,
        switches: { ...s.switches, eveningBrief: on },
        briefings: { ...s.briefings, ...patch },
      },
    });
  };
  /** The evening job, as of `when` today. */
  async function runEvening(when: number): Promise<void> {
    await rows(
      admin(),
      sql`delete from app.scheduled_jobs where dedupe_key = ${eveningJobKey(w.workspaceId)}
            and status = 'pending'`,
    );
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, ${EVENING_JOB}, ${eveningJobKey(w.workspaceId)},
            ${iso(when)}::timestamptz, '{}'::jsonb)`,
    );
    await runDue(w, [eveningJobKey(w.workspaceId)]);
  }
  const evenings = async (email: string) =>
    (await mailTo(email)).filter((m) => /still open|nothing left open/.test(m.Subject));

  it('reaches owners and admins with the day in numbers, once, at the business’s own time', async () => {
    // A job done today, and one whose time passed with nobody marking it.
    const dee = await filedCustomer(w, 'Dee');
    const done = await jobToday(dee.id, '02:00');
    await run(w, appointmentSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId: done,
      status: 'completed',
    });
    const eli = await filedCustomer(w, 'Eli');
    await jobToday(eli.id, '04:00');
    await drain(w);

    // Its own time is 8 PM: armed for 6 PM (tomorrow, as the planner arms it), it waits for 8.
    const tomorrow = addDays(today(), 1);
    await setEvening({ eveningAt: '20:00' });
    await runEvening(localInstant(tomorrow, '18:00', CHI));
    expect(await evenings(w.owner.email)).toHaveLength(0);
    const [waiting] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs where dedupe_key = ${eveningJobKey(w.workspaceId)}
            and status = 'pending'`,
    );
    expect(new Date(waiting!.run_at).getTime()).toBe(localInstant(tomorrow, '20:00', CHI));

    // Today at noon (or now, if that's later): it goes.
    await setEvening({ eveningAt: '12:00' });
    await runEvening(Math.max(Date.now(), todayAt('12:00')));
    await new Promise((r) => setTimeout(r, 500));
    const [evening] = await evenings(w.owner.email);
    expect(evening).toBeDefined();
    const full = await waitForMail(w.owner.email, evening!.Subject);
    expect(full.text).toContain('Leads:');
    expect(full.text).toMatch(/Jobs: \d+ booked, 1 done/);
    expect(full.text).toContain('Not marked done yet');
    expect(full.text).toContain('Eli');
    expect(full.text).toContain('Still open');
    // Members don't get it.
    expect(await evenings(w.member.email)).toHaveLength(0);

    // Once a day.
    await runEvening(Math.max(Date.now(), todayAt('12:00')) + 60_000);
    expect(await evenings(w.owner.email)).toHaveLength(1);
  });

  it('sends nothing when the business turned it off', async () => {
    await setEvening({}, false);
    // Tomorrow evening: a new day, but the switch is off.
    await runEvening(localInstant(addDays(today(), 1), '18:00', CHI));
    expect(await evenings(w.owner.email)).toHaveLength(1);
    await setEvening({});
  });
});
