/**
 * Teammate funnels in the worker (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md stage 2), on the real database
 * with the fake carrier and the scripted model, Christina's recruiting funnel as the scenario: a new lead gets in by
 * the funnel's rule and gets its first message (not the teammate's greeting); booking a session moves them on, and
 * the reminders go around it, the one before with their own Join link; joining, being there and saying "I'm in"
 * move them on; the Interested stage hands them to the team, which pauses the funnel while a booking still moves them
 * to the won stage. Then: a funnel that asks first leaves drafts, someone on the team taking over pauses it and handing
 * back picks it up, and STOP takes them out.
 */
import {
  appointmentAddAttendee,
  attendeeSetAttendance,
  conversationHandToAi,
  conversationTakeOver,
  FunnelDefinition,
  funnelCreate,
  funnelDecideSuggestion,
  funnelGet,
  funnelSave,
  funnelTurnOn,
  leadCreate,
  sessionPublish,
  type FunnelDefinitionInput,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachJobKey } from '../src/ai-team/index';
import { tickJobKey } from '../src/funnels/index';
import { processJobs } from '../src/jobs';
import { jobs } from '../src/scheduled';
import {
  admin,
  briefOf,
  drain,
  jobRow,
  makeCalendar,
  newCustomer,
  query,
  replyNow,
  requestAbout,
  run,
  runNow,
  teammateWorld,
  textIn,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

const MIN = 60_000;
let w: TeammateWorld;
let presentation: { id: string; slug: string };
let threeWay: { id: string; slug: string };

const STAGES = [
  { key: 'new', name: 'New lead', kind: 'open' },
  { key: 'booked', name: 'Booked', kind: 'open' },
  { key: 'at', name: 'At the presentation', kind: 'open' },
  { key: 'after', name: 'After', kind: 'open' },
  { key: 'missed', name: 'Missed', kind: 'open' },
  { key: 'interested', name: 'Interested', kind: 'open' },
  { key: 'call', name: 'Three-way call', kind: 'won' },
  { key: 'out', name: 'Out', kind: 'lost' },
] as const;
type Key = (typeof STAGES)[number]['key'];

/** Christina's funnel over her pipeline's stage ids. */
function recruiting(id: Record<Key, string>, over: Partial<FunnelDefinitionInput> = {}) {
  return FunnelDefinition.parse({
    entry: { rules: [{ id: 'rnewlead', kind: 'new_lead' }] },
    approval: 'send',
    stages: [
      {
        stageId: id.new,
        goal: 'Get them to book a presentation',
        moves: [
          {
            id: 'vbooked',
            kind: 'event',
            event: 'appointment.booked',
            calendarId: presentation.id,
            to: id.booked,
          },
          { id: 'vquiet', kind: 'quiet', minutes: 3 * 24 * 60, to: id.out },
        ],
        messages: [
          {
            id: 'mhello',
            when: { kind: 'arrive', minutes: 0 },
            wording: 'exact',
            text: 'Hi {first_name}! Thanks for your interest in joining {business}.',
          },
        ],
      },
      {
        stageId: id.booked,
        goal: 'Get them to the presentation',
        moves: [
          { id: 'vjoined', kind: 'event', event: 'attendee.joined', to: id.at },
          { id: 'vnoshow', kind: 'event', event: 'attendee.no_show', to: id.missed },
        ],
        messages: [
          {
            id: 'mhour',
            when: { kind: 'booking', minutes: -60 },
            text: 'Remind them it starts in an hour, with their Join link.',
          },
          {
            id: 'mlogon',
            when: { kind: 'booking', minutes: 5 },
            onlyIf: { has: false, event: 'attendee.joined' },
            wording: 'exact',
            text: 'Were you able to log on, {first_name}? {join_link}',
          },
        ],
      },
      {
        stageId: id.at,
        moves: [{ id: 'vended', kind: 'event', event: 'attendee.attended', to: id.after }],
        messages: [
          {
            id: 'mhear',
            when: { kind: 'arrive', minutes: 10 },
            wording: 'exact',
            text: 'Can you hear the presenter okay?',
          },
        ],
      },
      {
        stageId: id.after,
        goal: 'Find out if they’re in',
        knows: 'The comp plan pays weekly.',
        moves: [
          { id: 'vyes', kind: 'reply', says: 'they say they’re interested', to: id.interested },
          { id: 'vnope', kind: 'reply', says: 'they say no', to: id.out },
        ],
      },
      { stageId: id.missed },
      {
        stageId: id.interested,
        moves: [
          {
            id: 'vthree',
            kind: 'event',
            event: 'appointment.booked',
            calendarId: threeWay.id,
            to: id.call,
          },
        ],
        messages: [
          {
            id: 'mleader',
            when: { kind: 'arrive', minutes: 0 },
            text: 'Send the Business Expansion Leader’s booking link.',
          },
        ],
        handOff: true,
      },
      { stageId: id.call },
      { stageId: id.out },
    ],
    ...over,
  });
}

let funnelId: string;
let pipelineId: string;
let stage: Record<Key, string>;

async function session(
  cal: { id: string },
  inMinutes: number,
): Promise<{ appointmentId: string; startsAt: number }> {
  const startsAt = new Date(Date.now() + inMinutes * MIN);
  startsAt.setUTCSeconds(0, 0);
  const published = await run(w, sessionPublish, {
    workspaceId: w.workspaceId,
    calendarId: cal.id,
    startsAt: startsAt.toISOString(),
    durationMinutes: 60,
    userIds: [w.owner.id],
    location: { kind: 'virtual', meetingUrl: 'https://zoom.us/j/5550002222' },
  });
  return { appointmentId: published.appointmentId, startsAt: startsAt.getTime() };
}

/**
 * Runs the person's tick as of when it was due (a reminder two days out goes now, as if it were then), with the
 * world's own model, then what it queued.
 */
async function tickAsDue(personId: string): Promise<void> {
  const key = tickJobKey((await rowOf(personId)).id);
  const [j] = await rows<{ id: string; due: Date | string }>(
    admin(),
    sql`with picked as (select id, run_at from app.scheduled_jobs where dedupe_key = ${key} and status = 'pending')
        update app.scheduled_jobs j set run_at = now(), locked_at = now(), locked_by = ${w.workerId}
        from picked where j.id = picked.id returning j.id, picked.run_at as due`,
  );
  expect(j, 'a pending tick').toBeDefined();
  const due = new Date(j!.due).getTime();
  await processJobs({
    ...w.s,
    jobs,
    workerId: w.workerId,
    batchSize: 10,
    reservedOnly: true,
    clock: (job) => (job.id === j!.id ? due : Date.now()),
  });
  await drain(w);
}

const rowOf = async (personId: string) =>
  (
    await rows<{
      id: string;
      status: string;
      stage_id: string;
      sent: string[];
      seen: string[];
      paused_reason: string | null;
      left_reason: string | null;
      appointment_id: string | null;
    }>(
      admin(),
      sql`select * from app.funnel_people where person_id = ${personId} order by created_at desc limit 1`,
    )
  )[0]!;

const runsFor = (personId: string) =>
  rows<{
    triggered_by: string;
    outcome: string | null;
    summary: string | null;
    conversation_id: string | null;
  }>(
    admin(),
    sql`select triggered_by, outcome, summary, conversation_id from app.ai_teammate_runs
        where person_id = ${personId} and not is_test order by started_at, id`,
  );

async function agreesToTexts(personId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${personId}`,
  );
}

async function newLead(personId: string): Promise<string> {
  const { leadId } = await run(w, leadCreate, {
    workspaceId: w.workspaceId,
    title: 'Recruit',
    personId,
    pipelineId,
  });
  await drain(w);
  return leadId;
}

beforeAll(async () => {
  w = await teammateWorld('funnels', { status: 'automatic', disclosure: 'when_asked' });
  presentation = await makeCalendar(w, 'Live presentation', {
    schedule: { mode: 'sessions' },
    capacity: { seats: 10 },
  });
  threeWay = await makeCalendar(w, 'Three-way calls', {
    schedule: { mode: 'sessions' },
    capacity: { seats: 2 },
  });
  const made = await run(w, funnelCreate, {
    workspaceId: w.workspaceId,
    name: 'Recruiting',
    newPipeline: {
      name: 'Recruiting',
      stages: STAGES.map((s) => ({ name: s.name, kind: s.kind })),
    },
  });
  ({ funnelId, pipelineId } = made);
  const list = await rows<{ id: string; name: string }>(
    admin(),
    sql`select id, name from app.pipeline_stages where pipeline_id = ${pipelineId}`,
  );
  stage = Object.fromEntries(
    STAGES.map((s) => [s.key, list.find((l) => l.name === s.name)!.id]),
  ) as Record<Key, string>;
  await run(w, funnelSave, {
    workspaceId: w.workspaceId,
    funnelId,
    revision: 1,
    definition: recruiting(stage),
  });
  await run(w, funnelTurnOn, { workspaceId: w.workspaceId, funnelId });
  await drain(w);
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

// Sam, the recruit.
let sam: { id: string; phone: string };
let samLead: string;
let presentationAt: { appointmentId: string; startsAt: number };
let samSeat: string;
let samConversation: string;

describe('Christina’s funnel, with Sam', () => {
  it('takes a new lead in by its rule, and its first message goes instead of the teammate’s greeting', async () => {
    sam = await newCustomer(w, 'Sam');
    await agreesToTexts(sam.id);
    samLead = await newLead(sam.id);
    expect(await rowOf(sam.id)).toMatchObject({
      status: 'active',
      stage_id: stage.new,
      sent: ['mhello'],
    });
    expect(await jobRow(outreachJobKey(samLead))).toBeUndefined();
    const [text] = textsTo(w, sam.phone);
    expect(text!.body).toMatch(
      /^Hi Sam! Thanks for your interest in joining .+\. Reply STOP to opt out\.$/,
    );
    const [r] = await runsFor(sam.id);
    expect(r).toMatchObject({ triggered_by: 'funnel.message', outcome: 'replied' });
    expect(r!.summary).toBe(
      'Recruiting · New lead: Sent “Hi Sam! Thanks for your interest in joining funnels Booking…”',
    );
    samConversation = r!.conversation_id!;
    // Inside a funnel, the teammate's follow-up ladder stands down.
    const [followUp] = await rows(
      admin(),
      sql`select 1 from app.scheduled_jobs where kind = 'ai_teammate.follow_up' and status = 'pending'
            and payload ->> 'conversationId' = ${samConversation}`,
    );
    expect(followUp).toBeUndefined();
  });

  it('moves them on when they book, and times the reminders around the session', async () => {
    presentationAt = await session(presentation, 2 * 24 * 60);
    samSeat = (
      await run(w, appointmentAddAttendee, {
        workspaceId: w.workspaceId,
        appointmentId: presentationAt.appointmentId,
        personId: sam.id,
        notify: false,
      })
    ).attendeeId;
    await drain(w);
    expect(await rowOf(sam.id)).toMatchObject({
      stage_id: stage.booked,
      appointment_id: presentationAt.appointmentId,
      sent: [],
    });
    const tick = await jobRow(tickJobKey((await rowOf(sam.id)).id));
    expect(tick).toMatchObject({ status: 'pending' });
    expect(new Date(tick!.run_at).getTime()).toBe(presentationAt.startsAt - 60 * MIN);
  });

  it('sends the hour-before reminder in the teammate’s words, with their own Join link', async () => {
    const before = textsTo(w, sam.phone).length;
    await tickAsDue(sam.id);
    const sent = textsTo(w, sam.phone).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(
      /^Remind them it starts in an hour, with their Join link\.\nhttps?:\/\/\S+\/j\/[0-9A-Za-z]{18}$/,
    );
    expect((await rowOf(sam.id)).sent).toEqual(['mhour']);
    // Next: five minutes in, unless they've joined.
    const tick = await jobRow(tickJobKey((await rowOf(sam.id)).id));
    await runNow(w, [tickJobKey((await rowOf(sam.id)).id)]);
    expect(new Date((await jobRow(tickJobKey((await rowOf(sam.id)).id)))!.run_at).getTime()).toBe(
      presentationAt.startsAt + 5 * MIN,
    );
    expect(tick).toBeDefined();
  });

  it('asks whether they could log on, five minutes in, in the exact words', async () => {
    const before = textsTo(w, sam.phone).length;
    await tickAsDue(sam.id);
    const [logon] = textsTo(w, sam.phone).slice(before);
    expect(logon!.body).toMatch(
      /^Were you able to log on, Sam\? https?:\/\/\S+\/j\/[0-9A-Za-z]{18}$/,
    );
  });

  it('moves them on as they join and as it ends, and checks they can hear', async () => {
    await run(w, attendeeSetAttendance, {
      workspaceId: w.workspaceId,
      attendeeId: samSeat,
      attendance: 'joined',
    });
    await drain(w);
    expect(await rowOf(sam.id)).toMatchObject({ stage_id: stage.at });
    const before = textsTo(w, sam.phone).length;
    await tickAsDue(sam.id);
    expect(
      textsTo(w, sam.phone)
        .slice(before)
        .map((t) => t.body),
    ).toEqual(['Can you hear the presenter okay?']);
    await run(w, attendeeSetAttendance, {
      workspaceId: w.workspaceId,
      attendeeId: samSeat,
      attendance: 'attended',
    });
    await drain(w);
    expect(await rowOf(sam.id)).toMatchObject({ stage_id: stage.after });
  });

  it('answers with the funnel in mind, and moves them on when they say they’re in', async () => {
    const said = await textIn(w, sam.phone, 'That was great, I’m in! What’s next?');
    await replyNow(w, said.conversationId);
    const r = await rowOf(sam.id);
    expect(r).toMatchObject({ stage_id: stage.interested });
    const [moved] = await rows<{ actor_type: string; meta: Record<string, unknown> }>(
      admin(),
      sql`select actor_type, meta from app.activities where lead_id = ${samLead} and subtype = 'stage_changed'
          order by occurred_at desc limit 1`,
    );
    expect(moved).toMatchObject({ actor_type: 'ai_employee', meta: { to: 'Interested' } });
    // The reply read where they are.
    expect(briefOf(requestAbout(w, 'I’m in!')!)).toContain('funnel_move_on with move id vyes');
  });

  it('sends the Interested stage’s message, then hands them to the team, which pauses the funnel', async () => {
    await runNow(w, [tickJobKey((await rowOf(sam.id)).id)]);
    await runNow(w, [tickJobKey((await rowOf(sam.id)).id)]);
    const r = await rowOf(sam.id);
    expect(r).toMatchObject({ status: 'paused', paused_reason: 'handed_off' });
    expect(r.sent).toEqual(['mleader', '_handoff']);
    expect(textsTo(w, sam.phone).map((t) => t.body)).toContainEqual(
      "Send the Business Expansion Leader's booking link.",
    );
  });

  it('still moves them to the won stage when the team books the three-way call, which ends it', async () => {
    const call = await session(threeWay, 3 * 24 * 60);
    await run(w, appointmentAddAttendee, {
      workspaceId: w.workspaceId,
      appointmentId: call.appointmentId,
      personId: sam.id,
      notify: false,
    });
    await drain(w);
    expect(await rowOf(sam.id)).toMatchObject({
      status: 'left',
      left_reason: 'won',
      stage_id: stage.call,
    });
    const [lead] = await rows<{ status: string }>(
      admin(),
      sql`select status from app.leads where id = ${samLead}`,
    );
    expect(lead!.status).toBe('won');
  });
});

describe('who decides, and who has them', () => {
  it('leaves a draft for a person’s OK when the funnel asks first', async () => {
    const got = await query(w, funnelGet, { workspaceId: w.workspaceId, funnelId });
    await run(w, funnelSave, {
      workspaceId: w.workspaceId,
      funnelId,
      revision: got.funnel.revision,
      definition: { ...got.funnel.definition, approval: 'ask' },
    });
    const kim = await newCustomer(w, 'Kim');
    await agreesToTexts(kim.id);
    await newLead(kim.id);
    expect(textsTo(w, kim.phone)).toHaveLength(0);
    const [draft] = await rows<{ kind: string; status: string; body: string }>(
      admin(),
      sql`select kind, status, preview #>> '{message,body}' as body from app.ai_teammate_drafts
          where person_id = ${kim.id}`,
    );
    expect(draft).toMatchObject({ kind: 'reply', status: 'pending' });
    expect(draft!.body).toMatch(/^Hi Kim! Thanks for your interest/);
    expect((await runsFor(kim.id))[0]!.summary).toMatch(/^Recruiting · New lead: Drafted “Hi Kim!/);
  });

  it('pauses when someone on the team takes over, picks up when handed back, and STOP takes them out', async () => {
    const got = await query(w, funnelGet, { workspaceId: w.workspaceId, funnelId });
    await run(w, funnelSave, {
      workspaceId: w.workspaceId,
      funnelId,
      revision: got.funnel.revision,
      definition: { ...got.funnel.definition, approval: 'send' },
    });
    const lee = await newCustomer(w, 'Lee');
    await agreesToTexts(lee.id);
    await newLead(lee.id);
    const [r] = await runsFor(lee.id);
    const conversationId = r!.conversation_id!;
    await run(w, conversationTakeOver, { workspaceId: w.workspaceId, conversationId });
    await drain(w);
    expect(await rowOf(lee.id)).toMatchObject({ status: 'paused', paused_reason: 'taken_over' });
    await run(w, conversationHandToAi, { workspaceId: w.workspaceId, conversationId });
    await drain(w);
    expect(await rowOf(lee.id)).toMatchObject({ status: 'active', paused_reason: null });
    await textIn(w, lee.phone, 'STOP');
    expect(await rowOf(lee.id)).toMatchObject({ status: 'left', left_reason: 'opted_out' });
  });

  it('moves them on after three quiet days, to a lost stage, with that as the reason', async () => {
    const ray = await newCustomer(w, 'Ray');
    await agreesToTexts(ray.id);
    const leadId = await newLead(ray.id);
    const row = await rowOf(ray.id);
    await runNow(w, [tickJobKey(row.id)]);
    const [reached] = await rows<{ at: Date | string }>(
      admin(),
      sql`select stage_reached_at as at from app.funnel_people where id = ${row.id}`,
    );
    const tick = await jobRow(tickJobKey(row.id));
    expect(new Date(tick!.run_at).getTime()).toBe(
      new Date(reached!.at).getTime() + 3 * 24 * 60 * MIN,
    );
    await tickAsDue(ray.id);
    expect(await rowOf(ray.id)).toMatchObject({
      status: 'left',
      left_reason: 'lost',
      stage_id: stage.out,
    });
    const [lead] = await rows<{ status: string; lost_reason: string }>(
      admin(),
      sql`select status, lost_reason from app.leads where id = ${leadId}`,
    );
    expect(lead).toEqual({ status: 'lost', lost_reason: '3 days quiet' });
  });
});

describe('the teammate’s suggestions', () => {
  it('suggests the funnel for someone who fits, and a yes puts them in it', async () => {
    const got = await query(w, funnelGet, { workspaceId: w.workspaceId, funnelId });
    await run(w, funnelSave, {
      workspaceId: w.workspaceId,
      funnelId,
      revision: got.funnel.revision,
      definition: {
        ...got.funnel.definition,
        description: 'Recruiting people who want to build a business of their own',
        entry: { ...got.funnel.definition.entry, aiSuggests: true },
      },
    });
    await drain(w);
    const pat = await newCustomer(w, 'Pat');
    await agreesToTexts(pat.id);
    const { conversationId } = await textIn(
      w,
      pat.phone,
      'Can you tell me about the business opportunity?',
    );
    await replyNow(w, conversationId);
    const asked = requestAbout(w, 'business opportunity');
    expect(briefOf(asked!)).toContain(`suggest_funnel with funnel id ${funnelId}`);
    expect(briefOf(asked!)).toContain('build a business of their own');
    const suggested = await rowOf(pat.id);
    expect(suggested).toMatchObject({ status: 'suggested' });
    const [why] = await rows<{ why: string; added_by: string }>(
      admin(),
      sql`select suggested_why as why, added_by from app.funnel_people where id = ${suggested.id}`,
    );
    expect(why).toEqual({
      why: 'They asked: Can you tell me about the business opportunity?',
      added_by: 'ai',
    });
    // Asked again, it doesn't suggest it twice.
    await textIn(w, pat.phone, 'Is the opportunity still open?');
    await replyNow(w, conversationId);
    expect(
      await rows(admin(), sql`select 1 from app.funnel_people where person_id = ${pat.id}`),
    ).toHaveLength(1);

    await run(w, funnelDecideSuggestion, {
      workspaceId: w.workspaceId,
      funnelPersonId: suggested.id,
      accept: true,
    });
    await drain(w);
    expect(await rowOf(pat.id)).toMatchObject({ status: 'active', stage_id: stage.new });
    const [lead] = await rows<{ pipeline_id: string; stage_id: string }>(
      admin(),
      sql`select pipeline_id, stage_id from app.leads where person_id = ${pat.id} and status = 'open'
            and pipeline_id = ${pipelineId}`,
    );
    expect(lead).toEqual({ pipeline_id: pipelineId, stage_id: stage.new });
  });

  it('leaves someone out once the team says no', async () => {
    const jo = await newCustomer(w, 'Jo');
    await agreesToTexts(jo.id);
    const { conversationId } = await textIn(w, jo.phone, 'What’s the opportunity here?');
    await replyNow(w, conversationId);
    const suggested = await rowOf(jo.id);
    expect(suggested.status).toBe('suggested');
    await run(w, funnelDecideSuggestion, {
      workspaceId: w.workspaceId,
      funnelPersonId: suggested.id,
      accept: false,
    });
    await textIn(w, jo.phone, 'Any other opportunity?');
    await replyNow(w, conversationId);
    const last = requestAbout(w, 'Any other opportunity');
    expect(briefOf(last!)).not.toContain('suggest_funnel with funnel id');
    expect((await rowOf(jo.id)).status).toBe('declined');
  });
});
