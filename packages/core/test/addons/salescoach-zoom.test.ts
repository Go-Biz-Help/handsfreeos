/**
 * Zoom meetings heard live (round three, docs/salescoach.md): a person claims the meeting they're in from
 * HandsFreeOS's app inside Zoom (`live_meeting.claim`), which needs an add-on that listens and their own Zoom
 * connected, finds the customer from the appointment the meeting was made for, and asking again finds the same
 * claim. Only they see it, and only the worker marks it live; Sales Coach then coaches it as a call.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { salescoachAddon } from '../../src/addons/salescoach/manifest';
import { callBegin } from '../../src/addons/salescoach/ops/calls';
import {
  addonRef,
  executeCommand,
  executeQuery,
  liveMeetingAccountDisconnect,
  liveMeetingAccountLink,
  liveMeetingAccountMine,
  liveMeetingClaim,
  liveMeetingEnded,
  liveMeetingStarted,
  organizationCreate,
  personCreate,
  type HumanActor,
  type SystemActor,
} from '../../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

let owner: TestUser;
let rep: TestUser;
let ws: string;
let orgId: string;
let personId: string;

const claim = (u: TestUser, input: Record<string, unknown>) =>
  executeCommand(
    api(),
    liveMeetingClaim,
    { workspaceId: ws, meetingUuid: 'mtg-uuid-1==', ...input } as never,
    human(u),
    meta(),
  ).then((r) => r.output);
const system = (addon = false): SystemActor => ({
  type: 'system',
  workspaceId: ws,
  organizationId: orgId,
  ...(addon ? { addon: addonRef(salescoachAddon) } : {}),
});

/** The worker links a Zoom user to a person, once both sign-ins agree. */
const link = (u: TestUser, zoomUserId: string) =>
  executeCommand(
    testDbs().worker.db,
    liveMeetingAccountLink,
    {
      workspaceId: ws,
      userId: u.id,
      provider: 'zoom',
      externalUserId: zoomUserId,
      accountEmail: 'rep@zoom.example',
    },
    system(),
    meta(),
  ).then((r) => r.output.accountId);

