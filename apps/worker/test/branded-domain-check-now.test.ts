import { randomUUID } from 'node:crypto';
import {
  brandedDomainVerify,
  executeCommand,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { as, closeTestDbs, createTestUser, testDbs, uniq, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { DOMAIN_JOBS } from '../src/hosting/domains';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

/**
 * Check now on a business's own domain (M17) looks now. While a domain waits, its next look sits fifteen minutes
 * out under the same key, and Check now used to find it there and do nothing: the screen said "Checking now." and
 * nothing changed until the fifteen minutes were up.
 */

const WORKER_ID = `vitest-domain-check-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let s: TestServices;
let org: string;
let ws: string;
let domainId: string;
const domain = `go.crafts-${uniq()}.example`;

beforeAll(async () => {
  owner = await createTestUser('domain-check-owner');
  s = testServices();
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Crafts N Things', industry: 'retail_store' },
    actor(owner),
    meta(),
  );
  ({ organizationId: org, workspaceId: ws } = output);
  const [site] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.booking_sites (workspace_id, slug, name, enabled)
        values (${ws}, ${`crafts-${uniq()}`}, 'Crafts N Things', true) returning id`,
  );
  // As `branded_domain.add` writes it, the host's records shown and the business still adding them.
  const [added] = await as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.branded_domains (workspace_id, site_id, domain, created_by)
          values (${ws}, ${site!.id}, ${domain}, ${owner.id}) returning id`,
    ),
  );
  domainId = added!.id;
}, 120_000);

afterAll(async () => {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set status = 'cancelled'
        where workspace_id = ${ws} and status = 'pending'`,
  );
  await closeTestDbs();
});

/** The event handlers over this business's events, until there are none. */
async function runEvents(): Promise<void> {
  for (;;) {
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const pass = await processOnce({
      ...s,
      workerId: WORKER_ID,
      batchSize: 50,
      reservedOnly: true,
      handlers,
    });
    if (pass.retried + pass.failed > 0) throw new Error('an event handler failed');
    if (pass.claimed === 0) return;
  }
}

/** The domain's waiting look: how far off it is, in whole minutes, and how many there are. */
const waiting = async () => {
  const found = await rows<{ minutes: number }>(
    admin(),
    sql`select round(extract(epoch from run_at - now()) / 60)::int as minutes
        from app.scheduled_jobs
        where kind = ${DOMAIN_JOBS.check} and dedupe_key = ${`branded_domain:${domainId}`}
          and status = 'pending'`,
  );
  return found;
};

describe('Check now on a business’s own domain', () => {
  it('brings the waiting look forward to now, rather than leaving it fifteen minutes out', async () => {
    // What the first look leaves behind while the records aren't there yet: the next one, fifteen minutes out.
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${org}, ${ws}, ${DOMAIN_JOBS.check}, ${`branded_domain:${domainId}`},
                  now() + interval '15 minutes', ${JSON.stringify({ domainId, first: true })}::jsonb)`,
    );
    expect(await waiting()).toEqual([{ minutes: 15 }]);

    await executeCommand(
      api(),
      brandedDomainVerify,
      { workspaceId: ws, domainId },
      actor(owner),
      meta(),
    );
    await runEvents();

    // Still the one look, now due.
    expect(await waiting()).toEqual([{ minutes: 0 }]);
  });
});
