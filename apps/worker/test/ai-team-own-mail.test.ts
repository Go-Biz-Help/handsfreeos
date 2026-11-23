/**
 * "Let Ava read this mail" (owner, 2026-11-22), in the worker against the stand-in model: the AI teammate leaves a
 * person's own mail alone until they turn the switch on for their address; then new mail gets a draft answer kept
 * on their thread, and nothing else happens. No run, no team draft, nothing sent, no customer, and the history
 * never says what was written.
 */
import { randomUUID } from 'node:crypto';
import {
  aiTeammateSetStatus,
  emailAddressCreate,
  emailAddressSetAiReads,
  emailReceive,
  executeCommand,
  messageSend,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownMailDraftJobKey, TEAMMATE_JOBS } from '../src/ai-team/index';
import { OWN_MAIL_SYSTEM } from '../src/ai-team/own-mail';
import { systemActor } from '../src/services';
import {
  admin,
  drain,
  run,
  runNow,
  scopeOf,
  teammateWorld,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;
let own: string;
let domain: string;

const token = () => randomUUID().slice(0, 8);
/** Mail to the owner's own address, filed as Postmark's webhook files it; then the worker's events run. */
async function mailIn(from: string, subject: string, body: string, name?: string) {
  const { output } = await executeCommand(
    testDbs().worker.db,
    emailReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'postmark',
      providerMessageId: `pm-${randomUUID()}`,
      messageIdHeader: `<${randomUUID()}@mail.example.com>`,
      from: { address: from, ...(name ? { name } : {}) },
      to: [{ address: `dale@${domain}` }],
      subject,
      bodyText: body,
      emailAddressId: own,
    },
    systemActor(scopeOf(w)),
    { correlationId: randomUUID(), channel: 'worker' },
  );
  await drain(w);
  return { conversationId: output.conversationId!, messageId: output.messageId! };
}
const turn = (on: boolean) =>
  run(w, emailAddressSetAiReads, { workspaceId: w.workspaceId, emailAddressId: own, aiReads: on });
const queued = async (conversationId: string) =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs
          where kind = ${TEAMMATE_JOBS.ownMailDraft} and dedupe_key = ${ownMailDraftJobKey(conversationId)}`,
    )
  )[0]!.n;
const draftOf = async (conversationId: string) =>
  (
    await rows<{ d: { body: string; forMessageId: string } | null }>(
      admin(),
      sql`select ai_draft as d from app.conversations where id = ${conversationId}`,
    )
  )[0]!.d;
/** The draft's writer's requests so far. */
const asked = () => w.requests.filter((r) => r.system === OWN_MAIL_SYSTEM);
/** The draft runs now instead of after its wait. */
const draftNow = (conversationId: string) => runNow(w, [ownMailDraftJobKey(conversationId)]);

beforeAll(async () => {
  w = await teammateWorld('own-mail');
  domain = `${token()}.example.com`;
  const [d] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.email_domains (workspace_id, domain, status, receiving, ownership_proved_at)
        values (${w.workspaceId}, ${domain}, 'verified', 'on', now()) returning id`,
  );
  own = (
    await run(w, emailAddressCreate, {
      workspaceId: w.workspaceId,
      emailDomainId: d!.id,
      localPart: 'dale',
      displayName: 'Dale',
      ownerUserId: w.owner.id,
    })
  ).emailAddressId;
}, 120_000);
afterAll(closeTestDbs);

