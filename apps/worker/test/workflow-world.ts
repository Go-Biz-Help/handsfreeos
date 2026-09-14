/**
 * A workspace for the workflow engine's tests, on top of the booking tests' world (booking-world.ts): the
 * owner, a booking site, the worker's HTTP server and loops drained over this workspace only. Adds workflows
 * written straight into the draft and published through the real command (the test gate opened by hand, so
 * each test says what it tests), customers, and ways to read runs and step logs and to run a run's job.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  executeCommand,
  parseDefinition,
  personCreate,
  workflowCreate,
  workflowPublish,
  type WorkflowDefinitionInput,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { processJobs, type JobStats } from '../src/jobs';
import { jobs } from '../src/scheduled';
import { createSafeFetch, type SafeFetch } from '../src/http/safe-fetch';
import type { AiStepRunner } from '../src/workflows/index';
import { runJobKey } from '../src/workflows/index';
import { admin, api, drain, makeWorld, nextPhone, run, runDue, type World } from './booking-world';

export * from './booking-world';

export interface FlowWorldOptions {
  /** Stands in for the safe fetch (outgoing webhooks reach a local fixture). */
  readonly fetchUrl?: SafeFetch;
  readonly workflowAi?: AiStepRunner;
}

export async function flowWorld(label: string, opts: FlowWorldOptions = {}): Promise<World> {
  const w = await makeWorld(label);
  if (opts.fetchUrl || opts.workflowAi)
    Object.assign(w, {
      s: {
        ...w.s,
        ...(opts.fetchUrl ? { fetchUrl: opts.fetchUrl } : {}),
        ...(opts.workflowAi ? { workflowAi: opts.workflowAi } : {}),
      },
    });
  return w;
}

/** Writes a definition straight into the draft (a new revision). */
export async function writeDraft(
  workflowId: string,
  def: WorkflowDefinitionInput,
): Promise<number> {
  const parsed = parseDefinition(def);
  const [r] = await rows<{ revision: number }>(
    admin(),
    sql`update app.workflows set definition = ${JSON.stringify(parsed)}::jsonb, revision = revision + 1
        where id = ${workflowId} returning revision`,
  );
  return r!.revision;
}

/** Publishes the draft through workflow.publish, the passing-test gate opened by hand, then drains. */
export async function publish(w: World, workflowId: string): Promise<string> {
  const [r] = await rows<{ revision: number }>(
    admin(),
    sql`update app.workflows set tested_revision = revision where id = ${workflowId} returning revision`,
  );
  const out = await run(w, workflowPublish, {
    workspaceId: w.workspaceId,
    workflowId,
    baseRevision: r!.revision,
  });
  await drain(w);
  return out.versionId;
}

/** A new workflow with this definition, published unless asked not to. */
export async function addWorkflow(
  w: World,
  name: string,
  def: WorkflowDefinitionInput,
  opts: { readonly publish?: boolean } = {},
): Promise<{ id: string; versionId: string | null }> {
  const created = await run(w, workflowCreate, {
    workspaceId: w.workspaceId,
    name,
    from: 'blank',
    trigger: def.trigger,
  });
  await writeDraft(created.workflowId, def);
  if (opts.publish === false) return { id: created.workflowId, versionId: null };
  return { id: created.workflowId, versionId: await publish(w, created.workflowId) };
}

let seq = 0;
/** A step id for a test definition. */
export const sid = (tag: string): string =>
  `s_${tag.padEnd(6, 'x').slice(0, 6)}${String(seq++ % 100).padStart(2, '0')}`;

/** A customer; consent 'opted_in' by default. */
export async function customerNamed(
  w: World,
  first: string,
  opts: {
    readonly phone?: string | null;
    readonly email?: string | null;
    readonly consent?: 'unknown' | 'opted_in' | 'opted_out';
  } = {},
): Promise<{ id: string; phone: string | null; email: string | null }> {
  const phone = opts.phone === undefined ? nextPhone() : opts.phone;
  const email =
    opts.email === undefined
      ? `${first.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`
      : opts.email;
  const { output } = await executeCommand(
    api(),
    personCreate,
    {
      workspaceId: w.workspaceId,
      firstName: first,
      lastName: 'Customer',
      phone,
      email,
      ignoreDuplicates: true,
    },
    { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims },
    { correlationId: randomUUID(), channel: 'test' },
  );
  await rows(
    admin(),
    sql`update app.people set sms_consent = ${opts.consent ?? 'opted_in'}::app.sms_consent where id = ${output.personId}`,
  );
  return { id: output.personId, phone, email };
}

