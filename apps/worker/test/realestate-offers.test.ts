/**
 * Real Estate Agent, round two, step 10, in the worker: the offer clock. Each version with a deadline gets an alert
 * two hours before, at the deadline and an hour after, while it's still the one waiting; a newer version or an answer
 * clears it. Turning the add-on off stops the clock, and turning it on again arms what's still ahead.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  addonDisable,
  addonEnable,
  executeCommand,
  personCreate,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { OFFER_CLOCK, offerAlertKey } from '../src/addons/realestate/offers';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) => realestate.commands!.find((c) => c.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(),
  ).then((r) => r.output);

const handlers = withAddons({});
const jobs = { ...addonJobs };
const HOUR = 3_600_000;
const terms = { priceCents: 40_100_000, loanType: 'conventional', financingDays: 21 };

let s: TestServices;
let agent: TestUser;
let ws: string;
let deal: string;
let offer: string;

async function drain() {
  for (let i = 0; i < 40; i++) {
    const runner = `vitest-offers-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()
            and kind <> 'realestate.sweep'`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

/** The clock's moments waiting, by version and moment, in hours from now. */
const clock = () =>
  rows<{ version: string; moment: string; hours: number }>(
    admin(),
    sql`select payload ->> 'versionId' as version, payload ->> 'moment' as moment,
          round(extract(epoch from run_at - now()) / 3600)::int as hours
        from app.scheduled_jobs where workspace_id = ${ws} and kind = ${OFFER_CLOCK} and status = 'pending'
        order by run_at`,
  );
/** Moves a moment of the clock to now. */
const reach = (versionId: string, moment: string) =>
  rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now() where workspace_id = ${ws} and kind = ${OFFER_CLOCK}
        and status = 'pending' and payload ->> 'versionId' = ${versionId} and payload ->> 'moment' = ${moment}`,
  );
const alert = () =>
  rows<{ severity: string; title: string; cleared: boolean; href: string }>(
    admin(),
    sql`select severity, title, cleared_at is not null as cleared, href from app.addon_alerts
        where workspace_id = ${ws} and addon_id = 'realestate' and key = ${offerAlertKey(offer)}`,
  ).then((r) => r[0]);

beforeAll(async () => {
  s = testServices();
  agent = await createTestUser('row-agent', { fullName: 'Dana Reyes' });
  ws = await realestateBusiness(agent, 'Clock Realty');
  const client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Linh', lastName: 'Nguyen' },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
      stage: 'offer',
    })
  ).dealId;
  await drain();
}, 120_000);

afterAll(closeTestDbs);

describe('the offer clock', () => {
  let first: string;
  let second: string;

  it('alerts two hours before the seller’s answer is due', async () => {
    const home = (
      await run('realestate.home.add', { dealId: deal, address: '418 Maple Ave, Austin, TX' })
    ).homeId;
    const out = await run('realestate.offer.start', {
      dealId: deal,
      homeId: home,
      terms,
      respondBy: new Date(Date.now() + 3 * HOUR).toISOString(),
    });
    offer = out.offerId;
    first = out.versionId;
    await drain();
    expect((await clock()).map((c) => [c.moment, c.hours])).toEqual([
      ['soon', 1],
      ['due', 3],
      ['passed', 4],
    ]);
    await reach(first, 'soon');
    await drain();
    expect(await alert()).toMatchObject({
      severity: 'at_risk',
      cleared: false,
      href: `/a/realestate/deals/${deal}/offers/${offer}`,
    });
    expect((await alert())!.title).toMatch(/^The seller’s answer on 418 Maple Ave is due at /);
  });

  it('moves to the newest version, and an older version’s moments say nothing', async () => {
    second = (
      await run('realestate.offer.add_version', {
        offerId: offer,
        side: 'them',
        terms: { ...terms, priceCents: 40_900_000 },
        respondBy: new Date(Date.now() + 5 * HOUR).toISOString(),
      })
    ).versionId;
    await drain();
    expect(await alert()).toMatchObject({ cleared: true });
    await reach(first, 'due');
    await drain();
    expect(await alert()).toMatchObject({ cleared: true });
    expect(
      (await clock()).filter((c) => c.version === second).map((c) => [c.moment, c.hours]),
    ).toEqual([
      ['soon', 3],
      ['due', 5],
      ['passed', 6],
    ]);
  });

  it('stops when the add-on is turned off, and arms what’s ahead when it’s on again', async () => {
    await executeCommand(
      api(),
      addonDisable as CommandDef,
      { workspaceId: ws, addonId: 'realestate' },
      human(agent),
      meta(),
    );
    await drain();
    expect(await clock()).toEqual([]);
    await executeCommand(
      api(),
      addonEnable as CommandDef,
      { workspaceId: ws, addonId: 'realestate' },
      human(agent),
      meta(),
    );
    await drain();
    expect((await clock()).map((c) => [c.version, c.moment])).toEqual([
      [second, 'soon'],
      [second, 'due'],
      [second, 'passed'],
    ]);
  });

  it('says it’s our answer that’s due, and clears once the offer is answered', async () => {
    await reach(second, 'due');
    await drain();
    expect(await alert()).toMatchObject({
      severity: 'critical',
      cleared: false,
      title: 'Your answer to the seller’s counter on 418 Maple Ave is due now',
    });
    await run('realestate.offer.record_response', { offerId: offer, outcome: 'declined' });
    await drain();
    expect(await alert()).toMatchObject({ cleared: true });
  });
});
