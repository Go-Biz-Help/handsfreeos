import { randomUUID } from 'node:crypto';
import {
  brandedDomainRecord,
  chatWidgetCreate,
  executeCommand,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { as, closeTestDbs, createTestUser, testDbs, uniq, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processOnce } from '../src/outbox';
import { systemActor, workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';

/**
 * A chat on the business's pages here (its simple page's) follows them to its own domain once that's serving
 * (chat/own-domain.ts), so the page's Chat button works on either name. Chats on the business's own website are
 * left alone, and so is a chat with no room for another site.
 */

const WORKER_ID = `vitest-own-domain-${process.pid}`;
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
const domain = `go.bayou-${uniq()}.example`;
/** The web app's own address in tests (testServices' webUrl). */
const OURS = 'http://localhost:3000';

beforeAll(async () => {
  owner = await createTestUser('own-domain-owner');
  s = testServices();
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Bayou Plumbing', industry: 'plumbing' },
    actor(owner),
    meta(),
  );
  ({ organizationId: org, workspaceId: ws } = output);
  const [site] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.booking_sites (workspace_id, slug, name, enabled)
        values (${ws}, ${`bayou-${uniq()}`}, 'Bayou Plumbing', true) returning id`,
  );
  // As `branded_domain.add` writes it: pending, nothing proved.
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
  await closeTestDbs();
});

const chat = async (origins: string[]) =>
  (
    await executeCommand(
      api(),
      chatWidgetCreate,
      { workspaceId: ws, allowedOrigins: origins },
      actor(owner),
      meta(),
    )
  ).output.widgetId;

const originsOf = async (widgetId: string) =>
  (
    await rows<{ origins: string[] }>(
      admin(),
      sql`select allowed_origins as origins from app.chat_widgets where id = ${widgetId}`,
    )
  )[0]!.origins;

/** What the worker's domain check writes when the host answers. */
const recordDomain = (serving: boolean) =>
  executeCommand(
    testDbs().worker.db,
    brandedDomainRecord,
    {
      workspaceId: ws,
      domainId,
      status: serving ? 'verified' : 'verifying',
      verificationHost: null,
      verificationValue: null,
      cnameHost: null,
      cnameValue: null,
      certificateReady: serving,
      lastError: null,
      nextCheckAt: null,
      ownershipProved: true,
    },
    systemActor({ workspaceId: ws, organizationId: org }),
    workerMeta(),
  );

/** Runs this business's outbox until nothing is left. */
async function work(): Promise<void> {
  for (let i = 0; i < 10; i++) {
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
    if (pass.retried + pass.failed > 0) {
      const errors = await rows(
        admin(),
        sql`select event_type, last_error from app.outbox
            where workspace_id = ${ws} and last_error is not null`,
      );
      throw new Error(`the outbox failed: ${JSON.stringify(errors)}`);
    }
    if (pass.claimed === 0) return;
  }
}

describe('a chat on the business’s pages here, once its own domain is serving', () => {
  it('goes on the domain too; chats on its own website and full ones stay as they are', async () => {
    const page = await chat([OURS]);
    const website = await chat(['bayou-plumbing.example.com']);
    const full = await chat([OURS, ...Array.from({ length: 9 }, (_, i) => `s${i}.example.com`)]);
    await work();

    await recordDomain(true);
    await work();

    expect(await originsOf(page)).toEqual([OURS, `https://${domain}`]);
    expect(await originsOf(website)).toEqual(['https://bayou-plumbing.example.com']);
    expect(await originsOf(full)).toHaveLength(10);
    expect(await originsOf(full)).not.toContain(`https://${domain}`);
    // The change is the system's, through the command, so it's in the audit log like any other.
    const [changed] = await rows<{ actor_type: string }>(
      admin(),
      sql`select actor_type from app.events
          where workspace_id = ${ws} and event_type = 'chat_widget.updated' and entity_id = ${page}`,
    );
    expect(changed?.actor_type).toBe('system');

    // Stopping and serving again adds nothing twice.
    await recordDomain(false);
    await work();
    await recordDomain(true);
    await work();
    expect(await originsOf(page)).toEqual([OURS, `https://${domain}`]);
  });
});
