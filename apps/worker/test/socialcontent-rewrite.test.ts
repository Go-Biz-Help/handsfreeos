/**
 * AI Social Media Content Creator's Redo on posts waiting to go up (apps/worker/src/addons/socialcontent/content.ts,
 * `rewriteManyNow` and `runRewrite`; docs/socialcontent.md, "Picking many posts"; the owner, 15 Nov), against the
 * local database: drafts and OK'd posts are queued to be written again, one job each and a little apart, and the
 * rest are left with why; a post that went up or was hidden before its turn is left as it is. No AI is asked.
 */
import { randomUUID } from 'node:crypto';
import { REWRITE_GAP_MS } from '@hfos/core/addons/socialcontent/calendar';
import { socialcontentAddon } from '@hfos/core/addons/socialcontent/manifest';
import { socialcontentAddonServer } from '@hfos/core/addons/socialcontent/server';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import {
  addonRef,
  executeCommand,
  organizationCreate,
  type CommandDef,
  type SystemActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addonJobs } from '../src/addons/index';
import { runAddonAction } from '../src/addons/actions';
import { REWRITE_JOB, rewriteManyNow } from '../src/addons/socialcontent/content';
import { processJobs } from '../src/jobs';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let ws: string;
let orgId: string;
let s: TestServices;
const actor = (): SystemActor => ({
  type: 'system',
  workspaceId: ws,
  organizationId: orgId,
  addon: addonRef(socialcontentAddon),
});
const op = (name: string) =>
  (socialcontentAddonServer.commands ?? []).find((o) => o.name === name) as CommandDef;

/** A post as the AI wrote it, then put in the state asked for. */
async function post(state: string, hidden = false): Promise<string> {
  const { output } = await executeCommand(
    testDbs().worker.db,
    op('socialcontent.content.put'),
    {
      workspaceId: ws,
      network: 'linkedin',
      ideaId: null,
      postAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      placedBy: 'ai',
      post: {
        title: `Spring cleaning ${randomUUID().slice(0, 4)}`,
        format: 'text',
        hook: 'Your gutters are full.',
        words: 'Here is why to clear them before the rain.',
        hashtags: [],
        slides: [],
        script: null,
        picture: null,
        pictureWay: 'design',
        angle: 'tip',
        topic: null,
      },
      askedBy: null,
    },
    actor(),
    meta(),
  );
  const id = (output as { postId: string }).postId;
  await rows(
    admin(),
    sql`update addon_socialcontent.content
        set state = ${state},
            approved_at = case when ${state} in ('ready', 'posting', 'posted') then now() end,
            hidden_at = ${hidden ? new Date().toISOString() : null}::timestamptz
        where record_id = ${id}`,
  );
  return id;
}

const redo = (postIds: string[]) =>
  runAddonAction(s, testDbs().worker.db, {
    manifest: socialcontentAddon,
    action: rewriteManyNow,
    workspaceId: ws,
    userId: owner.id,
    input: { postIds },
  }) as Promise<{ asked: number; notAsked: { postId: string; why: string }[] }>;

const queued = () =>
  rows<{ post_id: string; run_at: Date; asked_by: string | null }>(
    admin(),
    sql`select payload->>'postId' as post_id, run_at, payload->>'askedBy' as asked_by
        from app.scheduled_jobs
        where workspace_id = ${ws} and kind = ${REWRITE_JOB} and status = 'pending'
        order by run_at`,
  );

beforeAll(async () => {
  s = testServices();
  owner = await createTestUser('content-rewrite-owner');
  const created = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Gutter Guys' },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    meta(),
  );
  ws = created.output.workspaceId;
  orgId = created.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'socialcontent', 'enabled', ${socialcontentAddon.version})`,
  );
  for (const k of socialcontentAddon.recordKinds ?? [])
    await rows(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
            addon_id, write_permission)
          values (${ws}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'}, ${k.icon ?? 'box'}, 900,
            'socialcontent', ${k.writePermission})`,
    );
}, 60_000);
afterAll(closeTestDbs);

describe('Redo on posts waiting to go up', () => {
  it('waits for the main offer to be live, as writing does', async () => {
    const draft = await post('draft');
    await expect(redo([draft])).rejects.toMatchObject({ rule: 'socialcontent_offer_not_live' });
    await rows(
      admin(),
      sql`insert into app.main_offers (workspace_id, live_version) values (${ws}, 1)
          on conflict (workspace_id) do update set live_version = 1`,
    );
  });

  it('queues drafts and OK’d posts to be written again, a little apart, and leaves the rest with why', async () => {
    const draft = await post('draft');
    const okd = await post('ready');
    const failed = await post('failed');
    const hidden = await post('skipped', true);
    const up = await post('posted');
    const out = await redo([draft, okd, failed, hidden, up, randomUUID()]);
    expect(out.asked).toBe(2);
    expect(out.notAsked.map((n) => n.why)).toEqual([
      W.picking.rewriteWhy.failed,
      W.picking.rewriteWhy.hidden,
      W.picking.rewriteWhy.up,
      W.picking.rewriteWhy.gone,
    ]);
    const jobs = await queued();
    expect(jobs.map((j) => j.post_id)).toEqual([draft, okd]);
    expect(jobs.every((j) => j.asked_by === owner.id)).toBe(true);
    expect(new Date(jobs[1]!.run_at).getTime() - new Date(jobs[0]!.run_at).getTime()).toBe(
      REWRITE_GAP_MS,
    );
    // Asking again doesn't queue a post twice.
    await redo([draft]);
    expect((await queued()).filter((j) => j.post_id === draft)).toHaveLength(1);
  });

  it('leaves a post that went up or was hidden before its turn as it is', async () => {
    const [first, second] = await queued();
    await rows(
      admin(),
      sql`update addon_socialcontent.content set state = 'posted', approved_at = now()
          where record_id = ${first!.post_id}`,
    );
    await rows(
      admin(),
      sql`update addon_socialcontent.content set state = 'skipped', approved_at = null, hidden_at = now()
          where record_id = ${second!.post_id}`,
    );
    const before = await rows<{ id: string; words: string }>(
      admin(),
      sql`select record_id as id, words from addon_socialcontent.content
          where record_id in (${first!.post_id}, ${second!.post_id}) order by record_id`,
    );
    const runner = `vitest-rewrite-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and kind = ${REWRITE_JOB}`,
    );
    await processJobs({
      ...s,
      jobs: { ...addonJobs },
      workerId: runner,
      batchSize: 10,
      reservedOnly: true,
    });
    expect(await queued()).toEqual([]);
    const after = await rows<{ id: string; words: string }>(
      admin(),
      sql`select record_id as id, words from addon_socialcontent.content
          where record_id in (${first!.post_id}, ${second!.post_id}) order by record_id`,
    );
    expect(after).toEqual(before);
  });
});
