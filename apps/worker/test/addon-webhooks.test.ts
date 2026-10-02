/**
 * An add-on's webhooks (round five, 20261021000200), over the made-up feed add-on
 * (packages/core/test/addons/connection-fixture.ts), whose Acme service signs its updates with HMAC-SHA256.
 *
 * - A connection gets its own address; opening it again replaces it, and letting the connection go ends it.
 * - The receiver checks the signature over the exact text: a bad one keeps nothing.
 * - Each update is kept once, by the service's own id, and handed to the add-on with its connection, in order.
 * - While the add-on is off in the business, what arrives is set aside, never handled later.
 */
import { createHmac, randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  executeCommand,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDON, fxconn } from '../../../packages/core/test/addons/connection-fixture';
import { addonScope } from '../src/addons/context';
import { addonWorkerModuleIssues } from '../src/addons/index';
import type { AddonWorkerModule } from '../src/addons/types';
import {
  addonDeliveryProcessor,
  openConnectionWebhook,
  type AddonWebhookContext,
} from '../src/addons/webhooks';
import { processDeliveries } from '../src/deliveries';
import { buildHttpServer } from '../src/http/server';
import { workerMeta } from '../src/services';
import { testServices, TEST_PUBLIC_URL, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

/** What the add-on was handed, in order. */
const handled: { id: string; kind: string; signed: boolean; connection: string }[] = [];
const sign = (body: string, secret: string) =>
  createHmac('sha256', secret).update(body).digest('hex');
const module: AddonWorkerModule = {
  manifest: fxconn,
  connectors: {
    listing_data: {
      acme: async () => ({ label: 'acme', accountRef: null }),
      other: async () => ({ label: 'other', accountRef: null }),
    },
  },
  webhooks: {
    listing_data: {
      acme: {
        verify: (req, secret) =>
          !!secret && req.headers['x-acme-signature'] === sign(req.rawBody, secret),
        parse: (req) =>
          (JSON.parse(req.rawBody) as { events: { id: string; type: string }[] }).events.map(
            (e) => ({ id: e.id, kind: e.type, data: e }),
          ),
        handle: async (ctx: AddonWebhookContext) => {
          if (ctx.update.kind === 'ping') return 'ignored';
          handled.push({
            id: ctx.update.id,
            kind: ctx.update.kind,
            signed: ctx.update.signed,
            connection: ctx.connection.id,
          });
        },
      },
    },
  },
};
const cmds = addonConnectionCommands([fxconn]);

let app: FastifyInstance;
let s: TestServices;
let owner: TestUser;
let ws: string;
let org: string;
let connectionId: string;
let path: string;
let secret: string;

const scopeCtx = () =>
  addonScope(s, fxconn, { workspaceId: ws, organizationId: org }, 1, workerMeta());
const send = (to: string, body: unknown, signWith: string | null = secret) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: to,
    headers: {
      'content-type': 'application/json',
      ...(signWith ? { 'x-acme-signature': sign(raw, signWith) } : {}),
    },
    payload: raw,
  });
};
const runner = `wh-${randomUUID()}`;
/** Runs this business's add-on deliveries, and only those. */
async function deliver() {
  await rows(
    admin(),
    sql`update app.webhook_deliveries set locked_at = now(), locked_by = ${runner}
        where workspace_id = ${ws} and status = 'pending'`,
  );
  return processDeliveries({
    ...s,
    processors: { 'addon:*': addonDeliveryProcessor([fxconn], [module]) },
    workerId: runner,
    batchSize: 20,
    reservedOnly: true,
  });
}
const deliveries = () =>
  rows<{ kind: string; status: string; signature_valid: boolean; url: string }>(
    admin(),
    sql`select kind, status, signature_valid, url from app.webhook_deliveries
        where workspace_id = ${ws} order by received_at, kind`,
  );

