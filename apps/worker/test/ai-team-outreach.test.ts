/**
 * First messages and follow-up nudges (M7 step 7), on the real database with the fake carrier and the scripted
 * model. A new lead gets one first message after the Respond skill's delay: a text when they agreed to texts (with
 * the STOP wording), an email when they haven't but have an address, and nothing otherwise (the run says why).
 * Booking-page leads and imports get none, and the teammate's own hours hold it back. Then nudges when the
 * customer goes quiet, up to the cap, stopping when they reply.
 */
import { randomUUID } from 'node:crypto';
import { addDays, executeCommand, leadCreate, localDateOf, weekdayOf } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followUpJobKey, outreachJobKey } from '../src/ai-team/index';
import { systemActor } from '../src/services';
import {
  admin,
  aiMessages,
  CHI,
  conversationOf,
  drain,
  jobRow,
  newCustomer,
  run,
  runNow,
  saveTeammate,
  scopeOf,
  teammateWorld,
  textIn,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;

beforeAll(async () => {
  w = await teammateWorld('tmfirst', { status: 'automatic' });
  await saveTeammate(w, { channels: { email: true } });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

async function agreesToTexts(personId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${personId}`,
  );
}

async function newLead(personId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { leadId } = await run(w, leadCreate, {
    workspaceId: w.workspaceId,
    title: 'AC install',
    personId,
    ...extra,
  });
  await drain(w);
  return leadId;
}

function teammateRunsFor(personId: string) {
  return rows<{
    id: string;
    status: string;
    outcome: string | null;
    triggered_by: string;
    conversation_id: string | null;
    summary: string | null;
  }>(
    admin(),
    sql`select id, status, outcome, triggered_by, conversation_id, summary from app.ai_teammate_runs
        where person_id = ${personId} and not is_test order by started_at, id`,
  );
}

describe('first messages to new leads', () => {
  it('texts a lead who agreed to texts, after the delay, with the STOP wording, and only once', async () => {
    const c = await newCustomer(w, 'Ada');
    await agreesToTexts(c.id);
    const leadId = await newLead(c.id);
    const key = outreachJobKey(leadId);
    const job = await jobRow(key);
    expect(job?.status).toBe('pending');
    // The Respond skill's delay: a minute unless the business says otherwise.
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    await runNow(w, [key]);

    const [r] = await teammateRunsFor(c.id);
    expect(r).toMatchObject({ status: 'done', outcome: 'replied', triggered_by: 'lead.created' });
    // It had no conversation to start with: its text started one, which it now handles.
    expect(await conversationOf(r!.conversation_id!)).toMatchObject({
      handled_by: 'ai',
      ai_teammate_id: w.teammateId,
    });
    const [sent] = await aiMessages(r!.conversation_id!);
    expect(sent!.channel).toBe('sms');
    expect(sent!.body_text).toContain('AI assistant');
    expect(sent!.body_text).toMatch(/Reply STOP to opt out\.$/);
    expect(textsTo(w, c.phone)).toHaveLength(1);

    // Another lead for them: someone (the teammate) is talking to them already.
    const again = await newLead(c.id, { title: 'Duct cleaning' });
    expect(await jobRow(outreachJobKey(again))).toBeUndefined();
    expect(await teammateRunsFor(c.id)).toHaveLength(1);
  });

  it('emails a lead who hasn’t agreed to texts but has an address', async () => {
    const c = await newCustomer(w, 'Ben');
    const leadId = await newLead(c.id);
    await runNow(w, [outreachJobKey(leadId)]);
    const [r] = await teammateRunsFor(c.id);
    expect(r).toMatchObject({ outcome: 'replied' });
    const [sent] = await aiMessages(r!.conversation_id!);
    expect(sent!.channel).toBe('email');
    expect(sent!.body_text).toContain('AI assistant');
    expect(textsTo(w, c.phone)).toHaveLength(0);
  });

  it('writes nothing to a lead it can’t reach, and says why', async () => {
    const c = await newCustomer(w, 'Cal', { email: null });
    const leadId = await newLead(c.id);
    await runNow(w, [outreachJobKey(leadId)]);
    const [r] = await teammateRunsFor(c.id);
    expect(r).toMatchObject({ status: 'done', outcome: 'no_reply', conversation_id: null });
    expect(r!.summary).toMatch(/haven’t agreed to texts.*no email address/);
    expect(textsTo(w, c.phone)).toHaveLength(0);
  });

  it('leaves booking-page leads and imports alone', async () => {
    const c = await newCustomer(w, 'Dee');
    await agreesToTexts(c.id);
    const booked = await newLead(c.id, { source: 'Booking page' });
    const d = await newCustomer(w, 'Eli');
    await agreesToTexts(d.id);
    // An import works for the person importing (the system, on their behalf).
    const { output } = await executeCommand(
      testDbs().worker.db,
      leadCreate,
      { workspaceId: w.workspaceId, title: 'Imported lead', personId: d.id },
      systemActor(scopeOf(w), w.owner.id),
      { correlationId: randomUUID(), channel: 'worker' },
    );
    await drain(w);
    expect(await jobRow(outreachJobKey(booked))).toBeUndefined();
    expect(await jobRow(outreachJobKey(output.leadId))).toBeUndefined();
  });

  it('waits for the teammate’s own working hours', async () => {
    const day = weekdayOf(addDays(localDateOf(Date.now(), CHI), 2));
    await saveTeammate(w, {
      hours: { mode: 'custom', custom: [{ day, start: '09:00', end: '10:00' }] },
    });
    try {
      const c = await newCustomer(w, 'Flo');
      await agreesToTexts(c.id);
      const leadId = await newLead(c.id);
      const key = outreachJobKey(leadId);
      await runNow(w, [key]);
      expect(await teammateRunsFor(c.id)).toHaveLength(0);
      const later = await jobRow(key);
      expect(later?.status).toBe('pending');
      expect(new Date(later!.run_at).getTime()).toBeGreaterThan(Date.now() + 24 * 3_600_000);
    } finally {
      await saveTeammate(w, { hours: { mode: 'always' } });
    }
  });
});

describe('follow-up nudges', () => {
  beforeAll(async () => {
    await saveTeammate(w, { followUp: { enabled: true, maxNudges: 2 } });
  });
  afterAll(async () => {
    await saveTeammate(w, { followUp: { enabled: false } });
  });

  const nudgeRuns = (conversationId: string) =>
    rows<{ outcome: string | null }>(
      admin(),
      sql`select outcome from app.ai_teammate_runs
          where conversation_id = ${conversationId} and triggered_by = 'ai_teammate.follow_up'`,
    );

  async function firstMessageTo(first: string): Promise<{ phone: string; conversationId: string }> {
    const c = await newCustomer(w, first);
    await agreesToTexts(c.id);
    const leadId = await newLead(c.id);
    await runNow(w, [outreachJobKey(leadId)]);
    const [r] = await teammateRunsFor(c.id);
    return { phone: c.phone, conversationId: r!.conversation_id! };
  }

  it('nudges a lead who went quiet after it asked something, up to the cap', async () => {
    const { conversationId } = await firstMessageTo('Gil');
    const key = followUpJobKey(conversationId);
    const armed = await jobRow(key);
    expect(armed?.status).toBe('pending');
    // The first nudge waits a few hours for them.
    expect(new Date(armed!.run_at).getTime()).toBeGreaterThan(Date.now() + 3 * 3_600_000);
    await runNow(w, [key]);
    // The next waits a day.
    const next = await jobRow(key);
    expect(next?.status).toBe('pending');
    expect(new Date(next!.run_at).getTime()).toBeGreaterThan(Date.now() + 20 * 3_600_000);
    await runNow(w, [key]);
    const sent = await aiMessages(conversationId);
    expect(sent).toHaveLength(3);
    expect(sent[1]!.body_text).toMatch(/checking in/i);
    expect(await nudgeRuns(conversationId)).toEqual([
      { outcome: 'replied' },
      { outcome: 'replied' },
    ]);
    // Two nudges is the cap: nothing more waits.
    expect((await jobRow(key))?.status).toBe('done');
  });

  it('stops when they reply', async () => {
    const { phone, conversationId } = await firstMessageTo('Hana');
    const key = followUpJobKey(conversationId);
    await textIn(w, phone, 'Thanks, we sorted it out ourselves');
    await runNow(w, [key]);
    expect(await nudgeRuns(conversationId)).toHaveLength(0);
    expect((await jobRow(key))?.status).toBe('done');
  });
});
