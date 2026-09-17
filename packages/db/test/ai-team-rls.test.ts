import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
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
/** Workspace A's admin. */
let admin: TestUser;
let member: TestUser;
/** Org B's owner. */
let outsider: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;
/** Each business's teammate, set up by its admin or owner. */
let teammateA: string;
let teammateB: string;

type Actor = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const uuids = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const mismatch = { code: '23514', detail: 'record_workspace_mismatch' };

let phones = 0;
const nextPhone = () => `+1512555${String(1000 + ++phones)}`;
let revisions = 0;
const nextRevision = () => ++revisions;

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('ai-owner'),
    createTestUser('ai-admin'),
    createTestUser('ai-member'),
    createTestUser('ai-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'AI Team Org A', 'AI Team A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'AI Team Org B', 'AI Team B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: admin.id, role: 'admin' },
    { workspaceId: A.ws, userId: member.id, role: 'member' },
  ]);
  teammateA = await createTeammate(admin, A.ws);
  teammateB = await createTeammate(outsider, B.ws);
});
afterAll(closeAll);

/** A business of its own, owned by `owner`, for walking one teammate through its states. */
async function freshBusiness(): Promise<Business> {
  const b = await bootstrapOrganization(owner, `AI Org ${uniq()}`, `AI Biz ${uniq()}`);
  return { ws: b.wsId, org: b.orgId };
}

/** A teammate set up by `user` (an owner or admin), as ai_teammate.create would. */
async function createTeammate(
  user: TestUser,
  ws: string,
  status = 'training',
  approvalsNeeded = 20,
): Promise<string> {
  const config = { identity: { name: 'Ava' }, autonomy: { approvalsNeeded } };
  const [t] = await as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.ai_teammates (workspace_id, name, status, config, created_by)
          values (${ws}, 'Ava', ${status}::app.ai_teammate_status, ${JSON.stringify(config)}::jsonb, ${user.id})
          returning id`,
    ),
  );
  return t!.id;
}

/** Times come back as epoch seconds: raw rows carry timestamps as strings. */
type TeammateRow = {
  status: string;
  approved_count: number;
  edited_count: number;
  rejected_count: number;
  automatic_via: string | null;
  automatic_since: number | null;
  training_started_at: number | null;
};
const teammateRow = (id: string) =>
  rows<TeammateRow>(
    dbs.admin.db,
    sql`select status, approved_count, edited_count, rejected_count, automatic_via,
          extract(epoch from automatic_since)::float8 as automatic_since,
          extract(epoch from training_started_at)::float8 as training_started_at
        from app.ai_teammates where id = ${id}`,
  ).then((r) => r[0]!);

const setStatus = (user: TestUser, id: string, status: string) =>
  as(user)((tx) =>
    rows(
      tx,
      sql`update app.ai_teammates set status = ${status}::app.ai_teammate_status where id = ${id} returning id`,
    ),
  );

type Decision = {
  status: string;
  approved_count: number;
  edited_count: number;
  rejected_count: number;
  approvals_needed: number;
  became_automatic: boolean;
};
const decideAs = (actor: Actor, teammateId: string, decision: string, edited = false) =>
  actor((tx) =>
    rows<Decision>(
      tx,
      sql`select * from private.record_teammate_decision(${teammateId}, ${decision}, ${edited})`,
    ),
  ).then((r) => r[0]!);

async function conversation(b: Business): Promise<string> {
  const [c] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.conversations (workspace_id, channel, counterpart)
          values (${b.ws}, 'sms', ${nextPhone()}) returning id`,
    ),
  );
  return c!.id;
}

async function inbound(b: Business, conversationId: string): Promise<string> {
  const [m] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
          values (${b.ws}, ${conversationId}, 'sms', 'inbound', 'received', 'Can you come out Thursday?')
          returning id`,
    ),
  );
  return m!.id;
}

/** A run the worker starts for a conversation's unanswered messages. */
async function startRun(
  b: Business,
  teammateId: string,
  conversationId: string | null,
  messageIds: string[] = [],
): Promise<string> {
  const [r] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.ai_teammate_runs (workspace_id, teammate_id, conversation_id, triggered_by, message_ids)
          values (${b.ws}, ${teammateId}, ${conversationId}, 'message.received', ${uuids(messageIds)})
          returning id`,
    ),
  );
  return r!.id;
}

