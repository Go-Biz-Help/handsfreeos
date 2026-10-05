/**
 * Messages in a client's portal, end to end through the worker (Real Estate round two, step 5): a client writes from
 * their portal about their deal, every worker handler takes it in stride, someone on the deal replies from the Inbox,
 * the worker marks the reply sent, and if the client hasn't read it ten minutes later they get one email with a link
 * to their portal and nothing of what was said. A reply they read in time sends nothing.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  executeCommand,
  messageSend,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installRealestate } from '../../../packages/core/test/addons/realestate-fixture';
import { unreadNoticeKey } from '../src/portal/replies';
import {
  admin,
  drain,
  jobRow,
  mailTo,
  makeWorld,
  post,
  run,
  runDue,
  waitForMail,
  type World,
} from './booking-world';
import { systemActor } from '../src/services';

let w: World;
let business: string;
let email: string;
let personId: string;
let deal: string;
let bearer: string;
let conversationId: string;

function op(name: string, body: Record<string, unknown> = {}) {
  return w.app.inject({
    method: 'POST',
    url: `/public/portal/op/${name}`,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.71',
      authorization: `Bearer ${bearer}`,
    },
    payload: JSON.stringify(body),
  });
}

async function reply(body: string): Promise<string> {
  const sent = await run(w, messageSend, {
    workspaceId: w.workspaceId,
    conversationId,
    channel: 'portal',
    body,
  });
  await drain(w);
  return sent.messageId;
}

beforeAll(async () => {
  w = await makeWorld('portal-messages');
  await installRealestate(w.workspaceId);
  const [ws] = await rows<{ name: string }>(
    admin(),
    sql`select name from app.workspaces where id = ${w.workspaceId}`,
  );
  business = ws!.name;
  email = `linh-${randomBytes(4).toString('hex')}@example.com`;
  personId = (
    await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName: 'Linh',
      lastName: 'Nguyen',
      email,
    })
  ).personId;
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.custom_records (workspace_id, type_id, name, created_by, owner_user_id)
        select ${w.workspaceId}, t.id, 'Nguyen purchase', ${w.owner.id}, ${w.owner.id} from app.custom_record_types t
        where t.workspace_id = ${w.workspaceId} and t.key = 'realestate_deal' returning id`,
  );
  deal = r!.id;
  await rows(
    admin(),
    sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
        select ${w.workspaceId}, t.id, ${personId}, ${deal} from app.relationship_types t
        where t.workspace_id = ${w.workspaceId} and t.addon_key = 'realestate_client'`,
  );
  const { accessId } = await run(w, portalAccessGive, { workspaceId: w.workspaceId, personId });
  const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
  const workerDb = testDbs().worker.db;
  const meta = { correlationId: randomUUID(), channel: 'test' as const };
  const { output: sent } = await executeCommand(
    workerDb,
    portalSendCode,
    { workspaceId: w.workspaceId, accessId },
    systemActor(scope),
    meta,
  );
  bearer = randomBytes(32).toString('base64url');
  await executeCommand(
    workerDb,
    portalCheckCode,
    {
      workspaceId: w.workspaceId,
      accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(bearer).digest('hex'),
    },
    systemActor(scope),
    meta,
  );
  // The invite went out: drained now so later mail counts start from here.
  await drain(w);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('a client writing from their portal', () => {
  it('lands in the Inbox, and every handler takes it in stride', async () => {
    const res = await op('portal.message_send', {
      recordId: deal,
      body: 'Is the inspection still on for Tuesday?',
      clientId: 'worker-portal-0001',
    });
    expect(res.statusCode, res.body).toBe(200);
    conversationId = (res.json() as { conversationId: string }).conversationId;
    // Push, workflows, the Action Center, contact AI and the rest: drain throws on any failure.
    await drain(w);
    const [c] = await rows<{ unread_count: number; assignee_user_id: string }>(
      admin(),
      sql`select unread_count, assignee_user_id from app.conversations where id = ${conversationId}`,
    );
    expect(c).toEqual({ unread_count: 1, assignee_user_id: w.owner.id });
  });
});

describe('a reply from the team', () => {
  it('is marked sent, and emails the client a link (and nothing of what was said) when it sits unread', async () => {
    const id = await reply('Yes, Tuesday at 9. The inspector will call ahead.');
    const [m] = await rows<{ status: string }>(
      admin(),
      sql`select status::text from app.messages where id = ${id}`,
    );
    expect(m!.status).toBe('sent');
    const key = unreadNoticeKey(conversationId);
    expect((await jobRow(key))?.status).toBe('pending');
    await runDue(w, [key]);
    const mail = await waitForMail(email, 'Dale at ');
    expect(mail.subject).toBe(`Dale at ${business} sent you a message`);
    expect(mail.text).toMatch(/\/c\/[0-9A-Za-z]{18}/);
    expect(mail.text).not.toContain('inspector');
  });

  it('sends nothing for a reply the client read in time', async () => {
    const before = (await mailTo(email)).length;
    const id = await reply('The appraisal is booked too.');
    const read = await op('portal.messages', { recordId: deal });
    const thread = read.json() as { messages: { id: string; from: string | null }[] };
    expect(thread.messages.at(-1)).toMatchObject({ id, from: 'Dale Owner' });
    const marked = await op('portal.mark_read', { conversationId, throughMessageId: id });
    // Both replies: the one the email was about, and this one.
    expect(marked.json()).toEqual({ marked: 2 });
    await drain(w);
    await post(w, '/test/scheduled-jobs/run-due', {
      workspaceId: w.workspaceId,
      dedupeKeys: [unreadNoticeKey(conversationId)],
    });
    await drain(w);
    await new Promise((r) => setTimeout(r, 500));
    expect((await mailTo(email)).length).toBe(before);
  });
});
