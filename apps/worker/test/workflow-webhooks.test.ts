/**
 * Schedules, date triggers and webhooks. A published schedule arms its next occurrence, enrols its audience
 * once per occurrence and re-arms itself; a date trigger fires at its anchor plus the offset, follows a moved
 * anchor and drops a gone one. Inbound: the owner gets the URL and secret; a bad or stale signature is a 401;
 * a delivery is stored once per id and starts a run for the matched or new customer. Outbound: signed with the
 * workflow's secret, retried on a timeout, and refused for a private address.
 */
import { randomUUID } from 'node:crypto';
import {
  leadCreate,
  leadSetNextAction,
  nextOccurrence,
  workflowEnrol,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { dateJobKey, scheduleJobKey, signBody, verifyBody } from '../src/workflows/index';
import {
  addWorkflow,
  admin,
  CHI,
  customerNamed,
  drain,
  fixtureSite,
  flowWorld,
  jobRow,
  nextPhone,
  run,
  runDue,
  runJob,
  runJobAt,
  runOf,
  runsOf,
  sid,
  stepOf,
  type World,
} from './workflow-world';

let w: World;
let site: Awaited<ReturnType<typeof fixtureSite>>;
let signedIn: FastifyInstance;
beforeAll(async () => {
  site = await fixtureSite();
  w = await flowWorld('wfhook', { fetchUrl: site.fetchUrl });
  const owner: HumanActor = {
    type: 'human',
    userId: w.owner.id,
    email: w.owner.email,
    claims: w.owner.claims,
  };
  signedIn = await buildHttpServer({
    ...w.s,
    // A route's unexpected error shows in the test output.
    log: pino({ level: 'error' }),
    httpDb: testDbs().worker.db,
    verifyToken: async () => owner,
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await Promise.all([w.app.close(), signedIn.close()]);
  await site.close();
  await closeTestDbs();
});

const note = (id: string, body: string) => ({
  id,
  type: 'action' as const,
  action: 'add_note' as const,
  config: { body },
});

async function notesOf(personId: string): Promise<string[]> {
  const list = await rows<{ body: string }>(
    admin(),
    sql`select body from app.activities where person_id = ${personId} and kind = 'note' order by created_at`,
  );
  return list.map((n) => n.body);
}

describe('schedules', () => {
  it('arms the next occurrence, enrols the audience once per occurrence, and re-arms itself', async () => {
    const cadence = { every: 'weekly' as const, days: [0, 1, 2, 3, 4, 5, 6], at: '09:00' };
    const wf = await addWorkflow(w, 'Daily hello', {
      version: 1,
      trigger: {
        kind: 'schedule',
        cadence,
        audience: {
          match: 'all',
          conditions: [{ field: 'person.first_name', op: 'eq', value: 'Sched' }],
        },
      },
      steps: [note(sid('schnot'), 'Hello from the schedule')],
    });
    const a = await customerNamed(w, 'Sched');
    const b = await customerNamed(w, 'Sched');
    const other = await customerNamed(w, 'Other');
    const key = scheduleJobKey(wf.id);
    const first = nextOccurrence(cadence, Date.now(), CHI);
    const armed = (await jobRow(key))!;
    expect(armed.status).toBe('pending');
    expect(new Date(armed.run_at).getTime()).toBe(first);

    await runDue(w, [key]);
    // A page's runs start spread over a minute: run the ones not due yet.
    for (const r of await runsOf(wf.id)) if (r.status !== 'completed') await runJob(w, r.id);
    const runs = await runsOf(wf.id);
    expect(runs.map((r) => r.person_id).sort()).toEqual([a.id, b.id].sort());
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
    expect(await notesOf(other.id)).toEqual([]);
    const rearmed = (await jobRow(key))!;
    expect(new Date(rearmed.run_at).getTime()).toBe(nextOccurrence(cadence, first, CHI));
    const [sched] = await rows<{ last_occurrence_at: Date }>(
      admin(),
      sql`select last_occurrence_at from app.workflow_schedules where workflow_id = ${wf.id}`,
    );
    expect(new Date(sched!.last_occurrence_at).getTime()).toBe(first);

    // The same occurrence again (a crash before the schedule moved on): nobody is enrolled twice.
    await rows(
      admin(),
      sql`update app.workflow_schedules set next_run_at = ${new Date(first).toISOString()}::timestamptz
          where workflow_id = ${wf.id}`,
    );
    await runDue(w, [key]);
    expect(await runsOf(wf.id)).toHaveLength(2);
  });
});

describe('date triggers', () => {
  it('fires at the anchor plus the offset, follows a moved anchor, and drops a gone one', async () => {
    const wf = await addWorkflow(w, 'Next action due', {
      version: 1,
      trigger: {
        kind: 'date',
        anchor: 'lead.next_action_at',
        offset: { amount: 30, unit: 'minutes', direction: 'after' },
      },
      steps: [note(sid('datnot'), 'Did you {{lead.next_action}}?')],
    });
    const p = await customerNamed(w, 'Dana');
    const { leadId } = await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      personId: p.id,
      title: 'Boiler',
    });
    const due = Date.now() + 3 * 3_600_000;
    const setNext = (text: string | null, at: number | null) =>
      run(w, leadSetNextAction, {
        workspaceId: w.workspaceId,
        leadId,
        text,
        dueAt: at === null ? null : new Date(at).toISOString(),
      });
    await setNext('call back', due);
    await drain(w);
    const key = dateJobKey(wf.id, leadId);
    expect(new Date((await jobRow(key))!.run_at).getTime()).toBe(due + 30 * 60_000);

    // Moved an hour later: at the old time the job reads the anchor again and waits for the new one.
    await setNext('call back', due + 3_600_000);
    await drain(w);
    await runDue(w, [key]);
    expect(await runsOf(wf.id)).toHaveLength(0);
    expect(new Date((await jobRow(key))!.run_at).getTime()).toBe(due + 3_600_000 + 30 * 60_000);
    await runDue(w, [key]);
    const [r] = await runsOf(wf.id);
    expect(r).toMatchObject({ status: 'completed', person_id: p.id });
    expect(await notesOf(p.id)).toEqual(['Did you call back?']);

    // Another lead whose next action is cleared: the job is dropped, nobody enrolled.
    const q = await customerNamed(w, 'Quinn');
    const second = await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      personId: q.id,
      title: 'Vents',
    });
    await run(w, leadSetNextAction, {
      workspaceId: w.workspaceId,
      leadId: second.leadId,
      text: 'send quote',
      dueAt: new Date(due).toISOString(),
    });
    await drain(w);
    await run(w, leadSetNextAction, {
      workspaceId: w.workspaceId,
      leadId: second.leadId,
      text: null,
    });
    await drain(w);
    await runDue(w, [dateJobKey(wf.id, second.leadId)]);
    expect((await runsOf(wf.id)).filter((x) => x.person_id === q.id)).toEqual([]);
    expect((await jobRow(dateJobKey(wf.id, second.leadId)))!.status).toBe('done');
  });
});