/** A draft the worker holds for a person's OK. */
async function makeDraft(
  b: Business,
  teammateId: string,
  runId: string,
  conversationId: string,
  kind: 'reply' | 'approval',
): Promise<string> {
  const [d] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.ai_teammate_drafts
            (workspace_id, teammate_id, run_id, conversation_id, kind, preview, client_id, expires_at)
          values (${b.ws}, ${teammateId}, ${runId}, ${conversationId}, ${kind},
            '{"text": "Thursday at 9 works. Want me to book it?"}', ${`ai:${runId}:${kind}`},
            now() + interval '2 hours')
          returning id`,
    ),
  );
  return d!.id;
}

describe('the AI teammate: who reads and who manages', () => {
  it('everyone in the workspace reads the teammate, its history, runs and tool calls; outsiders see none', async () => {
    await as(admin)((tx) =>
      tx.execute(sql`insert into app.ai_teammate_revisions (workspace_id, teammate_id, revision, config, config_version, changed_by)
        values (${A.ws}, ${teammateA}, ${nextRevision()}, '{"identity": {"name": "Ava"}}', 1, ${admin.id})`),
    );
    const runId = await startRun(A, teammateA, await conversation(A));
    await worker(A)((tx) =>
      tx.execute(sql`insert into app.ai_teammate_tool_calls (workspace_id, run_id, provider_call_id, tool, arguments, status)
        values (${A.ws}, ${runId}, 'toolu_01', 'search_knowledge', '{"query": "tune-up price"}', 'done')`),
    );
    const count = (user: TestUser, table: string, column: string, value: string) =>
      as(user)((tx) =>
        rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)} where ${sql.raw(column)} = ${value}`),
      ).then((r) => r.length);
    const probes: [string, string, string][] = [
      ['ai_teammates', 'id', teammateA],
      ['ai_teammate_revisions', 'teammate_id', teammateA],
      ['ai_teammate_runs', 'id', runId],
      ['ai_teammate_tool_calls', 'run_id', runId],
    ];
    for (const [table, column, value] of probes) {
      expect(await count(member, table, column, value)).toBeGreaterThan(0);
      expect(await count(admin, table, column, value)).toBeGreaterThan(0);
      expect(await count(outsider, table, column, value)).toBe(0);
    }
  });

  it('owners and admins set the teammate up and save its history; members cannot', async () => {
    expect(await code(() => createTeammate(member, A.ws))).toBe('42501');
    // One live teammate per business.
    expect(await code(() => createTeammate(admin, A.ws))).toBe('23505');
    const save = (user: TestUser) =>
      as(user)((tx) =>
        rows(
          tx,
          sql`update app.ai_teammates
              set name = 'Ava', config = config || '{"tone": "warm"}', config_version = 1, revision = revision + 1,
                labels = '{"Appointment Coordinator"}'
              where id = ${teammateA} returning id`,
        ),
      );
    expect(await save(member)).toHaveLength(0);
    expect(await save(admin)).toHaveLength(1);
    expect(await save(owner)).toHaveLength(1);
    const revise = (user: TestUser) =>
      as(user)((tx) =>
        tx.execute(sql`insert into app.ai_teammate_revisions (workspace_id, teammate_id, revision, config, config_version, changed_by)
          values (${A.ws}, ${teammateA}, ${nextRevision()}, '{"tone": "warm"}', 1, ${user.id})`),
      );
    expect(await code(() => revise(member))).toBe('42501');
    await revise(admin);
  });

  it('nobody writes the training counts directly, the worker included', async () => {
    const bySomeone = (set: string) =>
      as(admin)((tx) =>
        tx.execute(sql`update app.ai_teammates set ${sql.raw(set)} where id = ${teammateA}`),
      );
    for (const set of [
      'approved_count = 20',
      'edited_count = 1',
      'rejected_count = 0',
      'training_started_at = now()',
      'automatic_since = now()',
      "automatic_via = 'threshold'",
      'archived_at = now()',
    ])
      expect(await code(() => bySomeone(set))).toBe('42501');
    const byWorker = (set: string) =>
      worker(A)((tx) =>
        tx.execute(sql`update app.ai_teammates set ${sql.raw(set)} where id = ${teammateA}`),
      );
    const protectedCounts = { code: '42501', detail: 'teammate_counts_protected' };
    expect(await failure(() => byWorker('approved_count = 20'))).toEqual(protectedCounts);
    expect(
      await failure(() =>
        byWorker("status = 'automatic', automatic_via = 'threshold', automatic_since = now()"),
      ),
    ).toEqual(protectedCounts);
    // A new teammate starts off or in training, with nothing counted and its training clock started.
    const b = await freshBusiness();
    expect(
      await failure(() =>
        worker(b)((tx) =>
          tx.execute(sql`insert into app.ai_teammates (workspace_id, name, status, approved_count)
            values (${b.ws}, 'Ava', 'training', 5)`),
        ),
      ),
    ).toEqual(protectedCounts);
    expect(await failure(() => createTeammate(owner, b.ws, 'automatic'))).toEqual({
      code: '42501',
      detail: 'teammate_status_transition',
    });
    expect(await teammateRow(teammateA)).toMatchObject({
      status: 'training',
      approved_count: 0,
      automatic_via: null,
      training_started_at: expect.any(Number),
    });
  });

  it('pauses and resumes without losing progress; only "Back to training" starts the count again', async () => {
    const b = await freshBusiness();
    const id = await createTeammate(owner, b.ws, 'off', 5);
    expect((await teammateRow(id)).training_started_at).toBeNull();
    await setStatus(owner, id, 'training');
    const started = (await teammateRow(id)).training_started_at!;
    expect(started).toEqual(expect.any(Number));
    await decideAs(as(owner), id, 'approved', true);
    await decideAs(as(owner), id, 'rejected');
    const progress = { approved_count: 1, edited_count: 1, rejected_count: 1 };
    // off -> training keeps the counts.
    await setStatus(owner, id, 'off');
    await setStatus(owner, id, 'training');
    expect(await teammateRow(id)).toMatchObject({
      status: 'training',
      training_started_at: started,
      ...progress,
    });
    // "Switch to automatic now".
    await setStatus(owner, id, 'automatic');
    const automatic = await teammateRow(id);
    expect(automatic).toMatchObject({
      status: 'automatic',
      automatic_via: 'override',
      automatic_since: expect.any(Number),
      ...progress,
    });
    // A holiday: automatic -> off -> automatic keeps the counts and when it turned automatic. Below the
    // threshold, resuming is still an override.
    await setStatus(owner, id, 'off');
    expect(await teammateRow(id)).toMatchObject({
      status: 'off',
      automatic_via: null,
      automatic_since: automatic.automatic_since,
      ...progress,
    });
    await setStatus(owner, id, 'automatic');
    expect(await teammateRow(id)).toMatchObject({
      status: 'automatic',
      automatic_via: 'override',
      automatic_since: automatic.automatic_since,
      ...progress,
    });
    // Paused, then into training: the counts stay, and it is no longer automatic since anything.
    await setStatus(owner, id, 'off');
    await setStatus(owner, id, 'training');
    expect(await teammateRow(id)).toMatchObject({
      status: 'training',
      automatic_via: null,
      automatic_since: null,
      training_started_at: started,
      ...progress,
    });
    // "Back to training" from automatic starts the count again.
    await setStatus(owner, id, 'automatic');
    await setStatus(owner, id, 'training');
    const back = await teammateRow(id);
    expect(back).toMatchObject({
      status: 'training',
      approved_count: 0,
      edited_count: 0,
      rejected_count: 0,
      automatic_via: null,
      automatic_since: null,
    });
    expect(back.training_started_at!).toBeGreaterThan(started);
  });

  it('counts each decision through the definer, and turns automatic at the threshold', async () => {
    const b = await freshBusiness();
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values([{ workspaceId: b.ws, userId: member.id, role: 'member' }]);
    const id = await createTeammate(owner, b.ws, 'training', 3);
    expect(await decideAs(as(member), id, 'approved')).toEqual({
      status: 'training',
      approved_count: 1,
      edited_count: 0,
      rejected_count: 0,
      approvals_needed: 3,
      became_automatic: false,
    });
    // An edited approval counts toward the threshold and as edited; a rejection counts on its own.
    expect(await decideAs(as(member), id, 'approved', true)).toMatchObject({
      approved_count: 2,
      edited_count: 1,
    });
    expect(await decideAs(as(member), id, 'rejected', true)).toMatchObject({
      approved_count: 2,
      edited_count: 1,
      rejected_count: 1,
    });
    // Only the business's own team, or the worker scoped to it, and only yes or no.
    const forbidden = { code: '42501', detail: 'teammate_decision_forbidden' };
    expect(await failure(() => decideAs(as(outsider), id, 'approved'))).toEqual(forbidden);
    expect(await failure(() => decideAs(worker(B), id, 'approved'))).toEqual(forbidden);
    expect(await failure(() => decideAs(as(member), id, 'maybe'))).toEqual({
      code: '22023',
      detail: 'teammate_decision_invalid',
    });
    // The third approval reaches it.
    expect(await decideAs(worker(b), id, 'approved')).toEqual({
      status: 'automatic',
      approved_count: 3,
      edited_count: 1,
      rejected_count: 1,
      approvals_needed: 3,
      became_automatic: true,
    });
    const earned = await teammateRow(id);
    expect(earned).toMatchObject({ status: 'automatic', automatic_via: 'threshold' });
    // Paused and resumed with the threshold met: it earned it, and keeps when it turned automatic.
    await setStatus(owner, id, 'off');
    await setStatus(owner, id, 'automatic');
    expect(await teammateRow(id)).toMatchObject({
      status: 'automatic',
      automatic_via: 'threshold',
      automatic_since: earned.automatic_since,
      approved_count: 3,
    });
    // Later decisions still count and switch nothing; a threshold that isn't a number means 20.
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.ai_teammates set config = config || '{"autonomy": {"approvalsNeeded": "lots"}}' where id = ${id}`,
      ),
    );
    expect(await decideAs(as(member), id, 'approved')).toMatchObject({
      status: 'automatic',
      approved_count: 4,
      approvals_needed: 20,
      became_automatic: false,
    });
  });

  it('keeps revisions append-only, the table owner included, until their teammate goes', async () => {
    const revision = nextRevision();
    const insert = () =>
      as(admin)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.ai_teammate_revisions (workspace_id, teammate_id, revision, config, config_version, changed_by)
              values (${A.ws}, ${teammateA}, ${revision}, '{"tone": "warm"}', 1, ${admin.id}) returning id`,
        ),
      );
    const [r] = await insert();
    const id = r!.id;
    expect(await code(insert)).toBe('23505');
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(sql`update app.ai_teammate_revisions set config = '{}' where id = ${id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        worker(A)((tx) => tx.execute(sql`delete from app.ai_teammate_revisions where id = ${id}`)),
      ),
    ).toBe('42501');
    const immutable = { code: '42501', detail: 'revision_immutable' };
    expect(
      await failure(() =>
        dbs.admin.db.execute(
          sql`update app.ai_teammate_revisions set config = '{"changed": true}' where id = ${id}`,
        ),
      ),
    ).toEqual(immutable);
    expect(
      await failure(() =>
        dbs.admin.db.execute(sql`delete from app.ai_teammate_revisions where id = ${id}`),
      ),
    ).toEqual(immutable);
    // The foreign key may still forget a deleted account.
    await dbs.admin.db.execute(
      sql`update app.ai_teammate_revisions set changed_by = null where id = ${id}`,
    );
    // Deleting a teammate takes its history along.
    const b = await freshBusiness();
    const gone = await createTeammate(owner, b.ws);
    await as(owner)((tx) =>
      tx.execute(sql`insert into app.ai_teammate_revisions (workspace_id, teammate_id, revision, config, config_version, changed_by)
        values (${b.ws}, ${gone}, 1, '{}', 1, ${owner.id})`),
    );
    await dbs.admin.db.execute(sql`delete from app.ai_teammates where id = ${gone}`);
    expect(
      await rows(
        dbs.admin.db,
        sql`select 1 from app.ai_teammate_revisions where teammate_id = ${gone}`,
      ),
    ).toHaveLength(0);
  });
});

describe('drafts', () => {
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
        sql`update app.ai_teammate_drafts
            set status = ${status}::app.workflow_approval_status, decided_by = ${decidedBy}, decided_at = now(),
              via = ${via}, edits = '{"text": "Thursday at 9 works, Mike!"}'
            where id = ${id} and status = 'pending' returning id`,
      ),
    );

  it('a member approves a reply draft but not an approval draft; each is decided once, in the decider’s own name', async () => {
    const conv = await conversation(A);
    const runId = await startRun(A, teammateA, conv);
    const reply = await makeDraft(A, teammateA, runId, conv, 'reply');
    const discount = await makeDraft(A, teammateA, runId, conv, 'approval');
    const seen = (user: TestUser) =>
      as(user)((tx) =>
        rows(tx, sql`select id from app.ai_teammate_drafts where run_id = ${runId}`),
      ).then((r) => r.length);
    expect(await seen(member)).toBe(2);
    expect(await seen(outsider)).toBe(0);

    expect(await decide(member, discount)).toHaveLength(0);
    expect(await decide(member, reply)).toHaveLength(1);
    // A second click finds nothing pending.
    expect(await decide(admin, reply, 'rejected')).toHaveLength(0);
    // Nobody decides in someone else's name, and only the system expires a draft or decides as 'system'.
    expect(await code(() => decide(admin, discount, 'approved', member.id))).toBe('42501');
    expect(await code(() => decide(admin, discount, 'expired'))).toBe('42501');
    expect(await code(() => decide(admin, discount, 'approved', admin.id, 'system'))).toBe('42501');
    expect(await decide(admin, discount)).toHaveLength(1);
    const [decided] = await rows<{ status: string; decided_by: string; via: string }>(
      dbs.admin.db,
      sql`select status, decided_by, via from app.ai_teammate_drafts where id = ${reply}`,
    );
    expect(decided).toEqual({ status: 'approved', decided_by: member.id, via: 'web' });
    // Decided on the phone says so (0063); nothing else a person names is taken.
    const conv2 = await conversation(A);
    const onPhone = await makeDraft(
      A,
      teammateA,
      await startRun(A, teammateA, conv2),
      conv2,
      'reply',
    );
    expect(await code(() => decide(member, onPhone, 'approved', member.id, 'pigeon'))).toBe(
      '42501',
    );
    expect(await decide(member, onPhone, 'rejected', member.id, 'mobile')).toHaveLength(1);

    // Only the worker makes drafts, and people change nothing about one but the decision.
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, conversation_id, kind, client_id)
            values (${A.ws}, ${teammateA}, ${conv}, 'reply', 'mine')`),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(sql`update app.ai_teammate_drafts set preview = '{}' where id = ${reply}`),
        ),
      ),
    ).toBe('42501');
  });

  it('keeps one pending reply per conversation, and a draft’s kind, preview and client id for good', async () => {
    const conv = await conversation(A);
    const runId = await startRun(A, teammateA, conv);
    const first = await makeDraft(A, teammateA, runId, conv, 'reply');
    expect(await code(() => makeDraft(A, teammateA, runId, conv, 'reply'))).toBe('23505');
    await makeDraft(A, teammateA, runId, conv, 'approval');
    // The customer wrote again: the worker supersedes the old reply, then drafts anew.
    await worker(A)((tx) =>
      tx.execute(sql`update app.ai_teammate_drafts set status = 'cancelled', decided_at = now(), via = 'system'
        where id = ${first}`),
    );
    const second = await makeDraft(A, teammateA, runId, conv, 'reply');
    for (const set of [
      "client_id = 'something-else'",
      "kind = 'approval'",
      `preview = '{"text": "changed"}'`,
      'conversation_id = null',
    ])
      expect(
        await code(() =>
          worker(A)((tx) =>
            tx.execute(sql`update app.ai_teammate_drafts set ${sql.raw(set)} where id = ${first}`),
          ),
        ),
      ).toBe('23514');
    // A decided draft says when; a pending one doesn't.
    expect(
      await code(() =>
        worker(A)((tx) =>
          tx.execute(
            sql`update app.ai_teammate_drafts set status = 'approved' where id = ${second}`,
          ),
        ),
      ),
    ).toBe('23514');
  });
});

