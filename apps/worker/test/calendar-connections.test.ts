/**
 * Calendar connections end to end on the fake providers: signing in through the real routes, busy times
 * without HandsFreeOS's own events, write-through that creates, moves and removes events and never doubles
 * them, a lost sign-in that emails its person once, and disconnecting.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  appointmentDelete,
  binEmpty,
  binRestore,
  calendarConnectionConnect,
  calendarConnectionDisconnect,
  calendarConnectionSyncNow,
  executeCommand,
  mailboxConnect,
  meetingConnectionConnect,
  meetingConnectionDisconnect,
  meetingConnectionCheckSettings,
  meetingConnectionList,
  executeQuery,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentCalendarEvents,
  calendarBusyBlocks,
  calendarConnections,
  mailboxConnections,
  meetingConnections,
} from '@hfos/db/schema';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeCalendarEvent } from '../src/calendar/fake';
import type { TokenSet } from '../src/calendar/provider';
import { queueCalendarSync } from '../src/calendar/sync';
import { queueSettingsCheck } from '../src/meetings/settings';
import { queueMeetingSync } from '../src/meetings/sync';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { finishSignIn, testTokenVerifier } from './finish-sign-in';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-calendar-${process.pid}`;
const token = () => randomUUID().slice(0, 8);
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const RECONNECT = 'Reconnect your calendar';

let owner: TestUser;
let tech: TestUser;
let workspaceId: string;
let organizationId: string;
let calendarId: string;
let google: string;
let googleId: string;
let googleState: string;
let outlook: string;
let outlookId: string;
let s: TestServices;
let app: FastifyInstance;

/** An hour `days` from now (UTC): inside the 60 days read ahead, never in the past. */
const at = (days: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};
const span = (from: Date, to: Date) => [from.toISOString(), to.toISOString()];

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox, webhook and job loops over this workspace's due work until it is idle. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [
      await processOnce({ ...d, handlers }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null
            union all select event_type, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

const scope = () => ({ workspaceId, organizationId });
const worker = <T>(fn: (tx: Tx) => Promise<T>) => asWorker(testDbs().worker.db, scope(), fn);
const get = (url: string) => app.inject({ method: 'GET', url });

const connection = async (id: string) =>
  (await admin().select().from(calendarConnections).where(eq(calendarConnections.id, id)))[0]!;
const blocks = async (connectionId: string) =>
  (
    await admin()
      .select()
      .from(calendarBusyBlocks)
      .where(eq(calendarBusyBlocks.connectionId, connectionId))
  )
    .map((b) => span(b.startsAt, b.endsAt))
    .sort();
const written = async (appointmentId: string, userId: string) =>
  (
    await admin()
      .select()
      .from(appointmentCalendarEvents)
      .where(
        and(
          eq(appointmentCalendarEvents.appointmentId, appointmentId),
          eq(appointmentCalendarEvents.userId, userId),
        ),
      )
  )[0];
const pendingRefresh = (connectionId: string) =>
  rows(
    admin(),
    sql`select 1 from app.scheduled_jobs
        where dedupe_key = ${`calendar.refresh:${connectionId}`} and status = 'pending'`,
  );

/** What HandsFreeOS wrote into a fake calendar, through the test route. */
async function eventsFor(account: string, appointmentId: string): Promise<FakeCalendarEvent[]> {
  const res = await get(`/test/calendars/events?account=${encodeURIComponent(account)}`);
  expect(res.statusCode).toBe(200);
  return (res.json() as { events: FakeCalendarEvent[] }).events.filter(
    (e) => e.appointmentId === appointmentId,
  );
}

/** Something else in a fake calendar (a dentist appointment), through the test route. */
async function addBusy(account: string, from: Date, to: Date): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/test/calendars/busy',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ account, start: from.toISOString(), end: to.toISOString() }),
  });
  expect(res.statusCode).toBe(200);
}