beforeAll(async () => {
  expect(addonWorkerModuleIssues([fxconn], [module])).toEqual([]);
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    addonConnections: { catalog: [fxconn], modules: [module] },
  });
  owner = await createTestUser('wh-owner');
  const made = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Hook Realty' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  org = made.output.organizationId;
  await rows(
    admin(),
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify(fxconn.permissions)}::jsonb)`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, ${ADDON}, 'enabled', '1.0.0')`,
  );
  const saved = await executeCommand(
    testDbs().worker.db,
    cmds.save,
    {
      workspaceId: ws,
      addonId: ADDON,
      connector: 'listing_data',
      provider: 'acme',
      auth: 'key',
      label: 'feed',
      accountRef: null,
      secretEnc: s.sealer.seal(JSON.stringify({ apiKey: 'k' })),
      keyId: s.sealer.keyId,
      connectedBy: owner.id,
    },
    { type: 'system', workspaceId: ws, organizationId: org, onBehalfOf: owner.id },
    meta(),
  );
  connectionId = saved.output.connectionId;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a connection’s own address', () => {
  it('is made for the add-on’s own connection, and only its hash is kept', async () => {
    const opened = await openConnectionWebhook(
      scopeCtx(),
      { id: connectionId },
      { secret: 'generate' },
    );
    expect(opened.url).toMatch(new RegExp(`^${TEST_PUBLIC_URL}/webhooks/addon/[A-Za-z0-9_-]{43}$`));
    path = opened.url.slice(TEST_PUBLIC_URL.length);
    secret = opened.secret!;
    const [row] = await rows<{ hash: string; sealed: string }>(
      admin(),
      sql`select encode(webhook_token_hash, 'hex') as hash, webhook_secret_enc as sealed
          from app.addon_connections where id = ${connectionId}`,
    );
    expect(row!.hash).toHaveLength(64);
    expect(row!.hash).not.toContain(path.split('/').at(-1)!);
    expect(row!.sealed).toMatch(/^v1\./);
    expect(row!.sealed).not.toContain(secret);
  });

  it('turns away an address nobody has and a signature that doesn’t check out, keeping nothing', async () => {
    expect((await send('/webhooks/addon/not-a-token', { events: [] })).statusCode).toBe(404);
    expect((await send(`/webhooks/addon/${'A'.repeat(43)}`, { events: [] })).statusCode).toBe(404);
    const body = { events: [{ id: 'e1', type: 'listing.updated' }] };
    expect((await send(path, body, null)).statusCode).toBe(403);
    expect((await send(path, body, 'someone else’s secret')).statusCode).toBe(403);
    expect(await deliveries()).toEqual([]);
  });

  it('keeps each update once and hands it to the add-on with its connection', async () => {
    const body = {
      events: [
        { id: 'e1', type: 'listing.updated' },
        { id: 'e2', type: 'listing.sold' },
        { id: 'e3', type: 'ping' },
      ],
    };
    const first = await send(path, body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, kept: 3 });
    // The service sends it again: nothing new.
    expect((await send(path, body)).json()).toEqual({ received: true, kept: 0 });

    const kept = await deliveries();
    expect(kept.map((d) => d.kind)).toEqual(['listing.sold', 'listing.updated', 'ping']);
    expect(kept.every((d) => d.signature_valid)).toBe(true);
    // The token isn't stored with the delivery.
    expect(kept.every((d) => !d.url.includes(path.split('/').at(-1)!))).toBe(true);

    expect(await deliver()).toMatchObject({ claimed: 3, done: 2, ignored: 1 });
    expect(handled.map((h) => h.id).sort()).toEqual(['e1', 'e2']);
    expect(handled.every((h) => h.signed && h.connection === connectionId)).toBe(true);
  });

  it('sets aside what arrives while the add-on is off, and never handles it later', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    );
    expect((await send(path, { events: [{ id: 'e4', type: 'listing.updated' }] })).statusCode).toBe(
      200,
    );
    expect(await deliver()).toMatchObject({ claimed: 1, ignored: 1 });
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    );
    expect(await deliver()).toMatchObject({ claimed: 0 });
    expect(handled.map((h) => h.id)).not.toContain('e4');
  });

  it('stops working when it’s opened again, and when the connection is let go', async () => {
    const old = path;
    const again = await openConnectionWebhook(
      scopeCtx(),
      { id: connectionId },
      { secret: 'generate' },
    );
    path = again.url.slice(TEST_PUBLIC_URL.length);
    secret = again.secret!;
    expect((await send(old, { events: [{ id: 'e5', type: 'x' }] })).statusCode).toBe(404);
    expect((await send(path, { events: [{ id: 'e5', type: 'x' }] })).statusCode).toBe(200);

    await executeCommand(
      testDbs().api.db,
      cmds.disconnect,
      { workspaceId: ws, connectionId },
      human(owner),
      meta(),
    );
    expect((await send(path, { events: [{ id: 'e6', type: 'x' }] })).statusCode).toBe(404);
    // What arrived before it was let go has nothing to act for now.
    const before = handled.length;
    expect(await deliver()).toMatchObject({ claimed: 1, ignored: 1 });
    expect(handled).toHaveLength(before);
  });
});
