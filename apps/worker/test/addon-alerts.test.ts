/**
 * An add-on telling people something (Real Estate step 5), end to end over the made-up catalogue: Property Management
 * (fxprop) raises alerts from its worker; they become Home cards for the people who hold its permission (and are
 * among the alert's audience, and see its record when that's private), reach them by push and email once per thing
 * said, wait for the business to open unless critical, are acknowledged from the card (and only fxprop hears that),
 * close when fxprop clears them, and go with fxprop when it's turned off.
 */
import { randomUUID } from 'node:crypto';
import {
  addonAlertAcknowledge,
  addonLifecycleCommands,
  attentionList,
  executeCommand,
  executeQuery,
  organizationCreate,
  pushDeviceRegister,
  type AddonManifest,
  type Catalog,
  type HumanActor,
} from '@hfos/core/server';
import { PushData } from '@hfos/core';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_CATALOG, fxprop, fxrent } from '../../../packages/core/test/addons/fixtures';
import {
  addonScope,
  addonWorker,
  clearAddonAlert,
  raiseAddonAlert,
  type AddonAlertInput,
  type AddonWorkerModule,
} from '../src/addons/index';
import { attentionJobs, withAttention } from '../src/attention/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { pushJobs } from '../src/push/send';
import { workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const env = testEnv();
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown, u: TestUser) =>
  executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output as T);
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string; cause?: { code?: string } };
    return err.rule ?? err.cause?.code ?? err.code ?? String(e);
  }
  throw new Error('It was allowed.');
}
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
  (await rows<T>(admin(), q))[0];

// Both add-ons hear that an alert was acknowledged; only the one whose alert it was is told.
const heard: string[] = [];
const fxpropHears: AddonManifest = {
  ...fxprop,
  // Owners and admins see every private lease.
  permissions: [
    ...fxprop.permissions,
    {
      key: 'fxprop.all_leases',
      label: 'See every private lease',
      description: 'Private leases, whoever is on them.',
      defaultRoles: ['admin'],
      requires: ['fxprop.read'],
    },
  ],
  events: {
    ...fxprop.events,
    consumes: [...(fxprop.events?.consumes ?? []), 'addon_alert.acknowledged'],
  },
};
const fxrentHears: AddonManifest = {
  ...fxrent,
  events: {
    ...fxrent.events,
    consumes: [...(fxrent.events?.consumes ?? []), 'addon_alert.acknowledged'],
  },
};
const catalog: Catalog = FIXTURE_CATALOG.map((m) =>
  m.id === fxprop.id ? fxpropHears : m.id === fxrent.id ? fxrentHears : m,
);
const cmds = addonLifecycleCommands(catalog);
const nothing = async () => {};
const modules: AddonWorkerModule[] = [
  {
    manifest: fxpropHears,
    subscribers: {
      'person.updated': nothing,
      'addon_alert.acknowledged': async (ctx) => {
        heard.push(`fxprop:${String((ctx.event.payload as Record<string, unknown>)['key'])}`);
      },
    },
    jobs: { 'fxprop.rent_check': nothing },
  },
  {
    manifest: fxrentHears,
    subscribers: {
      'fxprop.lease.signed': nothing,
      'invoice.paid': nothing,
      'addon_alert.acknowledged': async () => {
        heard.push('fxrent');
      },
    },
    releaseResource: nothing,
  },
];
const w = addonWorker(catalog, modules);
const handlers = w.withAddons(withAttention({}));
const jobs = { ...attentionJobs, ...pushJobs, ...w.jobs };

let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let other: TestUser;
let ws: string;
let org: string;
let generation: number;
let lease: string;