describe('runs and tool calls', () => {
  it('one run per conversation at a time, one row per tool call, and only the worker writes them', async () => {
    const conv = await conversation(A);
    const msg = await inbound(A, conv);
    const first = await startRun(A, teammateA, conv, [msg]);
    expect(await code(() => startRun(A, teammateA, conv))).toBe('23505');
    // How two jobs settle it: the loser inserts nothing and moves on.
    const raced = await worker(A)((tx) =>
      rows(
        tx,
        sql`insert into app.ai_teammate_runs (workspace_id, teammate_id, conversation_id, triggered_by)
            values (${A.ws}, ${teammateA}, ${conv}, 'message.received') on conflict do nothing returning id`,
      ),
    );
    expect(raced).toHaveLength(0);
    // A running run has no outcome yet.
    expect(
      await code(() =>
        worker(A)((tx) =>
          tx.execute(sql`update app.ai_teammate_runs set outcome = 'replied' where id = ${first}`),
        ),
      ),
    ).toBe('23514');
    await worker(A)((tx) =>
      tx.execute(sql`update app.ai_teammate_runs
        set status = 'done', outcome = 'drafted', ended_at = now(), tool_steps = 1, model = 'claude-sonnet-5'
        where id = ${first}`),
    );
    const second = await startRun(A, teammateA, conv);

    const call = (runId: string, providerCallId: string) =>
      worker(A)((tx) =>
        rows(
          tx,
          sql`insert into app.ai_teammate_tool_calls (workspace_id, run_id, provider_call_id, tool, arguments)
              values (${A.ws}, ${runId}, ${providerCallId}, 'find_times', '{"day": "thursday"}')
              on conflict (run_id, provider_call_id) do nothing returning id`,
        ),
      );
    expect(await call(second, 'toolu_1')).toHaveLength(1);
    expect(await call(second, 'toolu_1')).toHaveLength(0);
    expect(await call(first, 'toolu_1')).toHaveLength(1);

    // People only read.
    for (const statement of [
      sql`insert into app.ai_teammate_runs (workspace_id, teammate_id, triggered_by) values (${A.ws}, ${teammateA}, 'test')`,
      sql`update app.ai_teammate_runs set status = 'failed', ended_at = now() where id = ${second}`,
      sql`insert into app.ai_teammate_tool_calls (workspace_id, run_id, provider_call_id, tool)
          values (${A.ws}, ${second}, 'toolu_2', 'reply')`,
    ])
      expect(await code(() => as(admin)((tx) => tx.execute(statement)))).toBe('42501');

    // A run's batch is its own conversation's messages.
    const other = await conversation(A);
    expect(await failure(() => startRun(A, teammateA, other, [msg]))).toEqual(mismatch);
  });
});

