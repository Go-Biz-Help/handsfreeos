/**
 * Live polls, part 2 of webinars (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md), on the real database: a call's poll,
 * asking its questions, answers landing on each person's contact, and each sheet sent when the call ends.
 *
 * What's worth holding:
 *   - a session's call starts with its calendar's poll, and only a form made as a Live poll can be one;
 *   - the team asks one question at a time: asking another closes the one that's up, and an asked one stays asked;
 *   - each person's answers are one response on their contact, one answer per question, the first standing, and only
 *     someone on the call's appointment can answer;
 *   - nearly everyone watching answering closes it, and a job that runs early leaves it be;
 *   - when the call ends each sheet is sent, so `form.submitted` goes out for it;
 *   - a live poll can't be filled in anywhere else;
 *   - part 3: the AI asks only while the call lets it, never over a question that's up, just after one closed, or one
 *     the team skipped; and what it sees of the poll names the team, whose words alone count;
 *   - part 4: a poll's slides are a PDF on the poll, kept for good; a question's slide must be one the slides have;
 *     the team shows a slide only of the published poll's slides, and they come down with another poll.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fileConfirm,
  fileDelete,
  formBeginSlidesUpload,
  formCreate,
  formPublish,
  formResponseStart,
  formSaveDraft,
  sessionPublish,
  videoCallEnter,
  videoCallJoin,
  videoCallJoined,
  videoCallOpen,
  videoCallPollAnswer,
  videoCallPollClose,
  videoCallPollCueState,
  videoCallPollNow,
  videoCallPollOpen,
  videoCallPollsFinish,
  videoCallPollsGet,
  videoCallPollSkip,
  videoCallSetPoll,
  videoCallSetPollAi,
  videoCallSlide,
  videoCallSlideNow,
  webinarRegister,
} from '../src/server';
import {
  admin,
  ask,
  askSystem,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let calendarId: string;
let pollId: string;

const Q = {
  leads: 'q_leads000',
  crm: 'q_crm00000',
  ready: 'q_ready000',
  trade: 'q_trade000',
  talk: 'q_talk0000',
};

/** A published live poll: pick one, yes or no, a 1 to 10 scale, a short answer and a Talk to someone button. */
async function publishedPoll(name: string, mode: 'poll' | 'form' = 'poll'): Promise<string> {
  const created = await run(formCreate, { workspaceId: t.wsId, name, mode }, t.owner);
  const [row] = await rows<{ definition: { pages: { id: string }[] } }>(
    admin(),
    sql`select definition from app.forms where id = ${created.formId}`,
  );
  const pageId = row!.definition.pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const ops =
    mode === 'poll'
      ? [
          add({
            id: Q.leads,
            type: 'choice',
            title: 'Where do your leads come from?',
            config: {
              choices: [
                { id: 'c_referral', label: 'Referrals' },
                { id: 'c_ads00000', label: 'Ads' },
              ],
            },
            live: { seconds: 45, showResults: true },
          }),
          add({ id: Q.crm, type: 'yes_no', title: 'Do you use a CRM?', config: {} }),
          add({ id: Q.ready, type: 'scale', title: 'How ready are you?', config: {} }),
          add({ id: Q.trade, type: 'short_text', title: 'What’s your trade?', config: {} }),
          add({
            id: Q.talk,
            type: 'button',
            title: 'Want help setting up?',
            config: { action: 'talk', label: 'Talk to someone' },
          }),
        ]
      : [add({ id: Q.trade, type: 'short_text', title: 'What’s your trade?', config: {} })];
  const saved = await run(
    formSaveDraft,
    { workspaceId: t.wsId, formId: created.formId, baseRevision: 1, ops },
    t.owner,
  );
  await run(
    formPublish,
    { workspaceId: t.wsId, formId: created.formId, baseRevision: saved.revision },
    t.owner,
  );
  return created.formId;
}

const publish = async (clock: string, weekday = 2) => {
  const s = await run(
    sessionPublish,
    {
      workspaceId: t.wsId,
      calendarId,
      startsAt: isoAt(nextWeekday(weekday, 5), clock),
      userIds: [t.priya.id],
      capacity: 8,
    },
    t.owner,
  );
  const open = await runSystem(
    videoCallOpen,
    { workspaceId: t.wsId, appointmentId: s.appointmentId },
    t.scope,
  );
  return { appointmentId: s.appointmentId, callId: open.callId };
};

