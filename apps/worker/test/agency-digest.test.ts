/**
 * The daily agency digest, through the real job and Mailpit. Each owner and admin of an organization gets one
 * email about its businesses that need a look, leaving out the ones where they are an owner or admin themselves
 * (they get those emails as they happen). Nothing goes out when nothing needs attention or nothing is left to
 * list, nor to someone who turned it off, and never with another organization's businesses. It goes out once a
 * day, and the job re-arms for the next 8 AM.
 */
import { randomUUID } from 'node:crypto';
import { localDateOf, workflowPause, workspaceCreate } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIGEST_JOBS, digestJobKey, nextDigestAt, scheduleDigest } from '../src/agency-digest';
import { processJobs } from '../src/jobs';
import { jobs } from '../src/scheduled';
import {
  addWorkflow,
  admin,
  CHI,
  drain,
  flowWorld,
  mailTo,
  run,
  sid,
  waitForMail,
  type World,
} from './workflow-world';

const WEB = 'http://localhost:3000';

/** Organization A: Dale owns its first business; Ann and Otto are the agency's admins, in neither business. */
let a: World;
let a2: World;
let ann: TestUser;
let otto: TestUser;
/** Organization B: Bea owns its first business. */
let b: World;

beforeAll(async () => {
  a = await flowWorld('agdiga');
  b = await flowWorld('agdigb');
  const second = await run(a, workspaceCreate, {
    organizationId: a.organizationId,
    name: 'Digest Bayou Plumbing',
    timezone: CHI,
  });
  a2 = { ...a, workspaceId: second.workspaceId };
  ann = await createTestUser('agdig-ann', { fullName: 'Ann Agency' });
  otto = await createTestUser('agdig-otto', { fullName: 'Otto Optout' });
  await rows(
    admin(),
    sql`insert into app.organization_memberships (organization_id, user_id, role)
        values (${a.organizationId}, ${ann.id}, 'admin'), (${a.organizationId}, ${otto.id}, 'admin')`,
  );
  await rows(
    admin(),
    sql`update app.users set settings = settings || ${JSON.stringify({ notifications: { agencyDigest: false } })}::jsonb
        where id = ${otto.id}`,
  );
  // What the daily planning does for every organization.
  for (const w of [a, b])
    await asWorker(w.s.db, {}, (tx) => scheduleDigest(tx, w.organizationId, CHI, Date.now()));
});
afterAll(async () => {
  await a?.app.close();
  await b?.app.close();
  await closeTestDbs();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The organization's name (and its first business's). */
const orgName = (w: World) => `${w.label} Booking HVAC`;
/** The newest email to `to` whose subject starts with `subject`, its text with plain line breaks. */
const mailFor = (to: string, subject: string) =>
  waitForMail(to, subject).then((m) => ({ ...m, text: m.text.replace(/\r\n/g, '\n') }));

/** Runs the organization's digest job now. */
async function runDigest(w: World): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${w.workerId}
        where kind = ${DIGEST_JOBS.send} and dedupe_key = ${digestJobKey(w.organizationId)}
          and status = 'pending'`,
  );
  const ran = await processJobs({
    ...w.s,
    jobs,
    workerId: w.workerId,
    batchSize: 50,
    reservedOnly: true,
  });
  expect(ran.failed + ran.retried).toBe(0);
}

async function digestJob(w: World) {
  const list = await rows<{ id: string; run_at: Date }>(
    admin(),
    sql`select id, run_at from app.scheduled_jobs
        where kind = ${DIGEST_JOBS.send} and dedupe_key = ${digestJobKey(w.organizationId)}
          and status = 'pending'`,
  );
  expect(list).toHaveLength(1);
  return { id: list[0]!.id, runAt: new Date(list[0]!.run_at).getTime() };
}

/** The days the organization's digest went out. */
async function sentDays(w: World): Promise<string[]> {
  const list = await rows<{ day: string }>(
    admin(),
    sql`select payload ->> 'day' as day from app.events
        where entity_id = ${w.organizationId} and event_type = 'organization.digest_sent'`,
  );
  return list.map((e) => e.day);
}

/** The organization's digests that reached `email`. */
const digestsTo = async (email: string, w: World) =>
  (await mailTo(email)).filter(
    (m) => m.Subject.startsWith(`${orgName(w)}: `) && m.Subject.endsWith('a look today'),
  );

/** A published workflow in a business. */
const workflowIn = (w: World, name: string) =>
  addWorkflow(w, name, {
    version: 1,
    trigger: { kind: 'manual' },
    steps: [{ id: sid('dnote'), type: 'action', action: 'add_note', config: { body: 'Hi' } }],
  });

type Flow = Awaited<ReturnType<typeof workflowIn>>;

async function failedRun(w: World, wf: Flow, endedAgo = '2 hours') {
  await rows(
    admin(),
    sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, status, dedupe_key, started_at,
          ended_at, end_reason)
        values (${w.workspaceId}, ${wf.id}, ${wf.versionId}, 'failed', ${`digest:${randomUUID()}`},
          now() - ${endedAgo}::interval - interval '1 minute', now() - ${endedAgo}::interval, 'step_failed')`,
  );
}