/** One pass over the business: its events, then its due jobs. */
async function pass() {
  const runner = `vitest-alerts-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${runner}
        where status = 'pending' and workspace_id = ${ws}`,
  );
  const outbox = await processOnce({
    ...s,
    handlers,
    workerId: runner,
    batchSize: 100,
    reservedOnly: true,
  });
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
        where status = 'pending' and workspace_id = ${ws}
          and (kind like 'addon.%' or kind like 'addon_alert.%' or kind like 'push.send' or run_at <= now())
          and run_at <= now() + interval '1 minute'`,
  );
  const done = await processJobs({
    ...s,
    jobs,
    workerId: runner,
    batchSize: 100,
    reservedOnly: true,
  });
  return { outbox, jobs: done };
}
async function drain() {
  for (let i = 0; i < 30; i++) {
    const r = await pass();
    if (r.outbox.claimed === 0 && r.jobs.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

/** fxprop's worker, in this business. */
const fx = () =>
  addonScope(s, fxpropHears, { workspaceId: ws, organizationId: org }, generation, workerMeta());
const raise = (input: Partial<AddonAlertInput> & Pick<AddonAlertInput, 'key'>) =>
  raiseAddonAlert(fx(), {
    severity: 'at_risk',
    title: 'Rent for 12 Elm St is 5 days late',
    detail: 'Tess hasn’t paid October’s rent.',
    href: '/a/fxprop/leases',
    permission: 'fxprop.read',
    ...input,
  });

/** What a person's Home shows of add-on alerts. */
const homeOf = async (u: TestUser) =>
  (
    await executeQuery(
      api(),
      attentionList,
      { workspaceId: ws, scope: 'everyone' },
      human(u),
      meta(),
    )
  ).items.filter((i) => i.kind === 'addon_alert');

const cardOf = (alertId: string) =>
  one<{
    state: string;
    resolution: string | null;
    sealed: boolean;
    custom_record_id: string | null;
  }>(
    sql`select state::text, resolution, sealed, custom_record_id from app.attention_items
        where kind = 'addon_alert' and subject_id = ${alertId}`,
  );

interface Mail {
  ID: string;
  Subject: string;
}
async function mailsTo(to: string, subject: string): Promise<Mail[]> {
  const res = await fetch(
    `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}" subject:"${subject}"`)}`,
  );
  return ((await res.json()) as { messages: Mail[] }).messages;
}

const pushesTo = (token: string) => s.push.fake.sent.filter((p) => p.message.to === token);

let agentPhone: string;
let otherPhone: string;

/** Business hours that aren't now: a stretch on a day three days from today, in Chicago. */
async function closedNow() {
  const today = new Date(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago' }).format(new Date()),
  ).getDay();
  await rows(
    admin(),
    sql`update app.workspaces set settings = settings || ${JSON.stringify({
      openHours: [{ day: (today + 3) % 7, start: '09:00', end: '10:00' }],
    })}::jsonb where id = ${ws}`,
  );
}
const alwaysOpen = () =>
  rows(
    admin(),
    sql`update app.workspaces set settings = settings || '{"openHours": []}'::jsonb where id = ${ws}`,
  );

