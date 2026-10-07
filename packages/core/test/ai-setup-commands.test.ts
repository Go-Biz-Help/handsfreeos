/**
 * Quick setup on the local database (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5):
 * - **The look-up** reads the business as each part's own screen does, and starts from what someone answered so
 *   far, else from the picks for its kind of business.
 * - **Keeping the answers** part way through stores them on the business, written only by quick setup. The first
 *   screen saves the business's name, kind and website straight away, and starts reading the website once.
 * - **Save** sets up the teammate (off until it's turned on) with everything around it, in one go: open hours, the
 *   profile, facts and answers, services, a booking calendar, a service area and the website chat. Run again with
 *   nothing changed, it changes nothing.
 * - It's for those who may change the teammate, and refuses answers that started from older teammate settings.
 * - **What Ava read on the website** is asked for once per address (again only when nothing came of it), kept with
 *   the website by the worker alone, and is where the screens start for what the business hasn't said.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AI_SETUP_FACT_TAG, AiSetupAnswers } from '../src/ai-setup/index';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import {
  aiSetupFinish,
  aiSetupGet,
  bookingSiteSetPage,
  aiSetupNoteFound,
  aiSetupSave,
  organizationCreate,
  workspaceUpdate,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;
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
const get = (u: TestUser, workspaceId: string) =>
  executeQuery(api(), aiSetupGet, { workspaceId }, human(u), meta());

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

const settingsOf = async (workspaceId: string) => {
  const [w] = await rows<{ settings: Record<string, unknown> }>(
    admin(),
    sql`select settings from app.workspaces where id = ${workspaceId}`,
  );
  return w!.settings;
};
const eventCount = async (workspaceId: string, type: string) => {
  const [r] = await rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from app.events where workspace_id = ${workspaceId} and event_type = ${type}`,
  );
  return r!.n;
};

let dale: TestUser;
let marco: TestUser;
let ws: string;

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('setup-owner', { fullName: 'Dale Owner' }),
    createTestUser('setup-member', { fullName: 'Marco Member' }),
  ]);
  ws = (
    await run(organizationCreate, { businessName: 'Setup Realty', industry: 'real_estate' }, dale)
  ).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${marco.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('ai_setup.get', () => {
  it('starts a new business from the picks for its kind', async () => {
    const r = await get(dale, ws);
    expect(r.state).toMatchObject({
      businessName: 'Setup Realty',
      kind: 'real_estate',
      teammate: null,
      website: null,
      openHours: null,
      services: [],
      calendars: [],
      chat: null,
      scan: { state: 'none', pending: 0 },
    });
    expect(r.answers).toEqual(r.starting);
    expect(r.answers.jobs).toContain('qualify');
    expect(r).toMatchObject({ reached: null, started: null, finished: null, runs: 0 });
  });

  it('is for those who may change the teammate', async () => {
    await expectHfos(() => get(marco, ws), 'forbidden');
  });
});

describe('ai_setup.save', () => {
  it('saves the first screen to the business, and starts reading the website once', async () => {
    const { starting } = await get(dale, ws);
    const first = await run(
      aiSetupSave,
      {
        workspaceId: ws,
        step: 'business',
        answers: starting,
        business: { name: 'Setup HVAC', industry: 'hvac', website: 'SetupHvac.com' },
      },
      dale,
    );
    expect(first).toMatchObject({
      reached: 'business',
      kind: 'home',
      kindChanged: true,
      scanStarted: true,
    });
    const [w] = await rows<{ name: string; industry: string }>(
      admin(),
      sql`select name, industry from app.workspaces where id = ${ws}`,
    );
    expect(w).toEqual({ name: 'Setup HVAC', industry: 'hvac' });
    expect((await settingsOf(ws))['website']).toBe('https://setuphvac.com/');
    expect(await eventCount(ws, 'ai_setup.read_requested')).toBe(1);

    const again = await run(
      aiSetupSave,
      {
        workspaceId: ws,
        step: 'business',
        answers: starting,
        business: { website: 'https://setuphvac.com' },
      },
      dale,
    );
    expect(again).toMatchObject({ kindChanged: false, scanStarted: false });
    const [scans] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.knowledge_scans where workspace_id = ${ws}`,
    );
    expect(scans!.n).toBe(1);
    expect(await eventCount(ws, 'ai_setup.read_requested')).toBe(1);
  });

  it('picks again what the kind of business picks, after the kind changed', async () => {
    const r = await get(dale, ws);
    expect(r.state.kind).toBe('home');
    expect(r.state.website).toBe('https://setuphvac.com/');
    expect(r.state.scan.state).toBe('running');
    // The draft was answered for a real estate agent: what's picked by kind is picked again for HVAC.
    expect(r.answers.jobs).toEqual(r.starting.jobs);
    expect(r.answers.jobs).not.toContain('qualify');
    expect(r.answers.chat).toBe(true);
  });

  it('keeps the answers part way through, and the furthest screen', async () => {
    const { answers } = await get(dale, ws);
    const about = { ...answers, description: 'Heating and cooling in Katy.' };
    expect(
      (await run(aiSetupSave, { workspaceId: ws, step: 'about', answers: about }, dale)).reached,
    ).toBe('about');
    expect(
      (await run(aiSetupSave, { workspaceId: ws, step: 'jobs', answers: about }, dale)).reached,
    ).toBe('about');
    const r = await get(dale, ws);
    expect(r.answers.description).toBe('Heating and cooling in Katy.');
    expect(r.reached).toBe('about');
    expect(r.started?.by).toBe(dale.id);
    expect(await eventCount(ws, 'ai_setup.started')).toBe(1);
  });

  it('takes the business’s details only from the first screen', async () => {
    const { answers } = await get(dale, ws);
    const err = await expectHfos(
      () =>
        run(
          aiSetupSave,
          { workspaceId: ws, step: 'jobs', answers, business: { name: 'Elsewhere' } },
          dale,
        ),
      'validation',
    );
    expect(err.details).toEqual([expect.objectContaining({ path: 'business' })]);
  });

  it('refuses a website it can’t read', async () => {
    const { answers } = await get(dale, ws);
    await expectHfos(
      () =>
        run(
          aiSetupSave,
          { workspaceId: ws, step: 'business', answers, business: { website: 'localhost' } },
          dale,
        ),
      'validation',
    );
  });

  it('is written only by quick setup, and only by those who may change the teammate', async () => {
    const { answers } = await get(dale, ws);
    await expectHfos(
      () => run(aiSetupSave, { workspaceId: ws, step: 'jobs', answers }, marco),
      'forbidden',
    );
    await expectHfos(
      () => run(workspaceUpdate, { workspaceId: ws, settings: { aiSetup: {} } }, dale),
      'validation',
    );
  });
});

describe('ai_setup.finish', () => {
  it('refuses answers missing what a screen needs, naming it', async () => {
    const { answers } = await get(dale, ws);
    const err = await expectHfos(
      () =>
        run(
          aiSetupFinish,
          { workspaceId: ws, answers: { ...answers, description: '' }, baseRevision: null },
          dale,
        ),
      'validation',
    );
    expect(err.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'answers.description' })]),
    );
  });

  it('sets up the teammate and everything around it, and keeps it off', async () => {
    const { answers } = await get(dale, ws);
    const out = await run(
      aiSetupFinish,
      {
        workspaceId: ws,
        baseRevision: null,
        answers: AiSetupAnswers.parse({
          ...answers,
          jobs: ['reply', 'answer', 'book', 'follow_up'],
          services: [{ name: 'AC repair', description: 'Same week' }],
          area: '77494, 77433',
          facts: { free_estimates: 'yes', licensed: 'no' },
          topQuestions: [{ question: 'Do you work weekends?', answer: 'Saturdays, 8 to noon.' }],
          chat: true,
        }),
      },
      dale,
    );
    expect(out.revision).toBe(1);
    expect(out.changes[0]).toBe('Sets up Ava, your AI teammate');
    expect(out.chat).not.toBeNull();
    expect(out.calendarId).not.toBeNull();

    const [t] = await rows<{ status: string; name: string; config: Record<string, unknown> }>(
      admin(),
      sql`select status::text as status, name, config from app.ai_teammates where id = ${out.teammateId}`,
    );
    expect(t).toMatchObject({ status: 'off', name: 'Ava' });
    expect(t!.config['book']).toMatchObject({ enabled: true, calendarIds: [out.calendarId] });
    expect(t!.config['channels']).toMatchObject({ chat: true, widgetId: out.chat!.widgetId });
    const [widget] = await rows<{ teammate_id: string; allowed_origins: string[] }>(
      admin(),
      sql`select teammate_id, allowed_origins from app.chat_widgets where id = ${out.chat!.widgetId}`,
    );
    expect(widget!.teammate_id).toBe(out.teammateId);
    expect(widget!.allowed_origins).toContain('https://setuphvac.com');

    const items = await rows<{ kind: string; title: string; body: string; tags: string[] }>(
      admin(),
      sql`select kind::text as kind, title, body, tags from app.knowledge_items
          where workspace_id = ${ws} and status = 'published' order by title`,
    );
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'fact',
          title: 'Free estimates',
          body: 'We give free estimates.',
          tags: [AI_SETUP_FACT_TAG],
        }),
        expect.objectContaining({ title: 'Do you work weekends?' }),
      ]),
    );
    // A No that isn't worth telling customers keeps nothing.
    expect(items.some((i) => i.title === 'Licensed and insured')).toBe(false);

    const [profile] = await rows<{ profile: Record<string, unknown> }>(
      admin(),
      sql`select profile from app.knowledge_profiles where workspace_id = ${ws}`,
    );
    expect(profile!.profile).toMatchObject({
      description: 'Heating and cooling in Katy.',
      serviceArea: '77494, 77433',
      services: [{ name: 'AC repair', description: 'Same week', price: null }],
    });
    const [territory] = await rows<{ name: string; postal_codes: string[] }>(
      admin(),
      sql`select name, postal_codes from app.territories where workspace_id = ${ws}`,
    );
    expect(territory).toEqual({ name: 'Service area', postal_codes: ['77433', '77494'] });
    const [calendar] = await rows<{ name: string; status: string; services: number }>(
      admin(),
      sql`select c.name, c.status::text as status,
            (select count(*) from app.calendar_services cs where cs.calendar_id = c.id)::int as services
          from app.calendars c where c.id = ${out.calendarId}`,
    );
    // Turned on, so customers (and Ava) can book it.
    expect(calendar).toEqual({ name: 'Service calls', status: 'active', services: 1 });
    expect(out.notes).toEqual([]);

    const settings = await settingsOf(ws);
    expect(settings['openHours']).toEqual(answers.openHours);
    expect(settings['aiSetup']).toMatchObject({ runs: 1, finished: { by: dale.id } });
    expect(settings['aiSetup']).not.toHaveProperty('draft');
    expect(await eventCount(ws, 'ai_setup.finished')).toBe(1);
  });

  it('reads back what it saved, so running it again changes nothing', async () => {
    const r = await get(dale, ws);
    expect(r.reached).toBeNull();
    expect(r.runs).toBe(1);
    expect(r.state.teammate?.revision).toBe(1);
    expect(r.answers.jobs).toEqual(['reply', 'answer', 'book', 'follow_up']);
    expect(r.answers.facts).toMatchObject({ free_estimates: 'yes' });
    expect(r.answers.chat).toBe(false);
    const out = await run(
      aiSetupFinish,
      { workspaceId: ws, answers: r.answers, baseRevision: 1 },
      dale,
    );
    expect(out).toMatchObject({ revision: 1, changes: [], chat: null, calendarId: null });
    expect((await settingsOf(ws))['aiSetup']).toMatchObject({ runs: 2 });
  });

  it('saves a change as a new revision headed Quick setup', async () => {
    const r = await get(dale, ws);
    const out = await run(
      aiSetupFinish,
      { workspaceId: ws, answers: { ...r.answers, name: 'Max' }, baseRevision: 1 },
      dale,
    );
    expect(out).toMatchObject({ revision: 2, changes: ['Name: Ava → Max'] });
    const [rev] = await rows<{ diff_summary: string[] }>(
      admin(),
      sql`select diff_summary from app.ai_teammate_revisions
          where teammate_id = ${out.teammateId} and revision = 2`,
    );
    expect(rev!.diff_summary).toEqual(['Quick setup', 'Name: Ava → Max']);
  });

  it('refuses answers that started from older teammate settings', async () => {
    const r = await get(dale, ws);
    await expectHfos(
      () => run(aiSetupFinish, { workspaceId: ws, answers: r.answers, baseRevision: 1 }, dale),
      'conflict',
      'revision_conflict',
    );
    await expectHfos(
      () => run(aiSetupFinish, { workspaceId: ws, answers: r.answers, baseRevision: 2 }, marco),
      'forbidden',
    );
  });
});

describe('what Ava read on the website', () => {
  const WEBSITE = 'https://readsite.example/';
  const READ = {
    url: WEBSITE,
    description: 'We fix heating and cooling across Austin.',
    services: [{ name: 'AC repair', description: 'Same day when you call before noon.' }],
    area: 'Austin and Round Rock',
    openHours: [{ day: 1, start: '07:00', end: '18:00' }],
    facts: { emergency: 'yes', financing: 'no' },
    questions: [
      {
        id: 'need',
        question: 'What needs fixing?',
        kind: 'choice',
        options: ['Heating', 'Cooling'],
      },
    ],
  };
  let biz: { ws: string; org: string; sourceId: string };
  const system = (): SystemActor => ({
    type: 'system',
    workspaceId: biz.ws,
    organizationId: biz.org,
    onBehalfOf: dale.id,
  });
  const note = (found: unknown) =>
    executeCommand(
      worker(),
      aiSetupNoteFound,
      { workspaceId: biz.ws, sourceId: biz.sourceId, found },
      system(),
      { ...meta(), channel: 'worker' },
    ).then((r) => r.output);
  const saveFirstScreen = async () => {
    const { answers } = await get(dale, biz.ws);
    await run(
      aiSetupSave,
      { workspaceId: biz.ws, step: 'business', answers, business: { website: 'readsite.example' } },
      dale,
    );
  };
  /** As if it was asked longer ago than it waits before asking again. */
  const askedLongAgo = () =>
    rows(
      admin(),
      sql`update app.knowledge_sources
          set settings = jsonb_set(settings, '{aiSetupReadAsked,at}', to_jsonb(${new Date(Date.now() - 11 * 60_000).toISOString()}::text))
          where id = ${biz.sourceId}`,
    );

  beforeAll(async () => {
    const out = await run(
      organizationCreate,
      { businessName: 'Read Site HVAC', industry: 'hvac' },
      dale,
    );
    biz = { ws: out.workspaceId, org: out.organizationId, sourceId: '' };
    await saveFirstScreen();
    const [src] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.knowledge_sources where workspace_id = ${biz.ws}`,
    );
    biz.sourceId = src!.id;
  });

  it('is asked for once per address, and again only when nothing came of it', async () => {
    // The screens wait for it a little while, then ask instead.
    expect((await get(dale, biz.ws)).state.reading).toBe(true);
    const [asked] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${biz.ws} and event_type = 'ai_setup.read_requested'`,
    );
    expect(asked!.payload).toMatchObject({
      sourceId: biz.sourceId,
      url: WEBSITE,
      requestedBy: dale.id,
    });
    await saveFirstScreen();
    expect(await eventCount(biz.ws, 'ai_setup.read_requested')).toBe(1);
    // The site was down, or no AI was set up: the first screen asks again a while later.
    await askedLongAgo();
    expect((await get(dale, biz.ws)).state.reading).toBe(false);
    await saveFirstScreen();
    expect(await eventCount(biz.ws, 'ai_setup.read_requested')).toBe(2);
  });

  it('is kept with the website, and the screens start from it', async () => {
    expect(await note(READ)).toEqual({ kept: true });
    expect(await eventCount(biz.ws, 'ai_setup.found')).toBe(1);
    const r = await get(dale, biz.ws);
    expect(r.state.found).toMatchObject({ url: WEBSITE, services: [{ name: 'AC repair' }] });
    expect(r.state.reading).toBe(false);
    expect(r.starting).toMatchObject({
      description: 'We fix heating and cooling across Austin.',
      services: [{ name: 'AC repair', description: 'Same day when you call before noon.' }],
      area: 'Austin and Round Rock',
      openHours: READ.openHours,
      facts: { emergency: 'yes', financing: 'no' },
    });
    expect(r.starting.questions.map((q) => q.id)).toEqual(['need']);
    // Read once is enough: the first screen doesn't ask again, however long it's been.
    await askedLongAgo();
    await saveFirstScreen();
    expect(await eventCount(biz.ws, 'ai_setup.read_requested')).toBe(2);
  });

  it('keeps nothing for an address that isn’t the website any more', async () => {
    expect(await note({ ...READ, url: 'https://elsewhere.example/' })).toEqual({ kept: false });
    expect((await get(dale, biz.ws)).state.found?.url).toBe(WEBSITE);
  });

  it('is written by the worker alone', async () => {
    await expectHfos(
      () =>
        run(aiSetupNoteFound, { workspaceId: biz.ws, sourceId: biz.sourceId, found: READ }, dale),
      'forbidden',
    );
  });
});

