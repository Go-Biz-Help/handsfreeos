/**
 * Settings → Automations' "Did the job happen?" and the job cards (stage 3b), on the real database:
 * - half an hour after a visit ends, whoever was on it gets a push with Done, Didn't happen and Still there;
 *   Still there asks again an hour later; a visit already marked gets nothing;
 * - still unmarked the next morning, a card (`job_unconfirmed`); three days on, "Booked, never marked done"
 *   (`job_never_completed`) takes over; marking it done clears it;
 * - a visit at the customer's place two days out with no address anywhere is a card (`job_no_address`) until the
 *   customer's address is added.
 */
import {
  addDays,
  appointmentCreate,
  appointmentSetStatus,
  appointmentStillGoing,
  automationsSaveSettings,
  defaultAutomationSettings,
  localDateOf,
  localInstant,
  personUpdate,
  pushDeviceRegister,
} from '@hfos/core/server';
import { morningAfter } from '@hfos/core';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eveningAfter, JOB_CHECK_JOB, jobCheckJobKey } from '../src/automations/index';
import {
  attentionWorld,
  filedCustomer,
  itemOf,
  runSweep,
  type AttentionWorld,
} from './attention-world';
import { admin, at, CHI, drain, HOUR, iso, jobRow, makeCalendar, run } from './booking-world';

const DAY = 86_400_000;
let w: AttentionWorld;
let calendar: { id: string; slug: string };

beforeAll(async () => {
  w = await attentionWorld('jobs');
  calendar = await makeCalendar(w, 'AC tune-up');
  // The owner has the app, so their push has somewhere to go.
  await run(w, pushDeviceRegister, {
    platform: 'ios',
    token: `ExponentPushToken[jobs-${w.workerId.slice(-8)}]`,
    appVersion: '1.0.0',
    deviceName: 'Dale’s phone',
  });
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

/** A visit for them, booked a few days out, then moved (without an event) to start at `start`. */
async function visit(personId: string, start: number, hours = 1): Promise<string> {
  const { appointmentId } = await run(w, appointmentCreate, {
    workspaceId: w.workspaceId,
    calendarId: calendar.id,
    startsAt: iso(at(3, '09:00')),
    personId,
    notify: false,
  });
  await drain(w);
  await rows(
    admin(),
    sql`update app.appointments set starts_at = ${iso(start)}::timestamptz,
          ends_at = ${iso(start + hours * HOUR)}::timestamptz where id = ${appointmentId}`,
  );
  return appointmentId;
}

/** Runs the visit's pending check now. */
async function checkNow(appointmentId: string, round: 1 | 2 = 1): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now() - interval '1 second'
        where kind = ${JOB_CHECK_JOB} and dedupe_key = ${jobCheckJobKey(appointmentId, round)}
          and status = 'pending'`,
  );
  await drain(w);
}

const pushesFor = async (appointmentId: string) =>
  rows<{ title: string; body: string; user_ids: string[] }>(
    admin(),
    sql`select payload ->> 'title' as title, payload ->> 'body' as body,
          array(select jsonb_array_elements_text(payload -> 'userIds')) as user_ids
        from app.scheduled_jobs
        where kind = 'push.send' and payload ->> 'category' = 'job_check'
          and payload -> 'refs' ->> 'appointmentId' = ${appointmentId}
        order by created_at`,
  );

describe('how did it go?', () => {
  it('pushes whoever was on it half an hour after it ends, and Still there asks again in an hour', async () => {
    const ana = await filedCustomer(w, 'Ana');
    const id = await visit(ana.id, Date.now() - 2 * HOUR);
    const armed = await jobRow(jobCheckJobKey(id, 1));
    expect(armed?.status).toBe('pending');

    await checkNow(id);
    const [push] = await pushesFor(id);
    expect(push).toMatchObject({ title: 'How did it go?', user_ids: [w.owner.id] });
    expect(push!.body).toContain('AC tune-up with Ana Test');

    await run(w, appointmentStillGoing, { workspaceId: w.workspaceId, appointmentId: id });
    await drain(w);
    const again = await jobRow(jobCheckJobKey(id, 1));
    expect(again?.status).toBe('pending');
    expect(Math.abs(new Date(again!.run_at).getTime() - (Date.now() + HOUR))).toBeLessThan(
      5 * 60_000,
    );

    // Marked done before it asks again: nothing more goes.
    await run(w, appointmentSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId: id,
      status: 'completed',
    });
    await drain(w);
    await checkNow(id);
    await checkNow(id, 2);
    expect(await pushesFor(id)).toHaveLength(1);
  });

  it('asks nothing while the business has it off', async () => {
    const s = defaultAutomationSettings();
    await run(w, automationsSaveSettings, {
      workspaceId: w.workspaceId,
      settings: { ...s, switches: { ...s.switches, jobCheck: false } },
    });
    const bo = await filedCustomer(w, 'Bo');
    const id = await visit(bo.id, Date.now() - 2 * HOUR);
    expect(await jobRow(jobCheckJobKey(id, 1))).toBeUndefined();
    await run(w, automationsSaveSettings, { workspaceId: w.workspaceId, settings: s });
  });

  it('sends the evening push at 7 PM, two hours after the first at the soonest, and not after 9', () => {
    const day = localDateOf(Date.now(), CHI);
    const t = (clock: string) => localInstant(day, clock, CHI);
    expect(eveningAfter(t('10:30'), CHI)).toBe(t('19:00'));
    expect(eveningAfter(t('18:00'), CHI)).toBe(t('20:00'));
    expect(eveningAfter(t('19:30'), CHI)).toBeNull();
  });
});

describe('the job cards', () => {
  it('asks the next morning, hands over to "never marked done" three days on, and clears when marked', async () => {
    const cy = await filedCustomer(w, 'Cy');
    const yesterday = localInstant(addDays(localDateOf(Date.now(), CHI), -1), '14:00', CHI);
    const id = await visit(cy.id, yesterday);
    const ended = yesterday + HOUR;

    await runSweep(w, morningAfter(ended, CHI) + 60_000);
    expect((await itemOf(w, id, 'job_unconfirmed')).state).toBe('open');

    await runSweep(w, ended + 3 * DAY + HOUR);
    expect((await itemOf(w, id, 'job_unconfirmed')).state).toBe('resolved');
    expect((await itemOf(w, id, 'job_never_completed')).state).toBe('open');

    await run(w, appointmentSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId: id,
      status: 'completed',
    });
    await drain(w);
    const cleared = await itemOf(w, id, 'job_never_completed');
    expect(cleared.state).toBe('resolved');
    expect(cleared.resolution).toBe('done');
  });

  it('flags a visit at their place with no address two days out, until the customer’s address is added', async () => {
    const di = await filedCustomer(w, 'Di');
    const id = await visit(di.id, Date.now() + DAY);
    await rows(
      admin(),
      sql`update app.appointments set location = '{"kind": "customer_address", "address": null}'::jsonb
          where id = ${id}`,
    );
    await runSweep(w);
    expect((await itemOf(w, id, 'job_no_address')).state).toBe('open');

    await run(w, personUpdate, {
      workspaceId: w.workspaceId,
      personId: di.id,
      address: { line1: '12 Elm St', city: 'Houston', state: 'TX', postalCode: '77004' },
    });
    await drain(w);
    const cleared = await itemOf(w, id, 'job_no_address');
    expect(cleared.state).toBe('resolved');
    expect(cleared.resolution).toBe('address_added');
  });
});
