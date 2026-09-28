/**
 * Voting on what's next (0109): the worker closing a week and telling people. A clear winner is picked and the
 * owners and admins of every business that voted hear it's coming soon (members don't, and nobody hears twice); a
 * tie asks the team to choose; the team's pick is told the same way; and a pick the catalogue makes available is
 * written down as shipped and told again.
 *
 * Over add-ons made up for the run and weeks far in the future, so it never picks one of HandsFreeOS's own.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  addonRoadmapCommands,
  defineAddon,
  executeCommand,
  organizationCreate,
  type AddonManifest,
  type Catalog,
  type CatalogStatus,
  type CommandDef,
  type HumanActor,
  nextAddonPickAt,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { addonRoadmapWorker, addonWeekKey, ROADMAP_JOBS } from '../src/addons/roadmap';
import type { HandlerContext } from '../src/handlers/types';
import type { JobContext, JobRow } from '../src/jobs';
import type { MailMessage } from '../src/mailer';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) =>
  executeCommand(api(), cmd, input, actor(u), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output);

const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
const fresh = () => `zw${letters(12)}`;
const planned = (id: string, name: string, status: CatalogStatus = 'planned'): AddonManifest =>
  defineAddon({
    id,
    name,
    summary: `${name}, made up for the test.`,
    description: `${name}, made up for the test.`,
    category: 'operations',
    version: status === 'planned' ? '0.0.0' : '1.0.0',
    dataVersion: 1,
    catalog: { status, keywords: ['test'] },
    capabilities:
      status === 'planned'
        ? []
        : [{ id: `${id}.use` as `${string}.${string}`, label: `Use ${name}`, description: name }],
    permissions: [],
    billing: { model: 'free' },
  });

const alpha = fresh();
const beta = fresh();
const delta = fresh();
const gamma = fresh();
const catalog: Catalog = [
  planned(alpha, 'Alpha Worker'),
  planned(beta, 'Beta Worker'),
  planned(delta, 'Delta Worker'),
  planned(gamma, 'Gamma Worker', 'available'),
];
const worker = addonRoadmapWorker(catalog);
const { vote } = addonRoadmapCommands(catalog);

let s: TestServices;
const sent: MailMessage[] = [];
const mailer = {
  async send(m: MailMessage) {
    sent.push(m);
    return { messageId: randomUUID() };
  },
};
const to = (addressees: readonly TestUser[]) => addressees.map((u) => u.email).sort();
const sentTo = () => sent.map((m) => m.to).sort();

/** A week of its own: a random moment after 2100, never one another run closed. */
const weekEnd = () => new Date(Date.UTC(2100, 0, 1) + randomInt(2 ** 47)).toISOString();

const jobCtx = (kind: string, payload: Record<string, unknown>): JobContext =>
  ({
    ...s,
    mailer,
    job: { id: randomUUID(), kind, payload } as unknown as JobRow,
    scope: {},
    attempt: 1,
    now: Date.now(),
  }) as JobContext;

let owner: TestUser;
let helper: TestUser;
let member: TestUser;
let partner: TestUser;
let teamAdmin: TestUser;
let wsA: string;
let wsB: string;