describe('inbound webhooks', () => {
  let wfId: string;
  let url: string;
  let secret: string;
  beforeAll(async () => {
    wfId = (
      await addWorkflow(w, 'Website form', {
        version: 1,
        trigger: { kind: 'webhook', personBy: 'phone_or_email', createPerson: true },
        steps: [note(sid('whnote'), 'Form from {{person.first_name}}')],
      })
    ).id;
  });

  const deliver = (body: string, headers: Record<string, string>) =>
    w.app.inject({
      method: 'POST',
      url: new URL(url).pathname,
      headers: { 'content-type': 'application/json', ...headers },
      payload: body,
    });
  const signed = (
    body: string,
    extra: Record<string, string> = {},
    at = Math.floor(Date.now() / 1000),
  ) => ({
    'x-hfos-timestamp': String(at),
    'x-hfos-signature': signBody(secret, String(at), body),
    ...extra,
  });

  it('gives the owner the URL and the secret, and rotates the secret', async () => {
    const reveal = (rotate = false) =>
      signedIn.inject({
        method: 'POST',
        url: '/v1/workflows/webhook/reveal',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        payload: JSON.stringify({ workspaceId: w.workspaceId, workflowId: wfId, rotate }),
      });
    const res = await reveal();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { url: string; secret: string; rotated: boolean };
    expect(body.url).toMatch(/\/webhooks\/workflows\/[A-Za-z0-9_-]{43}$/);
    expect(body.secret.length).toBeGreaterThan(30);
    const again = (await reveal()).json() as { url: string; secret: string };
    expect(again).toMatchObject({ url: body.url, secret: body.secret });
    const rotated = (await reveal(true)).json() as {
      url: string;
      secret: string;
      rotated: boolean;
    };
    expect(rotated.url).toBe(body.url);
    expect(rotated.secret).not.toBe(body.secret);
    url = rotated.url;
    secret = rotated.secret;
  });

  it('refuses a bad or stale signature with a 401', async () => {
    const body = JSON.stringify({ first_name: 'Mallory', phone: nextPhone() });
    const wrong = await deliver(body, {
      'x-hfos-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-hfos-signature': 'sha256=00',
    });
    expect(wrong.statusCode).toBe(401);
    const stale = await deliver(body, signed(body, {}, Math.floor(Date.now() / 1000) - 600));
    expect(stale.statusCode).toBe(401);
    const unsigned = await deliver(body, {});
    expect(unsigned.statusCode).toBe(401);
    const nobody = await w.app.inject({
      method: 'POST',
      url: '/webhooks/workflows/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headers: { 'content-type': 'application/json', ...signed(body) },
      payload: body,
    });
    expect(nobody.statusCode).toBe(404);
  });

  it('stores a delivery once per id and starts a run for a new or matched customer', async () => {
    const email = `webby-${randomUUID().slice(0, 8)}@example.com`;
    const body = JSON.stringify({
      first_name: 'Webby',
      last_name: 'Form',
      email,
      message: 'Need a quote',
    });
    const deliveryId = `dl-${randomUUID()}`;
    const first = await deliver(body, signed(body, { 'x-hfos-delivery-id': deliveryId }));
    expect(first.statusCode, first.body).toBe(202);
    const replay = await deliver(body, signed(body, { 'x-hfos-delivery-id': deliveryId }));
    expect(replay.statusCode).toBe(202);
    const stored = await rows<{ id: string }>(
      admin(),
      sql`select id from app.webhook_deliveries where provider = 'workflow' and dedupe_key like ${`%:${deliveryId}`}`,
    );
    expect(stored).toHaveLength(1);
    await drain(w);
    const [person] = await rows<{ id: string; source: string }>(
      admin(),
      sql`select id, source from app.people where workspace_id = ${w.workspaceId} and email = ${email}::extensions.citext`,
    );
    expect(person!.source).toBe('Webhook');
    const runs = (await runsOf(wfId)).filter((r) => r.person_id === person!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('completed');
    expect((runs[0]!.context['trigger'] as Record<string, unknown>)['body']).toMatchObject({
      message: 'Need a quote',
    });
    expect(await notesOf(person!.id)).toEqual(['Form from Webby']);

    // A customer already on file is matched by phone, not added again.
    const known = await customerNamed(w, 'Known');
    const again = JSON.stringify({ name: 'Somebody Else', phone: known.phone });
    expect((await deliver(again, signed(again))).statusCode).toBe(202);
    await drain(w);
    expect((await runsOf(wfId)).filter((r) => r.person_id === known.id)).toHaveLength(1);
    expect(await notesOf(known.id)).toEqual(['Form from Known']);
  });
});

describe('outgoing webhooks', () => {
  const hook = (id: string, path: string, onError: 'stop' | 'continue' = 'stop') => ({
    id,
    type: 'action' as const,
    action: 'webhook_out' as const,
    config: {
      url: `https://hooks.fixture.test${path}`,
      include: ['person' as const, 'trigger' as const],
    },
    onError,
  });

  async function start(workflowId: string, first: string) {
    const p = await customerNamed(w, first);
    await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId, personId: p.id });
    await drain(w);
    return { p, runId: (await runsOf(workflowId)).find((r) => r.person_id === p.id)!.id };
  }

  it('signs what it sends with the workflow’s secret', async () => {
    const id = sid('outsig');
    const wf = await addWorkflow(w, 'To the CRM', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [hook(id, '/crm')],
    });
    site.status = 200;
    const { p, runId } = await start(wf.id, 'Signe');
    expect((await runOf(runId)).status).toBe('completed');
    const hit = site.hits.find((h) => h.path === '/crm' && h.body.includes(p.id))!;
    expect(hit.headers['content-type']).toBe('application/json');
    const [secretRow] = await rows<{ secret_enc: string }>(
      admin(),
      sql`select secret_enc from app.workflow_webhooks where workflow_id = ${wf.id}`,
    );
    const secretOf = w.s.sealer.open(secretRow!.secret_enc);
    const ts = String(hit.headers['x-hfos-timestamp']);
    expect(verifyBody(secretOf, ts, String(hit.headers['x-hfos-signature']), hit.body)).toBe(true);
    const sent = JSON.parse(hit.body) as Record<string, unknown>;
    expect(sent).toMatchObject({
      id: hit.headers['x-hfos-delivery-id'],
      type: 'workflow.step',
      workflow: { id: wf.id, name: 'To the CRM' },
      person: { id: p.id, firstName: 'Signe' },
    });
    expect((await stepOf(runId, id))!.output).toMatchObject({ status: 200 });
  });

  it('tries again later when the address doesn’t answer in time', async () => {
    const id = sid('outslo');
    const wf = await addWorkflow(w, 'Slow receiver', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [hook(id, '/hang')],
    });
    const { runId } = await start(wf.id, 'Slow');
    const step = (await stepOf(runId, id))!;
    expect(step).toMatchObject({ status: 'failed', attempt: 1 });
    expect(String(step.error!['message'])).toContain('took too long');
    expect(await runOf(runId)).toMatchObject({ status: 'running' });
    expect(await runJobAt(runId)).not.toBeNull();
  });

  it('refuses a private address, and the step’s onError decides', async () => {
    const id = sid('outpri');
    const wf = await addWorkflow(w, 'Private address', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [
        {
          id,
          type: 'action',
          action: 'webhook_out',
          config: { url: 'https://10.1.2.3/hook', include: ['person'] },
          onError: 'stop',
        },
      ],
    });
    const { runId } = await start(wf.id, 'Priv');
    expect(await runOf(runId)).toMatchObject({ status: 'failed', end_reason: 'blocked_address' });
    const step = (await stepOf(runId, id))!;
    expect(step).toMatchObject({ status: 'failed', attempt: 1 });
    expect(step.error).toMatchObject({ rule: 'blocked_address' });
    expect(await runJobAt(runId)).toBeNull();
    await runJob(w, runId).catch(() => undefined);
    expect((await runOf(runId)).status).toBe('failed');
  });
});
