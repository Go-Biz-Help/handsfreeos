/**
 * M18 step 4 through the worker: a customer hears about their job as it moves along — on the way with when to
 * expect them (the driving time from where the tech tapped), waiting on parts with the team's note, done — once
 * per change, only when they agreed to texts.
 */
import { jobSetStatus } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobText } from '../src/booking/job-texts';
import { pino } from 'pino';
import { createGoogleDriveTimer, roughMinutes } from '../src/geo/driving';
import {
  admin,
  at,
  BUSINESS,
  bookOnline,
  customer,
  drain,
  makeCalendar,
  makeWorld,
  readyTexting,
  run,
  textsTo,
  type World,
} from './booking-world';

let w: World;
let cal: { id: string; slug: string };

beforeAll(async () => {
  w = await makeWorld('jobtexts');
  await readyTexting(w);
  cal = await makeCalendar(w, 'Home repairs', {
    locations: { options: [{ kind: 'customer_address' }] },
  });
}, 60_000);
afterAll(async () => {
  await w?.app.close();
});

const appointmentOf = async (phone: string) => {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`select a.id from app.appointments a join app.appointment_attendees t on t.appointment_id = a.id
        where t.contact_phone_e164 = ${phone} order by a.created_at desc limit 1`,
  );
  return r!.id;
};

describe('the texts a customer gets as their job moves along', () => {
  it('says who is on the way and when, then waiting on parts with the note, then done', async () => {
    const who = customer('Rae');
    await bookOnline(w, cal.slug, at(2, '10:00'), {
      ...who,
      smsConsent: true,
      locationKind: 'customer_address',
      // The stand-in geocoder places "@lat,lng" addresses there: about 12 miles north of the tech.
      address: '1 Elm St, Plano, TX 75024 @32.95,-96.80',
      postalCode: '75024',
    });
    await drain(w);
    const appointmentId = await appointmentOf(who.phone);
    const before = textsTo(w, who.phone).length;

    await run(w, jobSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId,
      status: 'on_the_way',
      origin: { lat: 32.7767, lng: -96.797 },
    });
    await drain(w);
    const minutes = roughMinutes({ lat: 32.777, lng: -96.797 }, { lat: 32.95, lng: -96.8 });
    const onWay = textsTo(w, who.phone).at(-1)!.body;
    expect(onWay).toMatch(
      /is on the way for your home repairs, arriving around \d{1,2}:\d{2} [AP]M/,
    );
    expect(onWay).toContain(`(about ${minutes} min)`);
    const [job] = await rows<{ eta_at: Date | null }>(
      admin(),
      sql`select j.eta_at from app.jobs j join app.appointments a on a.job_id = j.id where a.id = ${appointmentId}`,
    );
    expect(job!.eta_at).not.toBeNull();

    await run(w, jobSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId,
      status: 'waiting_on_parts',
      customerNote: 'The part is ordered and due Friday.',
    });
    await drain(w);
    expect(textsTo(w, who.phone).at(-1)!.body).toBe(
      `${BUSINESS}: Your home repairs is waiting on parts. We'll let you know when we're back. Note from us: The part is ordered and due Friday.`,
    );

    await run(w, jobSetStatus, { workspaceId: w.workspaceId, appointmentId, status: 'done' });
    await drain(w);
    expect(textsTo(w, who.phone).at(-1)!.body).toContain('is done. Thank you!');
    // One text per change, even when the events are handled again.
    await drain(w);
    expect(textsTo(w, who.phone).length - before).toBe(3);
  });

  it('texts nobody who didn’t agree to texts, and nothing for a change told to stay quiet', async () => {
    const who = customer('Sam');
    await bookOnline(w, cal.slug, at(3, '10:00'), {
      ...who,
      smsConsent: false,
      locationKind: 'customer_address',
      address: '2 Oak St, Dallas, TX 75201',
      postalCode: '75201',
    });
    await drain(w);
    const appointmentId = await appointmentOf(who.phone);
    const before = textsTo(w, who.phone).length;
    await run(w, jobSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId,
      status: 'in_progress',
    });
    await drain(w);
    expect(textsTo(w, who.phone).length).toBe(before);
  });
});

describe('the words', () => {
  const base = {
    business: 'Lone Star',
    title: 'AC repair',
    noteOnly: false,
    note: null,
    staff: ['Marco'],
    eta: null,
    first: false,
  };
  it('reads plainly for each status, and sends nothing for back to scheduled', () => {
    expect(jobText({ ...base, status: 'in_progress' })).toBe(
      'Lone Star: Marco has started your AC repair.',
    );
    expect(jobText({ ...base, staff: [], status: 'on_the_way' })).toBe(
      'Lone Star: Our tech is on the way for your AC repair.',
    );
    expect(jobText({ ...base, status: 'scheduled' })).toBeNull();
    expect(
      jobText({ ...base, noteOnly: true, note: 'Back Monday.', status: 'waiting_on_parts' }),
    ).toBe('Lone Star: An update on your AC repair: Back Monday.');
    expect(jobText({ ...base, status: 'done', first: true })).toBe(
      'Lone Star: Your AC repair is done. Thank you! Reply STOP to opt out.',
    );
  });
});

describe('driving time', () => {
  const from = { lat: 32.7767, lng: -96.797 };
  const to = { lat: 32.95, lng: -96.8 };
  it('asks Google’s Routes API with traffic, and falls back to a rough guess when it fails', async () => {
    const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    let answer: Response = new Response(JSON.stringify({ routes: [{ duration: '1510s' }] }));
    const timer = createGoogleDriveTimer({
      apiKey: 'test-key',
      log: pino({ level: 'silent' }),
      fetch: (async (_url: string, init?: RequestInit) => {
        sent.push({
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return answer;
      }) as typeof fetch,
    });
    expect(await timer.minutes(from, to)).toBe(25);
    expect(sent[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(sent[0]!.body).toMatchObject({
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    });
    answer = new Response('denied', { status: 403 });
    expect(await timer.minutes(from, to)).toBe(roughMinutes(from, to));
  });
});