/** An appointment as the booking engine writes one: the row, then who works it. */
function book(
  title: string,
  from: Date,
  to: Date,
  staff: readonly string[],
  location: Record<string, unknown> = {},
): Promise<string> {
  return worker(async (tx) => {
    const [a] = await rows<{ id: string }>(
      tx,
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, location)
          values (${workspaceId}, ${calendarId}, 1, ${title}, ${from.toISOString()}::timestamptz,
            ${to.toISOString()}::timestamptz, ${JSON.stringify(location)}::jsonb)
          returning id`,
    );
    for (const userId of staff)
      await rows(
        tx,
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
            values (${workspaceId}, ${a!.id}, ${userId})`,
      );
    return a!.id;
  });
}
const move = (appointmentId: string, from: Date, to: Date) =>
  worker((tx) =>
    tx.execute(
      sql`update app.appointments set starts_at = ${from.toISOString()}::timestamptz,
            ends_at = ${to.toISOString()}::timestamptz where id = ${appointmentId}`,
    ),
  );
const setStatus = (appointmentId: string, status: string) =>
  worker((tx) =>
    tx.execute(
      sql`update app.appointments set status = ${status}::app.appointment_status where id = ${appointmentId}`,
    ),
  );
/** The job stopped after the provider answered but before it recorded the event. */
const loseAnswer = (appointmentId: string) =>
  worker((tx) =>
    tx
      .update(appointmentCalendarEvents)
      .set({ providerEventId: null, syncedAt: null })
      .where(eq(appointmentCalendarEvents.appointmentId, appointmentId)),
  );

/** The appointment's events are written (or moved, or taken out) now. */
async function sync(appointmentId: string): Promise<void> {
  await worker((tx) => queueCalendarSync(tx, scope(), appointmentId));
  await drain();
}