describe('conversations, messages and leads', () => {
  it('a conversation the AI handles names its teammate, and one waiting for a person is a person’s', async () => {
    const conv = await conversation(A);
    const set = (assignments: string) =>
      worker(A)((tx) =>
        tx.execute(sql`update app.conversations set ${sql.raw(assignments)} where id = ${conv}`),
      );
    expect(await code(() => set("handled_by = 'ai'"))).toBe('23514');
    await worker(A)((tx) =>
      tx.execute(sql`update app.conversations set handled_by = 'ai', ai_teammate_id = ${teammateA}, ai_epoch = ai_epoch + 1
        where id = ${conv}`),
    );
    // Only a conversation handed to a person waits for one.
    expect(await code(() => set('needs_person_since = now()'))).toBe('23514');
    await set(
      "handled_by = 'person', needs_person_since = now(), handoff_reason = 'asked_for_person', handoff_note = 'Wants to talk about a warranty claim.'",
    );
    expect(await code(() => set("handoff_reason = 'bored'"))).toBe('23514');
    expect(await code(() => set(`handoff_note = '${'x'.repeat(501)}'`))).toBe('23514');
    // Someone who works the inbox takes it over; the teammate stays named for Hand back.
    const taken = await as(member)((tx) =>
      rows(
        tx,
        sql`update app.conversations
            set handled_by = 'person', needs_person_since = null, taken_over_by = ${member.id}, ai_epoch = ai_epoch + 1
            where id = ${conv} returning ai_epoch, ai_teammate_id, taken_over_by`,
      ),
    );
    expect(taken).toEqual([{ ai_epoch: 2, ai_teammate_id: teammateA, taken_over_by: member.id }]);
  });

  it('the teammate’s messages have no person as sender, keep their teammate, and alone carry AI details', async () => {
    const conv = await conversation(A);
    const runId = await startRun(A, teammateA, conv);
    const draftId = await makeDraft(A, teammateA, runId, conv, 'reply');
    const [sent] = await worker(A)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text,
              sent_by_teammate_id, ai_run_id, ai_draft_id, approved_by, client_id)
            values (${A.ws}, ${conv}, 'sms', 'outbound', 'queued', 'Thursday at 9 works, Mike!',
              ${teammateA}, ${runId}, ${draftId}, ${member.id}, ${`ai:${runId}`})
            returning id`,
      ),
    );
    // A person never sends as the teammate.
    expect(
      await code(() =>
        as(member)((tx) =>
          tx.execute(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text,
              sent_by, sent_by_teammate_id)
            values (${A.ws}, ${conv}, 'sms', 'outbound', 'queued', 'Hi, it is Ava', ${member.id}, ${teammateA})`),
        ),
      ),
    ).toBe('23514');
    for (const statement of [
      // Only the teammate's messages name an approver …
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, approved_by)
          values (${A.ws}, ${conv}, 'sms', 'outbound', 'queued', 'Hi', ${member.id})`,
      // … and the teammate only ever sends.
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by_teammate_id)
          values (${A.ws}, ${conv}, 'sms', 'inbound', 'received', 'Hi', ${teammateA})`,
      // The teammate that wrote a message never changes.
      sql`update app.messages set sent_by_teammate_id = null where id = ${sent!.id}`,
    ])
      expect(await code(() => worker(A)((tx) => tx.execute(statement)))).toBe('23514');
    // A pruned run leaves the message (and its draft) in place.
    await dbs.admin.db.execute(sql`delete from app.ai_teammate_runs where id = ${runId}`);
    const [after] = await rows<{ ai_run_id: string | null; ai_draft_id: string | null }>(
      dbs.admin.db,
      sql`select ai_run_id, ai_draft_id from app.messages where id = ${sent!.id}`,
    );
    expect(after).toEqual({ ai_run_id: null, ai_draft_id: draftId });
  });

  it('a lead keeps its qualifying answers as an object of up to 16 KB', async () => {
    const leadId = await worker(A)(async (tx) => {
      const [p] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${A.ws}, 'Mike') returning id`,
      );
      const [stage] = await rows<{ id: string; pipeline_id: string }>(
        tx,
        sql`select id, pipeline_id from app.pipeline_stages
            where workspace_id = ${A.ws} and kind = 'open' order by position limit 1`,
      );
      const [l] = await rows<{ id: string }>(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title)
            values (${A.ws}, ${stage!.pipeline_id}, ${stage!.id}, ${p!.id}, 'AC replacement') returning id`,
      );
      return l!.id;
    });
    const answer = (value: string) =>
      worker(A)((tx) =>
        tx.execute(sql`update app.leads set qualification = ${value}::jsonb where id = ${leadId}`),
      );
    await answer(
      JSON.stringify({
        budget: { question: 'What budget do you have in mind?', answer: 'Around $8,000' },
      }),
    );
    const [lead] = await rows<{ qualification: { budget: { answer: string } } }>(
      dbs.admin.db,
      sql`select qualification from app.leads where id = ${leadId}`,
    );
    expect(lead?.qualification.budget.answer).toBe('Around $8,000');
    expect(await code(() => answer('[]'))).toBe('23514');
    expect(
      await code(() => answer(JSON.stringify({ notes: randomBytes(24_000).toString('base64') }))),
    ).toBe('23514');
  });
});

