/**
 * AI outbound calls on the local database: a customer's written consent to calls (a yes needs where it's written;
 * a no comes from the team or from the AI on a call), what the customer page shows of it, and a visit confirmed on
 * a call the AI placed (the worker only).
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendeeConfirmByCall, personGet, personSetCallConsent } from '../src/server';
import {
  admin,
  ask,
  customer,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  nextWeekday,
  run,
  runSystem,
  bookOnline,
  setupTeam,
  type Team,
} from './calendar-helpers';

describe('AI calls', () => {
  let t: Team;
  beforeAll(async () => {
    t = await setupTeam('ai-calls');
  });
  afterAll(closeTestDbs);

  it('records written consent to calls, and where it is', async () => {
    const personId = await customer(t, 'Ana', nextPhone());
    await expectHfos(
      () =>
        run(personSetCallConsent, { workspaceId: t.wsId, personId, consent: 'opted_in' }, t.owner),
      'validation',
    );
    const yes = await run(
      personSetCallConsent,
      { workspaceId: t.wsId, personId, consent: 'opted_in', source: 'Signed service agreement' },
      t.owner,
    );
    expect(yes).toMatchObject({ consent: 'opted_in', source: 'Signed service agreement' });
    const got = await ask(personGet, { workspaceId: t.wsId, personId }, t.owner);
    expect(got.person.callConsent).toEqual({
      consent: 'opted_in',
      source: 'Signed service agreement',
    });
    // The AI on a call records a no itself.
    const no = await runSystem(
      personSetCallConsent,
      { workspaceId: t.wsId, personId, consent: 'opted_out', source: 'Asked on a call' },
      t.scope,
    );
    expect(no).toMatchObject({ consent: 'opted_out', source: 'Asked on a call' });
    const [ev] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where entity_id = ${personId} and event_type = 'person.call_consent_changed'`,
    );
    expect(ev?.n).toBe(2);
  });

  it('confirms a visit on a call the AI placed, as the AI, once', async () => {
    const cal = await makeCalendar(t, 'Visits', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    const phone = nextPhone();
    const booked = await bookOnline(t, cal.id, isoAt(nextWeekday(3), '10:00'), {
      customer: { firstName: 'Bo', lastName: 'Customer', phone },
    });
    const [seat] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.appointment_attendees where appointment_id = ${booked.appointmentId}`,
    );
    await expectHfos(
      () => run(attendeeConfirmByCall, { workspaceId: t.wsId, attendeeId: seat!.id }, t.owner),
      'forbidden',
    );
    const first = await runSystem(
      attendeeConfirmByCall,
      { workspaceId: t.wsId, attendeeId: seat!.id },
      t.scope,
    );
    expect(first).toMatchObject({ confirmedVia: 'ai', changed: true });
    const again = await runSystem(
      attendeeConfirmByCall,
      { workspaceId: t.wsId, attendeeId: seat!.id },
      t.scope,
    );
    expect(again.changed).toBe(false);
  });
});