async function waitingApproval(w: World, wf: Flow, waited: string) {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, status, dedupe_key)
        values (${w.workspaceId}, ${wf.id}, ${wf.versionId}, 'awaiting_approval', ${`digest:${randomUUID()}`})
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, created_at)
        values (${w.workspaceId}, ${wf.id}, ${r!.id}, 's_dappr00#1', now() - ${waited}::interval)`,
  );
}

/** An agency template at version 2, installed in the business at version 1. */
async function updateAvailable(w: World, name: string) {
  const [t] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_templates (organization_id, name, latest_version)
        values (${w.organizationId}, ${name}, 2) returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.workflow_template_installs (organization_id, template_id, workspace_id,
          installed_version, status, installed_at)
        values (${w.organizationId}, ${t!.id}, ${w.workspaceId}, 1, 'installed', now())`,
  );
}

async function knowledgeSuggestion(w: World) {
  await rows(
    admin(),
    sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason)
        values (${w.workspaceId}, 'faq',
          ${JSON.stringify({ title: 'Do you service boilers?', body: 'Yes.', tags: [] })}::jsonb, 'gap')`,
  );
}

describe('the daily agency digest', () => {
  it('waits for 8 AM, and sends nothing when nothing needs attention', async () => {
    // A knowledge suggestion on its own isn't enough to send one.
    await knowledgeSuggestion(a);
    const armed = await digestJob(a);
    expect(armed.runAt).toBe(nextDigestAt(Date.now(), CHI));
    await runDigest(a);
    const next = await digestJob(a);
    expect(next).toEqual({ id: armed.id, runAt: nextDigestAt(Date.now(), CHI) });
    expect(await sentDays(a)).toEqual([]);
    await pause(300);
    for (const u of [a.owner, ann, otto]) expect(await digestsTo(u.email, a)).toEqual([]);
  });

  it('sends a business owner nothing about the business they own', async () => {
    await failedRun(b, await workflowIn(b, 'Solo follow-up'));
    await runDigest(b);
    expect(await sentDays(b)).toEqual([]);
    await pause(300);
    expect(await digestsTo(b.owner.email, b)).toEqual([]);
  });

  it('sends each owner and admin one email about the businesses they don’t run, once a day', async () => {
    const followUp = await workflowIn(a, 'Estimate follow-up');
    await failedRun(a, followUp);
    // Longer ago than the last 24 hours: not counted.
    await failedRun(a, followUp, '30 hours');
    await waitingApproval(a, followUp, '5 hours');
    const review = await workflowIn(a2, 'Review request');
    await run(a2, workflowPause, { workspaceId: a2.workspaceId, workflowId: review.id });
    await drain(a2);
    await updateAvailable(a2, 'Speed to lead (agency)');
    await runDigest(a);

    // Ann is in neither business: both, in one email.
    const toAnn = await mailFor(ann.email, `${orgName(a)}: 2 businesses need a look today`);
    const one = `${WEB}/app/w/${a.workspaceId}`;
    const two = `${WEB}/app/w/${a2.workspaceId}`;
    expect(toAnn.text).toContain(
      [
        orgName(a),
        `- 1 workflow run failed in the last 24 hours: ${one}/workflows/runs?status=failed&range=1d`,
        `- 1 approval waiting, for 5 hours: ${one}/workflows/approvals`,
        `- 1 knowledge suggestion waiting: ${one}/knowledge/suggestions`,
        `Open ${orgName(a)}: ${one}`,
      ].join('\n'),
    );
    expect(toAnn.text).toContain(
      [
        'Digest Bayou Plumbing',
        `- Paused: Review request: ${two}/workflows`,
        `- Update available: Speed to lead (agency): ${WEB}/app/org/${a.organizationId}/businesses`,
        `Open Digest Bayou Plumbing: ${two}`,
      ].join('\n'),
    );
    expect(toAnn.text).toContain(`Open the agency area: ${WEB}/app/org/${a.organizationId}`);

    // Dale owns the first business and hears about it as it happens: only the second.
    const toDale = await mailFor(a.owner.email, `${orgName(a)}: 1 business needs a look today`);
    expect(toDale.text).toContain(`Open Digest Bayou Plumbing: ${two}`);
    expect(toDale.text).not.toContain(one);
    expect(await sentDays(a)).toEqual([localDateOf(Date.now(), CHI)]);

    // Otto turned it off; and the same day again sends nothing more.
    await runDigest(a);
    await pause(300);
    expect(await digestsTo(otto.email, a)).toEqual([]);
    expect(await digestsTo(ann.email, a)).toHaveLength(1);
    expect(await digestsTo(a.owner.email, a)).toHaveLength(1);
    expect(await sentDays(a)).toHaveLength(1);
    expect((await digestJob(a)).runAt).toBe(nextDigestAt(Date.now(), CHI));
  });

  it('never lists another organization’s businesses', async () => {
    const created = await run(b, workspaceCreate, {
      organizationId: b.organizationId,
      name: 'Digest Summit Roofing',
      timezone: CHI,
    });
    const b2: World = { ...b, workspaceId: created.workspaceId };
    await failedRun(b2, await workflowIn(b2, 'Roof follow-up'));
    await runDigest(b);

    // Bea hears about the business she doesn't own, and nothing of organization A's.
    const toBea = await mailFor(b.owner.email, `${orgName(b)}: 1 business needs a look today`);
    expect(toBea.text).toContain(`Open Digest Summit Roofing: ${WEB}/app/w/${b2.workspaceId}`);
    for (const other of [b.workspaceId, a.workspaceId, a2.workspaceId, 'Digest Bayou Plumbing'])
      expect(toBea.text).not.toContain(other);
    const toAnn = await mailFor(ann.email, `${orgName(a)}: `);
    for (const other of [b.workspaceId, b2.workspaceId, 'Digest Summit Roofing'])
      expect(toAnn.text).not.toContain(other);
    expect(await digestsTo(ann.email, b)).toEqual([]);
  });
});

describe('the next 8 AM', () => {
  it('is today’s before 8, tomorrow’s from 8 on, and follows daylight saving', () => {
    const at = (iso: string, zone = CHI) =>
      new Date(nextDigestAt(Date.parse(iso), zone)).toISOString();
    expect(at('2026-09-14T12:00:00Z')).toBe('2026-09-14T13:00:00.000Z');
    expect(at('2026-09-14T13:00:00Z')).toBe('2026-09-15T13:00:00.000Z');
    // Clocks go back early on Sunday, November 1, 2026: 8 AM is an hour later in UTC.
    expect(at('2026-10-31T14:00:00Z')).toBe('2026-11-01T14:00:00.000Z');
    expect(at('2026-09-14T12:00:00Z', 'America/Denver')).toBe('2026-09-14T14:00:00.000Z');
  });
});
