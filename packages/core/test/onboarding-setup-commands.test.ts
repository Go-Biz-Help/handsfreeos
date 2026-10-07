/**
 * The onboarding setup on the local database (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5):
 * - **The look-up** reads the business as each part's own screen does, and starts from what someone answered so
 *   far, else from the picks for its kind of business.
 * - **Leaving a screen** keeps the answers on the business, so someone can carry on from the phone, and saves what
 *   can't wait: the business itself (Ava starts reading its website once), invitations and Getting started's
 *   answers, where customers are, the booking page, and the review link.
 * - **Stay in the loop** saves the rest in one go: the AI teammate (off until it's turned on) and everything around
 *   it, the price list and the person's own hours. Run again with nothing changed, it changes nothing.
 * - It's for those who may change the business, and refuses answers that started from older teammate settings.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta } from '../src/kernel/types';
import { OnboardingSetupAnswers } from '../src/onboarding-setup/index';
import {
  bookingSiteSetPage,
  onboardingSetupFinish,
  onboardingSetupGet,
  onboardingSetupSave,
  organizationCreate,
  workspaceUpdate,
} from '../src/server';

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
const get = (u: TestUser, workspaceId: string) =>
  executeQuery(api(), onboardingSetupGet, { workspaceId }, human(u), meta());

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

const AUSTIN = { line1: '12 Oak St', city: 'Austin', state: 'tx', postalCode: '78701' };
const OPEN = [2, 3, 4, 5, 6].map((day) => ({ day, start: '10:00', end: '19:00' }));

let dale: TestUser;
let marco: TestUser;
let ws: string;

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('onboard-owner', { fullName: 'Dale Owner' }),
    createTestUser('onboard-member', { fullName: 'Marco Member' }),
  ]);
  ws = (
    await run(organizationCreate, { businessName: 'Setup Plumbing', industry: 'plumbing' }, dale)
  ).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${marco.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('onboarding_setup.get', () => {
  it('starts a new business from the picks for its kind', async () => {
    const r = await get(dale, ws);
    expect(r.state).toMatchObject({
      businessName: 'Setup Plumbing',
      kind: 'home',
      address: null,
      reviewLink: null,
      quick: null,
      booking: { on: false, site: null },
      team: { members: 2, invited: [] },
      bookable: [],
      priceList: [],
      myHours: null,
      customers: { count: 0, running: null, asYouGo: false },
      numberSetup: { next: 'buy_number' },
    });
    expect(r.answers).toEqual(r.starting);
    // Customers of a plumber don't book a time: Ava answers leads, and books nothing.
    expect(r.answers).toMatchObject({
      booksTime: false,
      goal: 'leads',
      customersIn: 'none',
      payWith: 'later',
    });
    expect(r.answers.ai.jobs).not.toContain('book');
    expect(r).toMatchObject({ reached: null, started: null, finished: null });
  });

  it('is for those who may change the business', async () => {
    await expectHfos(() => get(marco, ws), 'forbidden');
  });
});

describe('onboarding_setup.save', () => {
  it('saves the first screen to the business, and starts reading the website once', async () => {
    const { starting } = await get(dale, ws);
    const first = await run(
      onboardingSetupSave,
      {
        workspaceId: ws,
        screen: 'business',
        answers: starting,
        business: {
          name: 'Bella Salon',
          industry: 'hair_salon',
          address: AUSTIN,
          timezone: 'America/Chicago',
          website: 'BellaSalon.example',
        },
      },
      dale,
    );
    expect(first).toMatchObject({
      reached: 'business',
      kind: 'salon',
      kindChanged: true,
      scanStarted: true,
      invited: [],
      calendarId: null,
    });
    const [w] = await rows<{ name: string; industry: string; timezone: string }>(
      admin(),
      sql`select name, industry, timezone from app.workspaces where id = ${ws}`,
    );
    expect(w).toEqual({ name: 'Bella Salon', industry: 'hair_salon', timezone: 'America/Chicago' });
    const settings = await settingsOf(ws);
    expect(settings['website']).toBe('https://bellasalon.example/');
    expect(settings['address']).toEqual({
      line1: '12 Oak St',
      line2: '',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    });
    expect(settings['onboardingSetup']).toMatchObject({
      reached: 'business',
      kind: 'home',
      started: { by: dale.id },
    });
    expect(await eventCount(ws, 'ai_setup.read_requested')).toBe(1);
    expect(await eventCount(ws, 'onboarding_setup.started')).toBe(1);

    const again = await run(
      onboardingSetupSave,
      {
        workspaceId: ws,
        screen: 'business',
        answers: starting,
        business: { website: 'https://bellasalon.example' },
      },
      dale,
    );
    expect(again).toMatchObject({ kindChanged: false, scanStarted: false, changes: [] });
    expect(await eventCount(ws, 'ai_setup.read_requested')).toBe(1);
    expect(await eventCount(ws, 'onboarding_setup.started')).toBe(1);
  });

  it('picks again what the kind of business picks, after the kind changed', async () => {
    const r = await get(dale, ws);
    expect(r.state).toMatchObject({
      kind: 'salon',
      website: 'https://bellasalon.example/',
      address: { city: 'Austin', state: 'TX' },
      timeZone: 'America/Chicago',
    });
    // The first screen was answered for a plumber: a salon's customers book a time, and Ava books them.
    expect(r.answers).toMatchObject({ booksTime: true, goal: 'booked' });
    expect(r.answers.ai.jobs).toContain('book');
    expect(r.reached).toBe('business');
  });

  it('invites the team and saves Getting started’s answers from the goal screen', async () => {
    const { answers } = await get(dale, ws);
    const out = await run(
      onboardingSetupSave,
      {
        workspaceId: ws,
        screen: 'goal',
        answers: { ...answers, teamSize: 'small' },
        invite: ['sam@hfos.test', 'SAM@hfos.test', marco.email],
      },
      dale,
    );
    expect(out.invited).toEqual(['sam@hfos.test']);
    expect(out.changes).toEqual(['Invites sam@hfos.test to the team']);
    expect(out.notes).toEqual([expect.stringContaining('is already in this business')]);
    const invitations = await rows<{ email: string; role: string }>(
      admin(),
      sql`select email::text as email, role::text as role from app.invitations where workspace_id = ${ws}`,
    );
    expect(invitations).toEqual([{ email: 'sam@hfos.test', role: 'member' }]);
    expect((await settingsOf(ws))['onboarding']).toMatchObject({
      answers: { goal: 'booked', customersIn: 'none', teamSize: 'small' },
    });

    const r = await get(dale, ws);
    expect(r.reached).toBe('goal');
    expect(r.state.team.invited).toEqual(['sam@hfos.test']);
    expect(r.state.quick).toEqual({ goal: 'booked', customersIn: 'none', teamSize: 'small' });
    expect(r.answers.teamSize).toBe('small');

    // Invited again from the same screen, they're a note, not a second invitation.
    const twice = await run(
      onboardingSetupSave,
      { workspaceId: ws, screen: 'goal', answers: r.answers, invite: ['sam@hfos.test'] },
      dale,
    );
    expect(twice).toMatchObject({ invited: [], changes: [] });
    expect(twice.notes).toHaveLength(1);
  });

  it('takes the business’s details and invitations only from their own screens', async () => {
    const { answers } = await get(dale, ws);
    const business = await expectHfos(
      () =>
        run(
          onboardingSetupSave,
          { workspaceId: ws, screen: 'about', answers, business: { name: 'Elsewhere' } },
          dale,
        ),
      'validation',
    );
    expect(business.details).toEqual([expect.objectContaining({ path: 'business' })]);
    const invite = await expectHfos(
      () =>
        run(
          onboardingSetupSave,
          { workspaceId: ws, screen: 'about', answers, invite: ['pat@hfos.test'] },
          dale,
        ),
      'validation',
    );
    expect(invite.details).toEqual([expect.objectContaining({ path: 'invite' })]);
  });

  it('keeps where customers are, and “Add them as you go”', async () => {
    const { answers } = await get(dale, ws);
    await run(
      onboardingSetupSave,
      { workspaceId: ws, screen: 'customers', answers: { ...answers, customersIn: 'none' } },
      dale,
    );
    expect((await settingsOf(ws))['onboarding']).toMatchObject({
      customersAsYouGo: { by: dale.id },
    });
    expect((await get(dale, ws)).state.customers.asYouGo).toBe(true);

    await run(
      onboardingSetupSave,
      { workspaceId: ws, screen: 'customers', answers: { ...answers, customersIn: 'sheet' } },
      dale,
    );
    const r = await get(dale, ws);
    expect(r.state.customers.asYouGo).toBe(false);
    expect(r.state.quick?.customersIn).toBe('sheet');
    expect(r.answers.customersIn).toBe('sheet');
  });

  it('makes the booking page from the services and hours so far, and turns it on', async () => {
    const { answers } = await get(dale, ws);
    const about = OnboardingSetupAnswers.parse({
      ...answers,
      ai: {
        ...answers.ai,
        description: 'Cuts, color and styling in downtown Austin.',
        services: [
          { name: 'Haircut', priceCents: 4500, minutes: 45 },
          { name: 'Color', minutes: 90 },
        ],
        openHours: OPEN,
      },
    });
    for (const screen of ['about', 'hours'] as const)
      await run(onboardingSetupSave, { workspaceId: ws, screen, answers: about }, dale);
    const out = await run(
      onboardingSetupSave,
      { workspaceId: ws, screen: 'booking', answers: about },
      dale,
    );
    expect(out.calendarId).not.toBeNull();
    expect(out.notes).toEqual([]);
    expect(out.changes).toEqual([
      'Adds the services Haircut and Color to Calendars',
      'Makes the booking calendar Appointments, with your services on it',
      'Your hours: Tue–Sat 10:00 AM–7:00 PM',
      'Turns on your booking page',
    ]);

    const services = await rows<{ name: string; minutes: number; price: number | null }>(
      admin(),
      sql`select name, default_duration as minutes, price_cents as price from app.services
          where workspace_id = ${ws} order by name`,
    );
    expect(services).toEqual([
      { name: 'Color', minutes: 90, price: null },
      { name: 'Haircut', minutes: 45, price: 4500 },
    ]);
    const [calendar] = await rows<{ name: string; status: string; services: number }>(
      admin(),
      sql`select c.name, c.status::text as status,
            (select count(*) from app.calendar_services cs where cs.calendar_id = c.id)::int as services
          from app.calendars c where c.id = ${out.calendarId}`,
    );
    // Turned on, so customers can book it.
    expect(calendar).toEqual({ name: 'Appointments', status: 'active', services: 2 });
    const [site] = await rows<{ enabled: boolean }>(
      admin(),
      sql`select enabled from app.booking_sites where workspace_id = ${ws}`,
    );
    expect(site!.enabled).toBe(true);
    const [hours] = await rows<{ weekly: unknown }>(
      admin(),
      sql`select weekly from app.schedules
          where workspace_id = ${ws} and owner_kind = 'user' and owner_id = ${dale.id}`,
    );
    expect(hours!.weekly).toEqual(OPEN);

    const r = await get(dale, ws);
    expect(r.reached).toBe('booking');
    expect(r.state.booking).toMatchObject({ on: true, site: { enabled: true } });
    expect(r.state.bookable.map((s) => s.name)).toEqual(['Color', 'Haircut']);
    expect(r.answers.ai.services).toEqual(about.ai.services);

    // Leaving the stop again changes nothing: the page is there and on.
    const again = await run(
      onboardingSetupSave,
      { workspaceId: ws, screen: 'booking', answers: r.answers },
      dale,
    );
    expect(again).toMatchObject({ calendarId: null, changes: [], notes: [] });
    const [calendars] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.calendars where workspace_id = ${ws}`,
    );
    expect(calendars!.n).toBe(1);
  });

  it('saves the review link for thank-you texts, and refuses one it can’t open', async () => {
    const { answers } = await get(dale, ws);
    const out = await run(
      onboardingSetupSave,
      {
        workspaceId: ws,
        screen: 'paid',
        answers: { ...answers, reviewLink: 'g.page/r/bella/review' },
      },
      dale,
    );
    expect(out.changes).toEqual(['Thank-you texts send your Google review link']);
    expect((await settingsOf(ws))['links']).toMatchObject({
      review: 'https://g.page/r/bella/review',
    });
    expect((await get(dale, ws)).state.reviewLink).toBe('https://g.page/r/bella/review');

    const err = await expectHfos(
      () =>
        run(
          onboardingSetupSave,
          { workspaceId: ws, screen: 'paid', answers: { ...answers, reviewLink: 'localhost' } },
          dale,
        ),
      'validation',
    );
    expect(err.details).toEqual([expect.objectContaining({ path: 'answers.reviewLink' })]);
  });

  it('is written only by the setup, and only by those who may change the business', async () => {
    const { answers } = await get(dale, ws);
    await expectHfos(
      () => run(onboardingSetupSave, { workspaceId: ws, screen: 'jobs', answers }, marco),
      'forbidden',
    );
    await expectHfos(
      () => run(workspaceUpdate, { workspaceId: ws, settings: { onboardingSetup: {} } }, dale),
      'validation',
    );
  });
});

describe('the simple page', () => {
  let shop: string;
  beforeAll(async () => {
    shop = (
      await run(organizationCreate, { businessName: 'Page Plumbing', industry: 'plumbing' }, dale)
    ).workspaceId;
  });
  const about = (answers: OnboardingSetupAnswers) =>
    OnboardingSetupAnswers.parse({
      ...answers,
      ai: {
        ...answers.ai,
        description: 'Leaks and drains fixed fast, all over Austin.',
        services: [{ name: 'Drain cleaning' }, { name: 'Leak repair' }],
        area: 'Austin and Round Rock',
        openHours: OPEN,
      },
    });
  const siteOf = async (workspaceId: string) => {
    const [site] = await rows<{ page: boolean; enabled: boolean; slug: string }>(
      admin(),
      sql`select page_enabled as page, enabled, slug::text as slug from app.booking_sites
          where workspace_id = ${workspaceId}`,
    );
    return site;
  };

  it('goes live for a business with no website, with what it does and its hours saved first', async () => {
    const { answers } = await get(dale, shop);
    const a = about(answers);
    const out = await run(
      onboardingSetupSave,
      { workspaceId: shop, screen: 'page', answers: a },
      dale,
    );
    expect(out.changes).toEqual([
      'Puts your page live',
      'Open hours: Tue–Sat 10:00 AM–7:00 PM',
      'Business profile: what you do, services, where you work and hours updated',
    ]);
    // The page is the booking site's, made here still not taking bookings.
    expect(await siteOf(shop)).toMatchObject({ page: true, enabled: false });
    expect((await settingsOf(shop))['openHours']).toEqual(OPEN);
    const [profile] = await rows<{ profile: Record<string, unknown> }>(
      admin(),
      sql`select profile from app.knowledge_profiles where workspace_id = ${shop}`,
    );
    expect(profile!.profile).toMatchObject({
      description: 'Leaks and drains fixed fast, all over Austin.',
      services: [{ name: 'Drain cleaning' }, { name: 'Leak repair' }],
      serviceArea: 'Austin and Round Rock',
      hours: 'Tue–Sat 10:00 AM–7:00 PM',
    });
    expect(await eventCount(shop, 'booking_site.page_set')).toBe(1);

    const r = await get(dale, shop);
    expect(r.state.page).toEqual({ slug: (await siteOf(shop))!.slug });
    // With the page on, Ava's chat can go on it, and is picked.
    expect(r.answers.ai.chat).toBe(true);
    const again = await run(
      onboardingSetupSave,
      { workspaceId: shop, screen: 'page', answers: r.answers },
      dale,
    );
    expect(again.changes).toEqual([]);
    expect(await eventCount(shop, 'booking_site.page_set')).toBe(1);
  });

  it('puts the chat on the page at the address it’s shown at, answered by Ava', async () => {
    const { answers } = await get(dale, shop);
    const out = await run(
      onboardingSetupFinish,
      {
        workspaceId: shop,
        answers: { ...answers, ai: { ...answers.ai, chat: true } },
        baseRevision: null,
        pageOrigin: 'https://app.handsfreeos.test',
      },
      dale,
    );
    expect(out.changes).toContain('Adds a chat to your page');
    const [widget] = await rows<{ origins: string[]; teammate: string | null }>(
      admin(),
      sql`select allowed_origins as origins, teammate_id as teammate from app.chat_widgets
          where workspace_id = ${shop}`,
    );
    expect(widget).toEqual({ origins: ['https://app.handsfreeos.test'], teammate: out.teammateId });
  });

  it('turns off on Not now, and leaves a business with a website alone', async () => {
    const { answers } = await get(dale, shop);
    const off = await run(
      onboardingSetupSave,
      { workspaceId: shop, screen: 'page', answers: { ...answers, usePage: false } },
      dale,
    );
    expect(off.changes).toEqual(['Turns off your page']);
    expect(await siteOf(shop)).toMatchObject({ page: false });

    // Bella Salon has a website: the screen isn't for it, and saving it changes nothing.
    const r = await get(dale, ws);
    const none = await run(
      onboardingSetupSave,
      { workspaceId: ws, screen: 'page', answers: r.answers },
      dale,
    );
    expect(none.changes).toEqual([]);
    expect((await siteOf(ws))?.page ?? false).toBe(false);
  });

  it('is turned on and off only by those who manage calendars', async () => {
    await expectHfos(
      () => run(bookingSiteSetPage, { workspaceId: ws, on: true }, marco),
      'forbidden',
    );
    const on = await run(bookingSiteSetPage, { workspaceId: shop, on: true }, dale);
    expect(on).toMatchObject({ page: true, changed: true });
    expect(await run(bookingSiteSetPage, { workspaceId: shop, on: true }, dale)).toMatchObject({
      changed: false,
    });
  });
});

describe('onboarding_setup.finish', () => {
  it('refuses answers missing what a screen needs, naming it', async () => {
    const { answers } = await get(dale, ws);
    const err = await expectHfos(
      () =>
        run(
          onboardingSetupFinish,
          {
            workspaceId: ws,
            answers: { ...answers, ai: { ...answers.ai, description: '' } },
            baseRevision: null,
          },
          dale,
        ),
      'validation',
    );
    expect(err.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'answers.ai.description' })]),
    );
  });

  it('saves everything else: the AI teammate, the price list and Getting started’s answers', async () => {
    const { answers } = await get(dale, ws);
    const out = await run(
      onboardingSetupFinish,
      { workspaceId: ws, answers, baseRevision: null },
      dale,
    );
    expect(out.revision).toBe(1);
    expect(out.changes[0]).toBe('Sets up Ava, your AI teammate');
    expect(out.changes).toContain('Adds Haircut ($45) to your price list');
    // The booking page made the calendar already, and the hours are the person's own.
    expect(out.calendarId).toBeNull();
    expect(out.changes.some((c) => c.startsWith('Your hours'))).toBe(false);

    const [t] = await rows<{ status: string; config: Record<string, unknown> }>(
      admin(),
      sql`select status::text as status, config from app.ai_teammates where id = ${out.teammateId}`,
    );
    expect(t!.status).toBe('off');
    const [calendar] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.calendars where workspace_id = ${ws}`,
    );
    expect(t!.config['book']).toMatchObject({ enabled: true, calendarIds: [calendar!.id] });

    const products = await rows<{ name: string; kind: string; cents: number; service: string }>(
      admin(),
      sql`select p.name, p.kind::text as kind, p.unit_price_cents::int as cents, s.name as service
          from app.products p join app.services s on s.id = p.service_id where p.workspace_id = ${ws}`,
    );
    expect(products).toEqual([
      { name: 'Haircut', kind: 'service', cents: 4500, service: 'Haircut' },
    ]);

    const settings = await settingsOf(ws);
    expect(settings['openHours']).toEqual(OPEN);
    expect(settings['onboardingSetup']).toMatchObject({
      reached: 'loop',
      kind: 'salon',
      finished: { by: dale.id },
    });
    expect(settings['aiSetup']).toMatchObject({ runs: 1, finished: { by: dale.id } });
    expect(await eventCount(ws, 'onboarding_setup.finished')).toBe(1);
  });

  it('reads back what it saved, so running it again changes nothing', async () => {
    const r = await get(dale, ws);
    expect(r.reached).toBe('loop');
    expect(r.finished?.by).toBe(dale.id);
    expect(r.state.priceList).toEqual([
      expect.objectContaining({ name: 'Haircut', priceCents: 4500 }),
    ]);
    const out = await run(
      onboardingSetupFinish,
      { workspaceId: ws, answers: r.answers, baseRevision: 1 },
      dale,
    );
    expect(out).toMatchObject({ revision: 1, changes: [], calendarId: null });
  });

  it('puts a new price on the price list item it made', async () => {
    const r = await get(dale, ws);
    const answers = {
      ...r.answers,
      ai: {
        ...r.answers.ai,
        services: r.answers.ai.services.map((s) =>
          s.name === 'Haircut' ? { ...s, priceCents: 5000 } : s,
        ),
      },
    };
    const out = await run(
      onboardingSetupFinish,
      { workspaceId: ws, answers, baseRevision: 1 },
      dale,
    );
    expect(out.changes).toContain('Price list: Haircut is now $50');
    const [p] = await rows<{ cents: number }>(
      admin(),
      sql`select unit_price_cents::int as cents from app.products where workspace_id = ${ws} and name = 'Haircut'`,
    );
    expect(p!.cents).toBe(5000);
  });

  it('refuses answers that started from older teammate settings, and those who can’t change the business', async () => {
    const r = await get(dale, ws);
    await run(
      onboardingSetupFinish,
      {
        workspaceId: ws,
        answers: { ...r.answers, ai: { ...r.answers.ai, name: 'Max' } },
        baseRevision: 1,
      },
      dale,
    );
    await expectHfos(
      () =>
        run(onboardingSetupFinish, { workspaceId: ws, answers: r.answers, baseRevision: 1 }, dale),
      'conflict',
      'revision_conflict',
    );
    await expectHfos(
      () =>
        run(onboardingSetupFinish, { workspaceId: ws, answers: r.answers, baseRevision: 2 }, marco),
      'forbidden',
    );
  });
});
