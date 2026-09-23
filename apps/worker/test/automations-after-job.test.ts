/**
 * Settings → Automations' appointment and after-the-job rows (stage 2b), on the real database with the fake
 * carrier and the scripted model:
 * - "Intake questions": a first-time customer gets the form's link two minutes after they're told about their
 *   booking; a returning one doesn't; nothing goes without a form, and a text waits out quiet hours.
 * - "Thank-you after the job": two hours after a job is marked done the AI teammate thanks them (a draft while
 *   it trains); with the teammate off, a card on Home asks a person, and clears once somebody writes to them.
 * - "Referral mentioned": a customer who names somebody who needs the business opens a card; "Create lead" makes
 *   them a customer and a lead; the teammate's reply thanks the customer; small talk opens nothing.
 */
import { randomUUID } from 'node:crypto';
import {
  appointmentCreate,
  appointmentSetStatus,
  attentionSaveSettings,
  automationsSaveSettings,
  defaultAttentionSettings,
  defaultAutomationSettings,
  formCreate,
  formPublish,
  formSaveDraft,
  messageSend,
  referralCreateLead,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followUpJobKey } from '../src/ai-team/index';
import { intakeJobKey, THANK_YOU_JOB, thankYouJobKey } from '../src/automations/index';
import {
  admin,
  at,
  drain,
  hh,
  hourNow,
  iso,
  jobRow,
  newCustomer,
  replyNow,
  run,
  runNow,
  setQuietHours,
  setStatus,
  teammateRequests,
  teammateWorld,
  textIn,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;
let form: { id: string; slug: string };

beforeAll(async () => {
  w = await teammateWorld('afterjob', { status: 'automatic', calendar: 'AC tune-up' });
  await setQuietHours(w, null);
  const created = await run(w, formCreate, {
    workspaceId: w.workspaceId,
    name: 'Before your first visit',
  });
  const [row] = await rows<{ definition: { pages: { id: string }[] } }>(
    admin(),
    sql`select definition from app.forms where id = ${created.formId}`,
  );
  const saved = await run(w, formSaveDraft, {
    workspaceId: w.workspaceId,
    formId: created.formId,
    baseRevision: 1,
    ops: [
      {
        op: 'add_question',
        pageId: row!.definition.pages[0]!.id,
        index: null,
        question: { id: 'q_pets0000', type: 'yes_no', title: 'Any pets at home?', config: {} },
      },
    ],
  });
  await run(w, formPublish, {
    workspaceId: w.workspaceId,
    formId: created.formId,
    baseRevision: saved.revision,
  });
  form = { id: created.formId, slug: created.slug };
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

async function customerWhoTexts(first: string) {
  const c = await newCustomer(w, first);
  await agreesToTexts(c.id);
  return c;
}

let slotDay = 3;
/** A staff booking the customer is told about (or not), on a day of its own. */
async function book(personId: string, notify = true) {
  const { appointmentId } = await run(w, appointmentCreate, {
    workspaceId: w.workspaceId,
    calendarId: w.calendar!.id,
    startsAt: iso(at(slotDay++, '10:00')),
    personId,
    notify,
  });
  await drain(w);
  const [seat] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.appointment_attendees where appointment_id = ${appointmentId}`,
  );
  return { appointmentId, attendeeId: seat!.id };
}

const saveAutomations = (patch: (s: ReturnType<typeof defaultAutomationSettings>) => unknown) =>
  run(w, automationsSaveSettings, {
    workspaceId: w.workspaceId,
    settings: patch(defaultAutomationSettings()),
  });
const chooseForm = (formId: string | null) =>
  saveAutomations((s) => ({ ...s, intake: { ...s.intake, formId } }));

const intakeTexts = (phone: string) =>
  textsTo(w, phone).filter((t) => t.body.includes('quick questions'));

describe('intake questions', () => {
  it('sends a first-time customer the form after the confirmation, and a returning one nothing', async () => {
    await chooseForm(form.id);
    const c = await customerWhoTexts('Iris');
    const first = await book(c.id);
    // The confirmation went at once; the form waits two minutes behind it.
    expect(textsTo(w, c.phone)).toHaveLength(1);
    const job = await jobRow(intakeJobKey(first.attendeeId));
    expect(job?.status).toBe('pending');
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    await runNow(w, [intakeJobKey(first.attendeeId)]);
    const [sent] = intakeTexts(c.phone);
    expect(sent!.body).toContain(`Hi Iris, thanks for booking with`);
    expect(sent!.body).toContain(`/f/${w.site}/${form.slug}`);

    // Their second booking: not their first visit.
    const second = await book(c.id);
    await runNow(w, [intakeJobKey(second.attendeeId)]);
    expect(intakeTexts(c.phone)).toHaveLength(1);
  });

  it('arms nothing with no form chosen, or when the customer isn’t told about the booking', async () => {
    await chooseForm(null);
    const a = await customerWhoTexts('Jade');
    const noForm = await book(a.id);
    expect(await jobRow(intakeJobKey(noForm.attendeeId))).toBeUndefined();

    await chooseForm(form.id);
    const b = await customerWhoTexts('Kai');
    const untold = await book(b.id, false);
    expect(await jobRow(intakeJobKey(untold.attendeeId))).toBeUndefined();
  });

  it('waits out quiet hours', async () => {
    await chooseForm(form.id);
    const c = await customerWhoTexts('Lior');
    const b = await book(c.id);
    const H = hourNow();
    await setQuietHours(w, { start: hh(H - 1), end: hh(H + 2) });
    try {
      await runNow(w, [intakeJobKey(b.attendeeId)]);
      expect(intakeTexts(c.phone)).toHaveLength(0);
      const waiting = await jobRow(intakeJobKey(b.attendeeId));
      expect(waiting?.status).toBe('pending');
      expect(new Date(waiting!.run_at).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    } finally {
      await setQuietHours(w, null);
    }
  });
});

const thankYouOf = async (attendeeId: string) => {
  const [t] = await rows<{ id: string; outcome: string; reason: string | null }>(
    admin(),
    sql`select id, outcome, reason from app.thank_yous where attendee_id = ${attendeeId}`,
  );
  return t;
};

async function jobDone(personId: string) {
  const b = await book(personId);
  await run(w, appointmentSetStatus, {
    workspaceId: w.workspaceId,
    appointmentId: b.appointmentId,
    status: 'completed',
  });
  await drain(w);
  return b;
}

const thankYous = (phone: string) =>
  textsTo(w, phone).filter((t) => t.body.includes('Thanks for choosing'));

describe('thank-you after the job', () => {
  beforeAll(() => chooseForm(null));

  it('thanks them two hours after the job is done, and follows nothing up', async () => {
    const c = await customerWhoTexts('Mara');
    const b = await jobDone(c.id);
    const job = await jobRow(thankYouJobKey(b.attendeeId));
    expect(job?.status).toBe('pending');
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now() + 110 * 60_000);
    await runNow(w, [thankYouJobKey(b.attendeeId)]);
    const [sent] = thankYous(c.phone);
    expect(sent).toBeDefined();
    expect((await thankYouOf(b.attendeeId))?.outcome).toBe('sent');
    // It asked nothing, so nothing chases it.
    const [conv] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.conversations where person_id = ${c.id} and channel = 'sms'`,
    );
    expect(await jobRow(followUpJobKey(conv!.id))).toBeUndefined();
    // And never twice.
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, ${THANK_YOU_JOB}, ${thankYouJobKey(b.attendeeId)},
            now(), ${JSON.stringify({ attendeeId: b.attendeeId, doneAt: new Date().toISOString() })}::jsonb)`,
    );
    await drain(w);
    expect(thankYous(c.phone)).toHaveLength(1);
  });

  it('writes a draft while the teammate trains', async () => {
    await setStatus(w, 'training');
    try {
      const c = await customerWhoTexts('Nico');
      const b = await jobDone(c.id);
      await runNow(w, [thankYouJobKey(b.attendeeId)]);
      expect(thankYous(c.phone)).toHaveLength(0);
      expect((await thankYouOf(b.attendeeId))?.outcome).toBe('drafted');
      const drafts = await rows<{ status: string }>(
        admin(),
        sql`select status::text as status from app.ai_teammate_drafts where person_id = ${c.id}`,
      );
      expect(drafts).toEqual([{ status: 'pending' }]);
    } finally {
      await setStatus(w, 'automatic');
    }
  });

  it('leaves alone someone the team already wrote to since', async () => {
    const c = await customerWhoTexts('Omi');
    const b = await jobDone(c.id);
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      toPhone: c.phone,
      channel: 'sms',
      body: 'Thanks again for today, Omi!',
      clientId: randomUUID(),
    });
    await drain(w);
    await runNow(w, [thankYouJobKey(b.attendeeId)]);
    expect(thankYous(c.phone)).toHaveLength(0);
    expect(await thankYouOf(b.attendeeId)).toMatchObject({
      outcome: 'skipped',
      reason: 'someone already wrote to them',
    });
  });

  it('asks a person with a card when the teammate is off, and the card clears once they write', async () => {
    await setStatus(w, 'off');
    try {
      const c = await customerWhoTexts('Pax');
      const b = await jobDone(c.id);
      await runNow(w, [thankYouJobKey(b.attendeeId)]);
      expect(thankYous(c.phone)).toHaveLength(0);
      const t = await thankYouOf(b.attendeeId);
      expect(t).toMatchObject({ outcome: 'card', reason: 'Your AI teammate is off' });
      const cardOf = async () => {
        const [item] = await rows<{ state: string; resolution: string | null; title: string }>(
          admin(),
          sql`select state::text as state, resolution, title from app.attention_items
              where kind = 'job_not_thanked' and subject_id = ${t!.id}`,
        );
        return item;
      };
      expect(await cardOf()).toMatchObject({ state: 'open', title: 'Pax Customer · AC tune-up' });
      await run(w, messageSend, {
        workspaceId: w.workspaceId,
        toPhone: c.phone,
        channel: 'sms',
        body: 'Thanks so much for having us today, Pax!',
        clientId: randomUUID(),
      });
      await drain(w);
      expect(await cardOf()).toMatchObject({ state: 'resolved', resolution: 'contacted' });
    } finally {
      await setStatus(w, 'automatic');
    }
  });
});

describe('referral mentioned', () => {
  const referralOf = async (personId: string) => {
    const [r] = await rows<{
      id: string;
      referred_name: string | null;
      relation: string | null;
      referred_phone_e164: string | null;
      need: string | null;
      status: string;
      thanked_at: Date | null;
      lead_id: string | null;
    }>(
      admin(),
      sql`select id, referred_name, relation, referred_phone_e164, need, status, thanked_at, lead_id
          from app.referrals where referrer_person_id = ${personId}`,
    );
    return r;
  };
  const cardOf = async (referralId: string) => {
    const [item] = await rows<{ state: string; resolution: string | null; title: string }>(
      admin(),
      sql`select state::text as state, resolution, title from app.attention_items
          where kind = 'referral_mentioned' and subject_id = ${referralId}`,
    );
    return item;
  };

  it('opens a card, thanks them in the reply, and makes the lead in one press', async () => {
    const c = await customerWhoTexts('Rosa');
    const said = await textIn(
      w,
      c.phone,
      'Also my neighbor Jan needs her AC looked at, her number is 713-555-0199',
    );
    const r = await referralOf(c.id);
    expect(r).toMatchObject({
      referred_name: 'Jan',
      relation: 'neighbor',
      referred_phone_e164: '+17135550199',
      need: 'AC looked at',
      status: 'mentioned',
    });
    expect(await cardOf(r!.id)).toMatchObject({
      state: 'open',
      title: 'Rosa Customer · Mentioned Jan',
    });

    // The teammate's reply thanks her for it, once.
    await replyNow(w, said.conversationId);
    const reply = textsTo(w, c.phone).at(-1)!;
    expect(reply.body).toContain('Thanks so much for thinking of us!');
    expect((await referralOf(c.id))?.thanked_at).not.toBeNull();

    // "Create lead": Jan, with her number, and a lead that says who sent her.
    const made = await run(w, referralCreateLead, {
      workspaceId: w.workspaceId,
      referralId: r!.id,
    });
    expect(made.existingPerson).toBe(false);
    const [lead] = await rows<{ title: string; source: string; first_name: string; phone: string }>(
      admin(),
      sql`select l.title, l.source, p.first_name, p.phone_e164 as phone from app.leads l
          join app.people p on p.id = l.person_id where l.id = ${made.leadId}`,
    );
    expect(lead).toEqual({
      title: 'AC looked at',
      source: 'Referred by Rosa Customer',
      first_name: 'Jan',
      phone: '+17135550199',
    });
    await drain(w);
    expect(await cardOf(r!.id)).toMatchObject({ state: 'resolved', resolution: 'lead_created' });
    // Pressed again: the same lead.
    const again = await run(w, referralCreateLead, {
      workspaceId: w.workspaceId,
      referralId: r!.id,
    });
    expect(again.leadId).toBe(made.leadId);
  });

  it('reads nothing into small talk, and nothing at all while switched off', async () => {
    const before = teammateRequests(w).length;
    const c = await customerWhoTexts('Sol');
    await textIn(w, c.phone, 'My friend dropped me off, running 5 min late');
    expect(await referralOf(c.id)).toBeUndefined();
    const asked = JSON.stringify(teammateRequests(w).slice(before));
    expect(asked).not.toContain('mention someone else who needs the business');

    const s = defaultAttentionSettings();
    await run(w, attentionSaveSettings, {
      workspaceId: w.workspaceId,
      settings: { ...s, kinds: { ...s.kinds, referral_mentioned: false } },
    });
    try {
      const d = await customerWhoTexts('Tam');
      await textIn(w, d.phone, 'My sister needs a new furnace, can I give her your number?');
      expect(await referralOf(d.id)).toBeUndefined();
    } finally {
      await run(w, attentionSaveSettings, { workspaceId: w.workspaceId, settings: s });
    }
  });
});
