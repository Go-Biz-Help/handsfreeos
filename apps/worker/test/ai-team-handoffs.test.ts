/**
 * What follows a hand-off to a person (M7 step 7), on the real database with the fake carrier, the scripted model
 * and Mailpit: the team's email (to the assignee, else the owners and admins) and its preference; an emergency's
 * safety text and urgent email; M3's unanswered alert after 15 minutes of open hours; the owners told once a day
 * that the teammate used its share of the AI limit; the hand-off line past the quiet-hours reply window; and a
 * draft nobody decides, which expires and hands the conversation over.
 */
import { EMERGENCY_SAFETY_TEXT, leadCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testEnv, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireDraftsJobKey, handoffLineJobKey } from '../src/ai-team/index';
import {
  admin,
  aiReplies,
  conversationOf,
  draftsOf,
  drain,
  HANDOFF_LINE,
  handoffLines,
  hh,
  hourNow,
  jobRow,
  mailTo,
  newCustomer,
  post,
  replyNow,
  saveTeammate,
  run,
  runDue,
  setQuietHours,
  teammateWorld,
  textIn,
  waitForMail,
  type TeammateWorld,
} from './ai-team-world';

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
const env = testEnv();

let w: TeammateWorld;
let marco: TestUser;

/** A person on the team who works leads. */
async function member(world: TeammateWorld, label: string): Promise<TestUser> {
  const u = await createTestUser(`${world.label}-${label}`, { fullName: 'Marco Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${world.workspaceId}, ${u.id}, 'member')`,
  );
  return u;
}

async function setAiHandoffEmails(u: TestUser, on: boolean): Promise<void> {
  await rows(
    admin(),
    sql`update app.users set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{notifications}',
          coalesce(settings -> 'notifications', '{}'::jsonb) || ${JSON.stringify({ aiHandoff: on })}::jsonb)
        where id = ${u.id}`,
  );
}

/** Nothing with this subject reached `to` (the handlers send mail as they run, before drain returns). */
async function noMail(to: string, subject: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
  expect((await mailTo(to)).filter((m) => m.Subject.startsWith(subject))).toEqual([]);
}

async function mailHeaders(to: string, subject: string): Promise<Record<string, string[]>> {
  const hit = (await mailTo(to)).find((m) => m.Subject.startsWith(subject));
  const res = await fetch(`${env.mailpitUrl}/api/v1/message/${hit!.ID}/headers`);
  return (await res.json()) as Record<string, string[]>;
}

beforeAll(async () => {
  w = await teammateWorld('tmhand', { status: 'automatic' });
  marco = await member(w, 'marco');
  // Open all week, so "15 minutes of open hours" is 15 minutes whenever the suite runs.
  await rows(
    admin(),
    sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ openHours: ALL_WEEK })}::jsonb
        where id = ${w.workspaceId}`,
  );
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

describe('the team’s email', () => {
  // A new teammate reaches the team on their phones; the email is theirs to turn on (M18).
  beforeAll(() => saveTeammate(w, { handOff: { alerts: { email: true } } }));

  it('is off for a new teammate until it is turned on (M18)', async () => {
    await saveTeammate(w, { handOff: { alerts: { email: false } } });
    try {
      const c = await newCustomer(w, 'Sal');
      const m = await textIn(w, c.phone, 'Can I talk to a real person?');
      await replyNow(w, m.conversationId);
      expect(await conversationOf(m.conversationId)).toMatchObject({ handled_by: 'person' });
      await noMail(w.owner.email, 'Sal Customer needs a person');
    } finally {
      await saveTeammate(w, { handOff: { alerts: { email: true } } });
    }
  });

  it('goes to the assignee, with the teammate’s note and the customer’s last message', async () => {
    const c = await newCustomer(w, 'Tom');
    await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      title: 'Maintenance contract',
      personId: c.id,
      assigneeUserId: marco.id,
    });
    const m = await textIn(w, c.phone, 'Can I talk to a real person about pricing?');
    await replyNow(w, m.conversationId);
    expect(await conversationOf(m.conversationId)).toMatchObject({ handled_by: 'person' });
    const mail = await waitForMail(marco.email, 'Tom Customer needs a person');
    expect(mail.text).toContain('Ava handed a text conversation to you at');
    expect(mail.text).toContain('Ava’s note');
    expect(mail.text).toContain('Can I talk to a real person about pricing?');
    expect(mail.text).toContain(`/inbox/${m.conversationId}`);
    expect(mail.text).toContain('Replying takes it over from Ava.');
    // The owner isn't on it: someone is assigned.
    await noMail(w.owner.email, 'Tom Customer needs a person');
    // Nor is it sent twice when the outbox runs again.
    const [marker] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where entity_id = ${m.conversationId} and event_type = 'ai_teammate.handoff_emailed'`,
    );
    expect(marker!.n).toBe(1);
  });

  it('goes to the owners and admins when nobody is assigned, and never to someone who turned it off', async () => {
    const c = await newCustomer(w, 'Una');
    const m = await textIn(w, c.phone, 'I want to speak to a manager');
    await replyNow(w, m.conversationId);
    const mail = await waitForMail(w.owner.email, 'Una Customer needs a person');
    expect(mail.text).toContain('Ava handed a text conversation to your team at');

    await setAiHandoffEmails(w.owner, false);
    try {
      const d = await newCustomer(w, 'Vera');
      const n = await textIn(w, d.phone, 'Can I talk to a real person?');
      await replyNow(w, n.conversationId);
      expect(await conversationOf(n.conversationId)).toMatchObject({ handled_by: 'person' });
      await noMail(w.owner.email, 'Vera Customer needs a person');
    } finally {
      await setAiHandoffEmails(w.owner, true);
    }
  });
});

