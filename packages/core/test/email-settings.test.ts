import { createHash, randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, uniq, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  emailAddressCreate,
  emailAddressUpdate,
  emailClaimUnmatched,
  emailComposeOptions,
  emailDismissUnmatched,
  emailDomainAdd,
  emailDomainRecord,
  emailDomainRemove,
  emailDomainVerify,
  emailSetupStatus,
  emailSuppressionAdd,
  emailSuppressionList,
  emailSuppressionRelease,
  emailUnmatchedList,
  mailboxActivate,
  mailboxConnect,
  mailboxDisconnect,
  mailboxFail,
  mailboxResync,
  messageSend,
  organizationCreate,
  personArchive,
  personCreate,
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
/** Writes the worker makes outside these commands (inbound mail, bounces), as the worker. */
const asTenant = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
  asWorker(testDbs().worker.db, { workspaceId: wsId, organizationId: orgId }, (tx) =>
    rows<T>(tx, query),
  );

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

type EventRow = { event_type: string; payload: Record<string, unknown> };
const eventsFor = (entityId: string) =>
  rows<EventRow>(
    admin(),
    sql`select event_type, payload from app.events where entity_id = ${entityId} order by created_at, event_type`,
  );
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Domains and shared-subdomain addresses are unique across every workspace, so each run uses its own.
const u = uniq();
const DOMAIN = `lonestar-${u}.com`;
const SHARED = 'mail.handsfreeos.com';
const TOKEN = `sealed-v1.${randomUUID()}`;

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let outsiderWsId: string;
let mikeId: string;
let archivedId: string;
let strangerId: string;
let sharedDefaultId: string;
let sharedDefaultAddress: string;
let domainId: string;
let salesId: string;
let supportId: string;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('email-owner'),
    createTestUser('email-member'),
    createTestUser('email-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Email Settings Co' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  outsiderWsId = (await run(organizationCreate, { businessName: 'Someone Else Co' }, outsider))
    .workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
  mikeId = (
    await run(personCreate, { workspaceId: wsId, firstName: 'Mike', lastName: 'Johnson' }, owner)
  ).personId;
  archivedId = (
    await run(personCreate, { workspaceId: wsId, firstName: 'Old', lastName: 'Customer' }, owner)
  ).personId;
  await run(personArchive, { workspaceId: wsId, personId: archivedId }, owner);
  strangerId = (
    await run(
      personCreate,
      { workspaceId: outsiderWsId, firstName: 'Not', lastName: 'Yours' },
      outsider,
    )
  ).personId;
});
afterAll(closeTestDbs);