beforeAll(async () => {
  [owner, rep] = await Promise.all([createTestUser('zoom-owner'), createTestUser('zoom-rep')]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Zoomed Cooling Co' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  orgId = made.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${rep.id}, 'member')`,
  );
  personId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Rosa', lastName: 'Diaz', phone: '(713) 555-0161' },
      human(owner),
      meta(),
    )
  ).output.personId;
  // An appointment HandsFreeOS made a Zoom meeting for, with Rosa booked on it.
  const [cal] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calendars (workspace_id, name, slug, status) values (${ws}, 'Estimates', 'estimates', 'active')
        returning id`,
  );
  const [appt] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, location)
        values (${ws}, ${cal!.id}, 1, 'Estimate review', now(), now() + interval '1 hour',
                ${JSON.stringify({ video: 'zoom', meetingId: '81234567890' })}::jsonb)
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
        values (${ws}, ${appt!.id}, ${personId})`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('claiming a Zoom meeting', () => {
  it('needs an add-on that listens, then the person’s Zoom linked through the coaching app', async () => {
    expect(await refused(claim(rep, {}))).toBe('live_meeting_nobody_listens');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${ws}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
    );
    expect(await refused(claim(rep, {}))).toBe('live_meeting_not_connected');
    // The meeting-link Zoom app's connection isn't the coaching app's: it doesn't count.
    await rows(
      admin(),
      sql`insert into app.meeting_connections (workspace_id, user_id, provider, status, external_user_id, connected_at)
          values (${ws}, ${rep.id}, 'zoom', 'active', 'zoom-rep-1', now())`,
    );
    expect(await refused(claim(rep, {}))).toBe('live_meeting_not_connected');
    // Nobody links a Zoom account by hand: only the worker, once both sign-ins agree.
    const forged = await asUser(api(), rep.claims, (tx) =>
      rows(
        tx,
        sql`insert into app.live_meeting_accounts (workspace_id, user_id, external_user_id)
            values (${ws}, ${rep.id}, 'zoom-rep-1') returning id`,
      ),
    ).then(
      () => 'went through',
      () => 'refused',
    );
    expect(forged).toBe('refused');
    const first = await link(rep, 'zoom-rep-1');
    // Disconnecting it stops the claim; linking again (the same Zoom user moves to whoever linked it last) restores it.
    await executeCommand(
      api(),
      liveMeetingAccountDisconnect,
      { workspaceId: ws, accountId: first },
      human(rep),
      meta(),
    );
    expect(await refused(claim(rep, {}))).toBe('live_meeting_not_connected');
    await link(owner, 'zoom-rep-1');
    await link(rep, 'zoom-rep-1');
    const mine = (u: TestUser) =>
      executeQuery(api(), liveMeetingAccountMine, { workspaceId: ws }, human(u), meta());
    expect((await mine(rep)).account).toMatchObject({ accountEmail: 'rep@zoom.example' });
    expect((await mine(owner)).account).toBeNull();
  });

  it('finds the customer from the appointment, and asking again finds the same claim', async () => {
    const first = await claim(rep, { meetingNumber: '81234567890', screenName: 'Dana Rep' });
    expect(first).toMatchObject({
      state: 'waiting',
      person: { id: personId, name: 'Rosa Diaz' },
    });
    expect(first.appointmentId).toBeTruthy();
    // Picking nobody keeps the claim, without the customer.
    const again = await claim(rep, { meetingNumber: '81234567890', personId: null });
    expect(again.liveMeetingId).toBe(first.liveMeetingId);
    expect(again.person).toBeNull();
    // Only the person sees it.
    const seen = (u: TestUser) =>
      asUser(api(), u.claims, (tx) =>
        rows(tx, sql`select id from app.live_meetings where workspace_id = ${ws}`),
      );
    expect(await seen(rep)).toHaveLength(1);
    expect(await seen(owner)).toHaveLength(0);
  });

  it('is marked live and ended only by the worker; Sales Coach coaches it as a call', async () => {
    const { liveMeetingId } = await claim(rep, { personId });
    // A person can't say the stream started.
    const forged = await asUser(api(), rep.claims, (tx) =>
      rows(
        tx,
        sql`update app.live_meetings set state = 'live' where id = ${liveMeetingId} returning id`,
      ),
    ).then(
      () => 'went through',
      () => 'refused',
    );
    expect(forged).toBe('refused');
    await executeCommand(
      testDbs().worker.db,
      liveMeetingStarted,
      { workspaceId: ws, liveMeetingId, streamId: 'stream-1' },
      system(),
      meta(),
    );
    const coached = await executeCommand(
      testDbs().worker.db,
      callBegin,
      { workspaceId: ws, callId: null, liveMeetingId, userId: rep.id, personId },
      system(true),
      meta(),
    );
    const twice = await executeCommand(
      testDbs().worker.db,
      callBegin,
      { workspaceId: ws, callId: null, liveMeetingId, userId: rep.id, personId },
      system(true),
      meta(),
    );
    expect(twice.output.coachedCallId).toBe(coached.output.coachedCallId);
    // A claim on a meeting that's live finds it, live.
    expect((await claim(rep, {})).state).toBe('live');
    await executeCommand(
      testDbs().worker.db,
      liveMeetingEnded,
      { workspaceId: ws, liveMeetingId },
      system(),
      meta(),
    );
    const [row] = await rows<{ state: string; ended: boolean }>(
      admin(),
      sql`select state, ended_at is not null as ended from app.live_meetings where id = ${liveMeetingId}`,
    );
    expect(row).toEqual({ state: 'ended', ended: true });
    // The next claim on the same meeting is a new one.
    expect((await claim(rep, {})).liveMeetingId).not.toBe(liveMeetingId);
  });
});