/** The connection's refresh runs now instead of in a minute. */
async function refreshNow(connectionId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where dedupe_key = ${`calendar.refresh:${connectionId}`} and status = 'pending'`,
  );
  await drain();
}

/**
 * Signs in through the real routes: connect, start, the stand-in page's Allow (or Cancel), the callback, then the
 * app finishing it as the person who pressed Connect.
 */
async function connect(
  user: TestUser,
  provider: 'google' | 'microsoft',
  account: string,
  decision: 'allow' | 'deny' = 'allow',
): Promise<{ connectionId: string; state: string; location: string }> {
  const { output } = await executeCommand(
    api(),
    calendarConnectionConnect,
    { workspaceId, provider },
    actor(user),
    meta(),
  );
  const start = await get(`/oauth/${provider}/start?state=${encodeURIComponent(output.state)}`);
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  expect(authorize.pathname).toBe(`/oauth/fake/${provider}/authorize`);
  const challenge = authorize.searchParams.get('code_challenge')!;
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const page = await get(`${authorize.pathname}${authorize.search}`);
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('No real calendar is touched');
  const approve = await get(
    `/oauth/fake/${provider}/approve?${new URLSearchParams({
      state: output.state,
      code_challenge: challenge,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      email: account,
      decision,
    })}`,
  );
  expect(approve.statusCode).toBe(302);
  const callback = new URL(String(approve.headers.location));
  const back = await finishSignIn(
    app,
    await get(`${callback.pathname}${callback.search}`),
    await signInTestUser(user),
  );
  expect(back.status).toBe(302);
  await drain();
  return {
    connectionId: output.connectionId,
    state: output.state,
    location: String(back.location),
  };
}

async function mailTo(to: string, subject: string): Promise<{ ID: string }[]> {
  const res = await fetch(
    `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  return ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages.filter(
    (m) => m.Subject === subject,
  );
}
async function waitForMail(to: string, subject: string): Promise<{ Text: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [hit] = await mailTo(to, subject);
    if (hit)
      return (await (await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no "${subject}" email reached ${to}`);
}

beforeAll(async () => {
  owner = await createTestUser('calendar-worker-owner');
  tech = await createTestUser('calendar-worker-tech');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Calendar Worker HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  // Priya works here too, as a member.
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${tech.id}, 'member')`,
  );
  const [c] = await worker((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status)
          values (${workspaceId}, 'Tune-ups', ${`tune-ups-${token()}`}, 'active') returning id`,
    ),
  );
  calendarId = c!.id;
  google = `dale-${token()}@gmail.fake`;
  outlook = `priya-${token()}@outlook.fake`;
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('connecting a calendar', () => {
  it('signs in through the stand-in Google page, seals the tokens and reads busy times at once', async () => {
    await addBusy(google, at(2, 15), at(2, 16));
    const signed = await connect(owner, 'google', google);
    googleId = signed.connectionId;
    googleState = signed.state;
    expect(signed.location).toBe(
      `http://localhost:3000/app/w/${workspaceId}/settings/my-calendar?calendar=connected`,
    );
    const c = await connection(googleId);
    expect(c).toMatchObject({
      status: 'active',
      provider: 'google',
      accountEmail: google,
      userId: owner.id,
      failures: 0,
    });
    expect(c.scopes).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/calendar.freebusy',
        'https://www.googleapis.com/auth/calendar.events.owned',
      ]),
    );
    // Sealed, not stored in the clear; the one-time state and the PKCE verifier are gone.
    expect(c.tokenEnc).toMatch(/^v1\./);
    expect(c.tokenEnc).not.toContain('fake-cal-access');
    expect(c.pkceVerifierEnc).toBeNull();
    expect(c.oauthStateHash).toBeNull();
    expect(JSON.parse(s.sealer.open(c.tokenEnc!)) as TokenSet).toMatchObject({
      refreshToken: expect.stringMatching(/^fake-cal-refresh\./),
    });
    // The first refresh ran right away.
    expect(c.busySyncedAt).not.toBeNull();
    expect(await blocks(googleId)).toEqual([span(at(2, 15), at(2, 16))]);
  });

  it('a used sign-in link is a dead end', async () => {
    const used = await get(`/oauth/google/start?state=${encodeURIComponent(googleState)}`);
    expect(used.statusCode).toBe(400);
    expect(used.body).toContain('This sign-in link has expired');
  });

  it('comes back as cancelled when the person says no, and nothing connects', async () => {
    const signed = await connect(tech, 'google', `nobody-${token()}@gmail.fake`, 'deny');
    expect(signed.location).toBe(
      `http://localhost:3000/app/w/${workspaceId}/settings/my-calendar?calendar=cancelled`,
    );
    const c = await connection(signed.connectionId);
    expect(c.status).toBe('pending');
    expect(c.lastError).toContain('access_denied');
  });

  it('connecting a mailbox still works the same way', async () => {
    const { output } = await executeCommand(
      api(),
      mailboxConnect,
      { workspaceId, provider: 'microsoft' },
      actor(owner),
      meta(),
    );
    const start = await get(`/oauth/microsoft/start?state=${encodeURIComponent(output.state)}`);
    expect(start.statusCode).toBe(302);
    const authorize = new URL(String(start.headers.location));
    const page = await get(`${authorize.pathname}${authorize.search}`);
    expect(page.body).toContain('No real mailbox is touched');
    const approve = await get(
      `/oauth/fake/microsoft/approve?${new URLSearchParams({
        state: output.state,
        code_challenge: authorize.searchParams.get('code_challenge')!,
        redirect_uri: authorize.searchParams.get('redirect_uri')!,
        email: `office-${token()}@outlook.fake`,
        decision: 'allow',
      })}`,
    );
    const callback = new URL(String(approve.headers.location));
    const back = await finishSignIn(
      app,
      await get(`${callback.pathname}${callback.search}`),
      await signInTestUser(owner),
    );
    expect(back.location).toBe(
      `http://localhost:3000/app/w/${workspaceId}/settings/email?mailbox=connected`,
    );
    await drain();
    const [m] = await admin()
      .select()
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, output.connectionId));
    expect(m).toMatchObject({ status: 'active' });
    expect(m!.tokenEnc).toMatch(/^v1\./);
  });
});