beforeAll(async () => {
  [owner, agent, other] = await Promise.all([
    createTestUser('alerts-owner'),
    createTestUser('alerts-agent'),
    createTestUser('alerts-other'),
  ]);
  const made = await run<{ workspaceId: string; organizationId: string }>(
    organizationCreate,
    { businessName: 'Alerts Realty' },
    owner,
  );
  ws = made.workspaceId;
  org = made.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${agent.id}, 'member'), (${ws}, ${other.id}, 'member')`,
  );
  for (const m of catalog)
    if (m.permissions.length > 0)
      await rows(
        admin(),
        sql`select private.register_addon_permissions(${m.id}, ${JSON.stringify(m.permissions)}::jsonb)`,
      );
  s = testServices();
  await alwaysOpen();
  await run(cmds.install, { workspaceId: ws, addonId: 'fxprop' }, owner);
  await run(cmds.install, { workspaceId: ws, addonId: 'fxrent' }, owner);
  await drain();
  generation = (await one<{ generation: number }>(
    sql`select generation from app.addon_installations where workspace_id = ${ws} and addon_id = 'fxprop'`,
  ))!.generation;
  // A record kept to the agent alone (seen whole by owners and admins): an alert about it is theirs, and the owner's.
  lease = (await one<{ id: string }>(
    sql`with kind as (
          insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
            kept_to_team, see_all_permission, position)
          values (${ws}, 'fxprop_private_lease', 'Private lease', 'Private leases', 'fxprop', 'fxprop.write', true,
            'fxprop.all_leases', 900)
          returning id)
        insert into app.custom_records (workspace_id, type_id, name, owner_user_id)
        select ${ws}, kind.id, '12 Elm St lease', ${agent.id}::uuid from kind
        returning id`,
  ))!.id;
  const phone = async (u: TestUser) => {
    const token = `ExponentPushToken[alerts-${randomUUID().slice(0, 12)}]`;
    await run(
      pushDeviceRegister,
      { platform: 'ios', token, appVersion: '1.0.0', deviceName: 'ios' },
      u,
    );
    return token;
  };
  agentPhone = await phone(agent);
  otherPhone = await phone(other);
}, 90_000);

afterAll(closeTestDbs);

describe('an add-on’s alert', () => {
  it('goes on Home for the people holding its permission, named after the add-on', async () => {
    const { alertId, news } = await raise({ key: 'lease:late:1', needsAck: true });
    expect(news).toBe(true);
    await drain();
    const [card] = await homeOf(agent);
    expect(card).toMatchObject({
      kind: 'addon_alert',
      title: 'Rent for 12 Elm St is 5 days late',
      urgent: true,
      handleLabel: 'Open',
      addonAlert: {
        alertId,
        addonId: 'fxprop',
        // Home names an add-on from the real catalogue, which the made-up ones aren't in.
        addonName: 'the add-on',
        severity: 'at_risk',
        href: '/a/fxprop/leases',
        needsAck: true,
        acknowledgedAt: null,
      },
      actions: { handle: true, snooze: true, dismiss: false, assign: false },
    });
    expect(card!.reasons.map((r) => r.code)).toEqual(['severity', 'needs_ack']);
    expect(await homeOf(owner)).toHaveLength(1);
    expect(await homeOf(other)).toHaveLength(1);
  });

  it('reaches its people by push and email once for each thing it says', async () => {
    const pushes = pushesTo(agentPhone).length;
    expect(pushes).toBeGreaterThan(0);
    expect(await mailsTo(agent.email, 'At risk: Rent for 12 Elm St is 5 days late')).toHaveLength(
      1,
    );
    // Raised again saying the same: no news, nobody told again.
    expect((await raise({ key: 'lease:late:1', needsAck: true })).news).toBe(false);
    await drain();
    expect(pushesTo(agentPhone)).toHaveLength(pushes);
    // Saying something new is news.
    expect(
      (
        await raise({
          key: 'lease:late:1',
          needsAck: true,
          title: 'Rent for 12 Elm St is 6 days late',
        })
      ).news,
    ).toBe(true);
    await drain();
    expect(pushesTo(agentPhone)).toHaveLength(pushes + 1);
    expect(await mailsTo(agent.email, 'At risk: Rent for 12 Elm St is 6 days late')).toHaveLength(
      1,
    );
  });

  it('is only for its audience, when it names one', async () => {
    const { alertId } = await raise({
      key: 'lease:audience',
      severity: 'attention',
      title: 'Check the smoke alarms at 12 Elm St',
      audienceUserIds: [agent.id],
    });
    await drain();
    expect((await homeOf(agent)).map((c) => c.addonAlert?.alertId)).toContain(alertId);
    expect((await homeOf(owner)).map((c) => c.addonAlert?.alertId)).not.toContain(alertId);
    expect((await homeOf(other)).map((c) => c.addonAlert?.alertId)).not.toContain(alertId);
    expect(pushesTo(otherPhone).filter((p) => p.message.title?.includes('smoke'))).toHaveLength(0);
  });

  it('about a private record, only for the people who see that record', async () => {
    const { alertId } = await raise({
      key: 'lease:private',
      title: 'The 12 Elm St lease ends in 30 days',
      customRecordId: lease,
    });
    await drain();
    expect(await cardOf(alertId)).toMatchObject({ sealed: true, custom_record_id: lease });
    expect((await homeOf(agent)).map((c) => c.addonAlert?.alertId)).toContain(alertId);
    expect((await homeOf(owner)).map((c) => c.addonAlert?.alertId)).toContain(alertId);
    expect((await homeOf(other)).map((c) => c.addonAlert?.alertId)).not.toContain(alertId);
    // Nor its row, read directly.
    const seen = await asUser(api(), other.claims, (tx) =>
      rows(tx, sql`select id from app.addon_alerts where id = ${alertId}`),
    );
    expect(seen).toHaveLength(0);
    expect(
      pushesTo(otherPhone).filter((p) => p.message.title?.includes('lease ends')),
    ).toHaveLength(0);
    const pushed = pushesTo(agentPhone).filter((p) => p.message.title?.includes('lease ends'));
    expect(pushed).toHaveLength(1);
    // It opens the add-on's page, and names the record, so the phone's screen for it can find it.
    expect(PushData.parse(pushed[0]!.message.data)).toMatchObject({
      category: 'addon_alert',
      path: `/app/w/${ws}/a/fxprop/leases`,
      refs: { alertId, recordId: lease },
    });
  });

  it('waits for the business to open, unless it’s critical', async () => {
    await closedNow();
    try {
      const late = await raise({ key: 'lease:night', title: 'A lease renewal is waiting' });
      const critical = await raise({
        key: 'lease:flood',
        severity: 'critical',
        title: 'Water leak reported at 12 Elm St',
      });
      await drain();
      expect(pushesTo(agentPhone).filter((p) => p.message.title?.includes('renewal'))).toHaveLength(
        0,
      );
      expect(
        pushesTo(agentPhone).filter((p) => p.message.title?.includes('Water leak')),
      ).toHaveLength(1);
      const waiting = await one<{ run_at: Date; status: string }>(
        sql`select run_at, status from app.scheduled_jobs
            where workspace_id = ${ws} and kind = 'addon_alert.notify' and payload ->> 'alertId' = ${late.alertId}`,
      );
      expect(waiting?.status).toBe('pending');
      expect(new Date(waiting!.run_at).getTime()).toBeGreaterThan(Date.now());
      // Home shows both straight away.
      const ids = (await homeOf(agent)).map((c) => c.addonAlert?.alertId);
      expect(ids).toEqual(expect.arrayContaining([late.alertId, critical.alertId]));
    } finally {
      await alwaysOpen();
    }
  });

  it('is acknowledged by someone who sees it, once, and only its add-on hears', async () => {
    const [card] = (await homeOf(agent)).filter((c) => c.addonAlert?.needsAck);
    const alertId = card!.addonAlert!.alertId;
    const first = await run<{ changed: boolean }>(
      addonAlertAcknowledge,
      { workspaceId: ws, alertId },
      agent,
    );
    expect(first.changed).toBe(true);
    const again = await run<{ changed: boolean }>(
      addonAlertAcknowledge,
      { workspaceId: ws, alertId },
      owner,
    );
    expect(again.changed).toBe(false);
    await drain();
    expect(heard).toEqual(['fxprop:lease:late:1']);
    const after = (await homeOf(agent)).find((c) => c.addonAlert?.alertId === alertId)!;
    expect(after.addonAlert?.acknowledgedAt).not.toBeNull();
    expect(after.reasons.map((r) => r.code)).toEqual(['severity']);

    // One it doesn't ask for, and one they can't see.
    const plain = (await homeOf(agent)).find((c) => !c.addonAlert?.needsAck)!;
    expect(
      await refused(
        run(addonAlertAcknowledge, { workspaceId: ws, alertId: plain.addonAlert!.alertId }, agent),
      ),
    ).toBe('addon_alert_no_ack');
    const theirs = await raise({
      key: 'lease:agent-only',
      title: 'Sign the renewal',
      needsAck: true,
      audienceUserIds: [agent.id],
    });
    expect(
      await refused(
        run(addonAlertAcknowledge, { workspaceId: ws, alertId: theirs.alertId }, other),
      ),
    ).toBe('addon_alert_not_yours');
  });

  it('closes its card when the add-on clears it, as handled today', async () => {
    const { alertId } = await raise({ key: 'lease:clear', title: 'Collect the deposit' });
    await drain();
    expect(await clearAddonAlert(fx(), 'lease:clear')).toBe(true);
    expect(await clearAddonAlert(fx(), 'lease:clear')).toBe(false);
    await drain();
    expect(await cardOf(alertId)).toMatchObject({ state: 'resolved', resolution: 'done' });
  });

  it('is written only by the worker, while the add-on may write', async () => {
    const tried = await refused(
      asUser(api(), owner.claims, (tx) =>
        rows(
          tx,
          sql`insert into app.addon_alerts (workspace_id, addon_id, key, severity, title, href, permission)
              values (${ws}, 'fxprop', 'x', 'info', 'x', '/a/fxprop', 'fxprop.read')`,
        ),
      ),
    );
    expect(tried).toBe('42501');
  });

  it('goes with the add-on when it’s turned off, and the move proves it', async () => {
    const open = await rows<{ id: string }>(
      admin(),
      sql`select id from app.addon_alerts where workspace_id = ${ws} and cleared_at is null`,
    );
    expect(open.length).toBeGreaterThan(0);
    await run(cmds.disable, { workspaceId: ws, addonId: 'fxprop', include: ['fxrent'] }, owner);
    await drain();
    expect(
      await one(
        sql`select count(*)::int as n from app.addon_alerts
            where workspace_id = ${ws} and (cleared_at is null or clear_reason is distinct from 'addon_off')
              and id = any(${`{${open.map((o) => o.id).join(',')}}`}::uuid[])`,
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(
        sql`select count(*)::int as n from app.attention_items
            where workspace_id = ${ws} and kind = 'addon_alert' and state <> 'resolved'`,
      ),
    ).toEqual({ n: 0 });
    expect(await homeOf(owner)).toEqual([]);
    const installed = await one<{ state: string; failed: string[] }>(
      sql`select state, coalesce((select array_agg(c ->> 'name') from jsonb_array_elements(verification -> 'checks') c
                    where (c ->> 'ok')::boolean = false), '{}') as failed
          from app.addon_installations where workspace_id = ${ws} and addon_id = 'fxprop'`,
    );
    expect(installed).toEqual({ state: 'disabled', failed: [] });
    // Nothing is raised while it's off.
    await expect(raise({ key: 'lease:off', title: 'Too late' })).rejects.toThrow();
  });
});