describe('someone’s own mail and the AI teammate', () => {
  it('is left alone until its person turns the switch on', async () => {
    const got = await mailIn(`sam-${token()}@example.com`, 'Patio', 'Can you do Friday?');
    expect(await queued(got.conversationId)).toBe(0);
    expect(await draftOf(got.conversationId)).toBeNull();
    expect(asked()).toHaveLength(0);
  });

  it('gets a draft only they see, and nothing else happens', async () => {
    await turn(true);
    const from = `kim-${token()}@example.com`;
    const got = await mailIn(
      from,
      'A quote',
      'Could you send me a quote for the patio?',
      'Kim Lee',
    );
    expect(await queued(got.conversationId)).toBe(1);
    await draftNow(got.conversationId);

    const draft = await draftOf(got.conversationId);
    expect(draft?.forMessageId).toBe(got.messageId);
    expect(draft?.body).toContain('Hi Kim,');
    expect(draft?.body).toContain('Dale');
    // The writer read the mail and who it is for.
    const [request] = asked();
    const said = JSON.stringify(request!.messages);
    expect(said).toContain('Could you send me a quote for the patio?');
    expect(said).toContain(`dale@${domain}`);

    // Nothing was sent, and nothing about it is where the team reads: no run, no draft for approval, no customer.
    const [seen] = await rows<{
      runs: number;
      drafts: number;
      sent: number;
      person_id: string | null;
      handled_by: string;
    }>(
      admin(),
      sql`select
            (select count(*) from app.ai_teammate_runs r where r.conversation_id = c.id)::int as runs,
            (select count(*) from app.ai_teammate_drafts d where d.conversation_id = c.id)::int as drafts,
            (select count(*) from app.messages m where m.conversation_id = c.id and m.direction = 'outbound')::int as sent,
            c.person_id, c.handled_by::text as handled_by
          from app.conversations c where c.id = ${got.conversationId}`,
    );
    expect(seen).toEqual({ runs: 0, drafts: 0, sent: 0, person_id: null, handled_by: 'none' });
    // The history says a draft was made on a private thread, never its words or the sender.
    const events = await rows<{ event_type: string; payload: unknown; after: unknown }>(
      admin(),
      sql`select e.event_type, e.payload, a.after from app.events e
          left join app.audit_logs a on a.event_id = e.id
          where e.workspace_id = ${w.workspaceId} and e.entity_id = ${got.conversationId}`,
    );
    expect(events.map((e) => e.event_type)).toContain('conversation.ai_drafted');
    const told = JSON.stringify(events);
    expect(told).not.toContain('Thanks for your email');
    expect(told).not.toContain(from);
    // The tokens count toward the business's AI limit, as the teammate's.
    const [usage] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage
          where workspace_id = ${w.workspaceId} and source = 'teammate' and teammate_id = ${w.teammateId}
            and teammate_run_id is null`,
    );
    expect(usage!.n).toBeGreaterThan(0);
  });

  it('drafts nothing for a newsletter, a machine’s mail, or mail they already answered', async () => {
    const before = asked().length;
    const news = await mailIn(
      `news-${token()}@example.com`,
      'Our October newsletter',
      'Big savings this month. Click unsubscribe to stop these.',
    );
    await draftNow(news.conversationId);
    expect(await draftOf(news.conversationId)).toBeNull();

    const away = await mailIn(
      `lee-${token()}@example.com`,
      'Out of office',
      'I am out of the office until Monday.',
    );
    if (await queued(away.conversationId)) await draftNow(away.conversationId);
    expect(await draftOf(away.conversationId)).toBeNull();
    // The machine's mail never reached the model: only the newsletter was read.
    expect(asked().length).toBe(before + 1);

    const answered = await mailIn(`pat-${token()}@example.com`, 'Friday', 'Are we on for Friday?');
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      channel: 'email',
      conversationId: answered.conversationId,
      emailAddressId: own,
      body: 'Yes, see you at 7. Dale',
    });
    await draftNow(answered.conversationId);
    expect(await draftOf(answered.conversationId)).toBeNull();
    expect(asked().length).toBe(before + 1);
  });

  it('stops with the switch, and with the teammate', async () => {
    await turn(false);
    const off = await mailIn(`rae-${token()}@example.com`, 'Hello', 'Do you have time this week?');
    expect(await queued(off.conversationId)).toBe(0);

    await turn(true);
    await run(w, aiTeammateSetStatus, {
      workspaceId: w.workspaceId,
      teammateId: w.teammateId,
      status: 'off',
    });
    const resting = await mailIn(`joe-${token()}@example.com`, 'Hello', 'Do you have time?');
    expect(await queued(resting.conversationId)).toBe(0);
    expect(await draftOf(resting.conversationId)).toBeNull();
  });
});