beforeAll(async () => {
  s = testServices();
  [owner, helper, member, partner, teamAdmin] = await Promise.all([
    createTestUser('roadmap-owner', { fullName: 'Olive Owner' }),
    createTestUser('roadmap-helper', { fullName: 'Hal Helper' }),
    createTestUser('roadmap-member', { fullName: 'Mo Member' }),
    createTestUser('roadmap-partner', { fullName: 'Pat Partner' }),
    createTestUser('roadmap-team', { fullName: 'Chris Team' }),
  ]);
  wsA = (await run(organizationCreate, { businessName: 'Roadmap HVAC' }, owner)).workspaceId;
  wsB = (await run(organizationCreate, { businessName: 'Roadmap Roofing' }, partner)).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsA}, ${helper.id}, 'admin'), (${wsA}, ${member.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role, display_name) values (${teamAdmin.id}, 'admin', 'Chris')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('a week closing', () => {
  it('picks the winner and tells the owners and admins of every business that voted, once', async () => {
    await run(vote, { workspaceId: wsA, addonId: alpha }, owner);
    await run(vote, { workspaceId: wsB, addonId: alpha }, partner);
    await run(vote, { workspaceId: wsB, addonId: beta }, partner);
    sent.length = 0;
    const endsAt = weekEnd();
    await worker.jobs[ROADMAP_JOBS.week]!(jobCtx(ROADMAP_JOBS.week, { endsAt }));

    const [pick] = await rows<{ how: string; votes: number; voters_told_at: Date | null }>(
      admin(),
      sql`select how, votes, voters_told_at from platform.addon_picks where addon_id = ${alpha}`,
    );
    expect(pick).toMatchObject({ how: 'votes', votes: 2 });
    expect(pick!.voters_told_at).not.toBeNull();
    expect(sentTo()).toEqual(to([owner, helper, partner]));
    const mine = sent.find((m) => m.to === owner.email)!;
    expect(mine.subject).toBe('Alpha Worker is coming soon');
    expect(mine.text).toContain('Roadmap HVAC voted for Alpha Worker');
    expect(mine.text).toContain(`/app/w/${wsA}/settings/add-ons`);

    // The same week again: the same answer, and nobody told twice.
    sent.length = 0;
    await worker.jobs[ROADMAP_JOBS.week]!(jobCtx(ROADMAP_JOBS.week, { endsAt }));
    expect(sent).toEqual([]);

    // The next week's close is waiting.
    const next = nextAddonPickAt(Date.parse(endsAt));
    const armed = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs
          where kind = ${ROADMAP_JOBS.week} and dedupe_key = ${addonWeekKey(next)} and status = 'pending'`,
    );
    expect(armed).toHaveLength(1);
  });

  it('asks the team to choose on a tie, once, and tells the voters what they chose', async () => {
    await run(vote, { workspaceId: wsA, addonId: delta }, owner);
    sent.length = 0;
    const endsAt = weekEnd();
    await worker.jobs[ROADMAP_JOBS.week]!(jobCtx(ROADMAP_JOBS.week, { endsAt }));
    const asked = sent.filter((m) => m.to === teamAdmin.email);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.subject).toBe('This week’s add-on vote is a tie');
    expect(asked[0]!.text).toMatch(/Beta Worker and Delta Worker|Delta Worker and Beta Worker/);
    expect(asked[0]!.text).toContain('/admin/add-ons');
    expect(sent.some((m) => m.to === owner.email)).toBe(false);

    sent.length = 0;
    await worker.jobs[ROADMAP_JOBS.week]!(jobCtx(ROADMAP_JOBS.week, { endsAt }));
    expect(sent).toEqual([]);

    // The team picks Delta (as addon_pick.choose does), and the handler tells the one business that voted for it.
    const [week] = await rows<{ id: string }>(
      admin(),
      sql`select id from platform.addon_vote_weeks where ends_at = ${endsAt}::timestamptz`,
    );
    await rows(
      admin(),
      sql`insert into platform.addon_picks (addon_id, how, week_id, votes, picked_by)
          values (${delta}, 'team', ${week!.id}, 1, ${teamAdmin.id})`,
    );
    await worker.handlers['platform.addon_picked'][0]!({
      ...s,
      mailer,
      event: { payload: { addonId: delta } },
    } as unknown as HandlerContext);
    expect(sentTo()).toEqual(to([owner, helper]));
  });
});

describe('shipping', () => {
  it('writes down a pick the catalogue makes available, and tells its voters they can add it', async () => {
    // Voted for while it was planned, picked, and now available in this catalogue.
    await rows(
      admin(),
      sql`insert into platform.addon_votes (addon_id, workspace_id, voted_by) values (${gamma}, ${wsB}, ${partner.id})`,
    );
    await rows(
      admin(),
      sql`insert into platform.addon_picks (addon_id, how, votes, voters_told_at) values (${gamma}, 'votes', 1, now())`,
    );
    sent.length = 0;
    const out = await worker.jobs[ROADMAP_JOBS.shipCheck]!(jobCtx(ROADMAP_JOBS.shipCheck, {}));
    expect(out && 'rescheduleAt' in out).toBe(true);
    const shippedMail = sent.filter((m) => m.subject === 'Gamma Worker is ready to add');
    expect(shippedMail.map((m) => m.to)).toEqual([partner.email]);
    expect(shippedMail[0]!.text).toContain(`/app/w/${wsB}/settings/add-ons?addon=${gamma}`);
    const [pick] = await rows<{ shipped_at: Date | null; shipped_told_at: Date | null }>(
      admin(),
      sql`select shipped_at, shipped_told_at from platform.addon_picks where addon_id = ${gamma}`,
    );
    expect(pick!.shipped_at).not.toBeNull();
    expect(pick!.shipped_told_at).not.toBeNull();

    sent.length = 0;
    await worker.jobs[ROADMAP_JOBS.shipCheck]!(jobCtx(ROADMAP_JOBS.shipCheck, {}));
    expect(sent.filter((m) => m.subject.startsWith('Gamma'))).toEqual([]);
  });
});
