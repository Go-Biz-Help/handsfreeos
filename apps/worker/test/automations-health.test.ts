/**
 * Settings → Automations' health and quality (stage 4b), on the real database:
 * - a payment connection that needs signing in again is an urgent card at once, and its owners get a push;
 * - a channel that usually gets texts and has gone quiet gets a card;
 * - three rejections of the AI teammate's drafts for the same reason become one line to add to what it knows, and
 *   adding it puts it in the policies and clears the card;
 * - drafts nobody looked at for a week get a card;
 * - the weekly re-read of the website starts a scan of its own, and its waiting updates get a card;
 * - a question the AI couldn't answer, asked three times, gets a card until it's answered.
 */
import { randomUUID } from 'node:crypto';
import {
  aiTeammateDecideDraft,
  executeCommand,
  paymentConnectionFail,
  pushDeviceRegister,
  teammateLessonApply,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBSITE_RESCAN_JOB, websiteRescanKey } from '../src/automations/index';
import {
  admin,
  api,
  draftsOf,
  drain,
  newCustomer,
  replyNow,
  run,
  teammateWorld,
  textIn,
  type TeammateWorld,
} from './ai-team-world';
import { itemOf, runSweep, sys } from './attention-world';

const HOUR = 3_600_000;
let t: TeammateWorld;