describe('an emergency', () => {
  it('sends the safety text at once, and an urgent email to everyone in charge, whatever their settings', async () => {
    await setAiHandoffEmails(w.owner, false);
    try {
      const c = await newCustomer(w, 'Kendra');
      await run(w, leadCreate, {
        workspaceId: w.workspaceId,
        title: 'Furnace',
        personId: c.id,
        assigneeUserId: marco.id,
      });
      const m = await textIn(w, c.phone, "There's a rotten egg smell by the furnace closet");
      await replyNow(w, m.conversationId);
      const [line] = await handoffLines(m.conversationId);
      expect(line!.body_text).toBe(EMERGENCY_SAFETY_TEXT.gas);
      expect(await conversationOf(m.conversationId)).toMatchObject({ handoff_reason: 'emergency' });
      for (const to of [marco.email, w.owner.email]) {
        const mail = await waitForMail(to, 'Urgent: Kendra Customer may smell gas');
        expect(mail.text).toContain('about a possible gas smell');
        expect(mail.text).toContain(EMERGENCY_SAFETY_TEXT.gas);
        expect(mail.text).toContain('this email can’t be turned off');
      }
      const headers = await mailHeaders(marco.email, 'Urgent: Kendra Customer');
      expect(headers['Importance']?.[0]).toMatch(/high/i);
    } finally {
      await setAiHandoffEmails(w.owner, true);
    }
  });
});

describe('if nobody answers', () => {
  it('sets off the unanswered alert after 15 minutes of open hours, once per hand-off', async () => {
    const c = await newCustomer(w, 'Lena');
    const m = await textIn(w, c.phone, 'Could somebody call me back?');
    await replyNow(w, m.conversationId);
    const conv = await conversationOf(m.conversationId);
    expect(conv.needs_person_since).not.toBeNull();
    const key = `unanswered:${m.conversationId}`;
    const job = await jobRow(key);
    expect(job?.status).toBe('pending');
    const due = new Date(job!.run_at).getTime();
    expect(
      Math.abs(due - (new Date(conv.needs_person_since!).getTime() + 15 * 60_000)),
    ).toBeLessThan(2_000);
    // Sixteen minutes on, nobody has written back.
    await rows(
      admin(),
      sql`update app.conversations set needs_person_since = needs_person_since - interval '16 minutes'
          where id = ${m.conversationId}`,
    );
    await runDue(w, [key]);
    await waitForMail(w.owner.email, 'Lena Customer is waiting for a reply');
    const alerts = () =>
      rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events
            where entity_id = ${m.conversationId} and event_type = 'conversation.unanswered_alerted'`,
      );
    expect((await alerts())[0]!.n).toBe(1);
    // Asked again for the same hand-off, it stays quiet.
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, 'conversation.unanswered_check', ${key}, now(),
            ${JSON.stringify({ conversationId: m.conversationId })}::jsonb)`,
    );
    await drain(w);
    expect((await alerts())[0]!.n).toBe(1);
  });
});

