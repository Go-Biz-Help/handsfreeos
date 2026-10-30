/**
 * Who to follow up with after a webinar, the worker's part (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 5), on the
 * real database with the fake carrier and the scripted model:
 * - once everyone is scored, the AI writes each one's line, and the hot ones are texted straight after;
 * - the AI teammate's text is a draft while it trains; someone the team already wrote to is left alone;
 * - with the teammate off, a card on Home asks a person, and it clears once somebody writes to them.
 */
import { randomUUID } from 'node:crypto';
import { appointmentCreate, messageSend } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIDEO_CALL_LEAD_REASONS_JOB, WEBINAR_TEXT_HOT_JOB } from '../src/video-calls/leads';
import {
  admin,
  at,
  drain,
  iso,
  newCustomer,
  run,
  runNow,
  setQuietHours,
  setStatus,
  teammateRequests,
  teammateWorld,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;

beforeAll(async () => {
  w = await teammateWorld('webinarhot', { status: 'automatic', calendar: 'Live demo' });
  await setQuietHours(w, null);
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

let slotDay = 3;
/** Someone who came to a webinar of their own and was scored, as `video_call.score_leads` leaves them. */
async function scored(first: string, label: 'hot' | 'warm' = 'hot') {
  const c = await newCustomer(w, first);
  await rows(
    admin(),
    sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${c.id}`,
  );
  const { appointmentId } = await run(w, appointmentCreate, {
    workspaceId: w.workspaceId,
    calendarId: w.calendar!.id,
    startsAt: iso(at(slotDay++, '10:00')),
    personId: c.id,
    notify: false,
  });
  await drain(w);
  const [call] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.video_calls (workspace_id, appointment_id, state, format)
        values (${w.workspaceId}, ${appointmentId}, 'ended', 'webinar') returning id`,
  );
  const parts = [
    { what: '“Do you use a CRM?”: Yes', points: 15 },
    { what: 'Pressed “Talk to someone”', points: 20 },
  ];
  const [lead] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.video_call_leads
          (workspace_id, video_call_id, person_id, points, label, stayed, seconds, parts, follow_up, scored_at)
        values (${w.workspaceId}, ${call!.id}, ${c.id}, ${label === 'hot' ? 45 : 15}, ${label}, true, 3600,
          ${JSON.stringify(parts)}::jsonb, 'text', now())
        returning id`,
  );
  return { ...c, callId: call!.id, leadId: lead!.id };
}

const leadOf = async (leadId: string) => {
  const [l] = await rows<{
    reason: string | null;
    outcome: string | null;
    outcome_reason: string | null;
  }>(
    admin(),
    sql`select reason, outcome, outcome_reason from app.video_call_leads where id = ${leadId}`,
  );
  return l;
};

/** The worker's job for a call that was just scored (`tag` tells a second run apart). */
async function afterScoring(callId: string, tag = 'first') {
  await rows(
    admin(),
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${w.organizationId}, ${w.workspaceId}, ${VIDEO_CALL_LEAD_REASONS_JOB},
          ${`${VIDEO_CALL_LEAD_REASONS_JOB}:${callId}:${tag}`}, now(), ${JSON.stringify({ callId })}::jsonb)`,
  );
  await drain(w);
}

const webinarTexts = (phone: string) =>
  textsTo(w, phone).filter((t) => t.body.includes('Thanks for joining the webinar'));

describe('after the webinar', () => {
  it('writes why each one is hot, then the AI teammate texts the hot ones from their answers', async () => {
    const ann = await scored('Ann');
    await afterScoring(ann.callId);
    expect((await leadOf(ann.leadId))!.reason).toMatch(
      /^Ready to talk: .*Pressed “Talk to someone”/,
    );
    expect(webinarTexts(ann.phone)).toHaveLength(1);
    expect(await leadOf(ann.leadId)).toMatchObject({ outcome: 'sent' });
    // The teammate read what they did, never their points.
    const asked = teammateRequests(w).find((r) => JSON.stringify(r).includes('<webinar>'));
    expect(JSON.stringify(asked)).toContain('Pressed “Talk to someone”');
    // And never twice.
    await afterScoring(ann.callId, 'again');
    expect(webinarTexts(ann.phone)).toHaveLength(1);
  });

  it('texts nobody who isn’t hot', async () => {
    const ben = await scored('Ben', 'warm');
    await afterScoring(ben.callId);
    expect((await leadOf(ben.leadId))!.reason).toMatch(/^Interested: /);
    expect(webinarTexts(ben.phone)).toHaveLength(0);
    expect((await leadOf(ben.leadId))!.outcome).toBeNull();
  });

  it('writes a draft while the teammate trains', async () => {
    await setStatus(w, 'training');
    try {
      const cal = await scored('Cal');
      await afterScoring(cal.callId);
      expect(webinarTexts(cal.phone)).toHaveLength(0);
      expect(await leadOf(cal.leadId)).toMatchObject({ outcome: 'drafted' });
      const drafts = await rows<{ status: string }>(
        admin(),
        sql`select status::text as status from app.ai_teammate_drafts where person_id = ${cal.id}`,
      );
      expect(drafts).toEqual([{ status: 'pending' }]);
    } finally {
      await setStatus(w, 'automatic');
    }
  });

  it('leaves alone someone the team already wrote to', async () => {
    const dee = await scored('Dee');
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      toPhone: dee.phone,
      channel: 'sms',
      body: 'Great to see you on the webinar, Dee!',
      clientId: randomUUID(),
    });
    await drain(w);
    await afterScoring(dee.callId);
    expect(webinarTexts(dee.phone)).toHaveLength(0);
    expect(await leadOf(dee.leadId)).toMatchObject({
      outcome: 'skipped',
      outcome_reason: 'someone already wrote to them',
    });
  });

  it('asks a person with a card when the teammate is off, and the card clears once they write', async () => {
    await setStatus(w, 'off');
    try {
      const eve = await scored('Eve');
      await afterScoring(eve.callId);
      expect(webinarTexts(eve.phone)).toHaveLength(0);
      expect(await leadOf(eve.leadId)).toMatchObject({
        outcome: 'card',
        outcome_reason: 'Your AI teammate is off',
      });
      const cardOf = async () => {
        const [item] = await rows<{ state: string; resolution: string | null; title: string }>(
          admin(),
          sql`select state::text as state, resolution, title from app.attention_items
              where kind = 'webinar_hot' and subject_id = ${eve.leadId}`,
        );
        return item;
      };
      const card = await cardOf();
      expect(card).toMatchObject({ state: 'open' });
      expect(card!.title).toMatch(/^Eve Customer · Hot after /);
      await run(w, messageSend, {
        workspaceId: w.workspaceId,
        toPhone: eve.phone,
        channel: 'sms',
        body: 'Thanks for coming to the webinar, Eve! Want to set up a call?',
        clientId: randomUUID(),
      });
      await drain(w);
      expect(await cardOf()).toMatchObject({ state: 'resolved', resolution: 'contacted' });
    } finally {
      await setStatus(w, 'automatic');
    }
  });

  it('does nothing when the text job runs again once it’s decided', async () => {
    const fay = await scored('Fay');
    await afterScoring(fay.callId);
    expect(await leadOf(fay.leadId)).toMatchObject({ outcome: 'sent' });
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, ${WEBINAR_TEXT_HOT_JOB}, ${`again:${fay.leadId}`},
            now(), ${JSON.stringify({ leadId: fay.leadId })}::jsonb)`,
    );
    await runNow(w, [`again:${fay.leadId}`]);
    expect(webinarTexts(fay.phone)).toHaveLength(1);
    expect(await leadOf(fay.leadId)).toMatchObject({ outcome: 'sent' });
  });
});
