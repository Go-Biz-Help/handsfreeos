/**
 * Real Estate Agent's demo business (step 19's phone flow, apps/mobile/maestro/realestate-offline.yaml): Hill Country
 * Realty, where Dana Whitfield works one buyer deal, "Smith purchase", for Ann Smith on 123 Main St.
 *
 * - The add-on is still being tested, so it's turned on the way HandsFreeOS hands one out: Chris, as staff, gives the
 *   business a grant (`addon_grant.give`), Dana adds it from her Add-ons page (`addon.install`), and the worker's
 *   reconcile job sets it up.
 * - The deal starts Under contract, with its contract's acceptance and closing on Key dates, so its duties are dated:
 *   "Homeowners insurance concierge" waits for an insurance binder, which a photo of the binder gives it.
 * - A tour of 123 Main St, a second look before closing, starts about an hour after the seed (on Dana's own
 *   calendar, the client not told), so its Check in opens the safety sheet. The buyer agreement is still on paper, so
 *   Dana lets it through with a reason, as an owner may.
 *
 * Its own account is how it knows it's there: a stack seeded before this business existed gets it on the next
 * `pnpm db:seed`, and a stack that has it is left alone. Every change goes through the commands, as Dana would make it.
 */
import { hostname } from 'node:os';
import { dealOpen } from '@hfos/core/addons/realestate/ops/deals';
import { homeAdd } from '@hfos/core/addons/realestate/ops/homes';
import { termEnter } from '@hfos/core/addons/realestate/ops/terms';
import { tourPlan } from '@hfos/core/addons/realestate/ops/tours';
import {
  addDays,
  addonGrantGive,
  addonInstall,
  calendarCreate,
  calendarSetStatus,
  executeCommand,
  localDateOf,
  organizationCreate,
  personCreate,
  type CommandDef,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import { createTestUser, type TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import type { OutboxDeps } from '../src/outbox';
import { settle } from './seed-messaging';

export interface SeedRealestateDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services and loop settings, as the seed built them. */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
}

export interface SeededRealestate {
  readonly seconds: number;
  readonly email: string;
  readonly business: string;
  readonly deal: string;
  readonly duties: number;
  readonly tourAt: string;
}

export const HILL_COUNTRY = {
  business: 'Hill Country Realty',
  timezone: 'America/Chicago',
  agent: { email: 'dana@hillcountryrealty.test', name: 'Dana Whitfield' },
  client: { firstName: 'Ann', lastName: 'Smith', email: 'ann.smith@example.com' },
  deal: 'Smith purchase',
  property: '123 Main St',
} as const;

const QUARTER = 15 * 60_000;

/**
 * Hill Country Realty, its agent and her deal. `chris` is HandsFreeOS staff (platform.staff admin), who hands the
 * add-on out. Null when the business is already there.
 */
export async function seedRealestate(
  d: SeedRealestateDeps,
  people: { readonly chris: TestUser; readonly password: string },
): Promise<SeededRealestate | null> {
  const there = await rows<{ id: string }>(
    d.admin,
    sql`select id from app.users where email = ${HILL_COUNTRY.agent.email}`,
  );
  if (there.length > 0) return null;
  const started = Date.now();
  // Only this business's work is run here, under its own worker id: whatever the rest of the seed queued for later
  // (reminders, holds that lapse, replies that wait) stays for the real worker, at its time.
  const since = (await rows<{ now: string }>(d.admin, sql`select now()::text as now`))[0]!.now;
  const loop = {
    admin: d.admin,
    since,
    worker: { ...d.worker, workerId: `seed-realestate:${hostname()}:${process.pid}` },
  };

  d.step(
    `${HILL_COUNTRY.business}: ${HILL_COUNTRY.agent.name}’s business, with Real Estate Agent on`,
  );
  const dana = await createTestUser('dana', {
    email: HILL_COUNTRY.agent.email,
    password: people.password,
    fullName: HILL_COUNTRY.agent.name,
  });
  const run = async <I extends z.ZodType, O extends z.ZodType>(
    cmd: CommandDef<I, O>,
    input: unknown,
    who: TestUser = dana,
  ): Promise<z.output<O>> =>
    (await executeCommand(d.api, cmd, input, d.actor(who), d.meta())).output;

  const { workspaceId } = await run(organizationCreate, {
    businessName: HILL_COUNTRY.business,
    timezone: HILL_COUNTRY.timezone,
  });
  // Staff hand it out to try; the business's owner adds it, and the worker sets it up.
  await run(
    addonGrantGive,
    {
      workspaceId,
      addonId: 'realestate',
      note: 'The demo business for the phone’s Real Estate flow.',
    },
    people.chris,
  );
  await run(addonInstall, { workspaceId, addonId: 'realestate', include: [] });
  const on = async () =>
    (
      await rows<{ state: string }>(
        d.admin,
        sql`select state::text as state from app.addon_installations
            where workspace_id = ${workspaceId} and addon_id = 'realestate'`,
      )
    )[0]?.state === 'enabled';
  await settle(loop, on);
  if (!(await on()))
    throw new Error(
      `Real Estate Agent didn’t finish setting up in ${HILL_COUNTRY.business} (see last_error in app.addon_installations).`,
    );

  // Her own calendar, which tours go on.
  const calendar = await run(calendarCreate, {
    workspaceId,
    name: 'Dana’s showings',
    preset: 'personal',
    color: '#0f766e',
    description: 'Tours and showings with Dana.',
  });
  await run(calendarSetStatus, { workspaceId, calendarId: calendar.calendarId, status: 'active' });

  d.step(
    `${HILL_COUNTRY.business}: "${HILL_COUNTRY.deal}", a buyer deal Under contract, and a tour`,
  );
  const client = await run(personCreate, { workspaceId, ...HILL_COUNTRY.client });
  const opened = await run(dealOpen, {
    workspaceId,
    side: 'buyer',
    name: HILL_COUNTRY.deal,
    stage: 'under_contract',
    clientPersonId: client.personId,
    newPropertyAddress: HILL_COUNTRY.property,
  });
  const dealId = opened.dealId;
  // The contract's dates, as Dana typed them in: the duties that rest on them get their due dates.
  const today = localDateOf(Date.now(), HILL_COUNTRY.timezone);
  await run(termEnter, { workspaceId, dealId, key: 'acceptance', date: addDays(today, -3) });
  await run(termEnter, { workspaceId, dealId, key: 'closing', date: addDays(today, 30) });

  const home = await run(homeAdd, { workspaceId, dealId, address: HILL_COUNTRY.property });
  const tour = await run(tourPlan, {
    workspaceId,
    dealId,
    homeIds: [home.homeId],
    startsAt: new Date(Math.ceil((Date.now() + 60 * 60_000) / QUARTER) * QUARTER).toISOString(),
    calendarId: calendar.calendarId,
    note: 'A second look before closing: Ann wants to measure the living room.',
    notifyClient: false,
    // Whatever the hour the seed runs at: outside Dana's hours, or sooner than the calendar's notice.
    acknowledgeWarnings: true,
    exception: {
      reason:
        'Ann signed the buyer agreement on paper at the office; the scan goes under Documents this week.',
    },
  });
  await settle(loop);

  const [duties] = await rows<{ n: number }>(
    d.admin,
    sql`select count(*)::int as n from addon_realestate.duties
        where deal_record_id = ${dealId} and status not in ('completed', 'waived', 'cancelled')`,
  );
  return {
    seconds: (Date.now() - started) / 1000,
    email: dana.email,
    business: HILL_COUNTRY.business,
    deal: HILL_COUNTRY.deal,
    duties: duties?.n ?? 0,
    tourAt: tour.startsAt,
  };
}

/** Chris as the seed made him, for a stack seeded before Hill Country Realty existed. */
export async function seededUser(admin: Db, email: string, password: string): Promise<TestUser> {
  const [u] = await rows<{ id: string; full_name: string | null }>(
    admin,
    sql`select id, full_name from app.users where email = ${email}`,
  );
  if (!u)
    throw new Error(`${email} isn’t on this stack. Run \`pnpm db:reset\` to seed it from scratch.`);
  return {
    id: u.id,
    email,
    password,
    fullName: u.full_name ?? email,
    claims: { sub: u.id, email },
  };
}
