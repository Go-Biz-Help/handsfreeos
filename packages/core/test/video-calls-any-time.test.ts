/**
 * Calls any time (docs/video-calls.md, part 5) on the real database: a HandsFreeOS video call with a customer that
 * isn't for an appointment, started by someone on the team, the customer's own link to it, its line on their
 * timeline, and its transcript and After the call.
 *
 * What's worth holding:
 *   - Video call sends the customer their own link as whoever pressed it, in the same change as the call, which they
 *     host; only the link's hash is kept;
 *   - nothing starts while the business has calls off, or with no way to send the link, and each refusal says why;
 *   - on their link the customer waits until someone from the team is in, then goes straight in, as on a booking's;
 *   - the call is one line on the customer's timeline once they've been in it, kept up to date by a later stretch;
 *   - what the AI heard becomes the call's transcript, its summary goes on that line, and its suggestions wait;
 *   - the database keeps a person's call to a customer they can see, hosted by them, and a customer's place in it
 *     to the call's own customer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, expectPgError, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointmentTranscriptList,
  callSuggestionDecide,
  callSuggestionList,
  callSuggestionRecord,
  personCreate,
  videoCallEnter,
  videoCallFinished,
  videoCallGet,
  videoCallHeard,
  videoCallJoin,
  videoCallJoined,
  videoCallKeepWords,
  videoCallStart,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, setupTeam, type Team } from './calendar-helpers';

const api = () => testDbs().api.db;
const ORIGIN = 'https://book.example.com';
const WORDS =
  'Thanks for jumping on. I would like the duct cleaning quote by Friday, and the attic one too if you can manage it.';

let t: Team;
let dana: string;
let rosa: string;
const t0 = Date.now() - 60 * 60_000;
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();

const setCalls = (on: boolean) =>
  rows(admin(), sql`update app.workspaces set video_calls = ${on} where id = ${t.wsId}`);

const callRow = async (id: string) =>
  (
    await rows<{
      appointment_id: string | null;
      person_id: string | null;
      conversation_id: string | null;
      host_user_id: string | null;
      state: string;
      link_key_hash: string | null;
      activity_id: string | null;
    }>(
      admin(),
      sql`select appointment_id, person_id, conversation_id, host_user_id, state, link_key_hash, activity_id
          from app.video_calls where id = ${id}`,
    )
  )[0]!;

const linesOf = (callId: string) =>
  rows<{ id: string; body: string | null; meta: Record<string, unknown>; author_user_id: string }>(
    admin(),
    sql`select id, body, meta, author_user_id from app.activities
        where kind = 'call' and subtype = 'video' and meta->>'videoCallId' = ${callId}`,
  );

beforeAll(async () => {
  t = await setupTeam('vany');
  await setCalls(true);
  dana = (
    await run(
      personCreate,
      {
        workspaceId: t.wsId,
        firstName: 'Dana',
        lastName: 'Lopez',
        email: `dana-${randomUUID().slice(0, 8)}@example.com`,
      },
      t.owner,
    )
  ).personId;
  rosa = (
    await run(
      personCreate,
      { workspaceId: t.wsId, firstName: 'Rosa', lastName: 'Delgado' },
      t.owner,
    )
  ).personId;
});
afterAll(closeTestDbs);

describe('a video call with a customer, any time', () => {
  let callId: string;
  let customerRow: string;
  let priyaRow: string;

  it('sends the customer their own link as you, and makes the call for you to host', async () => {
    const out = await run(
      videoCallStart,
      { workspaceId: t.wsId, personId: dana, origin: `${ORIGIN}/some/page?x=1` },
      t.priya,
    );
    // No number to text: the link goes by email.
    expect(out).toMatchObject({ personId: dana, channel: 'email', name: 'Dana Lopez' });
    expect(out.conversationId).not.toBeNull();
    callId = out.callId;

    const [m] = await rows<{ subject: string | null; body_text: string; sent_by: string | null }>(
      admin(),
      sql`select subject, body_text, sent_by from app.messages where conversation_id = ${out.conversationId}`,
    );
    expect(m).toMatchObject({
      sent_by: t.priya.id,
      subject: expect.stringMatching(/^Video call with /),
    });
    const key = /https:\/\/book\.example\.com\/j\/([0-9A-Za-z]{32})\b/.exec(m!.body_text)?.[1];
    expect(key).toBeDefined();

    const c = await callRow(callId);
    expect(c).toEqual({
      appointment_id: null,
      person_id: dana,
      conversation_id: out.conversationId,
      host_user_id: t.priya.id,
      state: 'open',
      link_key_hash: createHash('sha256').update(key!).digest('hex'),
      activity_id: null,
    });
    // The worker finds the call from the key in the link; the key itself is kept nowhere.
    const [found] = await rows<{ call_id: string; workspace_id: string }>(
      admin(),
      sql`select call_id, workspace_id from private.video_call_by_link(${c.link_key_hash})`,
    );
    expect(found).toEqual({ call_id: callId, workspace_id: t.wsId });
    const opened = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'video_call.opened' and entity_id = ${callId}`,
    );
    expect(JSON.stringify(opened)).not.toContain(key!);

    const got = await ask(videoCallGet, { workspaceId: t.wsId, callId }, t.owner);
    expect(got).toMatchObject({
      appointment: null,
      customer: { personId: dana, name: 'Dana Lopez' },
      host: { userId: t.priya.id },
    });
  });

  it('starts nothing with no way to send the link, or with calls off, and says why', async () => {
    const none = await expectHfos(
      () => run(videoCallStart, { workspaceId: t.wsId, personId: rosa, origin: ORIGIN }, t.priya),
      'video_call_no_way',
      409,
    );
    expect(none.message).toContain('Rosa Delgado has no phone number or email address');
    const byText = await expectHfos(
      () =>
        run(
          videoCallStart,
          { workspaceId: t.wsId, personId: dana, channel: 'sms', origin: ORIGIN },
          t.priya,
        ),
      'video_call_no_way',
    );
    expect(byText.message).toContain('or send it by email');

    await setCalls(false);
    try {
      await expectHfos(
        () => run(videoCallStart, { workspaceId: t.wsId, personId: dana, origin: ORIGIN }, t.priya),
        'video_calls_off',
        409,
      );
    } finally {
      await setCalls(true);
    }
    const calls = await rows(
      admin(),
      sql`select 1 from app.video_calls where workspace_id = ${t.wsId} and person_id = ${rosa}`,
    );
    expect(calls).toEqual([]);
  });

  it('lets the customer in on their own link once someone from the team is there', async () => {
    const enter = () =>
      runSystem(videoCallEnter, { workspaceId: t.wsId, callId, name: 'Dana Lopez' }, t.scope);
    const first = await enter();
    expect(first).toMatchObject({ status: 'waiting', callId, name: 'Dana Lopez', host: 'Priya' });
    customerRow = first.personId!;
    // Asked again while they wait: the same place, and the team hears once.
    expect(await enter()).toMatchObject({ status: 'waiting', personId: customerRow });
    const waits = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'video_call.waiting' and entity_id = ${callId}`,
    );
    expect(waits.map((w) => w.payload)).toEqual([
      expect.objectContaining({ appointmentId: null, personId: dana, title: 'Video call' }),
    ]);

    priyaRow = (await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya)).personId;
    await runSystem(
      videoCallJoined,
      { workspaceId: t.wsId, callId, personId: priyaRow, roomSid: 'RM_any_1', at: at(0) },
      t.scope,
    );
    expect(await enter()).toMatchObject({ status: 'in', personId: customerRow });
    await runSystem(
      videoCallJoined,
      {
        workspaceId: t.wsId,
        callId,
        personId: customerRow,
        roomSid: 'RM_any_1',
        participantSid: 'PA_dana_1',
        at: at(30),
      },
      t.scope,
    );
    const [seat] = await rows<{ kind: string; attendee_id: string | null; person_id: string }>(
      admin(),
      sql`select kind, attendee_id, person_id from app.video_call_people where id = ${customerRow}`,
    );
    expect(seat).toEqual({ kind: 'customer', attendee_id: null, person_id: dana });
  });

  it('is its own line on the customer’s timeline once the call is over', async () => {
    expect(await linesOf(callId)).toEqual([]);
    const done = await runSystem(
      videoCallFinished,
      { workspaceId: t.wsId, callId, roomSid: 'RM_any_1', at: at(300) },
      t.scope,
    );
    expect(done.changed).toBe(true);
    const [line, ...more] = await linesOf(callId);
    expect(more).toEqual([]);
    expect(line).toMatchObject({
      body: null,
      author_user_id: t.priya.id,
      meta: expect.objectContaining({ videoCallId: callId, durationSeconds: 270, people: 2 }),
    });
    expect((await callRow(callId)).activity_id).toBe(line!.id);
    const [onDana] = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from app.activities where id = ${line!.id}`,
    );
    expect(onDana!.person_id).toBe(dana);
  });

  it('keeps what the AI heard as the call’s transcript, puts its summary on that line, and waits on the rest', async () => {
    await runSystem(
      videoCallHeard,
      {
        workspaceId: t.wsId,
        callId,
        lines: [{ key: 'l1', personId: customerRow, text: WORDS, saidAt: at(60) }],
      },
      t.scope,
    );
    const kept = await runSystem(
      videoCallKeepWords,
      { workspaceId: t.wsId, callId, until: at(300), stretch: 'RM_any_1' },
      t.scope,
    );
    expect(kept.transcriptId).not.toBeNull();
    const [transcript] = await rows<{ appointment_id: string | null; video_call_id: string }>(
      admin(),
      sql`select appointment_id, video_call_id from app.appointment_transcripts where id = ${kept.transcriptId}`,
    );
    expect(transcript).toEqual({ appointment_id: null, video_call_id: callId });
    const ready = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'video_call.transcript_ready' and entity_id = ${callId}`,
    );
    expect(ready.map((r) => r.payload)).toEqual([
      { transcriptId: kept.transcriptId, personId: dana },
    ]);
    // The team reads it from the line; the words never go in the event.
    const read = await ask(
      appointmentTranscriptList,
      { workspaceId: t.wsId, videoCallId: callId },
      t.member,
    );
    expect(read.items).toEqual([
      expect.objectContaining({ provider: 'handsfree', body: `Dana Lopez: ${WORDS}` }),
    ]);
    expect(JSON.stringify(ready)).not.toContain('duct');

    const review = {
      workspaceId: t.wsId,
      videoCallId: callId,
      transcriptId: kept.transcriptId!,
      review: {
        summary: 'Dana wants a duct cleaning quote by Friday, and one for the attic.',
        tasks: [{ title: 'Send Dana the duct quote', dueInDays: 2 }],
        followUp: { subject: 'Your duct cleaning quote', body: 'Hi Dana, here it is.' },
      },
    };
    expect(await runSystem(callSuggestionRecord, review, t.scope)).toEqual({
      noted: true,
      suggestions: 2,
    });
    // Once: a retried job does nothing more.
    expect(await runSystem(callSuggestionRecord, review, t.scope)).toEqual({
      noted: false,
      suggestions: 0,
    });
    const [line] = await linesOf(callId);
    expect(line!.body).toBe(review.review.summary);

    const after = await ask(
      callSuggestionList,
      { workspaceId: t.wsId, videoCallId: callId },
      t.priya,
    );
    expect(after.summary).toBe(review.review.summary);
    expect(after.items.map((i) => [i.kind, i.status])).toEqual([
      ['task', 'pending'],
      ['follow_up', 'pending'],
    ]);
    // Approved, the task goes to whoever hosted the call, about the customer.
    const task = after.items.find((i) => i.kind === 'task')!;
    const done = await run(
      callSuggestionDecide,
      { workspaceId: t.wsId, suggestionId: task.id, decision: 'approve' },
      t.owner,
    );
    const [made] = await rows<{ title: string; assignee_user_id: string; person_id: string }>(
      admin(),
      sql`select title, assignee_user_id, person_id from app.tasks where id = ${done.taskId}`,
    );
    expect(made).toEqual({
      title: 'Send Dana the duct quote',
      assignee_user_id: t.priya.id,
      person_id: dana,
    });
  });

  it('keeps one line through a later stretch, timed by how long the customer was in it all told', async () => {
    // Priya starts it again, and Dana comes back for a minute.
    await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya);
    await runSystem(
      videoCallJoined,
      { workspaceId: t.wsId, callId, personId: priyaRow, roomSid: 'RM_any_2', at: at(1000) },
      t.scope,
    );
    expect(
      await runSystem(videoCallEnter, { workspaceId: t.wsId, callId, name: 'Dana Lopez' }, t.scope),
    ).toMatchObject({ status: 'in', personId: customerRow });
    await runSystem(
      videoCallJoined,
      {
        workspaceId: t.wsId,
        callId,
        personId: customerRow,
        roomSid: 'RM_any_2',
        participantSid: 'PA_dana_2',
        at: at(1010),
      },
      t.scope,
    );
    await runSystem(
      videoCallFinished,
      { workspaceId: t.wsId, callId, roomSid: 'RM_any_2', at: at(1070) },
      t.scope,
    );
    const [line, ...more] = await linesOf(callId);
    expect(more).toEqual([]);
    expect(line!.meta).toMatchObject({ videoCallId: callId, durationSeconds: 330 });
    // The summary stays on it.
    expect(line!.body).toContain('duct cleaning quote');
  });
});

describe('the database', () => {
  it('lets a person make a call only with a customer they can see, hosted by them', async () => {
    const made = await asUser(api(), t.priya.claims, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.video_calls (workspace_id, person_id, host_user_id)
            values (${t.wsId}, ${dana}, ${t.priya.id}) returning id`,
      ),
    );
    expect(made).toHaveLength(1);
    const forSomeoneElse = await expectPgError(() =>
      asUser(api(), t.priya.claims, (tx) =>
        rows(
          tx,
          sql`insert into app.video_calls (workspace_id, person_id, host_user_id)
              values (${t.wsId}, ${dana}, ${t.owner.id})`,
        ),
      ),
    );
    expect(forSomeoneElse.code).toBe('42501');
    const alreadyLive = await expectPgError(() =>
      asUser(api(), t.priya.claims, (tx) =>
        rows(
          tx,
          sql`insert into app.video_calls (workspace_id, person_id, host_user_id, state)
              values (${t.wsId}, ${dana}, ${t.priya.id}, 'live')`,
        ),
      ),
    );
    expect(alreadyLive.code).toBe('42501');
  });

  it('keeps a customer’s place in a call to the call’s own customer', async () => {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.video_calls (workspace_id, person_id, host_user_id)
          values (${t.wsId}, ${dana}, ${t.priya.id}) returning id`,
    );
    const someoneElse = await expectPgError(() =>
      rows(
        admin(),
        sql`insert into app.video_call_people (workspace_id, video_call_id, kind, person_id, name)
            values (${t.wsId}, ${c!.id}, 'customer', ${rosa}, 'Rosa Delgado')`,
      ),
    );
    expect(someoneElse.detail).toBe('record_workspace_mismatch');
    const nobody = await expectPgError(() =>
      rows(
        admin(),
        sql`insert into app.video_call_people (workspace_id, video_call_id, kind, name)
            values (${t.wsId}, ${c!.id}, 'customer', 'Nobody')`,
      ),
    );
    expect(nobody.code).toBe('23514');
    // A transcript is an appointment's or a call's, never neither.
    const neither = await expectPgError(() =>
      rows(
        admin(),
        sql`insert into app.appointment_transcripts (workspace_id, provider, external_id, body)
            values (${t.wsId}, 'handsfree', 'video:none', 'Hello')`,
      ),
    );
    expect(neither.code).toBe('23514');
  });
});