const owner = (w: TeammateWorld): HumanActor => ({
  type: 'human',
  userId: w.owner.id,
  email: w.owner.email,
  claims: w.owner.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

beforeAll(async () => {
  t = await teammateWorld('health');
  await run(t, pushDeviceRegister, {
    platform: 'ios',
    token: `ExponentPushToken[health-${t.workerId.slice(-8)}]`,
    appVersion: '1.0.0',
    deviceName: 'Dale’s phone',
  });
});
afterAll(async () => {
  await t?.app.close();
  await closeTestDbs();
});

const noItem = async (subjectId: string, kind: string) =>
  (
    await rows(
      admin(),
      sql`select 1 from app.attention_items
          where subject_id = ${subjectId} and kind = ${kind} and state <> 'resolved'`,
    )
  ).length === 0;

describe('a connection that broke', () => {
  it('is urgent at once, and the owners get a push to reconnect it', async () => {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.payment_connections (workspace_id, provider, status, external_account_id, connected_at)
          values (${t.workspaceId}, 'stripe', 'active', ${`acct_${randomUUID().slice(0, 8)}`}, now())
          returning id`,
    );
    await sys(t, paymentConnectionFail, {
      workspaceId: t.workspaceId,
      connectionId: c!.id,
      reason: 'reauth_required',
      message: 'The token expired.',
    });
    await drain(t);
    const card = await itemOf(t, c!.id, 'connection_error');
    expect(card.state).toBe('open');
    expect(card.subjectType).toBe('payment_connection');
    expect(card.urgentFrom).not.toBeNull();
    expect(card.reasons[0]).toMatchObject({ code: 'broken', label: 'Sign-in expired' });
    const [push] = await rows<{ title: string; user_ids: string[] }>(
      admin(),
      sql`select payload ->> 'title' as title,
            array(select jsonb_array_elements_text(payload -> 'userIds')) as user_ids
          from app.scheduled_jobs
          where kind = 'push.send' and dedupe_key like ${`push:connection:${c!.id}%`}`,
    );
    expect(push?.title).toBe('Stripe stopped working');
    expect(push?.user_ids).toContain(t.owner.id);
  });
});

describe('a channel gone quiet', () => {
  it('opens when texts that came in every few hours stopped days ago', async () => {
    const c = await newCustomer(t, 'Quinn');
    const { conversationId } = await textIn(t, c.phone, 'Hello?');
    await drain(t);
    // Twelve more over the week before, three hours apart, the last four days ago.
    for (let i = 0; i < 12; i++)
      await rows(
        admin(),
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
            values (${t.workspaceId}, ${conversationId}, 'sms', 'inbound', 'received', 'Hi',
              now() - interval '4 days' - ${`${i * 3} hours`}::interval)`,
      );
    await rows(
      admin(),
      sql`update app.messages set occurred_at = now() - interval '4 days' - interval '1 minute'
          where conversation_id = ${conversationId} and body_text = 'Hello?'`,
    );
    await runSweep(t);
    const [card] = await rows<{ subject_type: string; reasons: { label: string }[] }>(
      admin(),
      sql`select subject_type, reasons from app.attention_items
          where workspace_id = ${t.workspaceId} and kind = 'channel_quiet' and state = 'open'`,
    );
    expect(card?.subject_type).toBe('channel_text');
    expect(card?.reasons[0]?.label).toBe('Texts usually every 3 h');
  });
});

describe('the AI teammate', () => {
  it('turns three rejections for the same reason into one line to add, and adding it clears the card', async () => {
    const reasons = [
      'We don’t work Sundays, offer Monday instead',
      'No Sundays please, we are closed',
      'Sundays are our day off',
    ];
    for (const [i, reason] of reasons.entries()) {
      const c = await newCustomer(t, `Sun${i}`);
      const { conversationId } = await textIn(t, c.phone, 'Can you come out Sunday?');
      await replyNow(t, conversationId);
      const [draft] = await draftsOf(conversationId);
      await executeCommand(
        api(),
        aiTeammateDecideDraft,
        { workspaceId: t.workspaceId, draftId: draft!.id, decision: 'reject', reason },
        owner(t),
        meta(),
      );
      await drain(t);
    }
    const [lesson] = await rows<{ id: string; line: string; corrections: number }>(
      admin(),
      sql`select id, line, cardinality(draft_ids) as corrections from app.teammate_lessons
          where teammate_id = ${t.teammateId}`,
    );
    // The scripted AI gives the latest reason as the line.
    expect(lesson).toMatchObject({ line: 'Sundays are our day off.', corrections: 3 });
    const card = await itemOf(t, lesson!.id, 'ai_corrections');
    expect(card.state).toBe('open');

    await executeCommand(
      api(),
      teammateLessonApply,
      { workspaceId: t.workspaceId, lessonId: lesson!.id },
      owner(t),
      meta(),
    );
    await drain(t);
    const [profile] = await rows<{ policies: string }>(
      admin(),
      sql`select profile ->> 'policies' as policies from app.knowledge_profiles
          where workspace_id = ${t.workspaceId}`,
    );
    expect(profile?.policies).toContain('Sundays are our day off.');
    expect((await itemOf(t, lesson!.id, 'ai_corrections')).state).toBe('resolved');
  });

  it('flags a week of drafts nobody looked at', async () => {
    // It has been training for a fortnight, and the last decision above is set back past the week.
    await rows(
      admin(),
      sql`update app.ai_teammates set training_started_at = now() - interval '14 days'
          where id = ${t.teammateId}`,
    );
    await rows(
      admin(),
      sql`update app.ai_teammate_drafts set decided_at = now() - interval '8 days'
          where teammate_id = ${t.teammateId} and decided_at is not null`,
    );
    await runSweep(t);
    const card = await itemOf(t, t.teammateId, 'ai_unreviewed');
    expect(card.state).toBe('open');
    expect(card.reasons[0]?.label).toMatch(/drafts · none reviewed in 7 days$/);
  });
});

describe('the knowledge base', () => {
  let sourceId: string;
  beforeAll(async () => {
    const [s] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.knowledge_sources (workspace_id, url) values (${t.workspaceId}, 'https://lonestar.example/')
          returning id`,
    );
    sourceId = s!.id;
    await rows(
      admin(),
      sql`insert into app.knowledge_scans (workspace_id, source_id, status, started_at, finished_at, created_at)
          values (${t.workspaceId}, ${sourceId}, 'done', now() - interval '8 days', now() - interval '8 days',
            now() - interval '8 days')`,
    );
  });

  it('reads the website again each week as a scan of its own, and flags the updates it proposes', async () => {
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${t.organizationId}, ${t.workspaceId}, ${WEBSITE_RESCAN_JOB},
            ${websiteRescanKey(t.workspaceId)}, now(), '{}'::jsonb)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
          do update set run_at = now()`,
    );
    await drain(t);
    const [scan] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.knowledge_scans where source_id = ${sourceId} and automatic`,
    );
    expect(scan).toBeDefined();
    // However the scan of the (made-up) website went, as it finishes: two pages changed, one update waits.
    await rows(
      admin(),
      sql`update app.knowledge_scans set status = 'done', started_at = now(), finished_at = now(),
            pages = '[{"url":"https://lonestar.example/prices","status":"changed"},{"url":"https://lonestar.example/hours","status":"changed"}]'::jsonb
          where id = ${scan!.id}`,
    );
    await rows(
      admin(),
      sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason, scan_id, source)
          values (${t.workspaceId}, 'fact', '{"title":"Hours","body":"Open 7 to 6"}'::jsonb, 'scan',
            ${scan!.id}, '{"url":"https://lonestar.example/hours"}'::jsonb)`,
    );
    await runSweep(t);
    const card = await itemOf(t, scan!.id, 'website_changed');
    expect(card.state).toBe('open');
    expect(card.reasons[0]?.label).toBe('2 pages changed · 1 update to review');
  });

  it('asks for the answer to a question the AI couldn’t answer, from its third time', async () => {
    const [gap] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason, source, group_key, similar_count)
          values (${t.workspaceId}, 'faq', '{"title":"Do you service heat pumps?","body":""}'::jsonb, 'gap',
            '{"question":"Do you service heat pumps?"}'::jsonb, 'do you service heat pumps', 3)
          returning id`,
    );
    await runSweep(t);
    const card = await itemOf(t, gap!.id, 'faq_suggestions');
    expect(card.reasons[0]?.label).toBe('“Do you service heat pumps?” · asked 3 times');
    await rows(
      admin(),
      sql`update app.knowledge_suggestions set status = 'accepted', decided_at = now() where id = ${gap!.id}`,
    );
    await runSweep(t, Date.now() + HOUR);
    expect(await noItem(gap!.id, 'faq_suggestions')).toBe(true);
  });
});
