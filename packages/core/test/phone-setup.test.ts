/**
 * The guided phone number setup (the owner, 22 Nov 2026): the answers kept as they are given, the last screen's one
 * save (the number bought and everything set the way they said), each part changed alone later from Settings, and
 * "the AI teammate answers" kept as a wish until the business has a teammate.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import {
  GUIDED_SETUPS,
  phoneMissedNow,
  phoneSetupAnswersFromNow,
  phoneSetupAnswersOf,
  phoneSetupFirstProblem,
  phoneSetupLines,
  phoneSetupNumberType,
  phoneSetupPartBody,
  phoneSetupProblems,
  phoneSetupQuestions,
  phoneSetupSaveBody,
  phoneSetupStart,
  PHONE_SETUP_WORDS,
  guidedSetupSavedWhen,
  type PhoneSetupAnswers,
  type PhoneSetupContext,
} from '../src';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  aiTeammateCreate,
  guidedSetupClearDraft,
  guidedSetupGetDraft,
  guidedSetupSaveDraft,
  messageSend,
  onboardingStatus,
  organizationCreate,
  personCreate,
  phoneNumberActivate,
  phoneSetupSave,
  phoneSetupStatus,
} from '../src/server';

const db = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(db(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), meta());
const system = (): SystemActor => ({ type: 'system', workspaceId: wsId, organizationId: orgId });
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, system(), meta()).then((r) => r.output);

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

/** A random number, so reruns never collide with one still live in an old test workspace. */
const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let owner: TestUser;
let member: TestUser;
let orgId: string;
let wsId: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([createTestUser('ps-owner'), createTestUser('ps-member')]);
  const org = await run(organizationCreate, { businessName: 'Phone Setup Co' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

const NO_TEAMMATE: PhoneSetupContext = {
  mode: 'new',
  businessName: 'Phone Setup Co',
  teammate: null,
  textingSettled: false,
  businessE164: null,
};
const picked = (e164: string, numberType: 'local' | 'toll_free' = 'local') => ({
  e164,
  display: e164,
  numberType,
  place: numberType === 'local' ? 'Huntsville, AL' : null,
});

describe('the phone setup’s questions, worked out in one place', () => {
  it('says why a number couldn’t be bought in one sentence, however the carrier ended its own', () => {
    const { failed } = PHONE_SETUP_WORDS.number;
    expect(failed('That number was just taken.')).toBe(
      'That number was just taken. Nothing was bought. Pick another number and carry on.',
    );
    expect(failed('Not available...  \t\n')).toMatch(/^Not available\. Nothing was bought\./);
    expect(failed(null)).toBe('Nothing was bought. Pick another number and carry on.');
    expect(failed(' . ')).toBe('Nothing was bought. Pick another number and carry on.');
    // A very long reason is read once, end to start, not once for every place in it.
    const long = `${'\t'.repeat(200_000)}x`;
    const began = Date.now();
    expect(failed(long).startsWith(long)).toBe(true);
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it('starts on the picks marked Best, and asks about an EIN and quiet hours only when they text', () => {
    const start = phoneSetupStart(NO_TEAMMATE, { city: 'Huntsville', state: 'AL' });
    expect(start).toMatchObject({
      have: 'new',
      texting: true,
      ein: null,
      then: 'teammate',
      quiet: 'night',
      search: { city: 'Huntsville', state: 'AL', miles: '25' },
    });
    expect(phoneSetupQuestions(start, NO_TEAMMATE)).toEqual([
      'have',
      'texting',
      'ein',
      'number',
      'ring',
      'missed',
      'quiet',
    ]);
    const callsOnly = { ...start, texting: false };
    expect(phoneSetupQuestions(callsOnly, NO_TEAMMATE)).toEqual([
      'have',
      'texting',
      'number',
      'ring',
      'missed',
    ]);
    // With the number already there, only what it does; texting isn't asked once the carriers have it.
    expect(phoneSetupQuestions(start, { mode: 'again', textingSettled: true })).toEqual([
      'ring',
      'missed',
      'quiet',
    ]);
    expect(phoneSetupQuestions(callsOnly, { mode: 'again', textingSettled: false })).toEqual([
      'texting',
      'ring',
      'missed',
    ]);
  });

  it('offers a toll-free number only to a business that texts and has no EIN', () => {
    const start = phoneSetupStart(NO_TEAMMATE);
    expect(phoneSetupNumberType({ ...start, ein: true })).toBe('local');
    expect(phoneSetupNumberType({ ...start, ein: false })).toBe('toll_free');
    expect(phoneSetupNumberType({ ...start, texting: false, ein: false })).toBe('local');
    expect(phoneSetupNumberType({ ...start, ein: true, numberType: 'toll_free' })).toBe(
      'toll_free',
    );
  });

  it('says what is wrong with an answer, by the row it is on', () => {
    const start = phoneSetupStart(NO_TEAMMATE);
    expect(phoneSetupProblems('ein', start, NO_TEAMMATE)).toHaveLength(1);
    expect(phoneSetupProblems('number', start, NO_TEAMMATE)[0]?.path).toBe('number');
    const number = picked('+12565550100');
    const phones: PhoneSetupAnswers = {
      ...start,
      ein: true,
      number,
      morePhones: true,
      phones: [
        { label: '', number: '(256) 555-0117', enabled: true },
        { label: 'Desk', number: 'nope', enabled: true },
        { label: 'Mine', number: '(256) 555-0100', enabled: true },
        { label: 'Twice', number: '256-555-0117', enabled: true },
      ],
    };
    expect(phoneSetupProblems('ring', phones, NO_TEAMMATE).map((p) => p.path)).toEqual([
      'phones.0.label',
      'phones.1.number',
      'phones.2.number',
      'phones.3.number',
    ]);
    expect(phoneSetupFirstProblem(phones, NO_TEAMMATE)).toBe('ring');
    expect(phoneSetupSaveBody(phones, NO_TEAMMATE, null)).toBeNull();
    // Someone who can't change the AI teammate can't have it answer, and isn't started on that pick.
    const locked: PhoneSetupContext = {
      ...NO_TEAMMATE,
      teammate: { name: 'Ava', on: true, canManage: false },
    };
    expect(phoneSetupStart(locked).then).toBe('voicemail');
    expect(
      phoneSetupProblems('missed', { ...start, then: 'teammate' }, locked)[0]?.message,
    ).toContain('Ava');
    expect(
      phoneSetupProblems(
        'quiet',
        { ...start, quiet: 'custom', quietStart: '21:00', quietEnd: '21:00' },
        NO_TEAMMATE,
      )[0]?.path,
    ).toBe('quietEnd');
  });

  it('sends the last screen’s answers as one save, and one part alone from Settings', () => {
    const start = phoneSetupStart(NO_TEAMMATE);
    const a: PhoneSetupAnswers = {
      ...start,
      ein: true,
      number: picked('+12565550100'),
      morePhones: true,
      phones: [{ label: ' Dale’s cell ', number: '(256) 555-0117', enabled: true }],
      callerId: 'business',
      then: 'voicemail',
      greeting: '  ',
      quiet: 'custom',
      quietStart: '21:00',
      quietEnd: '07:00',
    };
    expect(phoneSetupSaveBody(a, NO_TEAMMATE, null)).toEqual({
      buy: { e164: '+12565550100', numberType: 'local' },
      ring: {
        forwarding: [{ e164: '+12565550117', label: 'Dale’s cell', enabled: true }],
        forwardedCallerId: 'business',
      },
      // An empty greeting is the usual one again, so it is sent as none rather than left as it was.
      missed: { ringSeconds: 20, then: 'voicemail', voicemailGreeting: null },
      texting: 'on',
      quietHours: { enabled: true, start: '21:00', end: '07:00' },
    });
    // Calls only: no EIN question, no quiet hours, and texting is said to be off.
    const callsOnly = { ...a, texting: false, ein: null, then: 'teammate' as const };
    expect(phoneSetupSaveBody(callsOnly, NO_TEAMMATE, null)).toMatchObject({
      texting: 'not_now',
      missed: { then: 'teammate', teammateMode: 'no_answer' },
    });
    expect(phoneSetupSaveBody(callsOnly, NO_TEAMMATE, null)).not.toHaveProperty('quietHours');
    const again: PhoneSetupContext = {
      ...NO_TEAMMATE,
      mode: 'again',
      textingSettled: true,
      businessE164: '+12565550100',
    };
    expect(phoneSetupSaveBody(a, again, 'number-id')).toMatchObject({ phoneNumberId: 'number-id' });
    expect(phoneSetupSaveBody(a, again, 'number-id')).not.toHaveProperty('texting');
    expect(phoneSetupPartBody('quiet', { ...a, quiet: 'never' }, again)).toEqual({
      quietHours: { enabled: false, start: '20:00', end: '08:00' },
    });
    expect(phoneSetupPartBody('ring', { ...a, morePhones: false }, again)).toEqual({
      ring: { forwarding: [], forwardedCallerId: 'business' },
    });
    expect(
      phoneSetupPartBody(
        'ring',
        { ...a, phones: [{ label: 'Me', number: '(256) 555-0100', enabled: true }] },
        again,
      ),
    ).toBeNull();
  });

  it('reads saved answers back whatever shape they were left in', () => {
    const start = phoneSetupStart(NO_TEAMMATE);
    const kept = phoneSetupAnswersOf(
      {
        at: 'ring',
        have: 'new',
        texting: false,
        number: { e164: '+12565550100', display: '(256) 555-0100', numberType: 'local' },
        phones: [{ label: 'Dale', number: '256 555 0117' }, 'nonsense'],
        ringSeconds: 99,
        quietStart: '25:00',
        then: 'sing',
      },
      start,
    );
    expect(kept).toMatchObject({
      at: 'ring',
      texting: false,
      number: { e164: '+12565550100', place: null },
      phones: [
        { label: 'Dale', number: '256 555 0117', enabled: true },
        { label: '', number: '', enabled: true },
      ],
      ringSeconds: 20,
      quietStart: '20:00',
      then: null,
    });
    expect(phoneSetupAnswersOf(null, start)).toEqual(start);
  });

  it('puts what the number does today into words, for Settings and the list beside the questions', () => {
    const now = {
      routing: {
        forwarding: [{ e164: '+12565550117', label: 'Dale’s cell', enabled: true }],
        ringSeconds: 15,
        voicemailEnabled: true,
        voicemailGreeting: null,
        forwardedCallerId: 'customer' as const,
      },
      settings: {
        quietHours: { enabled: true, start: '20:00', end: '08:00' },
        texting: 'on' as const,
        teammateAnswers: 'after_hours' as const,
      },
      teammate: null,
    };
    // Asked for before there was a teammate: still their answer, and callers get the voicemail meanwhile.
    expect(phoneMissedNow(now)).toEqual({ then: 'teammate', mode: 'after_hours', waiting: true });
    const answers = { ...phoneSetupStart(NO_TEAMMATE), ...phoneSetupAnswersFromNow(now) };
    expect(answers).toMatchObject({
      morePhones: true,
      then: 'teammate',
      teammateMode: 'after_hours',
      quiet: 'night',
      ringSeconds: 15,
    });
    const lines = phoneSetupLines(answers, {
      ...NO_TEAMMATE,
      mode: 'again',
      textingSettled: true,
    });
    expect(lines.map((l) => [l.question, l.value])).toEqual([
      ['ring', 'HandsFreeOS and Dale’s cell'],
      ['missed', 'Your AI teammate answers when you’re closed'],
      ['quiet', '8 PM to 8 AM'],
    ]);
    expect(lines[1]?.sub).toContain('voicemail for now');
  });

  it('says when answers were saved the way a person would', () => {
    const now = new Date('2026-11-22T18:00:00Z');
    expect(guidedSetupSavedWhen('2026-11-22T15:00:00Z', now, 'America/Chicago')).toBe('today');
    expect(guidedSetupSavedWhen('2026-11-21T15:00:00Z', now, 'America/Chicago')).toBe('yesterday');
    expect(guidedSetupSavedWhen('2026-11-20T15:00:00Z', now, 'America/Chicago')).toBe('on Friday');
    expect(guidedSetupSavedWhen('2026-11-03T15:00:00Z', now, 'America/Chicago')).toBe('on Nov 3');
  });
});

describe('a guided setup’s answers, kept as they are given', () => {
  it('keeps one set per setup, for the people who can change that setting', async () => {
    expect(await ask(guidedSetupGetDraft, { workspaceId: wsId, setup: 'phone' }, owner)).toEqual({
      answers: null,
      savedAt: null,
    });
    const answers = { mode: 'new', at: 'number', texting: true, phones: [{ label: 'Dale' }] };
    await run(guidedSetupSaveDraft, { workspaceId: wsId, setup: 'phone', answers }, owner);
    await run(
      guidedSetupSaveDraft,
      { workspaceId: wsId, setup: 'phone', answers: { ...answers, at: 'ring' } },
      owner,
    );
    // Each setup keeps its own.
    await run(
      guidedSetupSaveDraft,
      { workspaceId: wsId, setup: 'email', answers: { at: 'sender' } },
      owner,
    );
    const saved = await ask(guidedSetupGetDraft, { workspaceId: wsId, setup: 'phone' }, owner);
    expect(saved.answers).toEqual({ ...answers, at: 'ring' });
    expect(saved.savedAt).toEqual(expect.any(String));
    const [count] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.guided_setup_drafts where workspace_id = ${wsId}`,
    );
    expect(count?.n).toBe(2);

    // Someone who can't change the business's number neither saves nor reads its setup.
    const refused = await expectHfos(
      () => run(guidedSetupSaveDraft, { workspaceId: wsId, setup: 'phone', answers: {} }, member),
      'forbidden',
    );
    expect(refused.message).not.toMatch(/channels\.manage/);
    await expectHfos(
      () => ask(guidedSetupGetDraft, { workspaceId: wsId, setup: 'phone' }, member),
      'forbidden',
    );
    await expectHfos(
      () => run(guidedSetupClearDraft, { workspaceId: wsId, setup: 'phone' }, member),
      'forbidden',
    );
    // A setup nobody built isn't kept.
    await expectHfos(
      () => run(guidedSetupSaveDraft, { workspaceId: wsId, setup: 'payroll', answers: {} }, owner),
      'validation',
    );

    expect(await run(guidedSetupClearDraft, { workspaceId: wsId, setup: 'phone' }, owner)).toEqual({
      cleared: true,
    });
    expect(await run(guidedSetupClearDraft, { workspaceId: wsId, setup: 'phone' }, owner)).toEqual({
      cleared: false,
    });
    expect(
      (await ask(guidedSetupGetDraft, { workspaceId: wsId, setup: 'phone' }, owner)).answers,
    ).toBeNull();
    expect(
      (await ask(guidedSetupGetDraft, { workspaceId: wsId, setup: 'email' }, owner)).answers,
    ).toEqual({ at: 'sender' });
  });

  it('asks the database for the same permission the app does', async () => {
    for (const [setup, { permission }] of Object.entries(GUIDED_SETUPS)) {
      const [row] = await rows<{ permission: string | null }>(
        admin(),
        sql`select private.guided_setup_permission(${setup}) as permission`,
      );
      expect(row?.permission, setup).toBe(permission);
    }
    const [unknown] = await rows<{ permission: string | null }>(
      admin(),
      sql`select private.guided_setup_permission('payroll') as permission`,
    );
    expect(unknown?.permission).toBeNull();
  });
});

describe('the last screen: the number bought and everything set, all or nothing', () => {
  const e164 = randomE164();
  const cell = randomE164();
  let numberId: string;

  it('refuses a save that names no number, or both a new one and one they have', async () => {
    await expectHfos(
      () => run(phoneSetupSave, { workspaceId: wsId, texting: 'not_now' }, owner),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          phoneSetupSave,
          {
            workspaceId: wsId,
            buy: { e164, numberType: 'local' },
            phoneNumberId: randomUUID(),
          },
          owner,
        ),
      'validation',
    );
    await expectHfos(
      () => run(phoneSetupSave, { workspaceId: wsId, buy: { e164, numberType: 'local' } }, member),
      'forbidden',
    );
  });

  it('buys the number and sets what rings, what callers get, texting and quiet hours together', async () => {
    // A forwarding phone that is the number itself: nothing is bought, nothing is set.
    await expectHfos(
      () =>
        run(
          phoneSetupSave,
          {
            workspaceId: wsId,
            buy: { e164, numberType: 'local' },
            ring: {
              forwarding: [{ e164, label: 'Oops', enabled: true }],
              forwardedCallerId: 'customer',
            },
          },
          owner,
        ),
      'validation',
    );
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).number).toBeNull();

    const out = await run(
      phoneSetupSave,
      {
        workspaceId: wsId,
        buy: { e164, numberType: 'local' },
        ring: {
          forwarding: [{ e164: cell, label: 'Dale’s cell', enabled: true }],
          forwardedCallerId: 'business',
        },
        missed: { ringSeconds: 15, then: 'teammate', teammateMode: 'after_hours' },
        texting: 'not_now',
        quietHours: { enabled: true, start: '21:00', end: '07:00' },
      },
      owner,
    );
    numberId = out.phoneNumberId;
    // No AI teammate yet: the answer is kept, and callers get the voicemail meanwhile.
    expect(out).toMatchObject({
      bought: true,
      teammate: 'waiting',
      settings: {
        texting: 'not_now',
        teammateAnswers: 'after_hours',
        quietHours: { enabled: true, start: '21:00', end: '07:00' },
      },
    });
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status.number).toMatchObject({
      id: numberId,
      e164,
      status: 'provisioning',
      routing: {
        forwarding: [{ e164: cell, label: 'Dale’s cell', enabled: true }],
        forwardedCallerId: 'business',
        ringSeconds: 15,
        voicemailEnabled: true,
      },
    });
    expect(status.teammate).toBeNull();
    // The worker is told to buy it, as it is for phone_number.buy.
    const [asked] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${wsId} and event_type = 'phone_number.purchase_requested'`,
    );
    expect(asked?.n).toBe(1);
  });

  it('counts a calls-only business’s number as done on Getting started', async () => {
    const [account] = await asWorker(
      testDbs().worker.db,
      { workspaceId: wsId, organizationId: orgId },
      (tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
            values (${wsId}, 'fake', ${`ACfake${randomUUID().slice(0, 8)}`}, 'active') returning id`,
        ),
    );
    await sys(phoneNumberActivate, {
      workspaceId: wsId,
      phoneNumberId: numberId,
      providerSid: `PNfake${randomUUID().slice(0, 8)}`,
      accountId: account!.id,
      capabilities: { sms: true, mms: true, voice: true },
    });
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    // Texting & calls still knows the registration was never sent; nothing nags about it.
    expect(status.nextStep).toBe('submit_registration');
    const guide = await ask(onboardingStatus, { workspaceId: wsId }, owner);
    expect(guide.steps.find((s) => s.key === 'number')?.state).toBe('done');
    // A text from it is refused with what to press, not with a registration nobody asked for.
    const { personId } = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      owner,
    );
    const off = await expectHfos(
      () => run(messageSend, { workspaceId: wsId, personId, body: 'Hi Mike' }, owner),
      'rule_violation',
      'messaging_not_ready',
    );
    expect(off.message).toContain('Turn on texting in Settings → Texting & calls');
    // Turning texting on puts the registration back on the list.
    await run(phoneSetupSave, { workspaceId: wsId, phoneNumberId: numberId, texting: 'on' }, owner);
    const after = await ask(onboardingStatus, { workspaceId: wsId }, owner);
    expect(after.steps.find((s) => s.key === 'number')?.state).not.toBe('done');
  });

  it('has the AI teammate answer from the moment the business sets one up', async () => {
    await run(
      aiTeammateCreate,
      { workspaceId: wsId, preset: 'lead_responder', name: 'Ava', disclosure: 'first_message' },
      owner,
    );
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status.teammate).toMatchObject({
      name: 'Ava',
      answersCalls: true,
      answer: 'after_hours',
      canManage: true,
    });
    expect(status.settings.teammateAnswers).toBeNull();
  });

  it('changes one part later and leaves the rest as it was', async () => {
    const out = await run(
      phoneSetupSave,
      {
        workspaceId: wsId,
        phoneNumberId: numberId,
        missed: {
          ringSeconds: 25,
          then: 'voicemail',
          voicemailGreeting: 'You’ve reached Phone Setup Co. Leave a message.',
        },
      },
      owner,
    );
    expect(out).toMatchObject({ bought: false, teammate: 'off' });
    let status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status.teammate).toMatchObject({ answersCalls: false });
    expect(status.number?.routing).toMatchObject({
      // What rings wasn't part of this save.
      forwarding: [{ e164: cell, label: 'Dale’s cell', enabled: true }],
      forwardedCallerId: 'business',
      ringSeconds: 25,
      voicemailEnabled: true,
      voicemailGreeting: 'You’ve reached Phone Setup Co. Leave a message.',
    });
    expect(status.settings.quietHours).toEqual({ enabled: true, start: '21:00', end: '07:00' });

    // Nothing: no voicemail, and the teammate stays off. The greeting is kept for when voicemail comes back.
    await run(
      phoneSetupSave,
      { workspaceId: wsId, phoneNumberId: numberId, missed: { ringSeconds: 25, then: 'nothing' } },
      owner,
    );
    // And the teammate again, every call.
    const on = await run(
      phoneSetupSave,
      {
        workspaceId: wsId,
        phoneNumberId: numberId,
        missed: { ringSeconds: 20, then: 'teammate', teammateMode: 'always' },
        ring: { forwarding: [], forwardedCallerId: 'customer' },
        quietHours: { enabled: false, start: '20:00', end: '08:00' },
      },
      owner,
    );
    expect(on.teammate).toBe('on');
    status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status.teammate).toMatchObject({ answersCalls: true, answer: 'always' });
    expect(status.number?.routing).toMatchObject({
      forwarding: [],
      forwardedCallerId: 'customer',
      ringSeconds: 20,
      voicemailEnabled: true,
      voicemailGreeting: 'You’ve reached Phone Setup Co. Leave a message.',
    });
    expect(status.settings.quietHours.enabled).toBe(false);
    // Each change to the teammate is one of its revisions, like any other: made, off, on again.
    const [revisions] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_teammate_revisions where workspace_id = ${wsId}`,
    );
    expect(revisions?.n).toBeGreaterThanOrEqual(3);
  });
});