describe('references stay inside the workspace', () => {
  it('refuses another business’s teammate, run, draft or people anywhere', async () => {
    const convA = await conversation(A);
    const runA = await startRun(A, teammateA, convA);
    const convB = await conversation(B);
    expect(
      await worker(B)((tx) =>
        rows(tx, sql`select id from app.ai_teammates where id = ${teammateA}`),
      ),
    ).toHaveLength(0);
    expect(await failure(() => startRun(B, teammateA, convB))).toEqual(mismatch);
    expect(await failure(() => makeDraft(B, teammateB, runA, convB, 'reply'))).toEqual(mismatch);
    for (const statement of [
      sql`update app.conversations set handled_by = 'ai', ai_teammate_id = ${teammateA} where id = ${convB}`,
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by_teammate_id)
          values (${B.ws}, ${convB}, 'sms', 'outbound', 'queued', 'Hi', ${teammateA})`,
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text,
            sent_by_teammate_id, ai_run_id)
          values (${B.ws}, ${convB}, 'sms', 'outbound', 'queued', 'Hi', ${teammateB}, ${runA})`,
      sql`insert into app.ai_teammate_revisions (workspace_id, teammate_id, revision, config, config_version)
          values (${B.ws}, ${teammateA}, 1, '{}', 1)`,
      sql`insert into app.ai_teammate_tool_calls (workspace_id, run_id, provider_call_id, tool)
          values (${B.ws}, ${runA}, 'toolu_x', 'reply')`,
    ])
      expect(await failure(() => worker(B)((tx) => tx.execute(statement)))).toEqual(mismatch);

    // Nobody from outside the business takes a conversation over, approves a message or decides a draft.
    const draftA = await makeDraft(A, teammateA, runA, convA, 'reply');
    for (const statement of [
      sql`update app.conversations set handled_by = 'person', taken_over_by = ${outsider.id} where id = ${convA}`,
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text,
            sent_by_teammate_id, approved_by)
          values (${A.ws}, ${convA}, 'sms', 'outbound', 'queued', 'Hi', ${teammateA}, ${outsider.id})`,
      sql`update app.ai_teammate_drafts set status = 'approved', decided_by = ${outsider.id}, decided_at = now(), via = 'email'
          where id = ${draftA}`,
    ])
      expect(await failure(() => worker(A)((tx) => tx.execute(statement)))).toEqual(mismatch);

    // AI usage names its own business's teammate, and a run of that teammate.
    const usage = (b: Business, teammateId: string | null, runId: string | null) =>
      worker(b)((tx) =>
        tx.execute(sql`insert into app.ai_usage (workspace_id, source, teammate_id, teammate_run_id, model, input_tokens, output_tokens)
          values (${b.ws}, 'teammate', ${teammateId}, ${runId}, 'claude-sonnet-5', 900, 120)`),
      );
    await usage(A, teammateA, runA);
    expect(await failure(() => usage(B, teammateA, null))).toEqual(mismatch);
    expect(await failure(() => usage(B, teammateB, runA))).toEqual(mismatch);
    expect(await failure(() => usage(A, null, runA))).toEqual(mismatch);
  });
});

describe('indexes and permissions', () => {
  it('indexes every foreign key the AI teammate and website chat added, leading with its column', async () => {
    const newTables = [
      'ai_teammates',
      'ai_teammate_revisions',
      'ai_teammate_runs',
      'ai_teammate_tool_calls',
      'ai_teammate_drafts',
      'chat_widgets',
      'chat_visitors',
      'chat_signals',
    ];
    const newColumns = [
      ['conversations', 'ai_teammate_id'],
      ['conversations', 'taken_over_by'],
      ['messages', 'sent_by_teammate_id'],
      ['messages', 'ai_run_id'],
      ['messages', 'ai_draft_id'],
      ['messages', 'approved_by'],
      ['ai_usage', 'teammate_id'],
      ['ai_usage', 'teammate_run_id'],
    ];
    // A partial index counts only when it covers every row that has a key ("where <key> is not null").
    const keys = await rows<{ tbl: string; col: string; indexed: boolean }>(
      dbs.admin.db,
      sql`select cl.relname::text as tbl, a.attname::text as col,
            exists (
              select 1 from pg_index i
              where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
                and (i.indpred is null or pg_get_expr(i.indpred, i.indrelid) = '(' || a.attname || ' IS NOT NULL)')
            ) as indexed
          from pg_constraint c
          join pg_class cl on cl.oid = c.conrelid
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
          where c.contype = 'f' and c.connamespace = 'app'::regnamespace and cardinality(c.conkey) = 1`,
    );
    const ours = keys.filter(
      (k) => newTables.includes(k.tbl) || newColumns.some(([t, c]) => t === k.tbl && c === k.col),
    );
    expect(ours.length).toBeGreaterThanOrEqual(36);
    expect(ours.filter((k) => !k.indexed)).toEqual([]);
  });

  it('gives ai_team.manage to owners and admins', async () => {
    const roles = await rows<{ role: string }>(
      dbs.admin.db,
      sql`select role from app.role_permissions where permission = 'ai_team.manage' order by role`,
    );
    expect(roles.map((r) => r.role)).toEqual(['admin', 'owner']);
  });
});
