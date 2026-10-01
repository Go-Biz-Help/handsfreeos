/**
 * M10 step 6a on the local database: a person's phones for push notifications, and the switches.
 * - **push_device.register** adds the phone, and sent again refreshes it: the same row, no new event; a name left out
 *   stays, and a phone turned off comes back on.
 * - **A phone passes between people:** registering its token turns off whoever used it before, and signing back in
 *   takes it back, so a token is only ever live for one person.
 * - **push_device.remove** turns off this phone by its token or another by its id, once; never someone else's.
 * - **Neither waits on a phone** (online), a repeat with the same command id runs once, and no token reaches an
 *   event, the audit log or the stored answer.
 * - **pushSwitchOn** reads a switch exactly as the database's private.push_on does.
 * - **A push to support people** (a new ticket) belongs to no business and opens the desk; every other push opens its
 *   own business. Its words say which ticket, who wrote and about what.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { auditLogs, commandReceipts, events, pushDevices } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta } from '../src/kernel/types';
import {
  isStaffPush,
  PUSH_CATEGORY_IDS,
  PUSH_SWITCHES,
  PushData,
  pushSwitchesOf,
  pushSwitchOn,
  supportTicketPushWords,
} from '../src/push';
import { pushDeviceRegister, pushDeviceRemove } from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const web = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'web' });
const phone = (commandId = randomUUID(), occurredAt = new Date()): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'mobile',
  commandId,
  occurredAt,
  sentAt: new Date(),
  confirmedAt: null,
  appVersion: '1.0.0',
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  meta: RequestMeta = phone(),
) => executeCommand(api(), cmd, input, human(u), meta).then((r) => r.output);

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect({ code: (e as HfosError).code, rule: (e as HfosError).rule }).toMatchObject({
      code,
      ...(rule ? { rule } : {}),
    });
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

const token = () => `ExponentPushToken[${randomUUID().replaceAll('-', '').slice(0, 22)}]`;
const register = (u: TestUser, t: string, extra: Record<string, unknown> = {}) =>
  run(pushDeviceRegister, { platform: 'ios', token: t, appVersion: '1.0.0', ...extra }, u);
const device = async (id: string) =>
  (await admin().select().from(pushDevices).where(eq(pushDevices.id, id)))[0]!;
const eventsFor = (id: string) =>
  admin()
    .select()
    .from(events)
    .where(and(eq(events.entityType, 'push_device'), eq(events.entityId, id)));

let dale: TestUser;
let marco: TestUser;

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('push-dale', { fullName: 'Dale Owner' }),
    createTestUser('push-marco', { fullName: 'Marco Member' }),
  ]);
});
afterAll(closeTestDbs);

describe('push_device.register', () => {
  it('adds a phone, and sent again refreshes the same one without news', async () => {
    const t = token();
    const first = await register(dale, t, { deviceName: 'Dale’s iPhone' });
    expect(first.created).toBe(true);
    const row = await device(first.deviceId);
    expect(row).toMatchObject({
      userId: dale.id,
      platform: 'ios',
      expoPushToken: t,
      deviceName: 'Dale’s iPhone',
      disabledAt: null,
    });
    expect((await eventsFor(first.deviceId)).map((e) => e.eventType)).toEqual([
      'push_device.registered',
    ]);

    // The app starts again on a newer build: the same row, its name kept, no second event.
    const again = await register(dale, t, { appVersion: '1.1.0', platform: 'ios' });
    expect(again).toEqual({ deviceId: first.deviceId, created: false });
    const refreshed = await device(first.deviceId);
    expect(refreshed.appVersion).toBe('1.1.0');
    expect(refreshed.deviceName).toBe('Dale’s iPhone');
    expect(refreshed.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row.lastSeenAt.getTime());
    expect(await eventsFor(first.deviceId)).toHaveLength(1);
    // null clears the name.
    await register(dale, t, { deviceName: null });
    expect((await device(first.deviceId)).deviceName).toBeNull();

    // Turned off here, then registered again: back on, and that is news.
    await run(pushDeviceRemove, { token: t, reason: 'turned_off' }, dale);
    const back = await register(dale, t);
    expect(back).toEqual({ deviceId: first.deviceId, created: false });
    expect(await device(first.deviceId)).toMatchObject({ disabledAt: null, disabledReason: null });
    expect((await eventsFor(first.deviceId)).map((e) => e.eventType).sort()).toEqual([
      'push_device.registered',
      'push_device.registered',
      'push_device.removed',
    ]);
  });

  it('passes a phone from one person to the next, and back', async () => {
    const t = token();
    const marcos = await register(marco, t);
    const dales = await register(dale, t);
    expect(dales.created).toBe(true);
    expect(await device(marcos.deviceId)).toMatchObject({ disabledReason: 'replaced' });
    expect(await device(dales.deviceId)).toMatchObject({ disabledAt: null });

    // Marco signs back in on it: his row comes back on and Dale's goes off.
    const again = await register(marco, t);
    expect(again).toEqual({ deviceId: marcos.deviceId, created: false });
    expect(await device(marcos.deviceId)).toMatchObject({ disabledAt: null, disabledReason: null });
    expect(await device(dales.deviceId)).toMatchObject({ disabledReason: 'replaced' });
    const [live] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.push_devices where expo_push_token = ${t} and disabled_at is null`,
    );
    expect(live!.n).toBe(1);
  });

  it('checks the token and keeps it out of events, the audit log and the stored answer', async () => {
    await expectHfos(() => register(dale, 'not-a-token'), 'validation');
    await expectHfos(
      () => run(pushDeviceRegister, { platform: 'windows', token: token(), appVersion: '1' }, dale),
      'validation',
    );
    const t = token();
    const commandId = randomUUID();
    const input = { platform: 'android', token: t, appVersion: '2.0.0', deviceName: 'Pixel' };
    const first = await run(pushDeviceRegister, input, dale, phone(commandId));
    // The same command again (its answer lost on the way): the first answer, and nothing runs twice.
    const repeat = await run(pushDeviceRegister, input, dale, phone(commandId));
    expect(repeat).toEqual(first);
    expect(await eventsFor(first.deviceId)).toHaveLength(1);

    const [receipt] = await admin()
      .select()
      .from(commandReceipts)
      .where(and(eq(commandReceipts.userId, dale.id), eq(commandReceipts.commandId, commandId)));
    const ids = (await eventsFor(first.deviceId)).map((e) => e.id);
    const audit = await admin().select().from(auditLogs).where(inArray(auditLogs.eventId, ids));
    const written = JSON.stringify([receipt, await eventsFor(first.deviceId), audit]);
    expect(written).toContain(first.deviceId);
    expect(written).not.toContain(t.slice(18, -1));
  });

  it('never waits on a phone', async () => {
    expect(pushDeviceRegister.offline).toBe('online');
    expect(pushDeviceRemove.offline).toBe('online');
    const old = new Date(Date.now() - 5 * 60_000);
    await expectHfos(
      () =>
        run(
          pushDeviceRegister,
          { platform: 'ios', token: token(), appVersion: '1.0.0' },
          dale,
          phone(randomUUID(), old),
        ),
      'rule_violation',
      'online_only',
    );
    // The web registers nothing, but nothing stops it running there either.
    const t = token();
    const { created } = await executeCommand(
      api(),
      pushDeviceRegister,
      { platform: 'ios', token: t, appVersion: '1.0.0' },
      human(dale),
      web(),
    ).then((r) => r.output);
    expect(created).toBe(true);
  });
});

describe('push_device.remove', () => {
  it('turns this phone off by its token once, as signed out', async () => {
    const t = token();
    const { deviceId } = await register(marco, t);
    const off = await run(pushDeviceRemove, { token: t }, marco);
    expect(off).toEqual({ deviceId, changed: true });
    const row = await device(deviceId);
    expect(row.disabledReason).toBe('signed_out');
    expect(row.disabledAt).not.toBeNull();
    // Again (a retry, or signing out twice): nothing changes, nothing new is written.
    expect(await run(pushDeviceRemove, { token: t }, marco)).toEqual({
      deviceId: null,
      changed: false,
    });
    expect(
      (await eventsFor(deviceId)).filter((e) => e.eventType === 'push_device.removed'),
    ).toHaveLength(1);
    // A phone that never registered signs out quietly too.
    expect(await run(pushDeviceRemove, { token: token() }, marco)).toEqual({
      deviceId: null,
      changed: false,
    });
  });

  it('turns another of your phones off by its id, and never someone else’s', async () => {
    const t = token();
    const { deviceId } = await register(marco, t);
    // Dale knows the id (say it leaked): row-level security and the command both keep him out.
    expect(await run(pushDeviceRemove, { deviceId, reason: 'turned_off' }, dale)).toEqual({
      deviceId: null,
      changed: false,
    });
    expect((await device(deviceId)).disabledAt).toBeNull();
    const seen = await executeCommand(
      api(),
      pushDeviceRemove,
      { token: t },
      human(dale),
      phone(),
    ).then((r) => r.output);
    expect(seen.changed).toBe(false);
    expect((await device(deviceId)).disabledAt).toBeNull();

    expect(await run(pushDeviceRemove, { deviceId, reason: 'turned_off' }, marco)).toEqual({
      deviceId,
      changed: true,
    });
    expect((await device(deviceId)).disabledReason).toBe('person');
  });

  it('names one phone, by its token or its id', async () => {
    await expectHfos(() => run(pushDeviceRemove, {}, marco), 'validation');
    await expectHfos(
      () => run(pushDeviceRemove, { token: token(), deviceId: randomUUID() }, marco),
      'validation',
    );
  });
});

describe('pushSwitchOn', () => {
  it('reads each switch exactly as private.push_on does', async () => {
    const cases: unknown[] = [
      {},
      { push: {} },
      { push: { payment: true, urgent: false } },
      { push: { booking: 'no', assigned: null, approval: false } },
      { push: 'off' },
      { notifications: { bookingEmail: false, payment: true } },
      {
        push: {
          customerWaiting: false,
          urgent: true,
          approval: true,
          booking: false,
          assigned: false,
          payment: false,
        },
      },
    ];
    for (const settings of cases)
      for (const key of PUSH_SWITCHES) {
        const [db] = await rows<{ on: boolean }>(
          admin(),
          sql`select private.push_on(${JSON.stringify(settings)}::jsonb, ${key}) as on`,
        );
        expect(pushSwitchOn(settings, key), `${key} in ${JSON.stringify(settings)}`).toBe(db!.on);
      }
    expect(pushSwitchesOf({})).toEqual({
      customerWaiting: true,
      missedCall: true,
      urgent: true,
      approval: true,
      booking: true,
      assigned: true,
      payment: false,
      // M16. On by default like the rest: `payment` is the only one that starts off.
      wallet: true,
      jobs: true,
      connections: true,
      // Real Estate step 5: an add-on's alerts.
      addons: true,
      // Only support people see it, and for them it is on until turned off.
      supportTickets: true,
    });
  });
});

describe('what a push carries', () => {
  const ws = randomUUID();
  const ticket = randomUUID();
  const base = {
    v: 1,
    notificationId: randomUUID(),
    sentAt: new Date().toISOString(),
    refs: {},
    commandIds: {},
  };
  const business = {
    ...base,
    category: 'booking',
    workspaceId: ws,
    business: 'Lone Star HVAC & Roofing',
    path: `/app/w/${ws}/calendar`,
  };
  const support = {
    ...base,
    category: 'support_ticket',
    workspaceId: null,
    business: '',
    path: `/admin/tickets/${ticket}`,
    refs: { ticketId: ticket },
  };

  it('has a business and opens under it, except a push to support people, which has none and opens the desk', () => {
    expect(PushData.safeParse(business).success).toBe(true);
    expect(PushData.safeParse(support).success).toBe(true);
    expect(PUSH_CATEGORY_IDS.filter(isStaffPush)).toEqual(['support_ticket']);
    for (const wrong of [
      { ...business, workspaceId: null },
      { ...business, path: `/admin/tickets/${ticket}` },
      { ...support, workspaceId: ws },
      { ...support, path: `/app/w/${ws}/inbox` },
      { ...support, path: 'https://example.com/admin/tickets' },
      { ...business, path: '/i/abc' },
    ])
      expect(PushData.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
  });

  it('names the ticket, who wrote and their business, and quotes the start of what they wrote', () => {
    expect(
      supportTicketPushWords({
        number: 1042,
        subject: '  Reminders   stopped going out ',
        preview: 'They went out on Monday\nand not since.',
        requester: 'Dana Reed',
        business: 'Reed Plumbing',
      }),
    ).toEqual({
      title: 'New support ticket #1042',
      about: 'Dana Reed · Reed Plumbing',
      body: 'Reminders stopped going out: “They went out on Monday and not since.”',
    });
    // No business known yet, nothing written: the address and the subject alone.
    expect(
      supportTicketPushWords({ number: 7, subject: '', requester: 'dana@example.com' }),
    ).toEqual({ title: 'New support ticket #7', about: 'dana@example.com', body: 'No subject' });
    // However long, the quote still closes inside what a phone shows.
    const long = supportTicketPushWords({
      number: 8,
      subject: 'S'.repeat(300),
      preview: 'w '.repeat(300),
      requester: 'Dana',
    });
    expect(long.body.length).toBeLessThanOrEqual(180);
    expect(long.body.endsWith('…”')).toBe(true);
  });
});