describe('a business with no website and its simple page', () => {
  let shop: string;
  beforeAll(async () => {
    shop = (await run(organizationCreate, { businessName: 'Page HVAC', industry: 'hvac' }, dale))
      .workspaceId;
  });
  const ready = (answers: AiSetupAnswers) =>
    AiSetupAnswers.parse({
      ...answers,
      description: 'Heating and cooling for Austin homes.',
      services: [{ name: 'AC repair' }],
      chat: true,
    });

  it('offers the chat once the page is on, for the page', async () => {
    expect((await get(dale, shop)).starting.chat).toBe(false);
    await run(bookingSiteSetPage, { workspaceId: shop, on: true }, dale);
    const r = await get(dale, shop);
    expect(r.state.page).not.toBeNull();
    expect(r.starting.chat).toBe(true);
  });

  it('adds the chat at the address the app shows the page at, and says so when it has none', async () => {
    const { answers } = await get(dale, shop);
    const first = await run(
      aiSetupFinish,
      { workspaceId: shop, answers: ready(answers), baseRevision: null },
      dale,
    );
    expect(first.chat).toBeNull();
    expect(first.notes).toEqual([expect.stringContaining('Settings → Website chat')]);

    const out = await run(
      aiSetupFinish,
      {
        workspaceId: shop,
        answers: ready(answers),
        baseRevision: first.revision,
        pageOrigin: 'https://app.handsfreeos.test',
      },
      dale,
    );
    expect(out.changes).toContain('Adds a chat to your page');
    const [widget] = await rows<{ origins: string[]; teammate: string }>(
      admin(),
      sql`select allowed_origins as origins, teammate_id as teammate from app.chat_widgets
          where id = ${out.chat!.widgetId}`,
    );
    expect(widget).toEqual({ origins: ['https://app.handsfreeos.test'], teammate: out.teammateId });
  });
});
