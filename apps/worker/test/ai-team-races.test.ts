/**
 * Races around the AI teammate's runs (M7 step 6), on the real database with the scripted model: a person
 * replying while it works, a new message superseding a pending draft, two jobs for one conversation, and a
 * job retried after a busy provider, which resumes its run without running a tool or sending twice.
 */
import { randomUUID } from 'node:crypto';
import { AiProviderError } from '@hfos/ai';
import { messageSend } from '@hfos/core/server';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { TEAMMATE_JOBS, teammateReplyJob } from '../src/ai-team/index';
import type { JobContext, JobRow } from '../src/jobs';
import {
  aiMessages,
  conversationOf,
  decide,
  draftsOf,
  drain,
  forceDue,
  jobsOnce,
  newCustomer,
  pendingReply,
  replyNow,
  run,
  runsOf,
  scopeOf,
  teammateWorld,
  textIn,
  textsTo,
  toolCallsOf,
  useModel,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;
let t: TeammateWorld;

beforeAll(async () => {
  w = await teammateWorld('tmrace', { status: 'automatic' });
  t = await teammateWorld('tmracet');
});
afterAll(async () => {
  await w.app.close();
  await t.app.close();
  await closeTestDbs();
});

/** The reply job as the job runner calls it, for a conversation (and a run to resume). */
function jobContext(
  world: TeammateWorld,
  payload: Record<string, unknown>,
  attempt = 1,
): JobContext {
  const job = {
    id: randomUUID(),
    kind: TEAMMATE_JOBS.reply,
    dedupeKey: `test:${randomUUID()}`,
    payload,
    workspaceId: world.workspaceId,
    organizationId: world.organizationId,
    attempts: attempt - 1,
  } as unknown as JobRow;
  return { ...world.s, job, scope: scopeOf(world), attempt, now: Date.now() };
}

describe('races', () => {
  it('a person replying while it works supersedes the run, and nothing goes out', async () => {
    const c = await newCustomer(w, 'Jay');
    const m = await textIn(w, c.phone, 'Do you install smart thermostats?');
    const inner = scriptedAi();
    let first = true;
    useModel(w, {
      id: 'interrupted',
      model: inner.model,
      stream: async (request, options) => {
        if (first) {
          first = false;
          await run(w, messageSend, {
            workspaceId: w.workspaceId,
            conversationId: m.conversationId,
            channel: 'sms',
            body: 'Dale here, I will call you in five.',
          });
        }
        return inner.stream(request, options);
      },
    });
    try {
      await replyNow(w, m.conversationId);
    } finally {
      useModel(w, scriptedAi());
    }
    const [r] = await runsOf(m.conversationId);
    expect(r).toMatchObject({ status: 'superseded' });
    expect(await aiMessages(m.conversationId)).toHaveLength(0);
    expect(await conversationOf(m.conversationId)).toMatchObject({
      handled_by: 'person',
      taken_over_by: w.owner.id,
    });
  });

  it('a new message supersedes the pending draft, and the next draft answers both', async () => {
    const c = await newCustomer(t, 'Kim');
    const one = await textIn(t, c.phone, 'Do you service furnaces?');
    await replyNow(t, one.conversationId);
    const [firstDraft] = await draftsOf(one.conversationId);
    expect(firstDraft).toMatchObject({ status: 'pending' });
    const two = await textIn(t, c.phone, 'Also, are you open Saturdays?');
    const [dropped] = await draftsOf(one.conversationId);
    expect(dropped).toMatchObject({
      id: firstDraft!.id,
      status: 'cancelled',
      via: 'system',
      reason: 'The customer wrote again.',
    });
    await expect(decide(t, firstDraft!.id, 'approve')).rejects.toMatchObject({
      rule: 'draft_decided',
    });
    await replyNow(t, one.conversationId);
    const drafts = await draftsOf(one.conversationId);
    expect(drafts).toHaveLength(2);
    expect(drafts[1]).toMatchObject({ status: 'pending' });
    const runs = await runsOf(one.conversationId);
    expect(runs[1]!.message_ids).toEqual([one.messageId, two.messageId]);
  });

  it('two jobs for one conversation make one run', async () => {
    const c = await newCustomer(w, 'Lou');
    const m = await textIn(w, c.phone, 'What brands do you carry?');
    const payload = { conversationId: m.conversationId, trigger: 'message.received' };
    await Promise.all([
      teammateReplyJob(jobContext(w, payload)),
      teammateReplyJob(jobContext(w, payload)),
    ]);
    expect(await runsOf(m.conversationId)).toHaveLength(1);
    await drain(w);
    expect(await aiMessages(m.conversationId)).toHaveLength(1);
    // The debounced job finds nothing left to answer.
    await replyNow(w, m.conversationId);
    expect(await runsOf(m.conversationId)).toHaveLength(1);
    expect(await aiMessages(m.conversationId)).toHaveLength(1);
  });

  it('a job retried after a busy provider resumes its run: no tool runs twice, and one message goes out', async () => {
    const inner = scriptedAi();
    let calls = 0;
    useModel(w, {
      id: 'busy-once',
      model: inner.model,
      stream: (request, options) => {
        calls += 1;
        if (calls === 2)
          return Promise.reject(new AiProviderError('Overloaded', 'overloaded', true));
        return inner.stream(request, options);
      },
    });
    try {
      const c = await newCustomer(w, 'Max');
      const m = await textIn(w, c.phone, 'What services do you offer?');
      await forceDue(m.conversationId);
      expect((await jobsOnce(w)).retried).toBe(1);
      const [r] = await runsOf(m.conversationId);
      expect(r).toMatchObject({ status: 'running' });
      expect(await toolCallsOf(r!.id)).toEqual([
        expect.objectContaining({ tool: 'search_knowledge', status: 'done' }),
      ]);
      const waiting = await pendingReply(m.conversationId);
      expect(waiting).toMatchObject({
        attempts: 1,
        payload: expect.objectContaining({ _runId: r!.id }),
      });

      await forceDue(m.conversationId);
      expect((await jobsOnce(w)).done).toBe(1);
      await drain(w);
      const runs = await runsOf(m.conversationId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: r!.id, status: 'done', outcome: 'replied' });
      const tools = await toolCallsOf(r!.id);
      expect(tools.filter((x) => x.tool === 'search_knowledge')).toHaveLength(1);
      expect(await aiMessages(m.conversationId)).toHaveLength(1);

      // The job running once more (a duplicate delivery) finds everything answered.
      await teammateReplyJob(jobContext(w, { conversationId: m.conversationId, _runId: r!.id }, 2));
      await drain(w);
      expect(await runsOf(m.conversationId)).toHaveLength(1);
      expect(await aiMessages(m.conversationId)).toHaveLength(1);
      expect(textsTo(w, c.phone)).toHaveLength(1);
    } finally {
      useModel(w, scriptedAi());
    }
  });
});
