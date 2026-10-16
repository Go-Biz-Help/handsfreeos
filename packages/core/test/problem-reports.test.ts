/**
 * Problem reports (schemas/problem-report.ts, 20261027008100): what one of our own tools saw when something didn't go.
 * Anyone in the business sends one, and it's theirs alone there; HandsFreeOS's staff with Health read every business's
 * on the desk, one with its outline, and mark them handled. Nobody else does, not support agents and not the business,
 * whether through the kernel or the database's functions.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import {
  organizationCreate,
  platformProblemReportGet,
  platformProblemReportList,
  problemReportSend,
  problemReportSetHandled,
} from '../src/server';
import {
  PROBLEM_OUTLINE_MOST,
  ProblemReport,
  type ProblemReportFull,
} from '../src/schemas/problem-report';
import { problemForClaude, problemState } from '../src/support/problem-words';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

const report = {
  addonId: 'outreach',
  source: 'extension',
  area: 'linkedin',
  job: 'profile_read',
  page: 'own-profile',
  path: '/in/{1}/',
} as const;

describe('a report as a tool sends it', () => {
  it('takes counts, yes or no and section names as found, and an empty note as none', () => {
    const got = ProblemReport.parse({
      ...report,
      found: { roles: 0, about: true, sections: ['About', 'Experience'] },
      note: ' ',
    });
    expect(got).toMatchObject({ ref: null, shown: null, note: null, outline: null });
    expect(got.found).toEqual({ roles: 0, about: true, sections: ['About', 'Experience'] });
  });

  it('refuses words as what was found, a key that isn’t a plain name, an area or add-on that isn’t one, and too long an outline', () => {
    const bad = [
      { found: { about: 'I help roofers' } },
      { found: { 'Dana Reyes': 1 } },
      { area: 'Linked In' },
      { addonId: 'Outreach!' },
      { outline: 'x'.repeat(PROBLEM_OUTLINE_MOST + 1) },
    ];
    for (const change of bad)
      expect(
        ProblemReport.safeParse({ ...report, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
  });
});

describe('Copy for Claude', () => {
  const full: ProblemReportFull = {
    reportId: randomUUID(),
    at: '2026-10-16T19:31:00.000Z',
    workspaceId: randomUUID(),
    business: 'Reyes Roofing',
    addonId: 'outreach',
    source: 'extension',
    area: 'linkedin',
    job: 'checkup',
    ref: null,
    version: '0.49.0',
    page: 'own-profile',
    path: '/in/{1}/',
    shown: true,
    note: 'Not read: Experience.',
    handledAt: null,
    found: { roles: 0 },
    outline: 'body\n  h2 "Experience"',
    handledBy: null,
  };

  it('says what, where and which version, with the outline, and never whose business it was', () => {
    const text = problemForClaude(full);
    expect(text).toContain('browser extension (the outreach add-on), version 0.49.0');
    expect(text).toContain('- Page: own-profile /in/{1}/');
    expect(text).toContain('- Note: Not read: Experience.');
    expect(text).toContain('- Found: {"roles":0}');
    expect(text).toContain('```text\nbody\n  h2 "Experience"\n```');
    expect(text).not.toContain('Reyes Roofing');
    expect(problemForClaude({ ...full, outline: null })).not.toContain('```');
  });

  it('reads the state a page address asks for, or the open ones', () => {
    expect(problemState('handled')).toBe('handled');
    expect(problemState('everything')).toBe('open');
  });
});

describe('sending and handling', () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let staffLead: TestUser;
  let agent: TestUser;
  let workspaceId: string;
  // An area of this run's own: the desk lists every business's, from every run on this database.
  const AREA = `t${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const beStaff = (u: TestUser, role: 'lead' | 'agent') =>
    admin().execute(
      sql`insert into platform.staff (user_id, role) values (${u.id}, ${role})
          on conflict (user_id) do update set role = ${role}, status = 'active'`,
    );
  const send = (who: TestUser, change: Record<string, unknown> = {}) =>
    executeCommand(
      api(),
      problemReportSend,
      { workspaceId, report: { ...report, ...change } },
      human(who),
      meta(),
    );
  const list = (who: TestUser, input: Record<string, unknown> = {}) =>
    executeQuery(api(), platformProblemReportList, input as never, human(who), meta());
  const handle = (who: TestUser, reportIds: string[], handled = true) =>
    executeCommand(api(), problemReportSetHandled, { reportIds, handled }, human(who), meta());

  /** The database's reason for refusing, however deep the driver wrapped it. */
  function refusal(e: unknown): string | undefined {
    let err = e as { detail?: string; cause?: unknown } | undefined;
    while (err && !err.detail && err.cause) err = err.cause as typeof err;
    return err?.detail;
  }

  beforeAll(async () => {
    [owner, member, outsider, staffLead, agent] = await Promise.all([
      createTestUser('problems-owner'),
      createTestUser('problems-member'),
      createTestUser('problems-outsider'),
      createTestUser('problems-staff-lead'),
      createTestUser('problems-staff-agent'),
    ]);
    const { output } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Problem Reports Roofing' },
      human(owner),
      meta(),
    );
    workspaceId = output.workspaceId;
    await admin().execute(
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${member.id}, 'member')`,
    );
    await Promise.all([beStaff(staffLead, 'lead'), beStaff(agent, 'agent')]);
  }, 60_000);
  afterAll(closeTestDbs);

  it('keeps a member’s report as theirs alone in the business, and says so in a small event', async () => {
    const outline = 'HandsFreeOS Social 0.49.0 · page outline\nbody\n  h2 "Experience"';
    const { output } = await send(member, {
      version: '0.49.0',
      shown: false,
      found: { roles: 0 },
      note: 'Not read: Experience.',
      outline,
    });
    const [row] = await rows<{ user_id: string; addon_id: string; outline: string }>(
      admin(),
      sql`select user_id, addon_id, outline from app.problem_reports where id = ${output.reportId}`,
    );
    expect(row).toEqual({ user_id: member.id, addon_id: 'outreach', outline });
    const [event] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'problem_report.sent' and entity_id = ${output.reportId}`,
    );
    expect(event?.payload).toEqual({
      addonId: 'outreach',
      source: 'extension',
      area: 'linkedin',
      job: 'profile_read',
      page: 'own-profile',
    });
    // The owner of the business doesn't read it on the database; its sender does.
    const read = (u: TestUser) =>
      asUser(api(), u.claims, (tx) =>
        rows(tx, sql`select id from app.problem_reports where id = ${output.reportId}`),
      );
    expect(await read(owner)).toEqual([]);
    expect(await read(member)).toHaveLength(1);
  });

  it('refuses someone who isn’t in the business', async () => {
    await expect(send(outsider)).rejects.toBeInstanceOf(HfosError);
  });

  it('lists every business’s for staff with Health, newest first and a page at a time, and one with its outline', async () => {
    const sent = [];
    for (const job of ['like', 'comment', 'checkup'])
      sent.push((await send(owner, { job, area: AREA })).output.reportId);
    const first = await list(staffLead, { area: AREA, limit: 2 });
    expect(first.reports.map((r) => r.reportId)).toEqual([sent[2], sent[1]]);
    expect(first.reports[0]).toMatchObject({
      business: 'Problem Reports Roofing',
      job: 'checkup',
      hasOutline: false,
      handledAt: null,
    });
    expect(first.nextBefore).not.toBeNull();
    const second = await list(staffLead, { area: AREA, limit: 2, before: first.nextBefore });
    expect(second.reports.map((r) => r.reportId)).toEqual([sent[0]]);
    expect(second.nextBefore).toBeNull();
    expect(first.areas).toEqual(
      expect.arrayContaining([
        { area: AREA, open: 3 },
        { area: 'linkedin', open: expect.any(Number) },
      ]),
    );
    const [withOutline] = (await list(staffLead, { area: 'linkedin' })).reports.filter(
      (r) => r.hasOutline && r.workspaceId === workspaceId,
    );
    const one = await executeQuery(
      api(),
      platformProblemReportGet,
      { reportId: withOutline!.reportId },
      human(staffLead),
      meta(),
    );
    expect(one).toMatchObject({ found: { roles: 0 }, shown: false, handledBy: null });
    expect(one.outline).toContain('h2 "Experience"');
  });

  it('marks reports handled and open again, once each, and lists them where they now belong', async () => {
    const { reports } = await list(staffLead, { area: AREA });
    const ids = reports.map((r) => r.reportId);
    expect((await handle(staffLead, ids)).output.changed.sort()).toEqual([...ids].sort());
    expect((await handle(staffLead, ids)).output.changed).toEqual([]);
    expect((await list(staffLead, { area: AREA })).reports).toEqual([]);
    const handled = await list(staffLead, { area: AREA, state: 'handled' });
    expect(handled.reports.map((r) => r.reportId).sort()).toEqual([...ids].sort());
    const one = await executeQuery(
      api(),
      platformProblemReportGet,
      { reportId: ids[0]! },
      human(staffLead),
      meta(),
    );
    expect(one.handledAt).not.toBeNull();
    expect((await handle(staffLead, [ids[0]!], false)).output.changed).toEqual([ids[0]]);
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_type = 'problem_report'
          and event_type in ('problem_report.handled', 'problem_report.reopened') and entity_id = any(${`{${ids.join(',')}}`}::uuid[])
          order by created_at`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'problem_report.handled',
      'problem_report.reopened',
    ]);
  });

  it('refuses a support agent and the business itself, through the kernel and the database', async () => {
    const [mine] = (await list(staffLead, { area: AREA, state: 'all' })).reports;
    await expect(list(agent)).rejects.toBeInstanceOf(HfosError);
    await expect(list(owner)).rejects.toBeInstanceOf(HfosError);
    await expect(handle(agent, [mine!.reportId])).rejects.toBeInstanceOf(HfosError);
    await expect(handle(member, [mine!.reportId])).rejects.toBeInstanceOf(HfosError);
    const direct = await asUser(api(), member.claims, (tx) =>
      rows(
        tx,
        sql`select * from private.set_problem_reports_handled(${`{${mine!.reportId}}`}::uuid[], true)`,
      ),
    ).catch((e: unknown) => e);
    expect(refusal(direct)).toBe('problem_reports_are_ours');
    const listed = await asUser(api(), owner.claims, (tx) =>
      rows(tx, sql`select * from private.admin_problem_reports(null, null, null, 100)`),
    );
    expect(listed).toEqual([]);
    const update = await asUser(api(), member.claims, (tx) =>
      rows(
        tx,
        sql`update app.problem_reports set handled_at = now() where id = ${mine!.reportId} returning id`,
      ),
    ).catch((e: unknown) => e);
    expect(update).toBeInstanceOf(Error);
  });
});
