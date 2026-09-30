/**
 * Bringing a number that already lives in Twilio (20261010000900), all the way through against the fake carrier:
 *
 *   - a GoHighLevel / LeadConnector number: looked up (Twilio-hosted, so it moves account to account), watched
 *     for in the workspace's own subaccount, and set up the moment HighLevel sends it — our webhooks on it, the
 *     messaging service, one of the business's numbers — with texting registration still its own question;
 *   - the business's own Twilio account: connected by an owner, listed with who is using each number today, a
 *     number assigned to another of the organization's businesses and finished there;
 *   - what may not happen: a member starting one, a person writing what arrived, a workspace admin who is not
 *     the organization's listing its whole Twilio account, the secret ever being readable;
 *   - a number moved straight into the business's own subaccount, with no import started here: found by
 *     listing that account, and set up with one press.
 *
 * **Needs the stack up** (`pnpm supabase:start && pnpm db:reset`). The fake's lookup says Twilio for every number
 * except one ending 0009 (another carrier) and 0008 (the lookup is down).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  createTokenVerifier,
  executeCommand,
  executeQuery,
  numberImportCancel,
  numberImportCheckNow,
  numberImportList,
  numberImportStart,
  numberPortStart,
  organizationCreate,
  twilioConnectionList,
  workspaceCreate,
  type HfosError,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { numberImports, phoneNumbers, telephonyAccounts, twilioConnections } from '@hfos/db/schema';
import {
  as,
  closeTestDbs,
  createTestUser,
  expectPgError,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { ensureAccount } from '../src/telephony/accounts';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-imports-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A number nobody else in the test database holds; the last four decide what the fake lookup says. */
const drawn = new Set<string>();
const aNumber = (ending: string, area = '256') => {
  for (;;) {
    const n = `+1${area}${String(200 + Math.floor(Math.random() * 799))}${ending}`;
    if (!drawn.has(n)) {
      drawn.add(n);
      return n;
    }
  }
};

let owner: TestUser;
let member: TestUser;
/** An admin of the first business who is not an owner or admin of its organization. */
let wsAdmin: TestUser;
let organizationId: string;
let workspaceId: string;
/** A second business in the same organization: a number from one Twilio account can go to either. */
let secondId: string;
/**
 * A business in another of the owner's organizations, with phone & texting on and nothing else: numbers turn up
 * in its own account unasked.
 */
let thirdId: string;
let thirdOrgId: string;
let s: TestServices;
let app: FastifyInstance;

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id in (${workspaceId}, ${secondId}, ${thirdId})`,
    );
}

/**
 * Runs the outbox and the jobs until nothing wants to run *now*. A number still on its way is looked for again
 * and again by design, so a pass whose every job only asked to come back later ends the drain.
 */
async function drain(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const events = await processOnce({ ...d, handlers });
    const ran = await processJobs({ ...d, jobs });
    if ([events, ran].some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select 'outbox' as source, event_type as what, last_error from app.outbox
              where workspace_id in (${workspaceId}, ${secondId}, ${thirdId}) and last_error is not null
            union all select 'job', kind, last_error from app.scheduled_jobs
              where workspace_id in (${workspaceId}, ${secondId}, ${thirdId}) and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (events.claimed === 0 && ran.claimed - ran.rescheduled === 0) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
    await sleep(60);
  }
}

const importRow = async (id: string) =>
  (await admin().select().from(numberImports).where(eq(numberImports.id, id)))[0]!;
const numberIn = async (ws: string, e164: string) =>
  (
    await admin()
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.workspaceId, ws), eq(phoneNumbers.e164, e164)))
  )[0];
const subaccountOf = async (ws: string) =>
  (await admin().select().from(telephonyAccounts).where(eq(telephonyAccounts.workspaceId, ws)))[0];

const start = async (
  input: { e164: string; source: 'twilio' | 'highlevel'; ws?: string } & Record<string, unknown>,
  who: TestUser = owner,
) =>
  (
    await executeCommand(
      api(),
      numberImportStart,
      { workspaceId: input.ws ?? workspaceId, ...input },
      actor(who),
      meta(),
    )
  ).output;

const list = async (ws = workspaceId, includeFinished = true) =>
  executeQuery(api(), numberImportList, { workspaceId: ws, includeFinished }, actor(owner), meta());

const post = async (who: TestUser, url: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${await signInTestUser(who)}`,
      'content-type': 'application/json',
    },
    payload,
  });