export interface RunView {
  id: string;
  status: string;
  version_id: string | null;
  person_id: string | null;
  cursor: string | null;
  depth: number;
  end_reason: string | null;
  is_test: boolean;
  context: Record<string, unknown>;
  waiting_for: string[];
  origin_run_id: string | null;
}

export async function runsOf(
  workflowId: string,
  opts: { tests?: boolean } = {},
): Promise<RunView[]> {
  return rows<RunView & Record<string, unknown>>(
    admin(),
    sql`select id, status::text as status, version_id, person_id, cursor, depth, end_reason, is_test, context,
          waiting_for, origin_run_id
        from app.workflow_runs where workflow_id = ${workflowId} ${opts.tests ? sql`` : sql`and not is_test`}
        order by created_at, id`,
  );
}

export async function runOf(runId: string): Promise<RunView> {
  const [r] = await rows<RunView & Record<string, unknown>>(
    admin(),
    sql`select id, status::text as status, version_id, person_id, cursor, depth, end_reason, is_test, context,
          waiting_for, origin_run_id
        from app.workflow_runs where id = ${runId}`,
  );
  return r!;
}

export interface StepView {
  step_key: string;
  status: string;
  attempt: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  next_step_key: string | null;
  event_ids: string[];
}

export async function stepsOf(runId: string): Promise<StepView[]> {
  return rows<StepView & Record<string, unknown>>(
    admin(),
    sql`select step_key, status::text as status, attempt, input, output, error, next_step_key, event_ids
        from app.workflow_run_steps where run_id = ${runId} order by started_at, created_at`,
  );
}

/** The step log row for one step id (its first visit unless another is named). */
export async function stepOf(
  runId: string,
  stepId: string,
  visit = 1,
): Promise<StepView | undefined> {
  return (await stepsOf(runId)).find((s) => s.step_key === `${stepId}#${visit}`);
}

/** Runs a run's cursor job now, as of when it was due, then drains what it queued. */
export async function runJob(w: World, runId: string): Promise<void> {
  await runDue(w, [runJobKey(runId)]);
}

/** Runs this workspace's due jobs with the engine's clock fixed at `at` (outbox and webhooks as usual). */
export async function runJobsAt(w: World, at: number): Promise<JobStats> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${w.workerId}
        where status = 'pending' and workspace_id = ${w.workspaceId}`,
  );
  return processJobs({
    ...w.s,
    jobs,
    workerId: w.workerId,
    batchSize: 50,
    reservedOnly: true,
    clock: () => at,
  });
}

/** The pending cursor job of a run, if any. */
export async function runJobAt(runId: string): Promise<number | null> {
  const [j] = await rows<{ run_at: string }>(
    admin(),
    sql`select run_at from app.scheduled_jobs where dedupe_key = ${runJobKey(runId)} and status = 'pending'
        order by created_at desc limit 1`,
  );
  return j ? new Date(j.run_at).getTime() : null;
}

export interface FixtureHit {
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/**
 * A local site that outgoing webhooks reach: `https://hooks.fixture.test/<path>` is sent to it over plain http
 * through the real safe fetch (its origin allowed as a test origin). `/hang` never answers; everything else
 * answers `status`. The engine's 10 s timeout is shortened for /hang so the test doesn't wait.
 */
export interface FixtureSite {
  readonly fetchUrl: SafeFetch;
  readonly hits: FixtureHit[];
  /** What every path but /hang answers. */
  status: number;
  close(): Promise<void>;
}

export async function fixtureSite(): Promise<FixtureSite> {
  const hits: FixtureHit[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      hits.push({ path: req.url ?? '/', headers: req.headers, body });
      if (req.url === '/hang') return;
      res.writeHead(site.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: site.status < 300 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const safe = createSafeFetch({ testOrigins: [origin] });
  const site: FixtureSite = {
    status: 200,
    hits,
    fetchUrl: (url, init) =>
      safe(
        url.replace('https://hooks.fixture.test', origin),
        url.endsWith('/hang') ? { ...init, timeoutMs: 300 } : init,
      ),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  return site;
}

/** The newest event of a type for an entity. */
export async function eventsOf(type: string, entityId: string) {
  return rows<{ id: string; payload: Record<string, unknown>; actor_type: string }>(
    admin(),
    sql`select id, payload, actor_type::text as actor_type from app.events
        where event_type = ${type} and entity_id = ${entityId} order by created_at`,
  );
}
