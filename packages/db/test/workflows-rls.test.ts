import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { organizationMemberships, workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

/** Org A's owner (also workspace A's owner). */
let owner: TestUser;
/** Org A's admin. */
let orgAdmin: TestUser;
/** Workspace A's own owner, not in the organization: a client business's owner. */
let bizOwner: TestUser;
let member: TestUser;
/** Org B's owner. */
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const uuids = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

beforeAll(async () => {
  [owner, orgAdmin, bizOwner, member, outsider] = await Promise.all([
    createTestUser('wf-owner'),
    createTestUser('wf-org-admin'),
    createTestUser('wf-biz-owner'),
    createTestUser('wf-member'),
    createTestUser('wf-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Workflow Org A', 'Workflow A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Workflow Org B', 'Workflow B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db
    .insert(organizationMemberships)
    .values([{ organizationId: orgA, userId: orgAdmin.id, role: 'admin' }]);
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: bizOwner.id, role: 'owner' },
    { workspaceId: wsA, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

interface Published {
  readonly workflowId: string;
  readonly versionId: string;
}

/** A workflow published to version 1 and turned on, as the worker would leave it. */
function published(ws: string, org: string): Promise<Published> {
  return worker(
    ws,
    org,
  )(async (tx) => {
    const [w] = await rows<{ id: string }>(
      tx,
      sql`insert into app.workflows (workspace_id, name, trigger_kind, trigger_event)
          values (${ws}, 'Speed to lead', 'event', 'lead.created') returning id`,
    );
    const [v] = await rows<{ id: string }>(
      tx,
      sql`insert into app.workflow_versions (workspace_id, workflow_id, version, definition, definition_version, revision)
          values (${ws}, ${w!.id}, 1, '{"steps": []}', 1, 1) returning id`,
    );
    await tx.execute(
      sql`update app.workflows set status = 'active', active_version_id = ${v!.id}, tested_revision = 1 where id = ${w!.id}`,
    );
    return { workflowId: w!.id, versionId: v!.id };
  });
}

interface EnrolOptions {
  readonly enrolKey?: string;
  readonly onceKey?: string;
  readonly isTest?: boolean;
  readonly dedupeKey?: string;
}

/** A run of the published version, as the dispatcher enrols one. */
async function enrol(wf: Published, opts: EnrolOptions = {}): Promise<string> {
  const [r] = await worker(
    wsA,
    orgA,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, dedupe_key, enrol_key, once_key, is_test, test_mode)
          values (${wsA}, ${wf.workflowId}, ${wf.versionId}, ${opts.dedupeKey ?? `evt:${uniq()}`},
            ${opts.enrolKey ?? null}, ${opts.onceKey ?? null}, ${opts.isTest ?? false}, ${opts.isTest ? 'simulate' : null})
          returning id`,
    ),
  );
  return r!.id;
}

const finish = (runId: string) =>
  worker(
    wsA,
    orgA,
  )((tx) =>
    tx.execute(
      sql`update app.workflow_runs set status = 'completed', ended_at = now(), end_reason = 'end' where id = ${runId}`,
    ),
  );

const approval = async (wf: Published, runId: string, approvers: string[]) => {
  const [a] = await worker(
    wsA,
    orgA,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, approvers, preview)
          values (${wsA}, ${wf.workflowId}, ${runId}, ${`approve-${uniq()}#1`}, ${uuids(approvers)},
            '{"action": "message.send", "text": "Thanks for choosing us!"}')
          returning id`,
    ),
  );
  return a!.id;
};

describe('workflows: who reads and who writes', () => {
  it('everyone in the workspace reads workflows, versions, runs, steps and approvals; outsiders see none', async () => {
    const wf = await published(wsA, orgA);
    const runId = await enrol(wf);
    await worker(
      wsA,
      orgA,
    )((tx) =>
      tx.execute(sql`insert into app.workflow_run_steps (workspace_id, run_id, step_key, status)
        values (${wsA}, ${runId}, 'text-1#1', 'done')`),
    );
    await approval(wf, runId, []);
    const count = (user: TestUser, table: string, column: string, value: string) =>
      as(user)((tx) =>
        rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)} where ${sql.raw(column)} = ${value}`),
      ).then((r) => r.length);
    const probes: [string, string, string][] = [
      ['workflows', 'id', wf.workflowId],
      ['workflow_versions', 'workflow_id', wf.workflowId],
      ['workflow_runs', 'id', runId],
      ['workflow_run_steps', 'run_id', runId],
      ['workflow_approvals', 'run_id', runId],
    ];
    for (const [table, column, value] of probes) {
      expect(await count(member, table, column, value)).toBeGreaterThan(0);
      expect(await count(bizOwner, table, column, value)).toBeGreaterThan(0);
      expect(await count(outsider, table, column, value)).toBe(0);
    }
  });

  it('members cannot build or publish; owners and admins can, and only the worker marks a draft tested', async () => {
    const insertAs = (user: TestUser, testedRevision: number | null = null) =>
      as(user)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.workflows (workspace_id, name, created_by, tested_revision)
              values (${wsA}, 'Review request', ${user.id}, ${testedRevision}) returning id`,
        ),
      );
    expect((await failure(() => insertAs(member))).code).toBe('42501');
    // A new workflow is an untested draft.
    expect((await failure(() => insertAs(bizOwner, 1))).code).toBe('42501');

    const [w] = await insertAs(bizOwner);
    const id = w!.id;
    await as(bizOwner)((tx) =>
      tx.execute(
        sql`update app.workflows set definition = '{"steps": [{"id": "a"}]}', revision = revision + 1 where id = ${id}`,
      ),
    );
    // The publish gate opens only for the worker's passing test.
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(sql`update app.workflows set tested_revision = 2 where id = ${id}`),
          ),
        )
      ).code,
    ).toBe('42501');
    const touched = await as(member)((tx) =>
      rows(tx, sql`update app.workflows set name = 'Mine now' where id = ${id} returning id`),
    );
    expect(touched).toHaveLength(0);

    const version = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.workflow_versions (workspace_id, workflow_id, version, definition, definition_version, revision, published_by)
              values (${wsA}, ${id}, 1, '{"steps": [{"id": "a"}]}', 1, 2, ${user.id}) returning id`,
        ),
      );
    expect((await failure(() => version(member))).code).toBe('42501');
    const [v] = await version(bizOwner);
    await as(bizOwner)((tx) =>
      tx.execute(
        sql`update app.workflows set status = 'active', active_version_id = ${v!.id} where id = ${id}`,
      ),
    );
    // An active workflow always has a version to run.
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(sql`update app.workflows set active_version_id = null where id = ${id}`),
          ),
        )
      ).code,
    ).toBe('23514');
  });

  it('people stop a run that is still going, and change nothing else about it', async () => {
    const wf = await published(wsA, orgA);
    const runId = await enrol(wf);
    const stop = (user: TestUser) =>
      as(user)((tx) =>
        rows(
          tx,
          sql`update app.workflow_runs set status = 'stopped', ended_at = now(), end_reason = 'removed'
              where id = ${runId} returning id`,
        ),
      );
    expect(await stop(member)).toHaveLength(0);
    expect(
      await failure(() =>
        as(bizOwner)((tx) =>
          tx.execute(
            sql`update app.workflow_runs set status = 'completed', ended_at = now() where id = ${runId}`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', detail: 'workflow_run_status_transition' });
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(sql`update app.workflow_runs set context = '{}' where id = ${runId}`),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(await stop(bizOwner)).toHaveLength(1);
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(
              sql`update app.workflow_runs set status = 'running', ended_at = null where id = ${runId}`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('an approval is decided once, by a named approver or an owner or admin', async () => {
    const wf = await published(wsA, orgA);
    const runId = await enrol(wf);
    const decide = (
      user: TestUser,
      id: string,
      status = 'approved',
      decidedBy = user.id,
      via = 'web',
    ) =>
      as(user)((tx) =>
        rows(
          tx,
          sql`update app.workflow_approvals
              set status = ${status}::app.workflow_approval_status, decided_by = ${decidedBy}, decided_at = now(),
                via = ${via}, edits = '{"text": "Thanks, Mike!"}'
              where id = ${id} and status = 'pending' returning id`,
        ),
      );

    const named = await approval(wf, runId, [member.id]);
    expect(await decide(outsider, named)).toHaveLength(0);
    expect(await decide(member, named)).toHaveLength(1);
    // A second click finds nothing pending.
    expect(await decide(bizOwner, named)).toHaveLength(0);

    const anyManager = await approval(wf, runId, []);
    expect(await decide(member, anyManager)).toHaveLength(0);
    expect(await decide(bizOwner, anyManager, 'rejected')).toHaveLength(1);

    // Nobody decides in someone else's name.
    const third = await approval(wf, runId, []);
    expect((await failure(() => decide(bizOwner, third, 'approved', member.id))).code).toBe(
      '42501',
    );
    // Decided on the phone says so (0063); nothing else a person names is taken.
    const onPhone = await approval(wf, runId, [member.id]);
    expect(
      (await failure(() => decide(member, onPhone, 'approved', member.id, 'system'))).code,
    ).toBe('42501');
    expect(await decide(member, onPhone, 'approved', member.id, 'mobile')).toHaveLength(1);
    // Approvers work in the workspace.
    expect(await failure(() => approval(wf, runId, [outsider.id]))).toEqual({
      code: '23514',
      detail: 'record_workspace_mismatch',
    });
  });
});

describe('workflows: the engine', () => {
  it('stays inside the workspace it is scoped to', async () => {
    const wf = await published(wsA, orgA);
    const fromB = await worker(
      wsB,
      orgB,
    )((tx) => rows(tx, sql`select id from app.workflows where id = ${wf.workflowId}`));
    expect(fromB).toHaveLength(0);
    expect(
      (
        await failure(() =>
          worker(
            wsB,
            orgB,
          )((tx) =>
            tx.execute(sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, dedupe_key)
              values (${wsA}, ${wf.workflowId}, ${wf.versionId}, ${`evt:${uniq()}`})`),
          ),
        )
      ).code,
    ).toBe('42501');
    // A run in B can't point at A's workflow, nor a workflow at another business's calendar.
    expect(
      await failure(() =>
        worker(
          wsB,
          orgB,
        )((tx) =>
          tx.execute(sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, dedupe_key)
            values (${wsB}, ${wf.workflowId}, ${wf.versionId}, ${`evt:${uniq()}`})`),
        ),
      ),
    ).toEqual({ code: '23514', detail: 'record_workspace_mismatch' });
    expect(
      (
        await failure(() =>
          worker(
            wsB,
            orgB,
          )((tx) =>
            tx.execute(sql`insert into app.workflows (workspace_id, name, calendar_ids)
              values (${wsB}, 'Reminders', ${uuids([crypto.randomUUID()])})`),
          ),
        )
      ).code,
    ).toBe('23514');
    const unscoped = await asService({})((tx) =>
      rows(tx, sql`select id from app.workflow_runs where workflow_id = ${wf.workflowId}`),
    );
    expect(unscoped).toHaveLength(0);
  });

  it('versions reject updates and deletes, and go only with their workflow', async () => {
    const wf = await published(wsA, orgA);
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(
              sql`update app.workflow_versions set definition = '{}' where id = ${wf.versionId}`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await failure(() =>
          worker(
            wsA,
            orgA,
          )((tx) => tx.execute(sql`delete from app.workflow_versions where id = ${wf.versionId}`)),
        )
      ).code,
    ).toBe('42501');
    // Not even the table's owner can change or remove one.
    expect(
      await failure(() =>
        dbs.admin.db.execute(
          sql`update app.workflow_versions set definition = '{"steps": ["changed"]}' where id = ${wf.versionId}`,
        ),
      ),
    ).toEqual({ code: '42501', detail: 'version_immutable' });
    expect(
      await failure(() =>
        dbs.admin.db.execute(sql`delete from app.workflow_versions where id = ${wf.versionId}`),
      ),
    ).toEqual({ code: '42501', detail: 'version_immutable' });
    expect(
      (
        await failure(() =>
          worker(
            wsA,
            orgA,
          )((tx) =>
            tx.execute(sql`insert into app.workflow_versions (workspace_id, workflow_id, version, definition, definition_version, revision)
              values (${wsA}, ${wf.workflowId}, 1, '{}', 1, 1)`),
          ),
        )
      ).code,
    ).toBe('23505');
    // Deleting the workflow itself takes its versions and runs along.
    await enrol(wf);
    await dbs.admin.db.execute(sql`delete from app.workflows where id = ${wf.workflowId}`);
    const left = await rows(
      dbs.admin.db,
      sql`select 1 from app.workflow_versions where workflow_id = ${wf.workflowId}
          union all select 1 from app.workflow_runs where workflow_id = ${wf.workflowId}`,
    );
    expect(left).toHaveLength(0);
  });

  it('re-entry: one active run per enrol key, a once key forever, and one run per trigger', async () => {
    const wf = await published(wsA, orgA);
    const key = `person:${uniq()}`;
    const first = await enrol(wf, { enrolKey: key });
    expect((await failure(() => enrol(wf, { enrolKey: key }))).code).toBe('23505');
    // How the dispatcher settles the race: the loser inserts nothing and moves on.
    const raced = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, dedupe_key, enrol_key)
            values (${wsA}, ${wf.workflowId}, ${wf.versionId}, ${`evt:${uniq()}`}, ${key})
            on conflict do nothing returning id`,
      ),
    );
    expect(raced).toHaveLength(0);
    // Tests don't count toward re-entry.
    await enrol(wf, { enrolKey: key, isTest: true });
    // Once the first run ends, the customer may enter again.
    await finish(first);
    await enrol(wf, { enrolKey: key });

    const onceKey = `person:${uniq()}`;
    await finish(await enrol(wf, { onceKey }));
    expect((await failure(() => enrol(wf, { onceKey }))).code).toBe('23505');
    expect((await failure(() => enrol(wf, { onceKey: `p:${uniq()}`, isTest: true }))).code).toBe(
      '23514',
    );

    const dedupeKey = `evt:${uniq()}`;
    await enrol(wf, { dedupeKey });
    expect((await failure(() => enrol(wf, { dedupeKey }))).code).toBe('23505');
  });

  it('never lets people read a webhook secret', async () => {
    const wf = await published(wsA, orgA);
    const token = `tok_${uniq()}${uniq()}${uniq()}`;
    await worker(
      wsA,
      orgA,
    )((tx) =>
      tx.execute(sql`insert into app.workflow_webhooks (workspace_id, workflow_id, token, secret_enc, key_id)
        values (${wsA}, ${wf.workflowId}, ${token}, 'sealed:not-for-people', 'k1')`),
    );
    const [seen] = await as(bizOwner)((tx) =>
      rows<{ token: string }>(
        tx,
        sql`select token from app.workflow_webhooks where workflow_id = ${wf.workflowId}`,
      ),
    );
    expect(seen?.token).toBe(token);
    for (const columns of ['secret_enc', 'key_id', '*'])
      expect(
        (
          await failure(() =>
            as(bizOwner)((tx) =>
              tx.execute(
                sql`select ${sql.raw(columns)} from app.workflow_webhooks where workflow_id = ${wf.workflowId}`,
              ),
            ),
          )
        ).code,
      ).toBe('42501');
    // The inbound route finds the tenant and secret before any scope is set; only the worker may ask.
    const [route] = await asService({})((tx) =>
      rows<{ workspace_id: string; secret_enc: string }>(
        tx,
        sql`select workspace_id, secret_enc from private.workflow_webhook_route(${token})`,
      ),
    );
    expect(route).toEqual({ workspace_id: wsA, secret_enc: 'sealed:not-for-people' });
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(sql`select * from private.workflow_webhook_route(${token})`),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('may create and complete tasks and update leads in its own workspace, and store workflow webhooks', async () => {
    const { personId, leadId } = await worker(
      wsA,
      orgA,
    )(async (tx) => {
      const [p] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsA}, 'Mike') returning id`,
      );
      const [stage] = await rows<{ id: string; pipeline_id: string }>(
        tx,
        sql`select id, pipeline_id from app.pipeline_stages
            where workspace_id = ${wsA} and kind = 'open' order by position limit 1`,
      );
      const [l] = await rows<{ id: string }>(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title)
            values (${wsA}, ${stage!.pipeline_id}, ${stage!.id}, ${p!.id}, 'AC replacement') returning id`,
      );
      return { personId: p!.id, leadId: l!.id };
    });
    await worker(
      wsA,
      orgA,
    )(async (tx) => {
      const [t] = await rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title, person_id, lead_id)
            values (${wsA}, 'Call Mike back', ${personId}, ${leadId}) returning id`,
      );
      await tx.execute(sql`update app.tasks set done_at = now() where id = ${t!.id}`);
      await tx.execute(
        sql`update app.leads set next_action = 'Send the estimate', next_action_at = now() + interval '1 day'
            where id = ${leadId}`,
      );
    });
    const [lead] = await rows<{ next_action: string }>(
      dbs.admin.db,
      sql`select next_action from app.leads where id = ${leadId}`,
    );
    expect(lead?.next_action).toBe('Send the estimate');
    const fromB = await worker(
      wsB,
      orgB,
    )((tx) =>
      rows(
        tx,
        sql`update app.leads set next_action = 'Hijacked' where id = ${leadId} returning id`,
      ),
    );
    expect(fromB).toHaveLength(0);
    await asService({})((tx) =>
      tx.execute(sql`insert into app.webhook_deliveries (provider, kind, dedupe_key, workspace_id, organization_id)
        values ('workflow', 'inbound', ${`wh:${uniq()}`}, ${wsA}, ${orgA})`),
    );
  });

  it('records AI usage the whole workspace can read and nobody else can write', async () => {
    await worker(
      wsA,
      orgA,
    )((tx) =>
      tx.execute(sql`insert into app.ai_usage (workspace_id, source, model, input_tokens, output_tokens)
        values (${wsA}, 'workflow', 'claude-sonnet-5', 1200, 300)`),
    );
    const total = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ total: number }>(
          tx,
          sql`select coalesce(sum(input_tokens + output_tokens), 0)::int as total from app.ai_usage where workspace_id = ${wsA}`,
        ),
      ).then((r) => r[0]!.total);
    expect(await total(member)).toBeGreaterThanOrEqual(1500);
    expect(await total(outsider)).toBe(0);
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(sql`insert into app.ai_usage (workspace_id, source, model)
              values (${wsA}, 'builder', 'claude-sonnet-5')`),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('agency templates', () => {
  let template: string;

  beforeAll(async () => {
    template = await as(owner)(async (tx) => {
      const [t] = await rows<{ id: string }>(
        tx,
        sql`insert into app.workflow_templates (organization_id, name, definition, created_by)
            values (${orgA}, 'Missed-call text back', '{"steps": []}', ${owner.id}) returning id`,
      );
      await tx.execute(sql`insert into app.workflow_template_versions (organization_id, template_id, version, definition, definition_version, published_by)
        values (${orgA}, ${t!.id}, 1, '{"steps": []}', 1, ${owner.id})`);
      await tx.execute(
        sql`update app.workflow_templates set latest_version = 1 where id = ${t!.id}`,
      );
      return t!.id;
    });
  });

  it('are visible only to the organization’s owners and admins', async () => {
    const sees = (user: TestUser, table: string, column: string) =>
      as(user)((tx) =>
        rows(
          tx,
          sql`select 1 from ${sql.raw(`app.${table}`)} where ${sql.raw(column)} = ${template}`,
        ),
      ).then((r) => r.length);
    for (const [table, column] of [
      ['workflow_templates', 'id'],
      ['workflow_template_versions', 'template_id'],
    ] as const) {
      expect(await sees(owner, table, column)).toBe(1);
      expect(await sees(orgAdmin, table, column)).toBe(1);
      for (const user of [bizOwner, member, outsider])
        expect(await sees(user, table, column)).toBe(0);
    }
    expect(
      (
        await failure(() =>
          as(bizOwner)((tx) =>
            tx.execute(sql`insert into app.workflow_templates (organization_id, name, created_by)
              values (${orgA}, 'Mine', ${bizOwner.id})`),
          ),
        )
      ).code,
    ).toBe('42501');
    // The worker sees its own organization's templates only.
    const byScope = (ws: string, org: string) =>
      worker(
        ws,
        org,
      )((tx) => rows(tx, sql`select id from app.workflow_templates where id = ${template}`));
    expect(await byScope(wsA, orgA)).toHaveLength(1);
    expect(await byScope(wsB, orgB)).toHaveLength(0);
    // Published versions are append-only too.
    expect(
      await failure(() =>
        dbs.admin.db.execute(
          sql`update app.workflow_template_versions set definition = '{}' where template_id = ${template}`,
        ),
      ),
    ).toEqual({ code: '42501', detail: 'version_immutable' });
  });

  it('install only into the organization’s businesses, which see the newest version number and nothing else', async () => {
    await as(orgAdmin)((tx) =>
      tx.execute(sql`insert into app.workflow_template_installs (organization_id, template_id, workspace_id, mapping, pushed_by, pushed_at)
        values (${orgA}, ${template}, ${wsA}, '{"calendar": "tune-ups"}', ${orgAdmin.id}, now())`),
    );
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(sql`insert into app.workflow_template_installs (organization_id, template_id, workspace_id, pushed_by)
            values (${orgA}, ${template}, ${wsB}, ${owner.id})`),
        ),
      ),
    ).toEqual({ code: '23514', detail: 'record_organization_mismatch' });

    // The install job, scoped to the business, turns the newest version into a draft there.
    await worker(
      wsA,
      orgA,
    )(async (tx) => {
      const [v] = await rows<{ version: number }>(
        tx,
        sql`select version from app.workflow_template_versions where template_id = ${template} order by version desc limit 1`,
      );
      const [w] = await rows<{ id: string }>(
        tx,
        sql`insert into app.workflows (workspace_id, name, template_id, template_version, installed_revision)
            values (${wsA}, 'Missed-call text back', ${template}, ${v!.version}, 1) returning id`,
      );
      await tx.execute(sql`update app.workflow_template_installs
        set workflow_id = ${w!.id}, installed_version = ${v!.version}, status = 'installed', installed_at = now()
        where template_id = ${template} and workspace_id = ${wsA}`);
    });
    const installs = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ status: string }>(
          tx,
          sql`select status from app.workflow_template_installs where template_id = ${template}`,
        ),
      );
    expect(await installs(owner)).toEqual([{ status: 'installed' }]);
    expect(await installs(bizOwner)).toHaveLength(0);

    const updates = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ template_id: string; latest_version: number }>(
          tx,
          sql`select template_id, latest_version from private.installed_template_versions(${wsA})`,
        ),
      );
    expect(await updates(bizOwner)).toContainEqual({ template_id: template, latest_version: 1 });
    expect(await updates(outsider)).toHaveLength(0);

    // A workflow in another organization can't claim this template.
    expect(
      await failure(() =>
        worker(
          wsB,
          orgB,
        )((tx) =>
          tx.execute(sql`insert into app.workflows (workspace_id, name, template_id)
            values (${wsB}, 'Borrowed', ${template})`),
        ),
      ),
    ).toEqual({ code: '23514', detail: 'record_organization_mismatch' });
  });
});

describe('permissions', () => {
  it('gives workflows.manage to owners and admins, and org.templates.manage to org owners and admins', async () => {
    const roles = async (permission: string) =>
      (
        await rows<{ role: string }>(
          dbs.admin.db,
          sql`select role from app.role_permissions where permission = ${permission} order by role`,
        )
      ).map((r) => r.role);
    expect(await roles('workflows.manage')).toEqual(['admin', 'owner']);
    expect(await roles('org.templates.manage')).toEqual(['org_admin', 'org_owner']);
  });
});