describe('busy times', () => {
  it('stores what else is in the calendar and leaves out HandsFreeOS’s own events', async () => {
    const visit = await book('AC tune-up', at(3, 14), at(3, 15), [owner.id]);
    await sync(visit);
    expect(await eventsFor(google, visit)).toHaveLength(1);
    // A dentist appointment, and a call that runs into the visit.
    await addBusy(google, at(3, 10), at(3, 11));
    await addBusy(google, at(3, 13, 30), at(3, 14, 30));
    await refreshNow(googleId);
    // Google's free/busy counts the visit as busy too (merged with the call); only the call's own time stays.
    expect(await blocks(googleId)).toEqual([
      span(at(2, 15), at(2, 16)),
      span(at(3, 10), at(3, 11)),
      span(at(3, 13, 30), at(3, 14)),
    ]);
    expect((await connection(googleId)).busySyncedAt).not.toBeNull();
  });

  it('Sync now reads them again right away, and only for your own calendar', async () => {
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() + interval '1 hour'
          where dedupe_key = ${`calendar.refresh:${googleId}`} and status = 'pending'`,
    );
    await addBusy(google, at(5, 9), at(5, 10));
    await executeCommand(
      api(),
      calendarConnectionSyncNow,
      { workspaceId, connectionId: googleId },
      actor(owner),
      meta(),
    );
    await drain();
    expect(await blocks(googleId)).toContainEqual(span(at(5, 9), at(5, 10)));
    // A member can't even see someone else's connection.
    await expect(
      executeCommand(
        api(),
        calendarConnectionSyncNow,
        { workspaceId, connectionId: googleId },
        actor(tech),
        meta(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('appointments in people’s calendars', () => {
  it('writes the event, moves it, and takes it out when cancelled; a retried job never makes a second one', async () => {
    const visit = await book('Furnace check', at(4, 16), at(4, 17), [owner.id]);
    await sync(visit);
    const [e] = await eventsFor(google, visit);
    expect(e).toMatchObject({
      id: visit.replace(/-/g, ''),
      title: 'Furnace check',
      start: at(4, 16).toISOString(),
      end: at(4, 17).toISOString(),
      attendees: [],
    });
    expect(e!.description).toContain(`/app/w/${workspaceId}/calendar?appt=${visit}`);
    expect(await written(visit, owner.id)).toMatchObject({
      connectionId: googleId,
      providerEventId: e!.id,
      error: null,
    });

    // Moved to the evening: the same event moves.
    await move(visit, at(4, 19), at(4, 20));
    await sync(visit);
    expect(await eventsFor(google, visit)).toEqual([
      expect.objectContaining({
        id: e!.id,
        start: at(4, 19).toISOString(),
        end: at(4, 20).toISOString(),
      }),
    ]);

    // The answer was lost and the job ran again, twice: still one event.
    await loseAnswer(visit);
    await sync(visit);
    await sync(visit);
    expect(await eventsFor(google, visit)).toHaveLength(1);
    expect((await written(visit, owner.id))?.providerEventId).toBe(e!.id);

    // Cancelled: the event goes.
    await setStatus(visit, 'cancelled');
    await sync(visit);
    expect(await eventsFor(google, visit)).toHaveLength(0);
    expect((await written(visit, owner.id))?.providerEventId).toBeNull();
  });

  it('makes one Google Meet link for an online visit set to get one, and keeps it', async () => {
    const video = {
      kind: 'virtual',
      address: null,
      meetingUrl: null,
      postalCode: null,
      video: 'google_meet',
    };
    const call = await book('Video consult', at(5, 16), at(5, 17), [owner.id], video);
    await sync(call);
    const [e] = await eventsFor(google, call);
    const link = `https://meet.google.com/fake-${call.slice(0, 8)}`;
    expect(e?.meetingUrl).toBe(link);
    const location = async () =>
      (
        await worker((tx) =>
          rows<{ location: Record<string, unknown> }>(
            tx,
            sql`select location from app.appointments where id = ${call}`,
          ),
        )
      )[0]!.location;
    expect(await location()).toMatchObject({
      kind: 'virtual',
      meetingUrl: link,
      video: 'google_meet',
    });
    // Saving the link ran the write-through again: the event now shows the link as its place.
    expect((await eventsFor(google, call))[0]).toMatchObject({ location: link, meetingUrl: link });

    // Moved: the same link stays.
    await move(call, at(5, 18), at(5, 19));
    await sync(call);
    expect(await location()).toMatchObject({ meetingUrl: link });

    // A visit with a link someone typed in is left alone.
    const typed = await book('Typed link', at(5, 20), at(5, 21), [owner.id], {
      ...video,
      meetingUrl: 'https://zoom.us/j/123',
    });
    await sync(typed);
    expect((await eventsFor(google, typed))[0]).toMatchObject({
      location: 'https://zoom.us/j/123',
      meetingUrl: null,
    });
  });

  it('Outlook finds its event again by our property, and a reassigned visit changes calendars', async () => {
    const signed = await connect(tech, 'microsoft', outlook);
    outlookId = signed.connectionId;
    expect(signed.location).toMatch(/\/settings\/my-calendar\?calendar=connected$/);
    const visit = await book('Duct cleaning', at(6, 15), at(6, 17), [tech.id]);
    await sync(visit);
    const [e] = await eventsFor(outlook, visit);
    expect(e).toMatchObject({ title: 'Duct cleaning', attendees: [] });
    expect(e!.id).toMatch(/^fake-outlook-event-/);
    // Outlook's busy times skip our own events, so there's nothing to take back out.
    expect(await blocks(outlookId)).toEqual([]);

    await loseAnswer(visit);
    await sync(visit);
    await sync(visit);
    expect(await eventsFor(outlook, visit)).toHaveLength(1);
    expect((await written(visit, tech.id))?.providerEventId).toBe(e!.id);

    // Reassigned to Dale: out of Priya's calendar, into his.
    await worker(async (tx) => {
      await tx.execute(
        sql`delete from app.appointment_staff where appointment_id = ${visit} and user_id = ${tech.id}`,
      );
      await tx.execute(
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
            values (${workspaceId}, ${visit}, ${owner.id})`,
      );
    });
    await sync(visit);
    expect(await eventsFor(outlook, visit)).toHaveLength(0);
    expect(await eventsFor(google, visit)).toHaveLength(1);
  });
});

describe('a booking deleted for good', () => {
  it('leaves the calendar, comes back with it, and is emptied once it has left', async () => {
    // Last week's visit, still on the calendar.
    const visit = await book('Boiler service', at(-7, 14), at(-7, 15), [owner.id]);
    await sync(visit);
    expect(await eventsFor(google, visit)).toHaveLength(1);

    const remove = async () => {
      const { output } = await executeCommand(
        api(),
        appointmentDelete,
        { workspaceId, appointmentId: visit, notify: false },
        actor(owner),
        meta(),
      );
      await drain();
      return output.deleted[0]!.binItemId;
    };
    const first = await remove();
    expect(await eventsFor(google, visit)).toHaveLength(0);
    expect((await written(visit, owner.id))?.providerEventId).toBeNull();

    // Brought back: in the calendar again.
    await executeCommand(
      api(),
      binRestore,
      { workspaceId, binItemId: first },
      actor(owner),
      meta(),
    );
    await drain();
    expect(await eventsFor(google, visit)).toHaveLength(1);

    // Deleted again, then "Delete now": the booking and what said where its event was are gone for good.
    const second = await remove();
    await executeCommand(
      api(),
      binEmpty,
      { workspaceId, binItemIds: [second] },
      actor(owner),
      meta(),
    );
    await drain();
    expect(await eventsFor(google, visit)).toHaveLength(0);
    expect(await rows(admin(), sql`select id from app.appointments where id = ${visit}`)).toEqual(
      [],
    );
    expect(await written(visit, owner.id)).toBeUndefined();
    expect(await rows(admin(), sql`select id from app.bin_items where id = ${second}`)).toEqual([]);
  });
});

describe('losing access', () => {
  it('a refused refresh asks for a reconnect and emails that person exactly once', async () => {
    // The access token is about to lapse, and the refresh finds the sign-in revoked.
    const c = await connection(outlookId);
    const tokens = JSON.parse(s.sealer.open(c.tokenEnc!)) as TokenSet;
    await worker((tx) =>
      tx
        .update(calendarConnections)
        .set({
          tokenEnc: s.sealer.seal(
            JSON.stringify({ ...tokens, expiresAt: new Date(0).toISOString() }),
          ),
        })
        .where(eq(calendarConnections.id, outlookId)),
    );
    s.calendars.fake.revoke(outlook);
    await refreshNow(outlookId);
    const after = await connection(outlookId);
    expect(after.status).toBe('reauth_required');
    expect(after.lastError).toContain('stopped accepting');
    expect(after.nextSyncAt).toBeNull();
    expect(await pendingRefresh(outlookId)).toHaveLength(0);

    // A new visit for Priya waits for the reconnect: no event, no second email.
    const visit = await book('Thermostat swap', at(7, 15), at(7, 16), [tech.id]);
    await sync(visit);
    expect(await eventsFor(outlook, visit)).toHaveLength(0);

    const mail = await waitForMail(tech.email, RECONNECT);
    expect(mail.Text).toContain(outlook);
    expect(mail.Text).toContain('/settings/my-calendar');
    await new Promise((r) => setTimeout(r, 750));
    expect(await mailTo(tech.email, RECONNECT)).toHaveLength(1);
  });
});

describe('disconnecting', () => {
  it('only your own, or anyone’s for owners and admins; it forgets the sign-in and stops blocking time', async () => {
    expect((await blocks(googleId)).length).toBeGreaterThan(0);
    // Priya can't see (or disconnect) Dale's calendar.
    await expect(
      executeCommand(
        api(),
        calendarConnectionDisconnect,
        { workspaceId, connectionId: googleId },
        actor(tech),
        meta(),
      ),
    ).rejects.toMatchObject({ status: 404 });

    await executeCommand(
      api(),
      calendarConnectionDisconnect,
      { workspaceId, connectionId: googleId },
      actor(owner),
      meta(),
    );
    const c = await connection(googleId);
    expect(c).toMatchObject({
      status: 'disconnected',
      tokenEnc: null,
      pkceVerifierEnc: null,
      nextSyncAt: null,
    });
    expect(c.disconnectedAt).not.toBeNull();
    expect(await blocks(googleId)).toEqual([]);
    // The refresh already queued finds nothing to do and writes nothing back.
    await refreshNow(googleId);
    expect(await blocks(googleId)).toEqual([]);
    expect(await pendingRefresh(googleId)).toHaveLength(0);

    // Owners and admins can disconnect anyone's; Sync now has nothing left to sync.
    await executeCommand(
      api(),
      calendarConnectionDisconnect,
      { workspaceId, connectionId: outlookId },
      actor(owner),
      meta(),
    );
    expect(await connection(outlookId)).toMatchObject({ status: 'disconnected', tokenEnc: null });
    await expect(
      executeCommand(
        api(),
        calendarConnectionSyncNow,
        { workspaceId, connectionId: googleId },
        actor(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('connecting Zoom', () => {
  /** Zoom's sign-in through the real routes, the same way a calendar's goes. */
  async function connectZoom(
    user: TestUser,
    account: string,
    decision: 'allow' | 'deny' = 'allow',
  ) {
    const { output } = await executeCommand(
      api(),
      meetingConnectionConnect,
      { workspaceId, provider: 'zoom' },
      actor(user),
      meta(),
    );
    const start = await get(`/oauth/zoom/start?state=${encodeURIComponent(output.state)}`);
    expect(start.statusCode).toBe(302);
    const authorize = new URL(String(start.headers.location));
    expect(authorize.pathname).toBe('/oauth/fake/zoom/authorize');
    const page = await get(`${authorize.pathname}${authorize.search}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('No real Zoom account is touched');
    const approve = await get(
      `/oauth/fake/zoom/approve?${new URLSearchParams({
        state: output.state,
        code_challenge: authorize.searchParams.get('code_challenge')!,
        redirect_uri: authorize.searchParams.get('redirect_uri')!,
        email: account,
        decision,
      })}`,
    );
    const callback = new URL(String(approve.headers.location));
    expect(callback.pathname).toBe('/oauth/zoom/callback');
    const back = await finishSignIn(
      app,
      await get(`${callback.pathname}${callback.search}`),
      await signInTestUser(user),
    );
    await drain();
    return { connectionId: output.connectionId, location: String(back.location) };
  }
  const meeting = async (id: string) =>
    (await admin().select().from(meetingConnections).where(eq(meetingConnections.id, id)))[0]!;

  it('signs in through the stand-in Zoom page and seals the tokens; a reconnect replaces the old one', async () => {
    const first = await connectZoom(tech, 'priya@zoom.fake');
    expect(first.location).toMatch(/\/settings\/my-calendar\?meeting=connected$/);
    const c = await meeting(first.connectionId);
    expect(c).toMatchObject({
      status: 'active',
      provider: 'zoom',
      accountEmail: 'priya@zoom.fake',
      oauthStateHash: null,
      pkceVerifierEnc: null,
    });
    expect(c.externalUserId).toMatch(/^fake-zoom-user-/);
    expect(c.tokenEnc).not.toContain('fake-zoom-access');
    const opened = JSON.parse(s.sealer.open(c.tokenEnc!)) as TokenSet;
    expect(opened.accessToken).toMatch(/^fake-zoom-access\./);

    // People see their own, never the tokens; the calendar stays as it was.
    const output = await executeQuery(
      api(),
      meetingConnectionList,
      { workspaceId },
      actor(tech),
      meta(),
    );
    expect(output.items).toEqual([
      expect.objectContaining({
        id: first.connectionId,
        status: 'active',
        fullName: expect.any(String),
      }),
    ]);
    expect(output.items[0]).not.toHaveProperty('tokenEnc');

    const again = await connectZoom(tech, 'priya.new@zoom.fake');
    expect((await meeting(again.connectionId)).status).toBe('active');
    expect(await meeting(first.connectionId)).toMatchObject({
      status: 'disconnected',
      tokenEnc: null,
    });
  });

  it('comes back as cancelled when the person says no', async () => {
    const { connectionId, location } = await connectZoom(owner, 'dale@zoom.fake', 'deny');
    expect(location).toMatch(/\?meeting=cancelled$/);
    expect((await meeting(connectionId)).status).toBe('pending');
  });

  it('makes the host’s Zoom meeting, moves it with the appointment and deletes it when cancelled', async () => {
    const zoomPlace = {
      kind: 'virtual',
      address: null,
      meetingUrl: null,
      postalCode: null,
      video: 'zoom',
    };
    const placeOf = async (id: string) =>
      (
        await worker((tx) =>
          rows<{ location: Record<string, unknown> }>(
            tx,
            sql`select location from app.appointments where id = ${id}`,
          ),
        )
      )[0]!.location;
    const meetingSync = async (id: string) => {
      await worker((tx) => queueMeetingSync(tx, scope(), id));
      await drain();
    };
    const zoom = s.calendars.fakeZoom!;

    // Priya connected Zoom above (priya.new@zoom.fake).
    const call = await book('Zoom consult', at(8, 16), at(8, 17), [tech.id], zoomPlace);
    await meetingSync(call);
    const [m] = zoom.meetings('priya.new@zoom.fake').filter((x) => x.appointmentId === call);
    expect(m).toMatchObject({
      topic: 'Zoom consult',
      start: at(8, 16).toISOString(),
      end: at(8, 17).toISOString(),
    });
    expect(await placeOf(call)).toMatchObject({
      video: 'zoom',
      meetingUrl: m!.joinUrl,
      meetingId: m!.id,
      meetingError: null,
    });

    // Moved: the same meeting moves; run again unchanged, nothing new is made.
    await move(call, at(8, 18), at(8, 19));
    await meetingSync(call);
    await meetingSync(call);
    const after = zoom.meetings('priya.new@zoom.fake').filter((x) => x.appointmentId === call);
    expect(after).toEqual([expect.objectContaining({ id: m!.id, start: at(8, 18).toISOString() })]);

    // Deleted in Zoom itself: the next change makes a new one.
    zoom.forget(m!.id);
    await move(call, at(8, 19), at(8, 20));
    await meetingSync(call);
    const remade = zoom.meetings('priya.new@zoom.fake').filter((x) => x.appointmentId === call);
    expect(remade).toHaveLength(1);
    expect(remade[0]!.id).not.toBe(m!.id);
    expect(await placeOf(call)).toMatchObject({ meetingId: remade[0]!.id });

    // Cancelled: the meeting comes out of Zoom.
    await setStatus(call, 'cancelled');
    await meetingSync(call);
    expect(zoom.meetings('priya.new@zoom.fake').filter((x) => x.appointmentId === call)).toEqual(
      [],
    );
    expect(await placeOf(call)).toMatchObject({ meetingId: null });
  });

  it('says why there’s no link when the host hasn’t connected Zoom, and Make link tries again', async () => {
    const zoomPlace = { kind: 'virtual', video: 'zoom' };
    const call = await book('No Zoom yet', at(8, 9), at(8, 10), [owner.id], zoomPlace);
    await worker((tx) => queueMeetingSync(tx, scope(), call));
    await drain();
    const [row] = await worker((tx) =>
      rows<{ location: Record<string, unknown> }>(
        tx,
        sql`select location from app.appointments where id = ${call}`,
      ),
    );
    expect(row!.location).toMatchObject({ meetingUrl: null });
    expect(String(row!.location['meetingError'])).toContain('hasn’t connected Zoom');
    expect(String(row!.location['meetingError'])).toContain('Settings → My calendar');
  });

  it('reads the Zoom settings after connecting and on Check again, and keeps what transcripts need', async () => {
    const zoom = s.calendars.fakeZoom!;
    const account = 'settings@zoom.fake';
    zoom.setSettings(account, { cloudRecording: true, audioTranscript: false });
    const { connectionId } = await connectZoom(tech, account);
    // Connecting queued the read; the drain ran it.
    expect(await meeting(connectionId)).toMatchObject({
      settingsProblems: ['zoom_transcript_off'],
    });
    expect((await meeting(connectionId)).settingsCheckedAt).not.toBeNull();
    const listed = await executeQuery(
      api(),
      meetingConnectionList,
      { workspaceId },
      actor(tech),
      meta(),
    );
    expect(listed.items.find((c) => c.id === connectionId)).toMatchObject({
      settingsProblems: ['zoom_transcript_off'],
    });

    // Fixed in Zoom, then Check again: nothing left to fix.
    zoom.setSettings(account, { audioTranscript: true });
    await executeCommand(
      api(),
      meetingConnectionCheckSettings,
      { workspaceId, connectionId },
      actor(tech),
      meta(),
    );
    await drain();
    expect((await meeting(connectionId)).settingsProblems).toEqual([]);

    // Downgraded to the free plan: the daily read finds it.
    zoom.setSettings(account, { planType: 1 });
    await worker((tx) => queueSettingsCheck(tx, scope(), connectionId));
    await drain();
    expect((await meeting(connectionId)).settingsProblems).toEqual(['zoom_basic_plan']);

    // Only the person checks their own.
    await expect(
      executeCommand(
        api(),
        meetingConnectionCheckSettings,
        { workspaceId, connectionId },
        actor(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('only your own, or anyone’s for owners and admins; disconnecting forgets the sign-in', async () => {
    const mine = await connectZoom(owner, 'dale@zoom.fake');
    await expect(
      executeCommand(
        api(),
        meetingConnectionDisconnect,
        { workspaceId, connectionId: mine.connectionId },
        actor(tech),
        meta(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await executeCommand(
      api(),
      meetingConnectionDisconnect,
      { workspaceId, connectionId: mine.connectionId },
      actor(owner),
      meta(),
    );
    expect(await meeting(mine.connectionId)).toMatchObject({
      status: 'disconnected',
      tokenEnc: null,
      pkceVerifierEnc: null,
    });
  });
});