const register = (callId: string, firstName: string) =>
  runSystem(
    webinarRegister,
    {
      workspaceId: t.wsId,
      callId,
      customer: { firstName, lastName: 'Watcher', phone: nextPhone() },
      smsConsent: true,
    },
    t.scope,
  );

const events = (type: string, entityId: string) =>
  rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where event_type = ${type} and entity_id = ${entityId} order by created_at`,
  );

const pollRow = async (callId: string, questionId: string) =>
  (
    await rows<{ id: string; state: string; answers: number; opened_by: string }>(
      admin(),
      sql`select id, state, answers, opened_by from app.video_call_polls
          where video_call_id = ${callId} and question_id = ${questionId}`,
    )
  )[0];

beforeAll(async () => {
  t = await setupTeam('polls');
  await rows(admin(), sql`update app.workspaces set video_calls = true where id = ${t.wsId}`);
  pollId = await publishedPoll('Demo poll');
  const cal = await makeCalendar(t, 'Live demos', {
    public: true,
    team: { members: [{ userId: t.priya.id }] },
    schedule: { mode: 'sessions' },
    locations: {
      options: [{ kind: 'virtual', video: 'handsfree' }],
      webinar: { pollFormId: pollId },
    },
  });
  calendarId = cal.id;
});
afterAll(closeTestDbs);

describe('a call’s poll', () => {
  it('starts with its calendar’s, and is only ever a form made as a Live poll', async () => {
    const { callId } = await publish('09:00');
    const [c] = await rows<{ poll_form_id: string | null }>(
      admin(),
      sql`select poll_form_id from app.video_calls where id = ${callId}`,
    );
    expect(c!.poll_form_id).toBe(pollId);

    const plain = await publishedPoll('Plain form', 'form');
    await expectHfos(
      () => run(videoCallSetPoll, { workspaceId: t.wsId, callId, formId: plain }, t.priya),
      'not_a_poll',
      409,
    );
    expect(
      await run(videoCallSetPoll, { workspaceId: t.wsId, callId, formId: null }, t.priya),
    ).toEqual({ changed: true, pollFormId: null });
    await expectHfos(
      () => run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.leads }, t.priya),
      'no_poll',
      409,
    );
  });

  it('can’t be filled in on a page, in a conversation or on the phone', async () => {
    await expectHfos(
      () =>
        runSystem(
          formResponseStart,
          { workspaceId: t.wsId, formId: pollId, source: 'link' },
          t.scope,
        ),
      'form_is_poll',
      409,
    );
  });
});

describe('asking and answering', () => {
  let callId: string;
  const seats: Record<string, { attendeeId: string; personId: string }> = {};
  const t0 = Date.now();

  const answer = (who: string, value: unknown, poll: string) =>
    runSystem(
      videoCallPollAnswer,
      { workspaceId: t.wsId, pollId: poll, attendeeId: seats[who]!.attendeeId, value },
      t.scope,
    );

  beforeAll(async () => {
    ({ callId } = await publish('11:00'));
    const priya = await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya);
    const joined = (personId: string, s: number) =>
      runSystem(
        videoCallJoined,
        {
          workspaceId: t.wsId,
          callId,
          personId,
          roomSid: 'RM_polls',
          participantSid: `PA_${personId.slice(0, 8)}_${s}`,
          at: new Date(t0 + s * 1000).toISOString(),
        },
        t.scope,
      );
    await joined(priya.personId, 0);
    for (const [i, name] of ['Ann', 'Ben'].entries()) {
      const seat = await register(callId, name);
      const inside = await runSystem(
        videoCallEnter,
        { workspaceId: t.wsId, attendeeId: seat.attendeeId, name },
        t.scope,
      );
      await joined(inside.personId!, 10 + i);
      const [p] = await rows<{ person_id: string }>(
        admin(),
        sql`select person_id from app.appointment_attendees where id = ${seat.attendeeId}`,
      );
      seats[name] = { attendeeId: seat.attendeeId, personId: p!.person_id };
    }
  });

  it('puts a question up for its seconds, by the team', async () => {
    const opened = await run(
      videoCallPollOpen,
      { workspaceId: t.wsId, callId, questionId: Q.leads },
      t.priya,
    );
    expect(opened.changed).toBe(true);
    const left = new Date(opened.closesAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(40_000);
    expect(left).toBeLessThanOrEqual(45_000);
    expect(await pollRow(callId, Q.leads)).toMatchObject({ state: 'open', opened_by: 'team' });
    expect(await events('video_call.poll_opened', callId)).toHaveLength(1);
    // Asking it again while it's up changes nothing.
    expect(
      (await run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.leads }, t.priya))
        .changed,
    ).toBe(false);

    const now = await askSystem(
      videoCallPollNow,
      { workspaceId: t.wsId, callId, personId: seats.Ann!.personId },
      t.scope,
    );
    expect(now.poll).toMatchObject({ pollId: opened.pollId, type: 'choice' });
    expect(now.answered).toBe(false);
  });

  it('keeps one answer per person, on a sheet on their contact', async () => {
    const poll = (await pollRow(callId, Q.leads))!.id;
    await expectHfos(() => answer('Ann', 'c_nothere0', poll), 'poll_answer_invalid', 400);
    expect(await answer('Ann', 'c_ads00000', poll)).toEqual({ status: 'saved', closed: false });
    expect(await answer('Ann', 'c_referral', poll)).toEqual({ status: 'already', closed: false });
    const [sheet] = await rows<{
      id: string;
      source: string;
      status: string;
      person_id: string;
      video_call_id: string;
    }>(
      admin(),
      sql`select id, source, status, person_id, video_call_id from app.form_responses
          where video_call_id = ${callId} and person_id = ${seats.Ann!.personId}`,
    );
    expect(sheet).toMatchObject({
      source: 'video_call',
      status: 'in_progress',
      video_call_id: callId,
    });
    const [said] = await rows<{ choice_ids: string[]; choice_labels: string[] }>(
      admin(),
      sql`select choice_ids, choice_labels from app.form_answers
          where response_id = ${sheet!.id} and question_id = ${Q.leads}`,
    );
    expect(said).toEqual({ choice_ids: ['c_ads00000'], choice_labels: ['Ads'] });
  });

  it('takes answers only from someone on this call’s appointment', async () => {
    const other = await publish('13:00');
    const stranger = await register(other.callId, 'Zed');
    const poll = (await pollRow(callId, Q.leads))!.id;
    await expectHfos(
      () =>
        runSystem(
          videoCallPollAnswer,
          {
            workspaceId: t.wsId,
            pollId: poll,
            attendeeId: stranger.attendeeId,
            value: 'c_ads00000',
          },
          t.scope,
        ),
      'poll_not_yours',
      403,
    );
  });

  it('closes once nearly everyone watching has answered', async () => {
    const poll = (await pollRow(callId, Q.leads))!.id;
    expect(await answer('Ben', 'c_referral', poll)).toEqual({ status: 'saved', closed: true });
    expect(await pollRow(callId, Q.leads)).toMatchObject({ state: 'closed', answers: 2 });
    const closed = await events('video_call.poll_closed', callId);
    expect(closed.at(-1)!.payload).toMatchObject({ pollId: poll, why: 'nearly_all', answers: 2 });
    // Too late now.
    expect(await answer('Ben', 'c_ads00000', poll)).toEqual({ status: 'closed', closed: false });
  });

  it('asks one at a time, never the same one twice, and lets the team skip one for now', async () => {
    await run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.crm }, t.priya);
    await run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.ready }, t.priya);
    expect(await pollRow(callId, Q.crm)).toMatchObject({ state: 'closed' });
    expect((await events('video_call.poll_closed', callId)).at(-1)!.payload).toMatchObject({
      why: 'replaced',
    });
    await expectHfos(
      () => run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.leads }, t.priya),
      'poll_already_asked',
      409,
    );
    expect(
      await run(videoCallPollSkip, { workspaceId: t.wsId, callId, questionId: Q.trade }, t.priya),
    ).toEqual({ changed: true });
    expect(
      await run(videoCallPollSkip, { workspaceId: t.wsId, callId, questionId: Q.trade }, t.priya),
    ).toEqual({ changed: false });
    // A skipped one can still be asked.
    await run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.trade }, t.priya);
    expect(await pollRow(callId, Q.trade)).toMatchObject({ state: 'open' });
  });

  it('leaves a question be when its job runs early, and closes it when its time is up', async () => {
    const poll = (await pollRow(callId, Q.trade))!.id;
    expect(
      await runSystem(videoCallPollClose, { workspaceId: t.wsId, callId, pollId: poll }, t.scope),
    ).toEqual({ changed: false });
    await rows(
      admin(),
      sql`update app.video_call_polls set closes_at = now() - interval '1 second' where id = ${poll}`,
    );
    expect(
      await runSystem(videoCallPollClose, { workspaceId: t.wsId, callId, pollId: poll }, t.scope),
    ).toEqual({ changed: true });
    expect((await events('video_call.poll_closed', callId)).at(-1)!.payload).toMatchObject({
      why: 'time',
    });
  });

  it('shows the team every question, how it stands and its totals', async () => {
    const panel = await ask(videoCallPollsGet, { workspaceId: t.wsId, callId }, t.priya);
    expect(panel.form).toMatchObject({ id: pollId, name: 'Demo poll', ready: true });
    expect(panel.watching).toBe(2);
    expect(panel.questions.map((q) => [q.questionId, q.state])).toEqual([
      [Q.leads, 'closed'],
      [Q.crm, 'closed'],
      [Q.ready, 'closed'],
      [Q.trade, 'closed'],
      [Q.talk, 'waiting'],
    ]);
    expect(panel.questions[0]!.totals).toEqual({
      answered: 2,
      bars: [
        { id: 'c_referral', label: 'Referrals', count: 1 },
        { id: 'c_ads00000', label: 'Ads', count: 1 },
      ],
      average: null,
    });
    expect(panel.questions[0]!.showResults).toBe(true);
  });

  it('says who pressed a button', async () => {
    const opened = await run(
      videoCallPollOpen,
      { workspaceId: t.wsId, callId, questionId: Q.talk },
      t.priya,
    );
    expect(await answer('Ann', true, opened.pollId)).toEqual({ status: 'saved', closed: false });
    const panel = await ask(videoCallPollsGet, { workspaceId: t.wsId, callId }, t.priya);
    const talk = panel.questions.find((q) => q.questionId === Q.talk)!;
    expect(talk.pressed).toEqual([{ personId: seats.Ann!.personId, name: 'Ann Watcher' }]);
    await run(videoCallPollClose, { workspaceId: t.wsId, callId, pollId: opened.pollId }, t.priya);
  });

  it('sends each person’s sheet when the call ends', async () => {
    const finished = await runSystem(
      videoCallPollsFinish,
      { workspaceId: t.wsId, callId },
      t.scope,
    );
    expect(finished).toEqual({ sent: 2 });
    const sheets = await rows<{ status: string }>(
      admin(),
      sql`select status from app.form_responses where video_call_id = ${callId}`,
    );
    expect(sheets.map((s) => s.status)).toEqual(['completed', 'completed']);
    const sent = await events('form.submitted', pollId);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.payload).toMatchObject({ mode: 'poll', formId: pollId, videoCallId: callId });
    // Once.
    expect(await runSystem(videoCallPollsFinish, { workspaceId: t.wsId, callId }, t.scope)).toEqual(
      { sent: 0 },
    );
  });
});

describe('the AI asking (part 3)', () => {
  let callId: string;
  let priyaIn: string;
  const open = (questionId: string) =>
    runSystem(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId }, t.scope);
  const cueState = () =>
    asWorker(testDbs().worker.db, t.scope, (tx) => videoCallPollCueState(tx, callId));

  beforeAll(async () => {
    // Another day: the answers' test has Priya at 13:00 on the first.
    ({ callId } = await publish('13:00', 3));
    ({ personId: priyaIn } = await run(videoCallJoin, { workspaceId: t.wsId, callId }, t.priya));
  });

  it('starts with the calendar’s choice, and the panel says whether the AI can hear', async () => {
    const panel = await ask(videoCallPollsGet, { workspaceId: t.wsId, callId }, t.priya);
    expect(panel).toMatchObject({ ai: 'ask', hearing: true });
    expect(panel.endsAt).not.toBeNull();
    const seen = await cueState();
    expect(seen).toMatchObject({ ai: 'ask', openNow: false, lastClosedAt: null, team: [priyaIn] });
    expect(seen!.questions.map((q) => [q.id, q.state])).toEqual([
      [Q.leads, 'waiting'],
      [Q.crm, 'waiting'],
      [Q.ready, 'waiting'],
      [Q.trade, 'waiting'],
      [Q.talk, 'waiting'],
    ]);
    expect(seen!.questions[0]!.choices).toEqual(['Referrals', 'Ads']);
  });

  it('asks a question as the AI, but never over one that’s up', async () => {
    await open(Q.leads);
    expect(await pollRow(callId, Q.leads)).toMatchObject({ state: 'open', opened_by: 'ai' });
    expect((await events('video_call.poll_opened', callId)).at(-1)!.payload).toMatchObject({
      openedBy: 'ai',
    });
    await expectHfos(() => open(Q.crm), 'poll_question_open', 409);
    expect((await cueState())!.openNow).toBe(true);
  });

  it('waits a little after a question closes, then asks the next', async () => {
    const leads = (await pollRow(callId, Q.leads))!.id;
    await run(videoCallPollClose, { workspaceId: t.wsId, callId, pollId: leads }, t.priya);
    await expectHfos(() => open(Q.crm), 'poll_too_soon', 409);
    await rows(
      admin(),
      sql`update app.video_call_polls set closed_at = now() - interval '30 seconds' where id = ${leads}`,
    );
    await open(Q.crm);
    expect(await pollRow(callId, Q.crm)).toMatchObject({ state: 'open', opened_by: 'ai' });
    // The team can still take it down and ask another themselves.
    await run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.ready }, t.priya);
    expect(await pollRow(callId, Q.ready)).toMatchObject({ state: 'open', opened_by: 'team' });
    await rows(
      admin(),
      sql`update app.video_call_polls set state = 'closed', closed_at = now() - interval '1 minute'
          where video_call_id = ${callId} and state = 'open'`,
    );
  });

  it('leaves a question the team skipped to the team', async () => {
    await run(videoCallPollSkip, { workspaceId: t.wsId, callId, questionId: Q.trade }, t.priya);
    await expectHfos(() => open(Q.trade), 'poll_skipped', 409);
  });

  it('only offers questions, or stays out of it, when the team says so', async () => {
    expect(
      await run(videoCallSetPollAi, { workspaceId: t.wsId, callId, ai: 'suggest' }, t.priya),
    ).toEqual({ changed: true, ai: 'suggest' });
    expect(
      await run(videoCallSetPollAi, { workspaceId: t.wsId, callId, ai: 'suggest' }, t.priya),
    ).toEqual({ changed: false, ai: 'suggest' });
    await expectHfos(() => open(Q.talk), 'poll_ai_off', 409);
    expect((await cueState())!.ai).toBe('suggest');
    // The team still asks it.
    await run(videoCallPollOpen, { workspaceId: t.wsId, callId, questionId: Q.talk }, t.priya);

    await run(videoCallSetPollAi, { workspaceId: t.wsId, callId, ai: 'off' }, t.priya);
    expect(await cueState()).toBeNull();
    expect((await events('video_call.poll_ai_set', callId)).map((e) => e.payload.ai)).toEqual([
      'suggest',
      'off',
    ]);
  });
});

describe('the slides (part 4)', () => {
  let callId: string;
  let deck: string;
  let fileId: string;
  const slideTo = (slide: number | null) =>
    run(videoCallSlide, { workspaceId: t.wsId, callId, slide }, t.priya);
  const revisionOf = async (formId: string) =>
    (
      await rows<{ revision: number }>(
        admin(),
        sql`select revision from app.forms where id = ${formId}`,
      )
    )[0]!.revision;
  const begin = (formId: string) =>
    run(
      formBeginSlidesUpload,
      {
        workspaceId: t.wsId,
        formId,
        name: 'Demo deck.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      },
      t.owner,
    );

  beforeAll(async () => {
    ({ callId } = await publish('15:00', 3));
    deck = await publishedPoll('Poll with slides');
  });

  it('keeps a poll’s slides on the poll, never on a customer, and for good', async () => {
    const plain = await publishedPoll('Plain form for slides', 'form');
    await expectHfos(() => begin(plain), 'not_a_poll', 409);
    const begun = await begin(deck);
    fileId = begun.fileId;
    expect(begun.objectPath.startsWith(`${t.wsId}/form/${deck}/${fileId}/`)).toBe(true);
    await rows(
      admin(),
      sql`insert into storage.objects (bucket_id, name, metadata)
          values ('attachments', ${begun.objectPath}, ${JSON.stringify({ size: 2048, mimetype: 'application/pdf' })}::jsonb)`,
    );
    await run(fileConfirm, { workspaceId: t.wsId, fileId }, t.owner);
    const [f] = await rows<{ record_type: string; status: string }>(
      admin(),
      sql`select record_type::text as record_type, status::text as status from app.files where id = ${fileId}`,
    );
    expect(f).toEqual({ record_type: 'form', status: 'ready' });
    // Published versions of the poll still show them.
    await expectHfos(
      () => run(fileDelete, { workspaceId: t.wsId, fileId }, t.owner),
      'slides_file_kept',
      409,
    );
  });

  it('goes on the poll as an edit, and each question’s slide is one the slides have', async () => {
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: t.wsId,
        formId: deck,
        baseRevision: await revisionOf(deck),
        ops: [
          { op: 'set_form', patch: { slides: { fileId, name: 'Demo deck.pdf', pages: 6 } } },
          { op: 'update_question', questionId: Q.crm, patch: { live: { slide: 9 } } },
        ],
      },
      t.owner,
    );
    expect(saved.changes).toContain('Added the slides “Demo deck.pdf”');
    expect(saved.issues.map((i) => i.message)).toContain(
      '“Do you use a CRM?” goes with slide 9, but the slides have 6. Pick another slide, or none.',
    );
    const fixed = await run(
      formSaveDraft,
      {
        workspaceId: t.wsId,
        formId: deck,
        baseRevision: saved.revision,
        ops: [{ op: 'update_question', questionId: Q.crm, patch: { live: { slide: 3 } } }],
      },
      t.owner,
    );
    expect(fixed.issues).toEqual([]);
    await run(
      formPublish,
      { workspaceId: t.wsId, formId: deck, baseRevision: fixed.revision },
      t.owner,
    );
  });

  it('turns away slides that aren’t a poll’s PDF', async () => {
    const other = await publishedPoll('Another poll for slides');
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: t.wsId,
        formId: other,
        baseRevision: await revisionOf(other),
        ops: [
          {
            op: 'set_form',
            patch: { slides: { fileId: randomUUID(), name: 'Gone.pdf', pages: 2 } },
          },
        ],
      },
      t.owner,
    );
    expect(saved.issues.map((i) => i.message)).toContain(
      'The slides “Gone.pdf” aren’t there anymore. Add them again.',
    );
  });

  it('shows nothing until the call’s poll has slides, and only the slides it has', async () => {
    await expectHfos(() => slideTo(1), 'no_slides', 409);
    await run(videoCallSetPoll, { workspaceId: t.wsId, callId, formId: deck }, t.priya);
    await expectHfos(() => slideTo(7), 'slide_past_end', 409);
  });

  it('shows a slide, tells the worker, and the panel and the AI know which', async () => {
    expect(await slideTo(2)).toEqual({ changed: true, slide: 2, of: 6 });
    expect(await slideTo(2)).toEqual({ changed: false, slide: 2, of: 6 });
    expect((await events('video_call.slide_changed', callId)).at(-1)!.payload).toMatchObject({
      slide: 2,
      of: 6,
      fileId,
      formId: deck,
    });
    const panel = await ask(videoCallPollsGet, { workspaceId: t.wsId, callId }, t.priya);
    expect(panel.slides).toEqual({ name: 'Demo deck.pdf', pages: 6 });
    expect(panel.slide).toBe(2);
    expect(panel.questions.find((q) => q.questionId === Q.crm)!.slide).toBe(3);
    const seen = await asWorker(testDbs().worker.db, t.scope, (tx) =>
      videoCallPollCueState(tx, callId),
    );
    expect(seen!.slide).toEqual({ n: 2, of: 6 });
    expect(seen!.questions.find((q) => q.id === Q.crm)!.slide).toBe(3);
    const now = await asWorker(testDbs().worker.db, t.scope, (tx) => videoCallSlideNow(tx, callId));
    expect(now).toMatchObject({ slide: 2, of: 6, bucket: 'attachments', name: 'Demo deck.pdf' });
  });

  it('comes down when the team says, or when another poll is picked', async () => {
    expect(await slideTo(null)).toEqual({ changed: true, slide: null, of: 6 });
    await slideTo(4);
    await run(videoCallSetPoll, { workspaceId: t.wsId, callId, formId: pollId }, t.priya);
    const [c] = await rows<{ slide: number | null }>(
      admin(),
      sql`select slide from app.video_calls where id = ${callId}`,
    );
    expect(c!.slide).toBeNull();
    expect((await events('video_call.slide_changed', callId)).at(-1)!.payload).toMatchObject({
      slide: null,
    });
  });
});
