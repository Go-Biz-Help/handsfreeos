/**
 * Social Outreach in the worker: a comment research summed up (decision 166). One that's stopped with enough kept, or
 * full, is summed up at once: how its comments are written is counted, the AI (the stand-in model here) gives the
 * patterns and examples, and only examples that are comments really kept stay. One whose days end with too few to
 * learn from is only stopped. The guide goes in nobody's comments until staff say so. Each network's research is
 * summed up on its own, with the AI told which network's comments they are (decision 172).
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider } from '@hfos/ai';
import {
  RESEARCH_TAGS,
  type CommentResearchOutput,
} from '@hfos/core/addons/outreach/comment-research';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { SUM_COMMENT_RESEARCH_JOB } from '../src/addons/outreach/comment-research';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

/** HandsFreeOS staff who may change what the AI is told, and the businesses' owner. */
let staff: TestUser;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-comment-research-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

/** The stand-in model, counting the research reads it was asked for. */
function counting(inner: AiProvider = scriptedAi()) {
  let asks = 0;
  const provider: AiProvider = {
    ...inner,
    stream: async (request, options) => {
      if (JSON.stringify(request).includes('Work out how these comments are written.')) asks += 1;
      return inner.stream(request, options);
    },
  };
  return { provider, asks: () => asks };
}

/** Instagram's row on the card: the research these tests start. */
const card = async (ws: string): Promise<CommentResearchOutput['networks'][number]> =>
  (
    (await runAs(staff, ws, 'outreach.comment_research.get', {})) as CommentResearchOutput
  ).networks.find((n) => n.platform === 'instagram')!;

/** The sum-up job waiting for a research: when it runs. */
const waiting = (ws: string) =>
  rows<{ soon: boolean }>(
    admin(),
    sql`select run_at <= now() + interval '1 minute' as soon from app.scheduled_jobs
        where workspace_id = ${ws} and kind = ${SUM_COMMENT_RESEARCH_JOB} and status = 'pending'`,
  );

beforeAll(async () => {
  staff = await createTestUser('outreach-comment-research-staff', { fullName: 'Marlo Quint' });
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role, display_name) values (${staff.id}, 'admin', 'Marlo')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
}, 60_000);

afterAll(closeTestDbs);

describe('a comment research summed up', () => {
  it('waits for its days to end, and is summed up at once when it’s stopped with enough kept', async () => {
    const ai = counting();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(staff, 'Outreach Comment Research Co');
    const started: CommentResearchOutput = await runAs(
      staff,
      ws,
      'outreach.comment_research.start',
      { platform: 'instagram' },
    );
    const id = started.networks.find((n) => n.platform === 'instagram')!.research!.id;
    await drain(s, ws);
    // Its end is queued for when its days are over, not now.
    expect(await waiting(ws)).toEqual([{ soon: false }]);
    expect(ai.asks()).toBe(0);

    // Two posts' comments under the first hashtag: 119 kept, and a bot's left out.
    const comments = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `that brisket looks so good ${from + i}`);
    const saved = await runAs(staff, ws, 'outreach.comment_research.save', {
      id,
      tag: RESEARCH_TAGS[0]!,
      posts: [
        { comments: comments(0, 60) },
        { comments: ['need this', 'DM me for a collab', ...comments(60, 58)] },
      ],
    });
    expect(saved).toEqual({ kept: 119, dropped: 1, total: 119, reading: true });
    await runAs(staff, ws, 'outreach.comment_research.stop', { id });
    await drain(s, ws);

    expect(ai.asks()).toBe(1);
    const done = (await card(ws)).research!;
    expect(done.state).toBe('done');
    expect(done.findings).toMatchObject({
      comments: 119,
      copied: 0,
      // The order it was given is dropped, and so is the example nobody typed.
      patterns: ['Most are a few plain words, with no full stop.'],
      kinds: [
        {
          topic: 'food',
          how: 'Short and plain, about what the post shows.',
          examples: ['need this'],
        },
      ],
    });
    expect(done.guide).toContain('From 119 real comments under Instagram posts');
    expect(done.guide).toContain('Like “need this”.');
    expect(await waiting(ws)).toEqual([]);
    // Summed up, it's in nobody's comments until staff say so.
    expect((await card(ws)).inUse?.thisOne ?? false).toBe(false);
  });

  it('is only stopped when its days end with too few comments to learn from', async () => {
    const ai = counting();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(staff, 'Outreach Comment Research Few Co');
    const started: CommentResearchOutput = await runAs(
      staff,
      ws,
      'outreach.comment_research.start',
      { platform: 'instagram' },
    );
    const id = started.networks.find((n) => n.platform === 'instagram')!.research!.id;
    await runAs(staff, ws, 'outreach.comment_research.save', {
      id,
      tag: RESEARCH_TAGS[0]!,
      posts: [{ comments: ['need this', 'so good'] }],
    });
    await drain(s, ws);
    // Its days are over.
    await rows(
      admin(),
      sql`update addon_outreach.comment_research set started_at = now() - interval '4 days'
          where id = ${id}`,
    );
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() - interval '1 second'
          where workspace_id = ${ws} and kind = ${SUM_COMMENT_RESEARCH_JOB} and status = 'pending'`,
    );
    await drain(s, ws);
    expect(ai.asks()).toBe(0);
    expect((await card(ws)).research).toMatchObject({
      id,
      state: 'stopped',
      kept: 2,
      findings: null,
      guide: null,
    });
  });
});
