/**
 * M8 step 6 on the real database: the urgent email. A hot lead left waiting, and a customer past the reply
 * threshold, bring one email — to the assignee, or to the owners and admins — and only one, however many jobs and
 * items point at the same wait. Someone who turned "Urgent items" off gets none, a lead's email waits for the
 * business to open, and data from before the Action Center never sets one off.
 */
import { randomUUID } from 'node:crypto';
import {
  ALWAYS_OPEN_HOURS,
  executeCommand,
  leadUpdate,
  messageReceive,
  zonedParts,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemActor } from '../src/services';
import {
  attentionWorld,
  filedCustomer,
  inboundLead,
  itemOf,
  runSweep,
  setOpenHours,
  setReplyThreshold,
  type AttentionWorld,
} from './attention-world';
import { admin, at, CHI, drain, jobRow, mailTo, post, run, waitForMail } from './booking-world';

let w: AttentionWorld;

beforeAll(async () => {
  w = await attentionWorld('attnalrt');
  // A customer's message counts as waiting at once; the hot lead's own 10 minutes decide when it's urgent.
  await setReplyThreshold(w, 10);
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A customer's text to the business number, as the carrier's webhook files it. */
async function textIn(from: string, body: string): Promise<void> {
  await executeCommand(
    testDbs().worker.db,
    messageReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'fake',
      providerMessageId: `SM${randomUUID()}`,
      from,
      to: w.number!,
      body,
      reminderAfterMs: 86_400_000,
    },
    systemActor(scope()),
    { correlationId: randomUUID(), channel: 'worker' },
  );
  await drain(w);
}

/**
 * A lead whose customer has texted ready-to-book words and has been waiting `minutes`: a hot lead, urgent once
 * its 10 minutes are up.
 */
async function hotLead(name: string, minutes = 11): Promise<{ phone: string; leadId: string }> {
  const c = await filedCustomer(w, name);
  const leadId = await inboundLead(w, c.id, `${name}: no cooling`);
  await drain(w);
  await textIn(c.phone, 'Can you come out today? I want to get this booked ASAP.');
  // The wait began `minutes` ago (no event: only the clock moves).
  await rows(
    admin(),
    sql`update app.conversations
        set awaiting_reply_since = awaiting_reply_since - ${`${minutes} minutes`}::interval
        where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
  );
  return { phone: c.phone, leadId };
}

/** The urgent emails that reached someone. */
const urgentTo = async (email: string) =>
  (await mailTo(email)).filter(
    (m) => m.Subject.startsWith('Hot lead: ') || m.Subject.endsWith('is waiting for a reply'),
  );

/** Everything the Action Center has waiting for the business, run now. */
async function runJobs(): Promise<{ moved: number }> {
  const res = await post(w, '/test/attention/run-jobs', { workspaceId: w.workspaceId });
  expect(res.statusCode, res.body).toBe(200);
  await drain(w);
  return res.json() as { moved: number };
}

describe('the urgent email', () => {
  it('goes to the owners once a hot lead has waited, and never twice for the same wait', async () => {
    const { leadId } = await hotLead('Maria');
    await runSweep(w);
    await runJobs();

    const mail = await waitForMail(w.owner.email, 'Hot lead: Maria Test is waiting');
    expect(mail.text).toContain('Maria Test has been waiting');
    expect(mail.text).toContain('and looks ready to go');
    expect(mail.text).toContain('ready to book');
    const item = await itemOf(w, leadId, 'hot_lead');
    expect(item.alertFingerprint).toBe(item.fingerprint);
    expect(item.alertedAt).not.toBeNull();

    // The unanswered check and another sweep both land on the same wait: still one email.
    await runSweep(w);
    await runJobs();
    await pause(300);
    expect(await urgentTo(w.owner.email)).toHaveLength(1);
    // One conversation.unanswered_alerted for the wait, whichever sender got there first.
    const [alerts] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${w.workspaceId} and event_type = 'conversation.unanswered_alerted'`,
    );
    expect(alerts!.n).toBe(1);
  });

  it('goes to the assignee alone, and not to someone who turned it off', async () => {
    await rows(
      admin(),
      sql`update app.users
          set settings = settings || ${JSON.stringify({ notifications: { unansweredEmail: false } })}::jsonb
          where id = ${w.owner.id}`,
    );
    try {
      const { leadId } = await hotLead('Nadia');
      // Marco owns this one, so only he hears about it.
      await run(w, leadUpdate, {
        workspaceId: w.workspaceId,
        leadId,
        assigneeUserId: w.member.id,
      });
      await drain(w);
      await runSweep(w);
      await runJobs();
      const mail = await waitForMail(w.member.email, 'Hot lead: Nadia Test is waiting');
      expect(mail.text).toContain('the lead is assigned to you');
      expect(await urgentTo(w.owner.email)).toHaveLength(1); // still only Maria's

      // With the owner's switch off and nobody assigned, an unassigned one emails nobody.
      const other = await hotLead('Opal');
      await run(w, leadUpdate, {
        workspaceId: w.workspaceId,
        leadId: other.leadId,
        assigneeUserId: null,
      });
      await drain(w);
      await runSweep(w);
      await runJobs();
      await pause(300);
      expect(await urgentTo(w.owner.email)).toHaveLength(1);
      const item = await itemOf(w, other.leadId, 'hot_lead');
      // Nobody could be told, so nothing is marked as alerted: it tries again when someone can be.
      expect(item.alertFingerprint).toBeNull();
    } finally {
      await rows(
        admin(),
        sql`update app.users
            set settings = settings || ${JSON.stringify({ notifications: { unansweredEmail: true } })}::jsonb
            where id = ${w.owner.id}`,
      );
    }
  });

  it('waits for the business to open before telling anyone about a lead', async () => {
    // Open tomorrow only, so the business is shut whatever time this runs (the weekday where the business is).
    const tomorrow = zonedParts(at(1, '12:00'), CHI).weekday;
    await setOpenHours(w, [{ day: tomorrow, start: '09:00', end: '17:00' }]);
    try {
      const { leadId } = await hotLead('Pilar');
      await runSweep(w);
      await runJobs();
      await pause(300);
      expect(await urgentTo(w.owner.email)).toHaveLength(1); // Maria's, from before
      const item = await itemOf(w, leadId, 'hot_lead');
      expect(item.alertFingerprint).toBeNull();
      const job = await jobRow(`attention-alert:${item.id}`);
      expect(job?.status).toBe('pending');
      expect(new Date(job!.run_at).getTime()).toBe(at(1, '09:00'));

      // Once it's open, it goes out.
      await setOpenHours(w, ALWAYS_OPEN_HOURS);
      await runJobs();
      await waitForMail(w.owner.email, 'Hot lead: Pilar Test is waiting');
    } finally {
      await setOpenHours(w, ALWAYS_OPEN_HOURS);
    }
  });

  it('says nothing about clocks from before the Action Center', async () => {
    const x = await attentionWorld('attnalrtold');
    try {
      await setReplyThreshold(x, 10);
      const amy = await filedCustomer(x, 'Amy');
      const leadId = await inboundLead(x, amy.id, 'Old furnace', 3 * 24 * 60);
      // Its events were handled before the Action Center existed.
      await rows(
        admin(),
        sql`update app.outbox set status = 'done'
            where workspace_id = ${x.workspaceId} and status = 'pending'`,
      );
      await runSweep(x);
      const item = await itemOf(x, leadId, 'unanswered_lead');
      // The first-sweep guard marked it as already alerted, so no job was ever queued.
      expect(item.alertFingerprint).toBe(item.fingerprint);
      expect(await jobRow(`attention-alert:${item.id}`)).toBeUndefined();
      const res = await post(x, '/test/attention/run-jobs', { workspaceId: x.workspaceId });
      expect(res.statusCode).toBe(200);
      await drain(x);
      await pause(300);
      expect(await urgentTo(x.owner.email)).toEqual([]);
    } finally {
      await x.app.close();
    }
  });
});

describe('a customer waiting for a reply', () => {
  it('keeps the wording the inbox alert has always had', async () => {
    const c = await filedCustomer(w, 'Quinn');
    await textIn(c.phone, 'Are you open on Saturday?');
    await rows(
      admin(),
      sql`update app.conversations set awaiting_reply_since = awaiting_reply_since - interval '11 minutes'
          where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
    );
    await runSweep(w);
    await runJobs();
    const mail = await waitForMail(w.owner.email, 'Quinn Test is waiting for a reply');
    expect(mail.text).toContain('Quinn Test texted');
    expect(mail.text).toContain('nobody has replied yet');
    expect(mail.text).toContain('“Are you open on Saturday?”');
  });
});
