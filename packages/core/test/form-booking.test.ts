/**
 * A form that books a time (funnels), on the local database: the last step's session is booked when the form is
 * sent, with the calendar's own online booking, and a session that filled up meanwhile refuses the whole send.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { formAnswers, formResponses, forms } from '@hfos/db/schema';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formCreate,
  formPublish,
  formResponseStart,
  formResponseSubmit,
  formSaveDraft,
  sessionPublish,
} from '../src/server';
import {
  admin,
  bookOnline,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let calendarId: string;
let sessionId: string;
let startsAt: string;

beforeAll(async () => {
  t = await setupTeam('form-book');
  const cal = await makeCalendar(t, 'Live presentation', {
    public: false,
    team: { members: [{ userId: t.owner.id }] },
    schedule: { mode: 'sessions' },
    capacity: { seats: 2 },
  });
  calendarId = cal.id;
  startsAt = isoAt(nextWeekday(2, 7), '10:00');
  const session = await run(
    sessionPublish,
    { workspaceId: t.wsId, calendarId, startsAt, userIds: [t.owner.id] },
    t.owner,
  );
  sessionId = session.appointmentId;
});
afterAll(closeTestDbs);

const qid = (name: string) => `q_${name.padEnd(8, '0').slice(0, 8)}`;

async function bookingForm(): Promise<string> {
  const created = await run(formCreate, { workspaceId: t.wsId, name: 'Meet the team' }, t.owner);
  const [form] = await admin().select().from(forms).where(eq(forms.id, created.formId));
  const pageId = (form!.definition as { pages: { id: string }[] }).pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const saved = await run(
    formSaveDraft,
    {
      workspaceId: t.wsId,
      formId: created.formId,
      baseRevision: created.revision,
      ops: [
        add({
          id: qid('name'),
          type: 'short_text',
          title: 'Your name',
          required: true,
          mapTo: 'person.first_name',
          config: {},
        }),
        add({
          id: qid('phone'),
          type: 'phone',
          title: 'Your phone',
          mapTo: 'person.phone',
          config: {},
        }),
        add({
          id: qid('when'),
          type: 'booking',
          title: 'Pick a presentation',
          required: true,
          config: { calendarId },
        }),
      ],
    },
    t.owner,
  );
  await run(
    formPublish,
    { workspaceId: t.wsId, formId: created.formId, baseRevision: saved.revision },
    t.owner,
  );
  return created.formId;
}

const send = async (formId: string, name: string, phone: string) => {
  const started = await runSystem(
    formResponseStart,
    { workspaceId: t.wsId, formId, source: 'link' },
    t.scope,
  );
  const submit = () =>
    runSystem(
      formResponseSubmit,
      {
        workspaceId: t.wsId,
        responseId: started.responseId,
        token: started.token,
        answers: {
          [qid('name')]: name,
          [qid('phone')]: phone,
          // The page's words for the time; the server writes its own.
          [qid('when')]: { startsAt, sessionId, label: 'whatever the page said' },
        },
      },
      t.scope,
    );
  return { started, submit };
};

const seatsOf = async (personId: string) =>
  rows<{ status: string }>(
    admin(),
    sql`select status::text as status from app.appointment_attendees
        where appointment_id = ${sessionId} and person_id = ${personId}`,
  );

describe('a form that books a time', () => {
  it('books the session they picked when they send it, in the calendar’s words', async () => {
    const formId = await bookingForm();
    const { started, submit } = await send(formId, 'Dana', '(512) 555-0501');
    const sent = await submit();
    expect(await seatsOf(sent.personId!)).toEqual([{ status: 'booked' }]);
    const answers = await admin()
      .select()
      .from(formAnswers)
      .where(eq(formAnswers.responseId, started.responseId));
    const when = answers.find((a) => a.questionId === qid('when'))!;
    expect(when.textValue).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} · 10:00 am$/);
  });

  it('refuses the whole send when the session filled up, and nothing is half done', async () => {
    const formId = await bookingForm();
    // The second seat is taken meanwhile.
    await bookOnline(t, calendarId, startsAt, { sessionId, throughForm: true });
    const { started, submit } = await send(formId, 'Kai', '(512) 555-0502');
    const error = await expectHfos(submit, 'form_booking_taken', 409);
    expect(error.message).toMatch(/just filled up\. Pick another time\.$/);
    expect(error.details).toEqual({ questionId: qid('when') });
    const [row] = await admin()
      .select({ status: formResponses.status })
      .from(formResponses)
      .where(eq(formResponses.id, started.responseId));
    expect(row!.status).toBe('in_progress');
    const kai = await rows<{ id: string }>(
      admin(),
      sql`select id from app.people where workspace_id = ${t.wsId} and first_name = 'Kai'`,
    );
    expect(kai).toEqual([]);
  });
});
