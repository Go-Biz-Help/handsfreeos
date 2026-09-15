/**
 * "Try again" on a draft a person rejected (M7 step 11): ai_teammate.retry asks the teammate to answer the same
 * messages again. The worker moves the conversation's answered-through mark back to before the rejected run's
 * messages and queues a reply whose context carries the person's reason and the draft they turned down. The
 * new draft still waits for an OK.
 */
import { randomUUID } from 'node:crypto';
import {
  aiTeammateDecideDraft,
  aiTeammateRetry,
  executeCommand,
  type HumanActor,
} from '@hfos/core/server';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  drain,
  draftsOf,
  newCustomer,
  pendingReply,
  replyNow,
  runsOf,
  teammateRequests,
  teammateWorld,
  textIn,
  type TeammateWorld,
} from './ai-team-world';

let t: TeammateWorld;

const owner = (w: TeammateWorld): HumanActor => ({
  type: 'human',
  userId: w.owner.id,
  email: w.owner.email,
  claims: w.owner.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

beforeAll(async () => {
  t = await teammateWorld('tmretry');
});
afterAll(async () => {
  await t.app.close();
  await closeTestDbs();
});

describe('trying again after a rejected draft', () => {
  it('answers the same messages again with the reason, and the new draft waits for an OK', async () => {
    const c = await newCustomer(t, 'Rae');
    const { conversationId } = await textIn(t, c.phone, 'Hi, do you work in Sugar Land?');
    await replyNow(t, conversationId);
    const [first] = await draftsOf(conversationId);
    expect(first).toMatchObject({ kind: 'reply', status: 'pending' });
    const reason = 'Tell them about the free estimate';
    await executeCommand(
      api(),
      aiTeammateDecideDraft,
      { workspaceId: t.workspaceId, draftId: first!.id, decision: 'reject', reason },
      owner(t),
      meta(),
    );
    await drain(t);
    // A rejection alone asks for nothing.
    expect(await pendingReply(conversationId)).toBeNull();

    await executeCommand(
      api(),
      aiTeammateRetry,
      { workspaceId: t.workspaceId, draftId: first!.id },
      owner(t),
      meta(),
    );
    await drain(t);
    expect((await pendingReply(conversationId))?.payload).toMatchObject({
      trigger: 'ai_teammate.retry_requested',
      retry: { reason, draft: first!.preview.message!.body },
    });
    const asked = teammateRequests(t).length;
    await replyNow(t, conversationId);

    const runs = await runsOf(conversationId);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      triggered_by: 'ai_teammate.retry_requested',
      message_ids: runs[0]!.message_ids,
    });
    expect((await draftsOf(conversationId)).map((d) => d.status)).toEqual(['rejected', 'pending']);
    const request = JSON.stringify(teammateRequests(t).slice(asked));
    expect(request).toContain('A person rejected your last draft');
    expect(request).toContain(reason);
  });
});