describe('email settings', () => {
  it('every workspace starts with a default address on the shared subdomain', async () => {
    const s = await ask(emailSetupStatus, { workspaceId: wsId }, member);
    expect(s.sharedDomain).toBe(SHARED);
    expect(s.addresses).toHaveLength(1);
    expect(s.addresses[0]).toMatchObject({
      isDefault: true,
      emailDomainId: null,
      domain: null,
      usable: true,
    });
    expect(s.addresses[0]!.address).toMatch(/^[a-z0-9-]+@mail\.handsfreeos\.com$/);
    expect(s).toMatchObject({
      domains: [],
      mailboxes: [],
      counts: { suppressions: 0, unmatched: 0 },
    });
    sharedDefaultId = s.addresses[0]!.id;
    sharedDefaultAddress = s.addresses[0]!.address;
    await expectHfos(() => ask(emailSetupStatus, { workspaceId: wsId }, outsider), 'not_found');
  });

  it('adds the business’s own domain as typed, and refuses ours, free mail, taken ones and a fourth', async () => {
    const added = await run(
      emailDomainAdd,
      { workspaceId: wsId, domain: ` HTTPS://LoneStar-${u}.com/contact?from=ad ` },
      owner,
    );
    domainId = added.emailDomainId;
    const [row] = await rows<{ domain: string; status: string; created_by: string }>(
      admin(),
      sql`select domain, status::text as status, created_by from app.email_domains where id = ${domainId}`,
    );
    expect(row).toEqual({ domain: DOMAIN, status: 'pending', created_by: owner.id });
    expect(await eventsFor(domainId)).toEqual([
      { event_type: 'email_domain.added', payload: { domain: DOMAIN } },
    ]);
    // www. stays as typed; a trailing dot goes.
    const www = await run(
      emailDomainAdd,
      { workspaceId: wsId, domain: `www.lonestar-${u}.com.` },
      owner,
    );
    const [w] = await rows<{ domain: string }>(
      admin(),
      sql`select domain from app.email_domains where id = ${www.emailDomainId}`,
    );
    expect(w?.domain).toBe(`www.${DOMAIN}`);

    await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: SHARED }, owner),
      'rule_violation',
      'email_domain_ours',
    );
    await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: 'HandsFreeOS.com' }, owner),
      'rule_violation',
      'email_domain_ours',
    );
    const consumer = await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: 'Gmail.com' }, owner),
      'rule_violation',
      'email_domain_consumer',
    );
    expect(consumer.message).toBe('Use a domain your business owns, like lonestarhvac.com.');
    await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: 'not a domain' }, owner),
      'validation',
    );
    await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: DOMAIN }, owner),
      'rule_violation',
      'email_domain_taken',
    );
    // Set up in someone else's workspace: refused, without saying whose.
    await run(
      emailDomainAdd,
      { workspaceId: outsiderWsId, domain: `elsewhere-${u}.com` },
      outsider,
    );
    const taken = await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: `elsewhere-${u}.com` }, owner),
      'rule_violation',
      'email_domain_taken',
    );
    expect(taken.status).toBe(409);
    expect(taken.message).not.toMatch(/Someone Else/);
    await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: `member-${u}.com` }, member),
      'forbidden',
    );
    await run(emailDomainAdd, { workspaceId: wsId, domain: `third-${u}.com` }, owner);
    await expectHfos(
      () => run(emailDomainAdd, { workspaceId: wsId, domain: `fourth-${u}.com` }, owner),
      'rule_violation',
      'email_domain_limit',
    );
  });

  it('verifies a domain through what Postmark says, and an API error does not unverify it', async () => {
    await run(emailDomainVerify, { workspaceId: wsId, emailDomainId: domainId }, owner);
    await expectHfos(
      () => run(emailDomainVerify, { workspaceId: wsId, emailDomainId: domainId }, member),
      'forbidden',
    );
    const records = {
      workspaceId: wsId,
      emailDomainId: domainId,
      providerDomainId: '4410123',
      dkimHost: `20260912pm._domainkey.${DOMAIN}`,
      dkimValue: 'k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1',
      returnPathHost: `pm-bounces.${DOMAIN}`,
      returnPathValue: 'pm.mtasv.net',
    };
    expect(
      await sys(emailDomainRecord, { ...records, dkimVerified: false, returnPathVerified: false }),
    ).toEqual({ emailDomainId: domainId, status: 'pending', changed: false });
    await expectHfos(
      () =>
        run(
          emailAddressCreate,
          { workspaceId: wsId, emailDomainId: domainId, localPart: 'dale', displayName: 'Dale' },
          owner,
        ),
      'rule_violation',
      'email_domain_unverified',
    );
    expect(
      await sys(emailDomainRecord, {
        workspaceId: wsId,
        emailDomainId: domainId,
        dkimVerified: true,
        returnPathVerified: false,
        error: 'The Return-Path CNAME was not found.',
      }),
    ).toMatchObject({ status: 'failed', changed: true });
    const verifiedAt = () =>
      rows<{ dkim: string | null; rp: string | null }>(
        admin(),
        sql`select dkim_verified_at::text as dkim, return_path_verified_at::text as rp
            from app.email_domains where id = ${domainId}`,
      ).then((r) => r[0]!);
    const halfway = await verifiedAt();
    expect(halfway.dkim).not.toBeNull();
    expect(halfway.rp).toBeNull();
    expect(
      await sys(emailDomainRecord, {
        workspaceId: wsId,
        emailDomainId: domainId,
        dkimVerified: true,
        returnPathVerified: true,
      }),
    ).toMatchObject({ status: 'verified', changed: true });
    expect(
      await sys(emailDomainRecord, {
        workspaceId: wsId,
        emailDomainId: domainId,
        error: 'Postmark is unavailable.',
      }),
    ).toMatchObject({ status: 'verified', changed: false });
    await expectHfos(
      () => executeCommand(db(), emailDomainRecord, records, human(owner), meta()),
      'forbidden',
    );

    const s = await ask(emailSetupStatus, { workspaceId: wsId }, member);
    const d = s.domains.find((x) => x.id === domainId)!;
    expect(d).toMatchObject({
      domain: DOMAIN,
      status: 'verified',
      dkimHost: records.dkimHost,
      dkimValue: records.dkimValue,
      returnPathHost: records.returnPathHost,
      returnPathValue: 'pm.mtasv.net',
      lastError: 'Postmark is unavailable.',
    });
    // Stamped the first time each check passed; later passes leave it alone.
    expect((await verifiedAt()).dkim).toBe(halfway.dkim);
    expect(d.dkimVerifiedAt).not.toBeNull();
    expect(d.returnPathVerifiedAt).not.toBeNull();
    expect(d.lastCheckedAt).not.toBeNull();
    const evs = await eventsFor(domainId);
    expect(evs.map((e) => e.event_type)).toEqual([
      'email_domain.added',
      'email_domain.verify_requested',
      'email_domain.checked',
      'email_domain.checked',
      'email_domain.checked',
      'email_domain.checked',
    ]);
    expect(evs[1]!.payload).toEqual({ domain: DOMAIN, providerDomainId: null });
    expect(evs.slice(2).map((e) => e.payload)).toEqual([
      { status: 'pending', changed: false, from: 'pending' },
      { status: 'failed', changed: true, from: 'pending' },
      { status: 'verified', changed: true, from: 'failed' },
      { status: 'verified', changed: false, from: 'verified' },
    ]);
  });

  it('adds addresses on the shared subdomain and on a verified domain; the default moves in one step', async () => {
    const sales = await run(
      emailAddressCreate,
      { workspaceId: wsId, localPart: ` Sales-${u} `, displayName: 'Lone Star Sales' },
      owner,
    );
    expect(sales.address).toBe(`sales-${u}@${SHARED}`);
    salesId = sales.emailAddressId;
    await expectHfos(
      () =>
        run(
          emailAddressCreate,
          { workspaceId: wsId, localPart: 'Support', displayName: 'S' },
          owner,
        ),
      'rule_violation',
      'email_local_part_reserved',
    );
    for (const localPart of ['a..b', '-sales', 'sales-', 'dale ramsey'])
      await expectHfos(
        () => run(emailAddressCreate, { workspaceId: wsId, localPart, displayName: 'X' }, owner),
        'validation',
      );
    await expectHfos(
      () =>
        run(
          emailAddressCreate,
          { workspaceId: wsId, localPart: `sales-${u}`, displayName: 'Again' },
          owner,
        ),
      'rule_violation',
      'email_address_taken',
    );
    // Another workspace's address is just as taken, though this one cannot see it.
    const [theirs] = await rows<{ local_part: string }>(
      admin(),
      sql`select local_part from app.email_addresses where workspace_id = ${outsiderWsId} and is_default`,
    );
    await expectHfos(
      () =>
        run(
          emailAddressCreate,
          { workspaceId: wsId, localPart: theirs!.local_part, displayName: 'Mine now' },
          owner,
        ),
      'rule_violation',
      'email_address_taken',
    );
    await expectHfos(
      () =>
        run(
          emailAddressCreate,
          { workspaceId: wsId, localPart: `x-${u}`, displayName: 'X' },
          member,
        ),
      'forbidden',
    );

    // The business's own domain may use any name, and its address can take over as the default.
    const support = await run(
      emailAddressCreate,
      {
        workspaceId: wsId,
        emailDomainId: domainId,
        localPart: 'support',
        displayName: 'Lone Star HVAC',
        isDefault: true,
      },
      owner,
    );
    expect(support.address).toBe(`support@${DOMAIN}`);
    supportId = support.emailAddressId;
    const defaults = await rows<{ id: string }>(
      admin(),
      sql`select id from app.email_addresses where workspace_id = ${wsId} and is_default`,
    );
    expect(defaults.map((r) => r.id)).toEqual([supportId]);
    expect(await eventsFor(supportId)).toEqual([
      {
        event_type: 'email_address.created',
        payload: {
          address: support.address,
          emailDomainId: domainId,
          isDefault: true,
          previousDefaultId: sharedDefaultId,
        },
      },
    ]);
    await expectHfos(
      () => run(emailDomainRemove, { workspaceId: wsId, emailDomainId: domainId }, owner),
      'rule_violation',
      'email_domain_in_use',
    );
    await expectHfos(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: supportId, isDefault: false },
          owner,
        ),
      'rule_violation',
      'email_default_required',
    );
    await expectHfos(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: salesId, displayName: 'No' },
          member,
        ),
      'forbidden',
    );

    const moved = await run(
      emailAddressUpdate,
      {
        workspaceId: wsId,
        emailAddressId: salesId,
        isDefault: true,
        displayName: 'Lone Star HVAC Sales',
      },
      owner,
    );
    expect(moved).toEqual({
      emailAddressId: salesId,
      address: sales.address,
      updated: ['displayName', 'isDefault'],
    });
    const s = await ask(emailSetupStatus, { workspaceId: wsId }, member);
    expect(s.addresses[0]).toMatchObject({
      id: salesId,
      isDefault: true,
      displayName: 'Lone Star HVAC Sales',
      usable: true,
    });
    expect(s.addresses.filter((a) => a.isDefault)).toHaveLength(1);
    expect(s.addresses.find((a) => a.id === supportId)).toMatchObject({
      domain: DOMAIN,
      emailDomainId: domainId,
      usable: true,
      isDefault: false,
    });
    const updated = (await eventsFor(salesId)).find(
      (e) => e.event_type === 'email_address.updated',
    );
    expect(updated?.payload).toEqual({
      fields: ['displayName', 'isDefault'],
      previousDefaultId: supportId,
    });

    // Renamed while it has not sent anything; reserved and taken names still refused.
    const renamed = await run(
      emailAddressUpdate,
      { workspaceId: wsId, emailAddressId: salesId, localPart: `Office-${u}` },
      owner,
    );
    expect(renamed.address).toBe(`office-${u}@${SHARED}`);
    await expectHfos(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: salesId, localPart: 'info' },
          owner,
        ),
      'rule_violation',
      'email_local_part_reserved',
    );
    await expectHfos(
      () =>
        run(
          emailAddressUpdate,
          {
            workspaceId: wsId,
            emailAddressId: salesId,
            localPart: sharedDefaultAddress.split('@')[0],
          },
          owner,
        ),
      'rule_violation',
      'email_address_taken',
    );
  });

  it('an address that has sent mail keeps its name, though its display name can change', async () => {
    await asTenant(
      sql`with c as (
            insert into app.conversations (workspace_id, channel, counterpart, person_id)
            values (${wsId}, 'email', ${`mike-${u}@example.com`}, ${mikeId}) returning id)
          insert into app.messages (workspace_id, conversation_id, channel, direction, status, email_address_id, subject, body_text)
          select ${wsId}, c.id, 'email', 'outbound', 'sent', ${salesId}, 'Your quote', 'Hi Mike, the quote is attached.' from c`,
    );
    await expectHfos(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: salesId, localPart: `sales2-${u}` },
          owner,
        ),
      'rule_violation',
      'email_address_in_use',
    );
    expect(
      await run(
        emailAddressUpdate,
        { workspaceId: wsId, emailAddressId: salesId, displayName: 'Lone Star HVAC' },
        owner,
      ),
    ).toEqual({
      emailAddressId: salesId,
      address: `office-${u}@${SHARED}`,
      updated: ['displayName'],
    });
  });

  it('a verified domain that stops verifying moves to failed, and email falls back to the shared address', async () => {
    // Its address is the default when a check finds the DKIM record gone.
    await run(
      emailAddressUpdate,
      { workspaceId: wsId, emailAddressId: supportId, isDefault: true },
      owner,
    );
    expect(
      await sys(emailDomainRecord, {
        workspaceId: wsId,
        emailDomainId: domainId,
        dkimVerified: false,
        returnPathVerified: true,
        error: `The DKIM record stopped verifying, so email goes out from ${sharedDefaultAddress} until it’s fixed.`,
      }),
    ).toEqual({ emailDomainId: domainId, status: 'failed', changed: true });
    const [d] = await rows<{ dkim: string | null; rp: string | null; last_error: string }>(
      admin(),
      sql`select dkim_verified_at::text as dkim, return_path_verified_at::text as rp, last_error
          from app.email_domains where id = ${domainId}`,
    );
    // The missing record shows as not found again; the one still there keeps its stamp.
    expect(d).toMatchObject({
      dkim: null,
      last_error: expect.stringContaining(sharedDefaultAddress),
    });
    expect(d!.rp).not.toBeNull();
    expect((await eventsFor(domainId)).at(-1)).toEqual({
      event_type: 'email_domain.checked',
      payload: { status: 'failed', changed: true, from: 'verified' },
    });

    // Its addresses stop sending: the next email goes from the shared-subdomain address.
    const s = await ask(emailSetupStatus, { workspaceId: wsId }, member);
    expect(s.addresses.find((a) => a.id === supportId)).toMatchObject({
      isDefault: true,
      usable: false,
    });
    const to = `lapse-${u}@example.com`;
    const sent = await run(
      messageSend,
      {
        workspaceId: wsId,
        channel: 'email',
        toEmail: to,
        subject: 'Your quote',
        body: 'Hi, the quote is attached.',
      },
      owner,
    );
    const [m] = await rows<{ email_address_id: string; from_address: string }>(
      admin(),
      sql`select email_address_id, from_address from app.messages where id = ${sent.messageId}`,
    );
    expect(m).toEqual({ email_address_id: sharedDefaultId, from_address: sharedDefaultAddress });
    const options = await ask(
      emailComposeOptions,
      { workspaceId: wsId, conversationId: sent.conversationId },
      member,
    );
    expect(options.fromAddressId).toBe(sharedDefaultId);
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            channel: 'email',
            toEmail: to,
            subject: 'Again',
            body: 'Hi again.',
            emailAddressId: supportId,
          },
          owner,
        ),
      'rule_violation',
      'email_domain_unverified',
    );

    // Back once the record is; then the default moves to the shared subdomain so the domain can go.
    expect(
      await sys(emailDomainRecord, {
        workspaceId: wsId,
        emailDomainId: domainId,
        dkimVerified: true,
        returnPathVerified: true,
      }),
    ).toMatchObject({ status: 'verified', changed: true });
    await run(
      emailAddressUpdate,
      { workspaceId: wsId, emailAddressId: salesId, isDefault: true },
      owner,
    );
  });

  it('removes a domain and its addresses once the default lives elsewhere', async () => {
    await expectHfos(
      () => run(emailDomainRemove, { workspaceId: wsId, emailDomainId: domainId }, member),
      'forbidden',
    );
    await run(emailDomainRemove, { workspaceId: wsId, emailDomainId: domainId }, owner);
    const [left] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.email_addresses where id = ${supportId}`,
    );
    expect(left?.n).toBe(0);
    const removed = (await eventsFor(domainId)).find(
      (e) => e.event_type === 'email_domain.removed',
    );
    expect(removed?.payload).toEqual({ domain: DOMAIN, providerDomainId: '4410123' });
    await expectHfos(
      () => run(emailDomainVerify, { workspaceId: wsId, emailDomainId: domainId }, owner),
      'not_found',
    );
  });

  it('connects a mailbox through a one-time state, replaces an older connection to the same account, and disconnects', async () => {
    await expectHfos(
      () => run(mailboxConnect, { workspaceId: wsId, provider: 'microsoft' }, member),
      'forbidden',
    );
    const first = await run(mailboxConnect, { workspaceId: wsId, provider: 'microsoft' }, owner);
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [pending] = await rows<{
      status: string;
      user_id: string;
      created_by: string;
      oauth_state_hash: string;
      ttl: number;
    }>(
      admin(),
      sql`select status::text as status, user_id, created_by, oauth_state_hash,
            extract(epoch from oauth_state_expires_at - now())::int as ttl
          from app.mailbox_connections where id = ${first.connectionId}`,
    );
    expect(pending).toMatchObject({
      status: 'pending',
      user_id: owner.id,
      created_by: owner.id,
      oauth_state_hash: sha256(first.state),
    });
    expect(pending!.ttl).toBeGreaterThan(540);
    expect(pending!.ttl).toBeLessThanOrEqual(601);
    expect(await eventsFor(first.connectionId)).toEqual([
      {
        event_type: 'mailbox.connect_started',
        payload: { provider: 'microsoft', shared: false, _broadcast: false },
      },
    ]);
    expect((await ask(emailSetupStatus, { workspaceId: wsId }, member)).mailboxes).toEqual([
      expect.objectContaining({
        id: first.connectionId,
        provider: 'microsoft',
        status: 'pending',
        accountEmail: null,
        userId: owner.id,
        userName: owner.fullName,
      }),
    ]);

    const activate = (connectionId: string) =>
      sys(mailboxActivate, {
        workspaceId: wsId,
        connectionId,
        accountEmail: 'Dale@LoneStarHVAC.com',
        displayName: 'Dale Ramsey',
        scopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'offline_access'],
        tokenEnc: TOKEN,
        tokenKeyId: 'k2026',
        tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(await activate(first.connectionId)).toEqual({
      connectionId: first.connectionId,
      status: 'active',
      changed: true,
    });
    expect(await activate(first.connectionId)).toMatchObject({ changed: false });
    const [live] = await rows<Record<string, unknown>>(
      admin(),
      sql`select status::text as status, account_email, token_enc, oauth_state_hash, pkce_verifier_enc, connected_at
          from app.mailbox_connections where id = ${first.connectionId}`,
    );
    expect(live).toMatchObject({
      status: 'active',
      account_email: 'dale@lonestarhvac.com',
      token_enc: TOKEN,
      oauth_state_hash: null,
      pkce_verifier_enc: null,
    });
    expect(live!.connected_at).not.toBeNull();
    await expectHfos(
      () =>
        executeCommand(
          db(),
          mailboxActivate,
          {
            workspaceId: wsId,
            connectionId: first.connectionId,
            accountEmail: 'me@example.com',
            scopes: [],
            tokenEnc: 'x',
            tokenKeyId: 'k',
            tokenExpiresAt: null,
          },
          human(owner),
          meta(),
        ),
      'forbidden',
    );
    await run(mailboxResync, { workspaceId: wsId, connectionId: first.connectionId }, owner);
    await expectHfos(
      () => run(mailboxResync, { workspaceId: wsId, connectionId: first.connectionId }, member),
      'forbidden',
    );

    // Signing in to the same account again retires the first connection.
    const second = await run(
      mailboxConnect,
      { workspaceId: wsId, provider: 'microsoft', shared: true },
      owner,
    );
    await activate(second.connectionId);
    const both = await rows<{ id: string; status: string; token_enc: string | null }>(
      admin(),
      sql`select id, status::text as status, token_enc from app.mailbox_connections
          where id in (${first.connectionId}, ${second.connectionId})`,
    );
    expect(Object.fromEntries(both.map((r) => [r.id, [r.status, r.token_enc]]))).toEqual({
      [first.connectionId]: ['disconnected', null],
      [second.connectionId]: ['active', TOKEN],
    });
    const firstEvents = await eventsFor(first.connectionId);
    expect(firstEvents.map((e) => e.event_type)).toEqual([
      'mailbox.connect_started',
      'mailbox.connected',
      'mailbox.resync_requested',
      'mailbox.disconnected',
    ]);
    expect(firstEvents[3]!.payload).toEqual({
      provider: 'microsoft',
      replacedBy: second.connectionId,
    });
    expect(
      (await eventsFor(second.connectionId)).find((e) => e.event_type === 'mailbox.connected')
        ?.payload,
    ).toEqual({ provider: 'microsoft', shared: true, replaced: [first.connectionId] });
    await expectHfos(() => activate(first.connectionId), 'rule_violation', 'mailbox_not_pending');
    await expectHfos(
      () => run(mailboxResync, { workspaceId: wsId, connectionId: first.connectionId }, owner),
      'rule_violation',
      'mailbox_not_active',
    );
    // The sealed token never reaches an event or the audit log.
    const [leaks] = await rows<{ n: number }>(
      admin(),
      sql`select
            (select count(*) from app.events where payload::text like ${`%${TOKEN}%`})::int
            + (select count(*) from app.audit_logs
                where coalesce(before::text, '') || coalesce(after::text, '') like ${`%${TOKEN}%`})::int as n`,
    );
    expect(leaks?.n).toBe(0);

    // Trouble is reported once per change.
    const reauth = {
      workspaceId: wsId,
      connectionId: second.connectionId,
      status: 'reauth_required',
      error: 'invalid_grant',
    };
    expect(await sys(mailboxFail, reauth)).toEqual({
      connectionId: second.connectionId,
      status: 'reauth_required',
      changed: true,
    });
    expect(await sys(mailboxFail, reauth)).toMatchObject({ changed: false });
    expect(
      (await eventsFor(second.connectionId)).filter(
        (e) => e.event_type === 'mailbox.reauth_required',
      ),
    ).toHaveLength(1);
    await expectHfos(
      () => run(mailboxResync, { workspaceId: wsId, connectionId: second.connectionId }, owner),
      'rule_violation',
      'mailbox_not_active',
    );

    await expectHfos(
      () =>
        run(mailboxDisconnect, { workspaceId: wsId, connectionId: second.connectionId }, member),
      'forbidden',
    );
    await run(mailboxDisconnect, { workspaceId: wsId, connectionId: second.connectionId }, owner);
    await run(mailboxDisconnect, { workspaceId: wsId, connectionId: second.connectionId }, owner);
    const [gone] = await rows<{ status: string; token_enc: string | null; at: Date | null }>(
      admin(),
      sql`select status::text as status, token_enc, disconnected_at as at from app.mailbox_connections where id = ${second.connectionId}`,
    );
    expect(gone).toMatchObject({ status: 'disconnected', token_enc: null });
    expect(gone?.at).not.toBeNull();
    expect(
      (await eventsFor(second.connectionId))
        .filter((e) => e.event_type === 'mailbox.disconnected')
        .map((e) => e.payload),
    ).toEqual([{ provider: 'microsoft' }]);
    expect((await ask(emailSetupStatus, { workspaceId: wsId }, member)).mailboxes).toEqual([]);
  });

  it('lists a failed sign-in, and drops one nobody finished once its state has expired', async () => {
    const google = await run(mailboxConnect, { workspaceId: wsId, provider: 'google' }, owner);
    expect(
      await sys(mailboxFail, {
        workspaceId: wsId,
        connectionId: google.connectionId,
        status: 'error',
        error: 'The user declined consent.',
      }),
    ).toMatchObject({ status: 'error', changed: true });
    expect((await eventsFor(google.connectionId)).map((e) => e.event_type)).toEqual([
      'mailbox.connect_started',
      'mailbox.failed',
    ]);
    const stale = await run(mailboxConnect, { workspaceId: wsId, provider: 'google' }, owner);
    await asTenant(
      sql`update app.mailbox_connections set created_at = now() - interval '11 minutes' where id = ${stale.connectionId}`,
    );
    const listed = (await ask(emailSetupStatus, { workspaceId: wsId }, member)).mailboxes;
    expect(listed.map((m) => [m.id, m.status, m.lastError])).toEqual([
      [google.connectionId, 'error', 'The user declined consent.'],
    ]);
  });

  it('files mail from an unknown sender under a customer, or dismisses it, exactly once', async () => {
    const receive = (from: string, subject: string, minutesAgo: number) =>
      asTenant<{ id: string }>(
        sql`insert into app.email_inbound_unmatched
              (workspace_id, email_address_id, from_address, from_name, subject, snippet, body_text, message_id_header, received_at)
            values (${wsId}, ${salesId}, ${from}, 'Someone New', ${subject}, 'Do you service Katy?',
              'Do you service Katy? We need a new AC.', ${`<${randomUUID()}@example.com>`},
              now() - make_interval(mins => ${minutesAgo}))
            returning id`,
      ).then((r) => r[0]!.id);
    const older = await receive(`new-${u}@example.com`, 'AC quote', 30);
    const newer = await receive(`other-${u}@example.com`, 'Furnace noise', 5);

    const page1 = await ask(emailUnmatchedList, { workspaceId: wsId, limit: 1 }, member);
    expect(page1.items).toEqual([
      expect.objectContaining({
        id: newer,
        fromAddress: `other-${u}@example.com`,
        fromName: 'Someone New',
        subject: 'Furnace noise',
        snippet: 'Do you service Katy?',
        toAddress: `office-${u}@${SHARED}`,
      }),
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await ask(
      emailUnmatchedList,
      { workspaceId: wsId, limit: 1, cursor: page1.nextCursor },
      member,
    );
    expect(page2.items.map((i) => i.id)).toEqual([older]);
    expect(page2.nextCursor).toBeNull();
    expect((await ask(emailSetupStatus, { workspaceId: wsId }, member)).counts.unmatched).toBe(2);

    await expectHfos(
      () =>
        run(
          emailClaimUnmatched,
          { workspaceId: wsId, unmatchedId: older, personId: archivedId },
          member,
        ),
      'rule_violation',
      'person_archived',
    );
    await expectHfos(
      () =>
        run(
          emailClaimUnmatched,
          { workspaceId: wsId, unmatchedId: older, personId: strangerId },
          member,
        ),
      'not_found',
    );
    await expectHfos(
      () =>
        run(
          emailClaimUnmatched,
          { workspaceId: wsId, unmatchedId: older, personId: mikeId },
          outsider,
        ),
      'not_found',
    );
    expect(
      await run(
        emailClaimUnmatched,
        { workspaceId: wsId, unmatchedId: older, personId: mikeId },
        member,
      ),
    ).toEqual({ unmatchedId: older, personId: mikeId });
    const [claimed] = await rows<{ person: string; by: string; at: Date | null }>(
      admin(),
      sql`select resolved_person_id as person, resolved_by as by, resolved_at as at
          from app.email_inbound_unmatched where id = ${older}`,
    );
    expect(claimed).toMatchObject({ person: mikeId, by: member.id });
    expect(claimed?.at).not.toBeNull();
    expect(await eventsFor(older)).toEqual([
      {
        event_type: 'email.unmatched_claimed',
        payload: { unmatchedId: older, personId: mikeId },
      },
    ]);
    await expectHfos(
      () =>
        run(
          emailClaimUnmatched,
          { workspaceId: wsId, unmatchedId: older, personId: mikeId },
          member,
        ),
      'rule_violation',
      'unmatched_resolved',
    );
    await expectHfos(
      () => run(emailDismissUnmatched, { workspaceId: wsId, unmatchedId: older }, member),
      'rule_violation',
      'unmatched_resolved',
    );

    expect(
      await run(emailDismissUnmatched, { workspaceId: wsId, unmatchedId: newer }, member),
    ).toEqual({ unmatchedId: newer });
    const [dismissed] = await rows<{ by: string }>(
      admin(),
      sql`select dismissed_by as by from app.email_inbound_unmatched where id = ${newer}`,
    );
    expect(dismissed?.by).toBe(member.id);
    expect(await eventsFor(newer)).toEqual([
      { event_type: 'email.unmatched_dismissed', payload: { unmatchedId: newer } },
    ]);
    await expectHfos(
      () =>
        run(
          emailClaimUnmatched,
          { workspaceId: wsId, unmatchedId: newer, personId: mikeId },
          member,
        ),
      'rule_violation',
      'unmatched_resolved',
    );
    expect((await ask(emailUnmatchedList, { workspaceId: wsId }, member)).items).toEqual([]);
    expect((await ask(emailSetupStatus, { workspaceId: wsId }, member)).counts.unmatched).toBe(0);
  });

  it('stops email to an address by hand and releases it', async () => {
    const address = `mike-${u}@example.com`;
    await expectHfos(
      () => run(emailSuppressionAdd, { workspaceId: wsId, address }, member),
      'forbidden',
    );
    const added = await run(
      emailSuppressionAdd,
      { workspaceId: wsId, address: `  Mike-${u}@Example.com ` },
      owner,
    );
    const [row] = await rows<{ address: string; reason: string; created_by: string }>(
      admin(),
      sql`select address, reason::text as reason, created_by from app.email_suppressions where id = ${added.suppressionId}`,
    );
    expect(row).toEqual({ address, reason: 'manual', created_by: owner.id });
    expect(await eventsFor(added.suppressionId)).toEqual([
      { event_type: 'email_suppression.added', payload: { address, reason: 'manual' } },
    ]);
    await expectHfos(
      () => run(emailSuppressionAdd, { workspaceId: wsId, address: address.toUpperCase() }, owner),
      'rule_violation',
      'email_already_suppressed',
    );
    await expectHfos(
      () => run(emailSuppressionAdd, { workspaceId: wsId, address: 'not-an-email' }, owner),
      'validation',
    );

    // A bounce the worker recorded sits beside it, newest first.
    await asTenant(
      sql`insert into app.email_suppressions (workspace_id, address, reason, origin)
          values (${wsId}, ${`gone-${u}@example.com`}, 'hard_bounce', 'postmark:bounce')`,
    );
    const first = await ask(emailSuppressionList, { workspaceId: wsId, limit: 1 }, member);
    expect(first.items).toEqual([
      expect.objectContaining({
        address: `gone-${u}@example.com`,
        reason: 'hard_bounce',
        origin: 'postmark:bounce',
        createdBy: null,
        releasedAt: null,
      }),
    ]);
    const rest = await ask(
      emailSuppressionList,
      { workspaceId: wsId, limit: 1, cursor: first.nextCursor },
      member,
    );
    expect(rest.items).toEqual([
      expect.objectContaining({
        id: added.suppressionId,
        createdBy: { id: owner.id, fullName: owner.fullName },
      }),
    ]);
    expect((await ask(emailSetupStatus, { workspaceId: wsId }, member)).counts.suppressions).toBe(
      2,
    );

    await expectHfos(
      () =>
        run(
          emailSuppressionRelease,
          { workspaceId: wsId, suppressionId: added.suppressionId },
          member,
        ),
      'forbidden',
    );
    await run(
      emailSuppressionRelease,
      { workspaceId: wsId, suppressionId: added.suppressionId },
      owner,
    );
    await run(
      emailSuppressionRelease,
      { workspaceId: wsId, suppressionId: added.suppressionId },
      owner,
    );
    expect((await eventsFor(added.suppressionId)).map((e) => e.event_type)).toEqual([
      'email_suppression.added',
      'email_suppression.released',
    ]);
    expect(
      (await ask(emailSuppressionList, { workspaceId: wsId }, member)).items.map((i) => i.address),
    ).toEqual([`gone-${u}@example.com`]);
    const all = await ask(
      emailSuppressionList,
      { workspaceId: wsId, includeReleased: true },
      member,
    );
    const released = all.items.find((i) => i.id === added.suppressionId);
    expect(released).toMatchObject({ releasedBy: { id: owner.id, fullName: owner.fullName } });
    expect(released?.releasedAt).not.toBeNull();
    // Released, it can be stopped again.
    await run(emailSuppressionAdd, { workspaceId: wsId, address }, owner);
    await expectHfos(
      () =>
        run(
          emailSuppressionRelease,
          { workspaceId: wsId, suppressionId: added.suppressionId },
          outsider,
        ),
      'not_found',
    );
  });
});