describe('the teammate’s share of the AI limit', () => {
  let b: TeammateWorld;
  beforeAll(async () => {
    b = await teammateWorld('tmlimit', { status: 'automatic' });
  });
  afterAll(async () => {
    await b.app.close();
  });

  it('tells the owners once a day, and each customer hears the hand-off line once', async () => {
    const used = await post(b, '/test/ai-team/use-budget', { workspaceId: b.workspaceId });
    expect(used.statusCode, used.body).toBe(200);
    expect((used.json() as { tokens: number }).tokens).toBeGreaterThan(6000);
    const first = await newCustomer(b, 'Ivy');
    const second = await newCustomer(b, 'Jon');
    const one = await textIn(b, first.phone, 'What are your hours?');
    const two = await textIn(b, second.phone, 'Do you do repairs?');
    await replyNow(b, one.conversationId);
    await replyNow(b, two.conversationId);
    for (const id of [one.conversationId, two.conversationId]) {
      expect(await conversationOf(id)).toMatchObject({ handoff_reason: 'budget' });
      expect(await aiReplies(id)).toHaveLength(0);
      const lines = await handoffLines(id);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.body_text).toMatch(HANDOFF_LINE);
    }
    await waitForMail(b.owner.email, 'Ava reached its share of today’s AI limit');
    await new Promise((r) => setTimeout(r, 400));
    expect(
      (await mailTo(b.owner.email)).filter((m) => m.Subject.startsWith('Ava reached its share')),
    ).toHaveLength(1);
    const [notices] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${b.workspaceId} and event_type = 'ai_teammate.budget_reached'`,
    );
    expect(notices!.n).toBe(1);
  });
});

describe('the hand-off line in quiet hours', () => {
  it('past the 15-minute reply window: by email when they have an address, else once quiet hours end', async () => {
    await setQuietHours(w, { start: hh(hourNow() - 1), end: hh(hourNow() + 2) });
    try {
      const c = await newCustomer(w, 'Otto');
      const m = await textIn(w, c.phone, 'I want to talk to a real person', {
        secondsAgo: 20 * 60,
      });
      await replyNow(w, m.conversationId);
      expect(await conversationOf(m.conversationId)).toMatchObject({ handled_by: 'person' });
      expect(await handoffLines(m.conversationId)).toHaveLength(0);
      const [emailed] = await rows<{ body_text: string; subject: string }>(
        admin(),
        sql`select m.body_text, m.subject from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.person_id = ${c.id} and c.channel = 'email' and m.direction = 'outbound'`,
      );
      expect(emailed!.body_text).toMatch(HANDOFF_LINE);

      const d = await newCustomer(w, 'Pia', { email: null });
      const n = await textIn(w, d.phone, 'I want to talk to a real person', {
        secondsAgo: 20 * 60,
      });
      await replyNow(w, n.conversationId);
      expect(await handoffLines(n.conversationId)).toHaveLength(0);
      const later = await jobRow(handoffLineJobKey(n.conversationId));
      expect(later?.status).toBe('pending');
      expect(new Date(later!.run_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    } finally {
      await setQuietHours(w, null);
    }
  });
});

describe('a draft nobody decides', () => {
  let t: TeammateWorld;
  beforeAll(async () => {
    t = await teammateWorld('tmexpire');
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('expires, and the conversation goes to a person with the hand-off line', async () => {
    const c = await newCustomer(t, 'Rex');
    const m = await textIn(t, c.phone, 'What areas do you serve?');
    await replyNow(t, m.conversationId);
    const [draft] = await draftsOf(m.conversationId);
    expect(draft).toMatchObject({ status: 'pending' });
    // The business's sweep is booked for when it expires (two hours by default).
    const sweep = await jobRow(expireDraftsJobKey(t.workspaceId));
    expect(sweep?.status).toBe('pending');
    expect(new Date(sweep!.run_at).getTime()).toBeGreaterThan(Date.now() + 110 * 60_000);

    const res = await post(t, '/test/ai-team/expire-draft', {
      workspaceId: t.workspaceId,
      draftId: draft!.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ due: 1, expired: 1 });
    await drain(t);
    const [after] = await draftsOf(m.conversationId);
    expect(after).toMatchObject({ status: 'expired', via: 'system' });
    const conv = await conversationOf(m.conversationId);
    expect(conv).toMatchObject({ handled_by: 'person', handoff_reason: 'draft_expired' });
    expect(conv.handoff_note).toMatch(/Nobody approved its reply in 2 hours/);
    const [line] = await handoffLines(m.conversationId);
    expect(line!.body_text).toMatch(HANDOFF_LINE);
    expect(await aiReplies(m.conversationId)).toHaveLength(0);
  });
});
