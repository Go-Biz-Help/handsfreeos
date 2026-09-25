/**
 * First messages and follow-up nudges (M7 step 7), on the real database with the fake carrier and the scripted
 * model. A new lead gets one first message after the Respond skill's delay: a text when they agreed to texts (with
 * the STOP wording), an email when they haven't but have an address, and nothing otherwise (the run says why).
 * Booking-page leads and imports get none, and it goes at once even outside the teammate's own hours (Automations:
 * a new lead is always answered right away). Then follow-ups on the ladder when the customer goes quiet, stopping
 * when they reply.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  DEFAULT_FOLLOW_UP_LADDER,
  executeCommand,
  leadCreate,
  localDateOf,
  weekdayOf,
} from '@hfos/core/server';
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

  it('greets a new lead at once, even outside the teammate’s own working hours', async () => {
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
      expect(await teammateRunsFor(c.id)).toHaveLength(1);
      expect((await jobRow(key))?.status).toBe('done');
      expect(textsTo(w, c.phone)).toHaveLength(1);
    } finally {
      await saveTeammate(w, { hours: { mode: 'always' } });
    }
  });
});

describe('follow-up nudges', () => {
  beforeAll(async () => {
    await saveTeammate(w, { followUp: { enabled: true } });
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

  it('follows up on the ladder, counted from the message they didn’t answer, until it runs out', async () => {
    // A short ladder so the test can walk it: 4 hours, day 1, then one monthly.
    await saveTeammate(w, {
      followUp: {
        ladder: [
          { after: 4, unit: 'hours' },
          { after: 1, unit: 'days' },
        ],
        monthlyForMonths: 1,
      },
    });
    try {
      const { conversationId } = await firstMessageTo('Gil');
      const key = followUpJobKey(conversationId);
      const [first] = await aiMessages(conversationId);
      const anchor = new Date(first!.occurred_at).getTime();
      const H = 3_600_000;
      const runAt = async () => new Date((await jobRow(key))!.run_at).getTime();
      expect((await jobRow(key))?.status).toBe('pending');
      expect(await runAt()).toBe(anchor + 4 * H);
      await runNow(w, [key]);
      // The next is day 1 after the message they didn't answer, not after the follow-up.
      expect((await jobRow(key))?.status).toBe('pending');
      expect(await runAt()).toBe(anchor + 24 * H);
      await runNow(w, [key]);
      // Then monthly: 30 days after the last step.
      expect(await runAt()).toBe(anchor + (24 + 30 * 24) * H);
      await runNow(w, [key]);
      const sent = await aiMessages(conversationId);
      expect(sent).toHaveLength(4);
      expect(sent[1]!.body_text).toMatch(/checking in/i);
      expect(await nudgeRuns(conversationId)).toEqual([
        { outcome: 'replied' },
        { outcome: 'replied' },
        { outcome: 'replied' },
      ]);
      // The ladder is used up: nothing more waits.
      expect((await jobRow(key))?.status).toBe('done');
    } finally {
      await saveTeammate(w, {
        followUp: { ladder: [...DEFAULT_FOLLOW_UP_LADDER], monthlyForMonths: 6 },
      });
    }
  });

  it('stops when their lead is lost, and when they text STOP', async () => {
    const lost = await firstMessageTo('Ines');
    await rows(
      admin(),
      sql`update app.leads l set lost_reason = 'Went with someone else', updated_at = now(),
            stage_id = (select s.id from app.pipeline_stages s
              where s.pipeline_id = l.pipeline_id and s.kind = 'lost' limit 1)
          where person_id = (select person_id from app.conversations where id = ${lost.conversationId})`,
    );
    await runNow(w, [followUpJobKey(lost.conversationId)]);
    expect(await nudgeRuns(lost.conversationId)).toHaveLength(0);

    const stop = await firstMessageTo('Jon');
    await textIn(w, stop.phone, 'STOP');
    await runNow(w, [followUpJobKey(stop.conversationId)]);
    expect(await nudgeRuns(stop.conversationId)).toHaveLength(0);
  });

  it('leaves a lead who never replied alone when that row is off', async () => {
    await saveTeammate(w, { followUp: { neverReplied: false } });
    try {
      const { conversationId } = await firstMessageTo('Kai');
      expect(await jobRow(followUpJobKey(conversationId))).toBeUndefined();
    } finally {
      await saveTeammate(w, { followUp: { neverReplied: true } });
    }
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
