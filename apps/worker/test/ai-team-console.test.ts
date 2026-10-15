/**
 * The builder's test console (M7 step 7), POST /v1/ai-team/test, on the real database with the scripted model:
 * it needs ai_team.manage; it streams the reply, the look-ups and the checks in the console's event contract
 * (@hfos/core's ai-team/test-console.ts); a booking is only described, and nothing is sent, booked or stored
 * but the test run and its tokens; it tests the builder's unsaved settings; an emergency gets the safety text;
 * it plays incoming and outgoing phone calls, greeting first, with the phone's tools and a goodbye or a hand-off
 * that ends the call; it reads the team's instructions, and "Retry with the fix" coaches that turn alone; and at the AI
 * limit it refuses with 429.
 */
import {
  appointmentCreate,
  createTokenVerifier,
  EMERGENCY_SAFETY_TEXT,
  parseTeammateConfig,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs, testEnv } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { jobs } from '../src/scheduled';
import { CONNECTING } from '../src/voice-agent/prompt';
import {
  admin,
  appointmentsOf,
  drain,
  iso,
  newCustomer,
  openSlot,
  run,
  teammateRequests,
  teammateWorld,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

const env = testEnv();
let w: TeammateWorld;
let app: FastifyInstance;
let ownerToken: string;
let memberToken: string;

type Event = Record<string, unknown> & { type: string };

beforeAll(async () => {
  w = await teammateWorld('tmconsole', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
  app = await buildHttpServer({
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    // Its use-budget route, so the share it uses up is counted against the same daily limit.
    testRoutes: { jobs },
  });
  const member = await createTestUser('tmconsole-member', { fullName: 'Marco Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(w.owner), signInTestUser(member)]);
});
afterAll(async () => {
  await app.close();
  await w.app.close();
  await closeTestDbs();
});

function test(
  token: string | null,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/ai-team/test',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: {
      workspaceId: w.workspaceId,
      personId: null,
      channel: 'sms',
      at: null,
      config: null,
      ...body,
    },
  });
}

const eventsOf = (res: LightMyRequestResponse): Event[] =>
  res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Event);

const says = (text: string) => ({ messages: [{ from: 'customer', text }] });

