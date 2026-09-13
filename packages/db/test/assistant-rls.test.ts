import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: string;
let org: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
const CHAT_TABLES = ['assistant_runs', 'assistant_messages', 'assistant_tool_calls'] as const;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('ai-owner'),
    createTestUser('ai-member'),
    createTestUser('ai-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Assistant Org', 'Assistant');
  ws = a.wsId;
  org = a.orgId;
  await bootstrapOrganization(outsider, 'Assistant Other Org', 'Other');
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

/** A chat for `user` as the worker writes it: thread, finished run, question, answer and one tool call. */
async function chat(user: TestUser) {
  return worker()(async (tx) => {
    const [t] = await rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_threads (workspace_id, user_id, title)
          values (${ws}, ${user.id}, 'What needs attention?') returning id`,
    );
    const [r] = await rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id, status)
          values (${ws}, ${user.id}, ${t!.id}, 'scripted', gen_random_uuid(), 'done') returning id`,
    );
    await tx.execute(sql`insert into app.assistant_messages (workspace_id, user_id, thread_id, role, text, run_id)
      values (${ws}, ${user.id}, ${t!.id}, 'user', 'What needs attention?', ${r!.id}),
             (${ws}, ${user.id}, ${t!.id}, 'assistant', 'Four things are waiting.', ${r!.id})`);
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_tool_calls (workspace_id, user_id, thread_id, run_id, tool, autonomy, status)
          values (${ws}, ${user.id}, ${t!.id}, ${r!.id}, 'what_needs_attention', 'auto', 'done') returning id`,
    );
    return { threadId: t!.id, runId: r!.id, callId: c!.id };
  });
}

const threadsSeen = (user: TestUser, threadId: string) =>
  as(user)((tx) => rows(tx, sql`select id from app.assistant_threads where id = ${threadId}`));
const rowsSeen = (user: TestUser, table: string, threadId: string) =>
  as(user)((tx) =>
    rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)} where thread_id = ${threadId}`),
  );

describe('Assistant chats', () => {
  it('only their person reads them; an owner and outsiders see nothing', async () => {
    const c = await chat(member);
    expect(await threadsSeen(member, c.threadId)).toHaveLength(1);
    for (const table of CHAT_TABLES)
      expect((await rowsSeen(member, table, c.threadId)).length).toBeGreaterThan(0);
    for (const other of [owner, outsider]) {
      expect(await threadsSeen(other, c.threadId)).toHaveLength(0);
      for (const table of CHAT_TABLES)
        expect(await rowsSeen(other, table, c.threadId)).toHaveLength(0);
    }
  });

  it('people cannot write chats; only the worker does', async () => {
    const c = await chat(member);
    const denied = async (statement: ReturnType<typeof sql>) =>
      (await expectPgError(() => as(member)((tx) => tx.execute(statement)))).code;
    expect(
      await denied(
        sql`insert into app.assistant_threads (workspace_id, user_id) values (${ws}, ${member.id})`,
      ),
    ).toBe('42501');
    expect(
      await denied(sql`insert into app.assistant_messages (workspace_id, user_id, thread_id, role, text)
        values (${ws}, ${member.id}, ${c.threadId}, 'assistant', 'I sent it.')`),
    ).toBe('42501');
    expect(
      await denied(
        sql`update app.assistant_tool_calls set status = 'confirmed' where id = ${c.callId}`,
      ),
    ).toBe('42501');
    expect(
      await denied(sql`update app.assistant_runs set input_tokens = 0 where id = ${c.runId}`),
    ).toBe('42501');
  });

  it('a person renames or archives their own thread, and nothing else about it', async () => {
    const c = await chat(member);
    await as(member)((tx) =>
      tx.execute(
        sql`update app.assistant_threads set title = 'AC for Mike', archived_at = now() where id = ${c.threadId}`,
      ),
    );
    const [t] = await rows<{ title: string; archived: boolean }>(
      dbs.admin.db,
      sql`select title, archived_at is not null as archived from app.assistant_threads where id = ${c.threadId}`,
    );
    expect(t).toEqual({ title: 'AC for Mike', archived: true });
    const code = (
      await expectPgError(() =>
        as(member)((tx) =>
          tx.execute(
            sql`update app.assistant_threads set last_message_at = now() where id = ${c.threadId}`,
          ),
        ),
      )
    ).code;
    expect(code).toBe('42501');
    // Someone else's thread matches no rows.
    const touched = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.assistant_threads set title = 'Mine now' where id = ${c.threadId} returning id`,
      ),
    );
    expect(touched).toHaveLength(0);
  });

  it('allows one running question per person', async () => {
    const c = await chat(member);
    const start = () =>
      worker()((tx) =>
        tx.execute(sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id)
          values (${ws}, ${member.id}, ${c.threadId}, 'scripted', gen_random_uuid())`),
      );
    await start();
    expect((await expectPgError(start)).code).toBe('23505');
    await worker()((tx) =>
      tx.execute(
        sql`update app.assistant_runs set status = 'done' where user_id = ${member.id} and status = 'running'`,
      ),
    );
  });

  it('lets the worker act as a signed-in person, under their RLS', async () => {
    const c = await chat(member);
    const sees = (user: TestUser) =>
      asUser(dbs.worker.db, { sub: user.id, email: user.email }, (tx) =>
        rows(tx, sql`select id from app.assistant_threads where id = ${c.threadId}`),
      );
    expect(await sees(member)).toHaveLength(1);
    expect(await sees(owner)).toHaveLength(0);
  });

  it('gives owners, admins and members assistant.use', async () => {
    const roles = await rows<{ role: string }>(
      dbs.admin.db,
      sql`select role from app.role_permissions where permission = 'assistant.use' order by role`,
    );
    expect(roles.map((r) => r.role)).toEqual(['admin', 'member', 'owner']);
  });
});
