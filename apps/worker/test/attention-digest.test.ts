/**
 * M8 step 6 on the real database: the morning summary. At 7 AM where the business is, each person gets one email
 * about what needs them — an owner sees everything, a member sees their own plus what nobody has taken — and only
 * when they have something. It goes out once a day, skips anyone who turned it off, and its 7 AM follows daylight
 * saving.
 */
import { localDateOf, leadUpdate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTENTION_JOBS, digestJobKey, nextAttentionDigestAt } from '../src/attention/index';
import {
  attentionWorld,
  filedCustomer,
  runSweep,
  typedLead,
  type AttentionWorld,
} from './attention-world';
import { admin, CHI, drain, mailTo, post, run, waitForMail } from './booking-world';

let w: AttentionWorld;

beforeAll(async () => {
  w = await attentionWorld('attndig');
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The morning summaries that reached someone. */
const summariesTo = async (email: string) =>
  (await mailTo(email)).filter((m) => m.Subject.includes('your attention today'));

/** A lead nobody has touched for eight days: it needs following up. */
async function staleLead(name: string, assigneeUserId: string | null): Promise<string> {
  const c = await filedCustomer(w, name);
  const leadId = await typedLead(w, c.id, `${name}: quote`, {
    daysAgo: 8,
    nextActionInDays: 60,
  });
  await run(w, leadUpdate, { workspaceId: w.workspaceId, leadId, assigneeUserId });
  await drain(w);
  return leadId;
}

/** Sends the business's morning summary now. */
async function sendDigest(): Promise<void> {
  const res = await post(w, '/test/attention/digest', { workspaceId: w.workspaceId });
  expect(res.statusCode, res.body).toBe(200);
  await drain(w);
}

/** The days the business's morning summary went out. */
async function sentDays(): Promise<string[]> {
  const list = await rows<{ day: string }>(
    admin(),
    sql`select payload ->> 'day' as day from app.events
        where entity_id = ${w.workspaceId} and event_type = 'workspace.attention_digest_sent'`,
  );
  return list.map((e) => e.day);
}

describe('the morning summary', () => {
  it('sends nothing on a day when nothing needs anyone', async () => {
    await sendDigest();
    expect(await sentDays()).toEqual([]);
    await pause(300);
    for (const u of [w.owner, w.member]) expect(await summariesTo(u.email)).toEqual([]);
  });

  it('gives each person their own list, once a day', async () => {
    await staleLead('Rosa', w.member.id);
    await staleLead('Sami', w.owner.id);
    const nobodys = await staleLead('Tomas', null);
    // One lead is worth real money, so "$ affected" has something to say.
    await rows(admin(), sql`update app.leads set value_cents = 1850000 where id = ${nobodys}`);
    await runSweep(w);

    await sendDigest();
    // Dale owns the business: he sees all three.
    const toDale = await waitForMail(w.owner.email, '3 things need your attention today');
    for (const name of ['Rosa', 'Sami', 'Tomas']) expect(toDale.text).toContain(`${name}: quote`);
    expect(toDale.text).toContain('$18,500 affected');
    expect(toDale.text).toContain('Gone quiet');
    expect(toDale.text).toContain(
      `Open the Action Center: http://localhost:3000/app/w/${w.workspaceId}`,
    );

    // Marco is a member: his own, plus the one nobody has taken.
    const toMarco = await waitForMail(w.member.email, '2 things need your attention today');
    expect(toMarco.text).toContain('Rosa: quote');
    expect(toMarco.text).toContain('Tomas: quote');
    expect(toMarco.text).not.toContain('Sami: quote');
    expect(await sentDays()).toEqual([localDateOf(Date.now(), CHI)]);

    // The same day again sends nothing more.
    await sendDigest();
    await pause(300);
    expect(await summariesTo(w.owner.email)).toHaveLength(1);
    expect(await summariesTo(w.member.email)).toHaveLength(1);
    expect(await sentDays()).toHaveLength(1);
  });

  // A business sends one summary a day, and app.events is append-only, so this takes a business of its own.
  it('skips someone who turned it off, and re-arms for the next 7 AM', async () => {
    const x = await attentionWorld('attndigoff');
    try {
      await rows(
        admin(),
        sql`update app.users
            set settings = settings || ${JSON.stringify({ notifications: { attentionDigest: false } })}::jsonb
            where id = ${x.member.id}`,
      );
      const c = await filedCustomer(x, 'Uma');
      const leadId = await typedLead(x, c.id, 'Uma: quote', { daysAgo: 8, nextActionInDays: 60 });
      await run(x, leadUpdate, { workspaceId: x.workspaceId, leadId, assigneeUserId: null });
      await drain(x);
      await runSweep(x);

      const res = await post(x, '/test/attention/digest', { workspaceId: x.workspaceId });
      expect(res.statusCode, res.body).toBe(200);
      await drain(x);
      // Dale gets it; Marco turned it off, so nothing reaches him.
      await waitForMail(x.owner.email, '1 thing needs your attention today');
      await pause(300);
      expect(
        (await mailTo(x.member.email)).filter((m) => m.Subject.includes('your attention today')),
      ).toEqual([]);

      const [job] = await rows<{ run_at: Date }>(
        admin(),
        sql`select run_at from app.scheduled_jobs
            where kind = ${ATTENTION_JOBS.digest} and dedupe_key = ${digestJobKey(x.workspaceId)}
              and status = 'pending'`,
      );
      expect(new Date(job!.run_at).getTime()).toBe(nextAttentionDigestAt(Date.now(), CHI));
    } finally {
      await x.app.close();
    }
  });
});

describe('the morning brief switch', () => {
  // Its own business again: a business sends one summary a day, and app.events is append-only.
  it('sends nobody one while the business has it off, and keeps the job for the next morning', async () => {
    const x = await attentionWorld('attndigbiz');
    try {
      await rows(
        admin(),
        sql`update app.workspaces
            set settings = jsonb_set(settings, '{automations}',
              ${JSON.stringify({ switches: { morningBrief: false } })}::jsonb)
            where id = ${x.workspaceId}`,
      );
      const c = await filedCustomer(x, 'Vic');
      const leadId = await typedLead(x, c.id, 'Vic: quote', { daysAgo: 8, nextActionInDays: 60 });
      await run(x, leadUpdate, { workspaceId: x.workspaceId, leadId, assigneeUserId: null });
      await drain(x);
      await runSweep(x);

      const res = await post(x, '/test/attention/digest', { workspaceId: x.workspaceId });
      expect(res.statusCode, res.body).toBe(200);
      await drain(x);
      await pause(300);
      for (const u of [x.owner, x.member])
        expect(
          (await mailTo(u.email)).filter((m) => m.Subject.includes('your attention today')),
        ).toEqual([]);
      const [job] = await rows<{ run_at: Date }>(
        admin(),
        sql`select run_at from app.scheduled_jobs
            where kind = ${ATTENTION_JOBS.digest} and dedupe_key = ${digestJobKey(x.workspaceId)}
              and status = 'pending'`,
      );
      expect(new Date(job!.run_at).getTime()).toBe(nextAttentionDigestAt(Date.now(), CHI));
    } finally {
      await x.app.close();
    }
  });
});

describe('the next 7 AM', () => {
  it('is today’s before 7, tomorrow’s from 7 on, and follows daylight saving', () => {
    const when = (iso: string, zone = CHI) =>
      new Date(nextAttentionDigestAt(Date.parse(iso), zone)).toISOString();
    expect(when('2026-09-14T11:00:00Z')).toBe('2026-09-14T12:00:00.000Z');
    expect(when('2026-09-14T12:00:00Z')).toBe('2026-09-15T12:00:00.000Z');
    // Clocks go back early on Sunday, November 1, 2026: 7 AM in Chicago is an hour later in UTC.
    expect(when('2026-10-31T13:00:00Z')).toBe('2026-11-01T13:00:00.000Z');
    expect(when('2026-09-14T11:00:00Z', 'America/Denver')).toBe('2026-09-14T13:00:00.000Z');
  });
});