describe('the test console', () => {
  it('needs someone who manages the AI teammate', async () => {
    expect((await test(null, says('Hi'))).statusCode).toBe(401);
    const res = await test(memberToken, says('Hi'));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('streams a booking it only describes, and sends, books and stores nothing but the test run', async () => {
    const c = await newCustomer(w, 'Ken');
    const res = await test(ownerToken, {
      personId: c.id,
      ...says('Can you book me in for Thursday?'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = eventsOf(res);
    expect(events[0]).toMatchObject({ type: 'started', runId: expect.any(String) });
    const types = new Set(events.map((e) => e.type));
    for (const t of ['context', 'knowledge', 'tool', 'would', 'delta', 'check', 'done'])
      expect(types).toContain(t);
    expect(events.find((e) => e.type === 'context')).toMatchObject({ title: 'Read who Ken is' });
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ name: 'find_times' });
    expect(events.find((e) => e.type === 'would')).toMatchObject({
      kind: 'book',
      summary: expect.stringMatching(/^booked Thu/),
    });
    expect(events.find((e) => e.type === 'check')).toMatchObject({ ok: true, rewritten: false });
    const done = events[events.length - 1]!;
    expect(done).toMatchObject({ type: 'done', outcome: 'replied', draft: false });
    expect(done['reply']).toMatch(/You're booked for Thu/);

    // Nothing happened for real.
    expect(await appointmentsOf(c.id)).toHaveLength(0);
    expect(textsTo(w, c.phone)).toHaveLength(0);
    const convs = await rows(
      admin(),
      sql`select 1 from app.conversations where person_id = ${c.id}`,
    );
    expect(convs).toHaveLength(0);
    const runId = String(events[0]!['runId']);
    const [r] = await rows<{
      status: string;
      outcome: string;
      is_test: boolean;
      triggered_by: string;
      conversation_id: string | null;
      input_tokens: number;
    }>(
      admin(),
      sql`select status, outcome, is_test, triggered_by, conversation_id, input_tokens
          from app.ai_teammate_runs where id = ${runId}`,
    );
    expect(r).toMatchObject({
      status: 'done',
      outcome: 'replied',
      is_test: true,
      triggered_by: 'test',
      conversation_id: null,
    });
    expect(r!.input_tokens).toBeGreaterThan(0);
    const calls = await rows(
      admin(),
      sql`select 1 from app.ai_teammate_tool_calls where run_id = ${runId}`,
    );
    expect(calls).toHaveLength(0);
  });

  it('tests the builder’s unsaved settings, and says what’s wrong with unreadable ones', async () => {
    const [saved] = await rows<{ config: unknown }>(
      admin(),
      sql`select config from app.ai_teammates where id = ${w.teammateId}`,
    );
    const config = parseTeammateConfig(saved!.config);
    const draft = { ...config, identity: { ...config.identity, name: 'Rex' } };
    const res = await test(ownerToken, { config: draft, ...says('Are you a robot?') });
    const done = eventsOf(res).pop()!;
    expect(done['reply']).toContain("I'm Rex, an AI assistant");

    const bad = await test(ownerToken, {
      config: { ...config, limits: { ...config.limits, dailySharePercent: 1 } },
      ...says('Hi'),
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('config.limits.dailySharePercent');
  });

  it('reads the team’s instructions, and retries a turn with the fix for that turn only', async () => {
    await rows(
      admin(),
      sql`insert into app.teammate_instructions (workspace_id, teammate_id, body)
          values (${w.workspaceId}, ${w.teammateId}, 'Always mention our 90-day warranty.')`,
    );
    const asked = teammateRequests(w).length;
    await test(ownerToken, {
      ...says('Do you fix furnaces?'),
      coaching: {
        reply: 'Yes, we do.',
        better: 'Yes! We fix every make, with a 90-day warranty.',
        why: 'Say the warranty',
      },
    });
    const [retry] = teammateRequests(w).slice(asked);
    const brief = [retry!.lasting, retry!.context].filter(Boolean).join('\n');
    expect(brief).toContain('<instructions>');
    expect(brief).toContain('Always mention our 90-day warranty.');
    expect(brief).toContain(
      'What they’d rather you said: Yes! We fix every make, with a 90-day warranty.',
    );
    expect(brief).toContain('Why: Say the warranty');
    await test(ownerToken, says('Do you fix furnaces?'));
    const plain = teammateRequests(w).at(-1)!;
    expect(plain.context).not.toContain('What they’d rather you said');
    await rows(
      admin(),
      sql`delete from app.teammate_instructions where teammate_id = ${w.teammateId}`,
    );
  });

  it('answers an emergency with the safety text, never asking the model', async () => {
    const asked = teammateRequests(w).length;
    const res = await test(ownerToken, says('I smell gas in my kitchen'));
    const events = eventsOf(res);
    expect(events.find((e) => e.type === 'would')).toMatchObject({ kind: 'hand_off' });
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      outcome: 'handed_off',
      reply: EMERGENCY_SAFETY_TEXT.gas,
    });
    expect(teammateRequests(w)).toHaveLength(asked);
  });

  describe('on the phone', () => {
    type Line = { from: 'customer' | 'teammate'; text: string };
    const done = (res: LightMyRequestResponse) => {
      const last = eventsOf(res).pop()!;
      expect(last['type'], res.body).toBe('done');
      return last;
    };
    /** Plays one turn of the call: what they say, after the call so far. */
    const turn = (
      lines: Line[],
      call: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => test(ownerToken, { channel: 'phone', call, messages: lines, ...extra });

    it('answers an incoming call: the greeting, a spoken answer, and a goodbye that hangs up', async () => {
      const c = await newCustomer(w, 'Lena');
      const inbound = { direction: 'inbound' };
      const asked = teammateRequests(w).length;
      const picked = await turn([], inbound, { personId: c.id });
      expect(picked.statusCode, picked.body).toBe(200);
      const first = eventsOf(picked);
      expect(first.find((e) => e.type === 'context')).toMatchObject({ title: 'Read who Lena is' });
      // Its phone setting is off, and a real call wouldn't reach it.
      expect(first.find((e) => e.type === 'note')).toMatchObject({ title: 'Phone calls are off' });
      const greeting = done(picked);
      expect(greeting).toMatchObject({ outcome: 'replied', draft: false, ended: false });
      expect(String(greeting['reply'])).toMatch(/^Thanks for calling /);
      // The greeting is its own words: no model call.
      expect(teammateRequests(w)).toHaveLength(asked);

      const lines: Line[] = [
        { from: 'teammate', text: String(greeting['reply']) },
        { from: 'customer', text: 'Can you book me in for Thursday?' },
      ];
      const booked = await turn(lines, inbound, { personId: c.id });
      const events = eventsOf(booked);
      expect(events.find((e) => e.type === 'tool')).toMatchObject({ name: 'find_times' });
      expect(events.find((e) => e.type === 'would')).toMatchObject({ kind: 'book' });
      expect(done(booked)).toMatchObject({ outcome: 'replied', ended: false });
      // The call so far is its transcript, and it answers out loud. How it talks on a call is in the part read
      // once, at pickup; each turn's own context is only the time and the knowledge that matches.
      const request = teammateRequests(w).at(-1)!;
      expect(request.lasting).toContain('Channel: a live phone call.');
      expect(request.context).toMatch(/^Today is /);
      expect(request.context).not.toContain('Channel:');
      expect(JSON.stringify(request.messages[0])).toContain('Thanks for calling');
      expect(request.tools?.map((t) => t.name)).toContain('end_call');

      lines.push(
        { from: 'teammate', text: String(done(booked)['reply']) },
        { from: 'customer', text: 'That’s all, bye!' },
      );
      const saidBye = await turn(lines, inbound, { personId: c.id });
      const bye = done(saidBye);
      expect(bye).toMatchObject({
        outcome: 'replied',
        reply: 'Thanks for calling. Bye now!',
        ended: true,
      });
      // A goodbye changes nothing, so it starts being said while it's written; the booking's words waited for it.
      expect(bye['firstWordsMs']).toEqual(expect.any(Number));
      expect(eventsOf(saidBye).find((e) => e.type === 'note')).toMatchObject({
        title: 'Starts talking',
        detail: expect.stringContaining('“Thanks for calling.”'),
      });
      expect(done(booked)['firstWordsMs']).toBeNull();
      // The stopwatch: where the time went before it could start talking. The goodbye's steps add up to it; the
      // booking's reply was said only once it was done, so it has no first-sentence step.
      const byeSteps = bye['steps'] as Record<string, unknown>;
      expect(byeSteps).toMatchObject({
        loadMs: expect.any(Number),
        waitMs: expect.any(Number),
        sentenceMs: expect.any(Number),
        thought: false,
        ready: false,
      });
      expect(
        Number(byeSteps['loadMs']) + Number(byeSteps['waitMs']) + Number(byeSteps['sentenceMs']),
      ).toBeLessThanOrEqual(Number(bye['firstWordsMs']) + 5);
      expect(done(booked)['steps']).toMatchObject({ sentenceMs: null });
      expect(greeting['steps']).toBeNull();
      // Each of its sentences comes as it's ready, so the console can say them out loud early too; the booking's
      // reply comes only once it's done.
      expect(
        eventsOf(saidBye)
          .filter((e) => e.type === 'say')
          .map((e) => e['text']),
      ).toEqual(['Thanks for calling.', 'Bye now!']);
      expect(eventsOf(booked).some((e) => e.type === 'say')).toBe(false);
      // The call was read once, at pickup: every turn sends the same lasting part, so the AI finds it ready.
      expect(teammateRequests(w).at(-1)!.lasting).toBe(request.lasting);

      // Nothing happened for real: no visit, no call, no conversation.
      expect(await appointmentsOf(c.id)).toHaveLength(0);
      const calls = await rows(admin(), sql`select 1 from app.calls where person_id = ${c.id}`);
      expect(calls).toHaveLength(0);
      const convs = await rows(
        admin(),
        sql`select 1 from app.conversations where person_id = ${c.id}`,
      );
      expect(convs).toHaveLength(0);
    });

    it('connects a caller who asks for a person to the team, which ends the call', async () => {
      const inbound = { direction: 'inbound' };
      const greeting = done(await turn([], inbound));
      const res = await turn(
        [
          { from: 'teammate', text: String(greeting['reply']) },
          { from: 'customer', text: 'I want to talk to a real person' },
        ],
        inbound,
      );
      const events = eventsOf(res);
      expect(events.find((e) => e.type === 'context')).toBeUndefined();
      expect(events.find((e) => e.type === 'would')).toMatchObject({
        kind: 'hand_off',
        summary: expect.stringMatching(/^connected them to the team on this call/),
      });
      expect(done(res)).toMatchObject({
        outcome: 'handed_off',
        reply: CONNECTING.en,
        ended: true,
      });
    });

    it('places a call to confirm their visit, and only describes the confirming', async () => {
      const c = await newCustomer(w, 'Omar');
      const call = { direction: 'outbound', purpose: 'confirm_visit' };
      // Nobody to confirm yet: it says so before the stream opens.
      const none = await turn([], call, { personId: c.id });
      expect(none.statusCode).toBe(409);
      expect(none.json()).toMatchObject({ error: { rule: 'nothing_to_call_about' } });

      await run(w, appointmentCreate, {
        workspaceId: w.workspaceId,
        calendarId: w.calendar!.id,
        startsAt: iso(await openSlot(w, 3)),
        personId: c.id,
        notify: false,
      });
      await drain(w);
      const placed = await turn([], call, { personId: c.id });
      const opening = eventsOf(placed);
      expect(
        opening.find((e) => e.type === 'context' && /^Called Omar/.test(String(e['title']))),
      ).toBeTruthy();
      const greeting = String(done(placed)['reply']);
      expect(greeting).toMatch(
        /^Hi Omar, this is .+, an AI assistant for .+\. This call is recorded\. I’m calling about your /,
      );
      expect(greeting).toMatch(/Does that still work for you\?$/);

      const res = await turn(
        [
          { from: 'teammate', text: greeting },
          { from: 'customer', text: 'Yes, that still works' },
        ],
        call,
        { personId: c.id },
      );
      expect(eventsOf(res).find((e) => e.type === 'would')).toMatchObject({ kind: 'confirm' });
      expect(done(res)).toMatchObject({ reply: 'Great, see you then. Bye!', ended: true });
      const [seat] = await rows<{ confirmed_at: Date | null }>(
        admin(),
        sql`select confirmed_at from app.appointment_attendees where person_id = ${c.id}`,
      );
      expect(seat!.confirmed_at).toBeNull();
    });

    it('rings back a missed call, and only describes a "don’t call me" ', async () => {
      const c = await newCustomer(w, 'Priya');
      const call = { direction: 'outbound', purpose: 'missed_call' };
      const greeting = String(done(await turn([], call, { personId: c.id }))['reply']);
      expect(greeting).toContain(
        'I’m calling back, since we missed your call earlier. How can I help?',
      );
      const res = await turn(
        [
          { from: 'teammate', text: greeting },
          { from: 'customer', text: 'Please don’t call me again' },
        ],
        call,
        { personId: c.id },
      );
      expect(eventsOf(res).find((e) => e.type === 'would')).toMatchObject({ kind: 'no_calls' });
      expect(done(res)).toMatchObject({ reply: 'Sorry for the trouble. Goodbye.', ended: true });
      const [p] = await rows<{ call_consent: string }>(
        admin(),
        sql`select call_consent::text as call_consent from app.people where id = ${c.id}`,
      );
      expect(p!.call_consent).not.toBe('opted_out');
    });

    it('says what a campaign call is about, and refuses an outgoing call with nobody to call', async () => {
      const c = await newCustomer(w, 'Rosa');
      const call = {
        direction: 'outbound',
        purpose: 'campaign',
        goal: 'Our spring tune-up special',
      };
      const placed = await turn([], call, { personId: c.id });
      expect(eventsOf(placed).find((e) => e.type === 'note')).toMatchObject({
        title: 'What it knows about the call',
        detail: expect.stringContaining('Our spring tune-up special'),
      });
      expect(String(done(placed)['reply'])).toContain(
        'I’m calling about our spring tune-up special. Is now a good time?',
      );

      const nobody = await turn([], call);
      expect(nobody.statusCode).toBe(400);
      expect(JSON.stringify(nobody.json())).toContain('personId');
      const noGoal = await turn(
        [],
        { direction: 'outbound', purpose: 'campaign' },
        { personId: c.id },
      );
      expect(noGoal.statusCode).toBe(400);
      const noWay = await test(ownerToken, { channel: 'phone', messages: [] });
      expect(noWay.statusCode).toBe(400);
    });
  });

  // Last: the share stays used up for the rest of the business's day.
  it('refuses with 429 once the teammate has used its share of the AI limit', async () => {
    const used = await app.inject({
      method: 'POST',
      url: '/test/ai-team/use-budget',
      payload: { workspaceId: w.workspaceId },
    });
    expect(used.statusCode, used.body).toBe(200);
    const res = await test(ownerToken, says('Hi'));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { rule: 'ai_limit' } });
  });
});