beforeAll(async () => {
  [owner, member, wsAdmin] = await Promise.all([
    createTestUser('imports-owner'),
    createTestUser('imports-member'),
    createTestUser('imports-wsadmin'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Imports Test Plumbing' },
    actor(owner),
    meta(),
  );
  ({ organizationId, workspaceId } = output);
  const second = await executeCommand(
    api(),
    workspaceCreate,
    { organizationId, name: 'Imports Test Plumbing — North' },
    actor(owner),
    meta(),
  );
  secondId = second.output.workspaceId;
  const third = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Imports Test Drains' },
    actor(owner),
    meta(),
  );
  ({ organizationId: thirdOrgId, workspaceId: thirdId } = third.output);
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member'), (${workspaceId}, ${wsAdmin.id}, 'admin')`,
  );
  s = testServices({});
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a GoHighLevel number', () => {
  it('is found in Twilio, watched for, and set up the moment HighLevel sends it', async () => {
    const e164 = aNumber('4411');
    const { importId, status } = await start({ e164, source: 'highlevel' });
    expect(status).toBe('waiting');
    await drain();

    // Looked up once: a Twilio carrier is what says it can move account to account, not by a port.
    const waiting = await importRow(importId);
    expect(waiting.status).toBe('waiting');
    expect(waiting.hostedInTwilio).toBe(true);
    expect(waiting.carrierName).toMatch(/Twilio/);
    // Where it is going: the business's own subaccount, made now so the page can say where to send it.
    const account = await subaccountOf(workspaceId);
    expect(waiting.destinationAccountSid).toBe(account!.accountSid);
    // Nothing is claimed while waiting: anybody can type anybody's number.
    expect(await numberIn(workspaceId, e164)).toBeUndefined();

    const [shown] = (await list()).imports.filter((i) => i.id === importId);
    expect(shown!.setup).toBe('waiting_for_transfer');
    expect(shown!.texting).toBe('needs_registration');
    expect(shown!.destinationAccountSid).toBe(account!.accountSid);

    // HighLevel's support sends it. It arrives still pointed at HighLevel.
    const sid = s.telephony.transferIn(e164, account!.accountSid!);
    await executeCommand(
      api(),
      numberImportCheckNow,
      { workspaceId, importId },
      actor(owner),
      meta(),
    );
    await drain();

    const done = await importRow(importId);
    expect(done.status).toBe('complete');
    expect(done.providerSid).toBe(sid);
    const landed = await numberIn(workspaceId, e164);
    expect(landed?.status).toBe('active');
    expect(landed?.providerSid).toBe(sid);
    expect(landed?.accountId).toBe(account!.id);
    expect(done.phoneNumberId).toBe(landed!.id);
    // Our webhooks on it (the old owner's apps and fallbacks cleared), and on the messaging service.
    expect(s.telephony.configured).toContain(sid);
    expect(s.telephony.serviced.map((x) => x.numberSid)).toContain(sid);

    // Two tracks: the number is live, and texting still needs its own registration — HighLevel's does not come.
    const [after] = (await list()).imports.filter((i) => i.id === importId);
    expect(after!.setup).toBe('live');
    expect(after!.texting).toBe('needs_registration');
  });

  it('says so when the number is not in Twilio, and keeps watching all the same', async () => {
    const e164 = aNumber('0009');
    const { importId } = await start({ e164, source: 'highlevel' });
    await drain();
    const row = await importRow(importId);
    expect(row.status).toBe('waiting');
    expect(row.hostedInTwilio).toBe(false);
    expect(row.carrierName).toBe('Verizon Wireless');

    const res = await post(owner, '/v1/telephony/number-host', { workspaceId, e164 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hostedInTwilio: false, carrierName: 'Verizon Wireless' });
  });

  it('keeps watching when the lookup is down, and asks it again next time', async () => {
    const e164 = aNumber('0008');
    const { importId } = await start({ e164, source: 'highlevel' });
    await drain();
    const row = await importRow(importId);
    expect(row.status).toBe('waiting');
    expect(row.lookedUpAt).toBeNull();
    expect(row.destinationAccountSid).toBeTruthy();
    const asked = s.telephony.lookups.filter((n) => n === e164).length;
    await drain();
    expect(s.telephony.lookups.filter((n) => n === e164).length).toBeGreaterThan(asked);
  });

  it('is one request however many times it is asked for, and stops when called off', async () => {
    const e164 = aNumber('4412');
    const first = await start({ e164, source: 'highlevel' });
    const again = await start({ e164, source: 'highlevel' });
    expect(again.importId).toBe(first.importId);
    await drain();

    await executeCommand(
      api(),
      numberImportCancel,
      { workspaceId, importId: first.importId },
      actor(owner),
      meta(),
    );
    // It arrives after all. Nobody is watching for it any more, so nothing claims it.
    s.telephony.transferIn(e164, (await subaccountOf(workspaceId))!.accountSid!);
    await drain();
    expect((await importRow(first.importId)).status).toBe('cancelled');
    expect(await numberIn(workspaceId, e164)).toBeUndefined();
  });

  it('refuses a number the business already has, or one a carrier port is already moving', async () => {
    const e164 = aNumber('4413');
    await executeCommand(
      api(),
      numberPortStart,
      { workspaceId, e164, kind: 'full' },
      actor(owner),
      meta(),
    );
    await expect(start({ e164, source: 'highlevel' })).rejects.toMatchObject({
      rule: 'number_port_open',
    } satisfies Partial<HfosError>);
  });

  it('stops, and says why, when another business on HandsFreeOS still holds the number', async () => {
    const e164 = aNumber('4414');
    const other = await createTestUser('imports-other');
    const theirs = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Somebody Else' },
      actor(other),
      meta(),
    );
    await rows(
      admin(),
      sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
          values (${theirs.output.workspaceId}, ${e164}, 'local', 'active')`,
    );
    const { importId } = await start({ e164, source: 'highlevel' });
    await drain();
    s.telephony.transferIn(e164, (await subaccountOf(workspaceId))!.accountSid!);
    await executeCommand(
      api(),
      numberImportCheckNow,
      { workspaceId, importId },
      actor(owner),
      meta(),
    );
    await drain();
    const row = await importRow(importId);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/another business/);
    expect(await numberIn(workspaceId, e164)).toBeUndefined();
  });
});

describe('who may do what', () => {
  it('a member cannot start one', async () => {
    await expect(
      start({ e164: aNumber('4415'), source: 'highlevel' }, member),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('a person can call one off, and nothing else: what arrived is the worker’s to write', async () => {
    const { importId } = await start({ e164: aNumber('4416'), source: 'highlevel' });
    const err = await expectPgError(() =>
      as(owner)((tx) =>
        tx.execute(
          sql`update app.number_imports set provider_sid = 'PNforged0000' where id = ${importId}`,
        ),
      ),
    );
    expect(err.detail).toBe('number_import_provider_fields');
    const forged = await expectPgError(() =>
      as(owner)((tx) =>
        tx.execute(sql`update app.number_imports set status = 'complete' where id = ${importId}`),
      ),
    );
    expect(forged.detail).toBe('number_import_status_transition');
  });
});

describe('the business’s own Twilio account', () => {
  let accountSid: string;
  const SECRET = 'their-own-auth-token-0123456789';
  let highLevelOne: string;
  let plainOne: string;

  beforeAll(() => {
    accountSid = s.telephony.addExternalAccount({
      secret: SECRET,
      friendlyName: 'Plumbing Twilio',
    });
    highLevelOne = aNumber('5501');
    plainOne = aNumber('5502', '713');
    s.telephony.addExternalNumber(accountSid, highLevelOne, {
      smsUrl: 'https://services.leadconnectorhq.com/phone-system/twilio/inbound-sms',
      voiceUrl: 'https://services.leadconnectorhq.com/phone-system/twilio/voice',
    });
    s.telephony.addExternalNumber(accountSid, plainOne);
  });

  it('is connected by the organization’s owners and admins only, and never with the wrong secret', async () => {
    const asAdmin = await post(wsAdmin, '/v1/telephony/twilio/connect', {
      workspaceId,
      accountSid,
      authToken: SECRET,
    });
    expect(asAdmin.statusCode).toBe(403);
    const wrong = await post(owner, '/v1/telephony/twilio/connect', {
      workspaceId,
      accountSid,
      authToken: 'not-the-right-token-at-all',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.rule).toBe('twilio_credentials');
  });

  it('refuses one of HandsFreeOS’s own accounts', async () => {
    const ours = (await subaccountOf(workspaceId))!.accountSid!;
    const res = await post(owner, '/v1/telephony/twilio/connect', {
      workspaceId,
      accountSid: ours,
      authToken: 'fake-twilio-auth-token',
    });
    expect(res.statusCode).toBe(409);
  });

  it('lists every number with who uses it, and brings one to another business', async () => {
    const res = await post(owner, '/v1/telephony/twilio/connect', {
      workspaceId,
      accountSid,
      authToken: SECRET,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      connection: { id: string; accountSid: string; usesApiKey: boolean };
      numbers: {
        sid: string;
        e164: string;
        usedBy: string;
        comingTo: { workspaceId: string } | null;
      }[];
    };
    expect(body.connection.accountSid).toBe(accountSid);
    expect(body.connection.usesApiKey).toBe(false);
    const byNumber = new Map(body.numbers.map((n) => [n.e164, n]));
    expect(byNumber.get(highLevelOne)?.usedBy).toBe('highlevel');
    expect(byNumber.get(plainOne)?.usedBy).toBe('nothing');

    // Sealed: stored, not as typed, and never readable by a person — not even the owner.
    const [stored] = await admin()
      .select()
      .from(twilioConnections)
      .where(eq(twilioConnections.id, body.connection.id));
    expect(stored!.secretEnc).toBeTruthy();
    expect(stored!.secretEnc).not.toContain(SECRET);
    const peek = await expectPgError(() =>
      as(owner)((tx) => tx.execute(sql`select secret_enc from app.twilio_connections`)),
    );
    expect(peek.code).toBe('42501');

    // The owner sees it and where numbers can go; the workspace admin, who is not the organization's, does not.
    const seen = await executeQuery(
      api(),
      twilioConnectionList,
      { workspaceId },
      actor(owner),
      meta(),
    );
    expect(seen.canConnect).toBe(true);
    expect(seen.connections.map((c) => c.id)).toContain(body.connection.id);
    expect(seen.workspaces.map((w) => w.id).sort()).toEqual([workspaceId, secondId].sort());
    const notSeen = await executeQuery(
      api(),
      twilioConnectionList,
      { workspaceId },
      actor(wsAdmin),
      meta(),
    );
    expect(notSeen.canConnect).toBe(false);
    expect(notSeen.connections).toEqual([]);

    // Assigned to the second business.
    const picked = byNumber.get(highLevelOne)!;
    const { importId } = await start({
      ws: secondId,
      e164: highLevelOne,
      source: 'twilio',
      connectionId: body.connection.id,
      sourceNumberSid: picked.sid,
    });
    await drain();
    const row = await importRow(importId);
    expect(row.sourceAccountSid).toBe(accountSid);
    expect(row.sourceNumberSid).toBe(picked.sid);
    // It is in a Twilio account, so there is nothing to look up.
    expect(row.hostedInTwilio).toBe(true);
    expect(s.telephony.lookups).not.toContain(highLevelOne);

    const again = await post(owner, '/v1/telephony/twilio/numbers', {
      workspaceId,
      connectionId: body.connection.id,
    });
    const listed = (again.json() as typeof body).numbers.find((n) => n.e164 === highLevelOne);
    expect(listed?.comingTo?.workspaceId).toBe(secondId);

    // They ask Twilio to move it; it lands in the second business's subaccount and is set up there.
    const secondAccount = (await subaccountOf(secondId))!;
    expect(row.destinationAccountSid).toBe(secondAccount.accountSid);
    const sid = s.telephony.transferIn(highLevelOne, secondAccount.accountSid!);
    await executeCommand(
      api(),
      numberImportCheckNow,
      { workspaceId: secondId, importId },
      actor(owner),
      meta(),
    );
    await drain();
    expect((await importRow(importId)).status).toBe('complete');
    expect((await numberIn(secondId, highLevelOne))?.providerSid).toBe(sid);
    expect(await numberIn(workspaceId, highLevelOne)).toBeUndefined();
  });

  it('lets the account go, wiping what it was opened with', async () => {
    const [c] = await admin()
      .select()
      .from(twilioConnections)
      .where(eq(twilioConnections.accountSid, accountSid));
    const res = await post(owner, '/v1/telephony/twilio/disconnect', {
      workspaceId,
      connectionId: c!.id,
    });
    expect(res.statusCode).toBe(200);
    const [gone] = await admin()
      .select()
      .from(twilioConnections)
      .where(eq(twilioConnections.id, c!.id));
    expect(gone!.status).toBe('disconnected');
    expect(gone!.secretEnc).toBeNull();
    const after = await post(owner, '/v1/telephony/twilio/numbers', {
      workspaceId,
      connectionId: c!.id,
    });
    expect(after.statusCode).toBe(404);
  });
});

describe('a port and a transfer of one number', () => {
  it('cannot both be under way: the port is refused while the transfer is watched for', async () => {
    const e164 = aNumber('4417');
    await start({ e164, source: 'highlevel' });
    await expect(
      executeCommand(
        api(),
        numberPortStart,
        { workspaceId, e164, kind: 'full' },
        actor(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'number_import_open' } satisfies Partial<HfosError>);
  });
});

describe('a number moved into the business’s own account without anybody asking here', () => {
  type Listing = {
    accountSid: string | null;
    alreadyHere: number;
    truncated: boolean;
    numbers: {
      sid: string;
      e164: string;
      usedBy: string;
      state: 'new' | 'coming' | 'elsewhere';
      importId: string | null;
    }[];
  };
  const look = async (ws: string, who: TestUser = owner) => {
    const res = await post(who, '/v1/telephony/own-numbers', { workspaceId: ws });
    expect(res.statusCode).toBe(200);
    return res.json() as Listing;
  };
  let accountSid: string;

  beforeAll(async () => {
    accountSid = (await ensureAccount(s, { workspaceId: thirdId, organizationId: thirdOrgId })).sid;
  });

  it('is found in the account, and set up here with one press: nothing to send, no lookup spent', async () => {
    const e164 = aNumber('6601');
    // HighLevel's support moved it straight into the subaccount. It arrives still pointed at HighLevel, and
    // nothing here is watching for it.
    s.telephony.addExternalNumber('AChighleveltest0001', e164, {
      smsUrl: 'https://services.leadconnectorhq.com/phone-system/twilio/inbound-sms',
      voiceUrl: 'https://services.leadconnectorhq.com/phone-system/twilio/voice',
    });
    const sid = s.telephony.transferIn(e164, accountSid);
    expect(await numberIn(thirdId, e164)).toBeUndefined();

    const before = await look(thirdId);
    expect(before.accountSid).toBe(accountSid);
    expect(before.numbers.find((n) => n.e164 === e164)).toMatchObject({
      sid,
      state: 'new',
      importId: null,
      usedBy: 'highlevel',
    });

    const { importId } = await start({
      e164,
      source: 'twilio',
      ws: thirdId,
      sourceAccountSid: accountSid,
      sourceNumberSid: sid,
    });
    // Asked for, not set up yet: on its way, and "look now" is what finishes it.
    expect((await look(thirdId)).numbers.find((n) => n.e164 === e164)).toMatchObject({
      state: 'coming',
      importId,
    });

    await drain();
    const done = await importRow(importId);
    expect(done.status).toBe('complete');
    expect(done.providerSid).toBe(sid);
    const landed = await numberIn(thirdId, e164);
    expect(landed?.status).toBe('active');
    expect(landed?.providerSid).toBe(sid);
    // Pointed at us, off HighLevel, and on the messaging service, like any number that lands.
    expect(s.telephony.configured).toContain(sid);
    expect(s.telephony.serviced.map((x) => x.numberSid)).toContain(sid);
    // It was sitting in Twilio already: nothing is spent asking the carrier lookup who hosts it.
    expect(s.telephony.lookups).not.toContain(e164);

    // One of the business's numbers now: counted, not offered again.
    const after = await look(thirdId);
    expect(after.numbers.some((n) => n.e164 === e164)).toBe(false);
    expect(after.alreadyHere).toBe(before.alreadyHere + 1);
  });

  it('says so, and offers nothing, when another business here still holds the number', async () => {
    const e164 = aNumber('6602');
    const other = await createTestUser('imports-own-other');
    const theirs = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Somebody Else Again' },
      actor(other),
      meta(),
    );
    await rows(
      admin(),
      sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
          values (${theirs.output.workspaceId}, ${e164}, 'local', 'active')`,
    );
    s.telephony.transferIn(e164, accountSid);
    expect((await look(thirdId)).numbers.find((n) => n.e164 === e164)).toMatchObject({
      state: 'elsewhere',
      importId: null,
    });
  });

  it('is for the people who manage the business’s numbers, and finds nothing where phone & texting is off', async () => {
    const asMember = await post(member, '/v1/telephony/own-numbers', { workspaceId });
    expect(asMember.statusCode).toBe(403);

    const off = await executeCommand(
      api(),
      workspaceCreate,
      { organizationId: thirdOrgId, name: 'Imports Test Drains — East' },
      actor(owner),
      meta(),
    );
    const none = await look(off.output.workspaceId);
    expect(none).toEqual({ accountSid: null, numbers: [], alreadyHere: 0, truncated: false });
    // Looking never makes an account.
    expect(await subaccountOf(off.output.workspaceId)).toBeUndefined();
  });
});
