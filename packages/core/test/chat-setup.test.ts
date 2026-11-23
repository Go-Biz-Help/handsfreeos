/**
 * The guided website chat setup (the owner, 23 Nov 2026: W1 a, W2 b, W3 a, W4 b): its own logic (guided-setup/chat.ts)
 * with no database (where the answers start, what is wrong with one, what Turn on website chat sends, the lines
 * beside the questions and on Settings → Website chat), then Turn on website chat (chat_setup.save) on the local
 * database: a new chat and a changed one, the AI teammate's Website chat turned on or moved with it (W1), someone who
 * can't change the teammate still getting their chat, and nothing changing when an answer is wrong.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { chatWidgets, guidedSetupDrafts } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CHAT_DEFAULT_GREETING,
  chatAskSummary,
  chatDoneChips,
  chatSetupAnswersFromWidget,
  chatSetupAnswersOf,
  chatSetupContextFrom,
  chatSetupFirstProblem,
  chatSetupLines,
  chatSetupProblems,
  chatSetupQuestionOf,
  chatSetupStart,
  chatSetupSwatches,
  chatSetupTeammateChange,
  chatSetupTeammateOf,
  chatSetupWidgetFields,
  chatTypedSites,
  type ChatSetupAnswers,
  type ChatSetupTeammate,
  type ChatSetupWidget,
} from '../src';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  aiTeammateCreate,
  aiTeammateGet,
  chatSetupSave,
  chatWidgetCreate,
  chatWidgetGet,
  chatWidgetUpdate,
  guidedSetupSaveDraft,
  organizationCreate,
  permissionSetMember,
} from '../src/server';

const AVA: ChatSetupTeammate = {
  id: '6f0b5f4e-8f61-4b7e-9d0c-2f9a3a1e1c01',
  name: 'Ava',
  status: 'training',
  chatOn: false,
  widgetId: null,
};

const widgetOf = (over: Partial<ChatSetupWidget> = {}): ChatSetupWidget => ({
  id: '0b9cbb57-3a2f-4f0c-9f56-7a1c4f3b9e10',
  name: 'lonestarhvac.com',
  publicKey: 'wk_aaaaaaaaaaaaaaaaaaaa',
  allowedOrigins: ['https://lonestarhvac.com', 'https://www.lonestarhvac.com'],
  teammate: { id: AVA.id, name: 'Ava', status: 'training' },
  greeting: 'Hi! Questions about a repair?',
  launcherLabel: 'Ask us',
  accentColor: '#0E7490',
  showLogo: false,
  placement: {
    desktop: { position: 'left', lift: 0, button: 'icon' },
    mobile: { position: 'left', ownPosition: false, lift: 60, button: 'label' },
  },
  awayMessage: 'Back at 8.',
  whenAway: 'away_form',
  askFor: { name: 'before_chat', phone: 'when_needed', email: 'never' },
  smsConsent: false,
  paused: false,
  install: { seen: false, lastSeenOrigin: null, lastSeenAt: null },
  ...over,
});

const NEW = chatSetupContextFrom({
  widget: null,
  teammate: AVA,
  website: 'lonestarhvacroofing.com',
  brandColor: '#B42318',
  hasLogo: true,
});

describe('where the answers start', () => {
  it('starts a new chat from sign-up: the website, the business colour, the AI teammate answering', () => {
    expect(NEW.mode).toBe('new');
    expect(NEW.brandColor).toBe('#b42318');
    expect(chatSetupStart(NEW)).toEqual({
      sites: ['lonestarhvacroofing.com'],
      who: 'ai',
      whenAway: 'chat',
      awayMessage: '',
      askName: 'when_needed',
      askPhone: 'when_needed',
      askEmail: 'when_needed',
      smsConsent: true,
      greeting: CHAT_DEFAULT_GREETING,
      launcherLabel: 'Chat with us',
      accentColor: '#b42318',
      showLogo: true,
      position: 'right',
      desktopButton: 'label',
      phone: 'same',
      mobileLift: 90,
      mobileButton: 'icon',
    });
  });

  it('starts with only the team and no site when there is no teammate and the website is no good', () => {
    const ctx = chatSetupContextFrom({
      widget: null,
      teammate: null,
      website: '192.168.1.5',
      brandColor: 'red',
      hasLogo: false,
    });
    expect(ctx.brandColor).toBeNull();
    expect(chatSetupStart(ctx)).toMatchObject({ sites: [], who: 'team', accentColor: '#2d69d8' });
  });

  it('starts a chat that is set up from what it has, its sites as typed', () => {
    const w = widgetOf();
    const ctx = chatSetupContextFrom({
      widget: w,
      teammate: AVA,
      website: null,
      brandColor: null,
      hasLogo: true,
    });
    expect(ctx.mode).toBe('again');
    expect(chatSetupStart(ctx)).toEqual({
      sites: ['https://lonestarhvac.com'],
      who: 'ai',
      whenAway: 'away_form',
      awayMessage: 'Back at 8.',
      askName: 'before_chat',
      askPhone: 'when_needed',
      askEmail: 'never',
      smsConsent: false,
      greeting: 'Hi! Questions about a repair?',
      launcherLabel: 'Ask us',
      accentColor: '#0e7490',
      showLogo: false,
      position: 'left',
      desktopButton: 'icon',
      phone: 'lift',
      mobileLift: 60,
      mobileButton: 'label',
    });
    const hidden = chatSetupAnswersFromWidget(
      widgetOf({
        teammate: null,
        placement: {
          desktop: { position: 'right', lift: 0, button: 'label' },
          mobile: { position: 'right', ownPosition: false, lift: 0, button: 'hidden' },
        },
      }),
    );
    expect(hidden).toMatchObject({
      who: 'team',
      phone: 'hidden',
      mobileLift: 90,
      mobileButton: 'icon',
    });
    expect(
      chatTypedSites(['https://acme.com', 'https://www.acme.com', 'http://localhost:4191']),
    ).toEqual(['https://acme.com', 'http://localhost:4191']);
  });

  it('reads saved answers back a field at a time, leaving one that no longer fits at its start', () => {
    const start = chatSetupStart(NEW);
    const back = chatSetupAnswersOf(
      { who: 'team', greeting: 'Howdy!', phone: 'sideways', mobileLift: 9000, at: 'look' },
      start,
    );
    expect(back).toEqual({ ...start, who: 'team', greeting: 'Howdy!' });
    expect(chatSetupAnswersOf(null, start)).toEqual(start);
  });

  it('offers the business colour first, then the usual six, then the one picked', () => {
    expect(chatSetupSwatches({ brandColor: '#123456' }, '#ABCDEF')).toEqual([
      '#123456',
      '#b42318',
      '#2d69d8',
      '#0e7490',
      '#008743',
      '#7c3aed',
      '#191d25',
      '#abcdef',
    ]);
    expect(chatSetupSwatches({ brandColor: '#b42318' }, '#b42318')).toHaveLength(6);
  });
});

describe('the AI teammate’s Website chat (W1)', () => {
  it('turns it on, moves it, or leaves it as it is', () => {
    const w = { id: 'w1' };
    expect(chatSetupTeammateChange({ who: 'team' }, { teammate: AVA, widget: w })).toBe('none');
    expect(chatSetupTeammateChange({ who: 'ai' }, { teammate: null, widget: w })).toBe('none');
    expect(chatSetupTeammateChange({ who: 'ai' }, { teammate: AVA, widget: null })).toBe('turn_on');
    const on = { ...AVA, chatOn: true };
    expect(chatSetupTeammateChange({ who: 'ai' }, { teammate: on, widget: null })).toBe('turn_on');
    expect(
      chatSetupTeammateChange({ who: 'ai' }, { teammate: { ...on, widgetId: 'w1' }, widget: w }),
    ).toBe('on');
    expect(
      chatSetupTeammateChange({ who: 'ai' }, { teammate: { ...on, widgetId: 'w2' }, widget: w }),
    ).toBe('move');
    expect(
      chatSetupTeammateChange({ who: 'ai' }, { teammate: { ...on, widgetId: 'w2' }, widget: null }),
    ).toBe('move');
  });

  it('reads the channel from the teammate’s saved settings', () => {
    expect(chatSetupTeammateOf(null)).toBeNull();
    expect(
      chatSetupTeammateOf({
        id: AVA.id,
        name: 'Ava',
        status: 'automatic',
        config: { channels: { chat: true, widgetId: 'w9' } },
      }),
    ).toEqual({ id: AVA.id, name: 'Ava', status: 'automatic', chatOn: true, widgetId: 'w9' });
  });
});

describe('what stops Next', () => {
  const good = chatSetupStart(NEW);
  const msg = (q: Parameters<typeof chatSetupProblems>[0], a: Partial<ChatSetupAnswers>) =>
    chatSetupProblems(q, { ...good, ...a }, NEW).map((p) => [p.path, p.message]);

  it('lets good answers through', () => {
    expect(chatSetupFirstProblem(good, NEW)).toBeNull();
  });

  it('says what is wrong with each answer, in plain words', () => {
    expect(msg('sites', { sites: [] })).toEqual([
      ['sites', 'Add the website the chat goes on, like acme.com.'],
    ]);
    expect(msg('sites', { sites: ['*.acme.com'] })[0]![1]).toMatch(/Wildcards/);
    expect(chatSetupProblems('who', { ...good, who: 'ai' }, { teammate: null })).toEqual([
      {
        path: 'who',
        message: 'You don’t have an AI teammate yet. Set one up first, or pick Only your team.',
      },
    ]);
    expect(msg('away', { awayMessage: 'x'.repeat(501) })).toEqual([
      ['awayMessage', 'Keep it under 500 characters.'],
    ]);
    expect(msg('look', { launcherLabel: '  ', accentColor: 'blue' })).toEqual([
      ['launcherLabel', 'Give the button some words, like Chat with us.'],
      ['accentColor', 'Pick a colour like #2d69d8.'],
    ]);
    expect(msg('look', { launcherLabel: 'x'.repeat(41) })[0]![0]).toBe('launcherLabel');
    expect(msg('place', { phone: 'lift', mobileLift: 0 })[0]![0]).toBe('mobileLift');
    expect(msg('place', { phone: 'same', mobileLift: 0 })).toEqual([]);
    expect(chatSetupFirstProblem({ ...good, accentColor: 'nope' }, NEW)).toBe('look');
  });

  it('finds the question a refusal is about, from the setup’s path or the chat’s own', () => {
    expect(chatSetupQuestionOf('answers.greeting')).toEqual({
      question: 'look',
      field: 'greeting',
    });
    expect(chatSetupQuestionOf('allowedOrigins.1')).toEqual({ question: 'sites', field: 'sites' });
    expect(chatSetupQuestionOf('askFor.email')).toEqual({ question: 'ask', field: 'askEmail' });
    expect(chatSetupQuestionOf('teammateId')).toEqual({ question: 'who', field: 'who' });
    expect(chatSetupQuestionOf('dailyCap')).toBeNull();
  });
});

describe('what Turn on website chat sends', () => {
  const good = chatSetupStart(NEW);

  it('sends every answer, the phone’s button as the phone answer says', () => {
    expect(chatSetupWidgetFields({ ...good, greeting: '  Hi!  ' }, AVA.id)).toEqual({
      allowedOrigins: ['lonestarhvacroofing.com'],
      teammateId: AVA.id,
      greeting: 'Hi!',
      launcherLabel: 'Chat with us',
      accentColor: '#b42318',
      showLogo: true,
      position: 'right',
      desktopButton: 'label',
      mobileButton: 'icon',
      mobileLift: 0,
      whenAway: 'chat',
      awayMessage: '',
      askFor: { name: 'when_needed', phone: 'when_needed', email: 'when_needed' },
      smsConsent: true,
    });
    expect(chatSetupWidgetFields({ ...good, phone: 'lift', mobileLift: 120 }, null)).toMatchObject({
      teammateId: null,
      mobileLift: 120,
    });
    const hidden = chatSetupWidgetFields({ ...good, phone: 'hidden', who: 'team' }, AVA.id);
    expect(hidden).toMatchObject({ teammateId: null, mobileButton: 'hidden' });
    expect(hidden).not.toHaveProperty('mobileLift');
  });
});

describe('the lines', () => {
  it('says each answer in a line, for the list, Check it over and Settings', () => {
    const a = {
      ...chatSetupStart(NEW),
      sites: ['lonestarhvacroofing.com', 'localhost:4191', 'acme.es'],
      askEmail: 'never' as const,
      phone: 'lift' as const,
    };
    expect(chatSetupLines(a, NEW).map((l) => [l.key, l.value])).toEqual([
      ['sites', 'lonestarhvacroofing.com and 2 more'],
      ['who', 'Ava, and your team can jump in'],
      ['away', 'Let them chat anyway'],
      ['ask', 'Name and mobile when needed, email never. Offers the box to get texts.'],
      ['look', 'Your colour, “Chat with us”, with your logo'],
      ['place', 'Bottom right with words. Just the icon on phones, moved up above a bar.'],
    ]);
    expect(
      chatAskSummary({ askName: 'before_chat', askPhone: 'before_chat', askEmail: 'before_chat' }),
    ).toBe('Name, mobile and email before the chat starts');
    expect(chatDoneChips(a, NEW)).toEqual([
      'lonestarhvacroofing.com',
      'Ava answers',
      'Chats anyway after hours',
      'Moved up on phones',
    ]);
  });
});

// ---------- on the local database ----------

const api = () => testDbs().api.db;
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
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code']) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).code).toBe(code);
    return e as HfosError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

describe('Turn on website chat', () => {
  let owner: TestUser;
  let manager: TestUser;
  let member: TestUser;
  let wsId: string;
  let teammateId: string;
  const ctxNow = () =>
    chatSetupContextFrom({
      widget: null,
      teammate: { id: teammateId, name: 'Ava', status: 'training', chatOn: false, widgetId: null },
      website: 'lonestarhvac.com',
      brandColor: '#b42318',
      hasLogo: false,
    });
  const channels = async () => {
    const got = await ask(aiTeammateGet, { workspaceId: wsId }, owner);
    return (got.teammate?.config as { channels: { chat: boolean; widgetId: string | null } })
      .channels;
  };

  beforeAll(async () => {
    [owner, manager, member] = await Promise.all([
      createTestUser('chat-setup-owner', { fullName: 'Dale Owner' }),
      createTestUser('chat-setup-admin', { fullName: 'Priya Admin' }),
      createTestUser('chat-setup-member', { fullName: 'Marco Member' }),
    ]);
    wsId = (await run(organizationCreate, { businessName: 'Chat Setup HVAC' }, owner)).workspaceId;
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${wsId}, ${manager.id}, 'admin'), (${wsId}, ${member.id}, 'member')`,
    );
    teammateId = (
      await run(
        aiTeammateCreate,
        { workspaceId: wsId, preset: 'lead_responder', name: 'Ava', disclosure: 'first_message' },
        owner,
      )
    ).teammateId;
  });
  afterAll(closeTestDbs);

  it('refuses wrong answers in the setup’s words, and changes nothing', async () => {
    const answers = { ...chatSetupStart(ctxNow()), sites: ['*.acme.com'], launcherLabel: '' };
    const err = await expectHfos(
      () => run(chatSetupSave, { workspaceId: wsId, widgetId: null, answers }, owner),
      'validation',
    );
    expect(err.details).toEqual([
      { path: 'answers.sites', message: expect.stringMatching(/Wildcards/) },
      { path: 'answers.launcherLabel', message: 'Give the button some words, like Chat with us.' },
    ]);
    const made = await admin().select().from(chatWidgets).where(eq(chatWidgets.workspaceId, wsId));
    expect(made).toHaveLength(0);
  });

  it('leaves out someone who can’t change the business’s channels', async () => {
    await expectHfos(
      () =>
        run(
          chatSetupSave,
          { workspaceId: wsId, widgetId: null, answers: chatSetupStart(ctxNow()) },
          member,
        ),
      'forbidden',
    );
  });

  let widgetId: string;
  it('makes the chat with every answer, turns on Ava’s Website chat for it, and spends the answers', async () => {
    await run(
      guidedSetupSaveDraft,
      { workspaceId: wsId, setup: 'chat', answers: { who: 'ai', at: 'review' } },
      owner,
    );
    const answers: ChatSetupAnswers = {
      ...chatSetupStart(ctxNow()),
      whenAway: 'away_form',
      awayMessage: 'We’re out on a job. Leave your number.',
      askEmail: 'never',
      phone: 'lift',
      mobileLift: 120,
    };
    const out = await run(chatSetupSave, { workspaceId: wsId, widgetId: null, answers }, owner);
    expect(out).toMatchObject({
      created: true,
      teammateChat: 'turned_on',
      publicKey: expect.stringMatching(/^wk_/),
    });
    widgetId = out.widgetId;
    const { widget } = await ask(chatWidgetGet, { workspaceId: wsId, widgetId }, owner);
    expect(widget).toMatchObject({
      allowedOrigins: ['https://lonestarhvac.com', 'https://www.lonestarhvac.com'],
      teammate: { id: teammateId, name: 'Ava' },
      accentColor: '#b42318',
      whenAway: 'away_form',
      awayMessage: 'We’re out on a job. Leave your number.',
      askFor: { name: 'when_needed', phone: 'when_needed', email: 'never' },
      smsConsent: true,
      placement: { mobile: { lift: 120, button: 'icon' }, desktop: { button: 'label' } },
    });
    expect(await channels()).toMatchObject({ chat: true, widgetId });
    const drafts = await admin()
      .select()
      .from(guidedSetupDrafts)
      .where(and(eq(guidedSetupDrafts.workspaceId, wsId), eq(guidedSetupDrafts.setup, 'chat')));
    expect(drafts).toHaveLength(0);
  });

  it('changes that chat, leaving what the setup doesn’t ask as it was', async () => {
    await run(
      chatWidgetUpdate,
      { workspaceId: wsId, widgetId, dailyCap: 150, name: 'Main site' },
      owner,
    );
    const { widget: before } = await ask(chatWidgetGet, { workspaceId: wsId, widgetId }, owner);
    const answers = {
      ...chatSetupAnswersFromWidget(before),
      greeting: 'Howdy! Need a hand?',
      phone: 'hidden' as const,
    };
    const out = await run(chatSetupSave, { workspaceId: wsId, widgetId, answers }, owner);
    expect(out).toMatchObject({
      widgetId,
      created: false,
      teammateChat: 'on',
      publicKey: before.publicKey,
    });
    const { widget } = await ask(chatWidgetGet, { workspaceId: wsId, widgetId }, owner);
    expect(widget).toMatchObject({
      greeting: 'Howdy! Need a hand?',
      name: 'Main site',
      dailyCap: 150,
      placement: { mobile: { button: 'hidden', lift: 120 } },
    });
  });

  it('moves Ava’s Website chat to another chat when she’s picked there', async () => {
    const other = (
      await run(chatWidgetCreate, { workspaceId: wsId, allowedOrigins: ['acme.es'] }, owner)
    ).widgetId;
    const { widget } = await ask(chatWidgetGet, { workspaceId: wsId, widgetId: other }, owner);
    const out = await run(
      chatSetupSave,
      {
        workspaceId: wsId,
        widgetId: other,
        answers: { ...chatSetupAnswersFromWidget(widget), who: 'ai' },
      },
      owner,
    );
    expect(out.teammateChat).toBe('turned_on');
    expect(await channels()).toMatchObject({ chat: true, widgetId: other });
  });

  it('still saves the chat for someone who can’t change the AI teammate, and says so', async () => {
    await run(
      permissionSetMember,
      { workspaceId: wsId, userId: manager.id, permission: 'ai_team.manage', allowed: false },
      owner,
    );
    const { widget } = await ask(chatWidgetGet, { workspaceId: wsId, widgetId }, manager);
    const out = await run(
      chatSetupSave,
      {
        workspaceId: wsId,
        widgetId,
        answers: { ...chatSetupAnswersFromWidget(widget), who: 'ai', greeting: 'Hi there' },
      },
      manager,
    );
    expect(out).toMatchObject({ created: false, teammateChat: 'not_allowed' });
    const { widget: after } = await ask(chatWidgetGet, { workspaceId: wsId, widgetId }, owner);
    expect(after.greeting).toBe('Hi there');
    // Ava stays on the other chat.
    expect((await channels()).widgetId).not.toBe(widgetId);
  });
});
