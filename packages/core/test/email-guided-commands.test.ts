/**
 * The guided email setup against the database (commands/email-setup.ts): a website name looked up before it is
 * added, "Set it up" with a free address, and with the business's own website name: added with a plan, its
 * addresses made once its records check out (one only its person reads, with "Let Ava read this mail" as they set
 * it), and more added later to a name that already works. It only adds: what is set up stays as it is.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import {
  as,
  closeTestDbs,
  createTestUser,
  expectPgError,
  testDbs,
  uniq,
  type TestUser,
} from '@hfos/db/testing';
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
import { emailGuidedLeft, emailGuidedOldRecords, type EmailGuidedAnswersInput } from '../src';
import {
  emailDomainRecord,
  emailDomainRecordReceiving,
  emailSetupApply,
  emailSetupGet,
  emailSetupLookUp,
  emailSetupRecordLookup,
  organizationCreate,
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

// Website names and shared-subdomain addresses are unique across every business, so each run uses its own.
const u = uniq();
const DOMAIN = `burroughs-${u}.digital`;
const FREE = `burroughs${u}`.replace(/[^a-z0-9]/g, '');
const OLD = [
  { host: 'mx10.antispam.mailspamprotection.com', priority: 10 },
  { host: 'mx20.antispam.mailspamprotection.com', priority: 20 },
];

let blake: TestUser;
let dana: TestUser;
let member: TestUser;
let orgId: string;
let wsId: string;

const answers = (over: EmailGuidedAnswersInput = {}): EmailGuidedAnswersInput => ({
  with: 'domain',
  domain: DOMAIN,
  freeLocal: FREE,
  name: 'Burroughs Digital',
  addresses: [
    { local: 'blake', reader: 'me', aiReads: true },
    { local: 'office', reader: 'team' },
    { local: 'info', reader: 'team' },
  ],
  sender: 'office',
  receive: true,
  ...over,
});
const apply = (over: EmailGuidedAnswersInput = {}, as: TestUser = blake) =>
  run(emailSetupApply, { workspaceId: wsId, email: answers(over) }, as);
const state = (as: TestUser = blake) =>
  ask(emailSetupGet, { workspaceId: wsId }, as).then((g) => g.state);
const stored = () =>
  rows<{
    local_part: string;
    owner_user_id: string | null;
    ai_reads: boolean;
    is_default: boolean;
  }>(
    admin(),
    sql`select a.local_part, a.owner_user_id, a.ai_reads, a.is_default
        from app.email_addresses a join app.email_domains d on d.id = a.email_domain_id
        where a.workspace_id = ${wsId} and d.domain = ${DOMAIN} order by a.local_part`,
  );

beforeAll(async () => {
  [blake, dana, member] = await Promise.all([
    createTestUser('email-guided-blake'),
    createTestUser('email-guided-dana'),
    createTestUser('email-guided-member'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Burroughs Digital' }, blake);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${dana.id}, 'admin'), (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('looking a website name up before adding it', () => {
  it('asks the worker, and changes nothing about the business’s email', async () => {
    const out = await run(
      emailSetupLookUp,
      { workspaceId: wsId, domain: `https://www.${DOMAIN}/contact` },
      blake,
    );
    expect(out.domain).toBe(DOMAIN);
    const [event] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events
          where workspace_id = ${wsId} and event_type = 'email_domain.lookup_requested'`,
    );
    expect(event?.payload).toMatchObject({ domain: DOMAIN });
    const s = await state();
    expect(s.domains).toEqual([]);
    expect(s.lookup).toBeNull();
  });

  it('refuses a name that can’t be a business’s own, and anyone who can’t change the email', async () => {
    await expectHfos(
      () => run(emailSetupLookUp, { workspaceId: wsId, domain: 'gmail.com' }, blake),
      'validation',
    );
    await expectHfos(
      () => run(emailSetupLookUp, { workspaceId: wsId, domain: 'not a name' }, blake),
      'validation',
    );
    await expectHfos(
      () => run(emailSetupLookUp, { workspaceId: wsId, domain: DOMAIN }, member),
      'forbidden',
    );
  });

  it('shows what the worker found, and the next name replaces it', async () => {
    await sys(emailSetupRecordLookup, {
      workspaceId: wsId,
      domain: 'somewhere-else.example',
      mailHost: 'google',
      dnsHost: 'godaddy',
      mxRecords: [{ host: 'aspmx.l.google.com', priority: 1 }],
    });
    await sys(emailSetupRecordLookup, {
      workspaceId: wsId,
      domain: DOMAIN,
      mailHost: 'other',
      dnsHost: 'siteground',
      mxRecords: OLD,
    });
    expect((await state()).lookup).toMatchObject({
      domain: DOMAIN,
      mailHost: 'other',
      dnsHost: 'siteground',
      mxRecords: OLD,
    });
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.email_domain_lookups where workspace_id = ${wsId}`,
    );
    expect(n!.n).toBe(1);
  });
});

describe('“Set it up”', () => {
  it('checks every answer again first', async () => {
    await expectHfos(() => apply({ name: ' ' }), 'validation');
    await expectHfos(() => apply({ addresses: [{ local: 'blake', reader: 'me' }] }), 'validation');
    await expectHfos(() => apply({ domain: 'gmail.com' }), 'validation');
    await expectHfos(() => apply({}, member), 'forbidden');
    expect((await state()).domains).toEqual([]);
  });

  it('with a free address: renames it without its random letters, and customers hear from it', async () => {
    const before = await state();
    const out = await apply({ with: 'free' });
    expect(out).toMatchObject({
      sender: `${FREE}@mail.handsfreeos.com`,
      emailDomainId: null,
      left: 'done',
    });
    const after = await state();
    expect(after.free).toMatchObject({ id: before.free!.id, localPart: FREE, isDefault: true });
    expect(after.domains).toEqual([]);
  });

  it('with the business’s own name: adds it with a plan, and mail keeps going from the free address', async () => {
    const out = await apply();
    expect(out.emailDomainId).not.toBeNull();
    expect(out).toMatchObject({ sender: `${FREE}@mail.handsfreeos.com`, left: 'records' });
    expect(out.changes).toEqual(
      expect.arrayContaining([
        `Emails go out from office@${DOMAIN} once its records are in`,
        `Makes blake@${DOMAIN} once its records are in`,
      ]),
    );
    const s = await state();
    expect(s.domains).toHaveLength(1);
    expect(s.domains[0]).toMatchObject({
      domain: DOMAIN,
      status: 'pending',
      plan: {
        team: { localPart: 'office', displayName: 'Burroughs Digital' },
        addresses: [{ localPart: 'blake', userId: blake.id, aiReads: true }, { localPart: 'info' }],
        receive: true,
      },
    });
    expect(await stored()).toEqual([]);
    // Coming back, the questions start from the plan.
    const got = await ask(emailSetupGet, { workspaceId: wsId }, blake);
    expect(got.guided!).toMatchObject({ with: 'domain', domain: DOMAIN, sender: 'office' });
    expect(got.guided!.addresses.map((a) => a.local)).toEqual(['office', 'blake', 'info']);
  });

  it('never lets someone else plan “Let Ava read this mail” for an address that isn’t theirs', async () => {
    const d = (await state()).domains[0]!;
    // Dana runs the questions again, with an address of her own: Blake's planned one stays as he set it.
    await apply(
      {
        addresses: [
          { local: 'office', reader: 'team' },
          { local: 'info', reader: 'team' },
          { local: 'dana', reader: 'me' },
        ],
      },
      dana,
    );
    expect((await state()).domains[0]!.plan.addresses).toEqual([
      { localPart: 'info' },
      { localPart: 'dana', userId: dana.id },
      { localPart: 'blake', userId: blake.id, aiReads: true },
    ]);
    // Written straight into the plan for someone else, the database refuses it.
    const forged = JSON.stringify({
      team: { localPart: 'office', displayName: 'Burroughs Digital' },
      addresses: [{ localPart: 'pat', userId: member.id, aiReads: true }],
    });
    const refused = await expectPgError(() =>
      as(dana)((tx) =>
        rows(tx, sql`update app.email_domains set plan = ${forged}::jsonb where id = ${d.id}`),
      ),
    );
    expect(refused).toMatchObject({ code: '42501', detail: 'email_address_ai_reads_is_theirs' });
  });

  it('makes everything once the records check out, the switch on only where its person said so', async () => {
    const d = (await state()).domains[0]!;
    await sys(emailDomainRecord, {
      workspaceId: wsId,
      emailDomainId: d.id,
      providerDomainId: '4410999',
      dkimHost: `20261122pm._domainkey.${DOMAIN}`,
      dkimValue: 'k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1',
      returnPathHost: `pm-bounces.${DOMAIN}`,
      returnPathValue: 'pm.mtasv.net',
      dkimVerified: true,
      returnPathVerified: true,
      ownershipFound: true,
      mailHost: 'other',
      dnsHost: 'siteground',
      mxRecords: OLD,
    });
    expect(await stored()).toEqual([
      { local_part: 'blake', owner_user_id: blake.id, ai_reads: true, is_default: false },
      { local_part: 'dana', owner_user_id: dana.id, ai_reads: false, is_default: false },
      { local_part: 'info', owner_user_id: null, ai_reads: false, is_default: false },
      { local_part: 'office', owner_user_id: null, ai_reads: false, is_default: true },
    ]);
    const s = await state();
    expect(s.sender).toMatchObject({
      address: `office@${DOMAIN}`,
      displayName: 'Burroughs Digital',
    });
    expect(s.domains[0]).toMatchObject({
      status: 'verified',
      receiving: 'pending',
      plan: {},
      mxRecords: OLD,
    });
    // Blake sees his own switch; Dana doesn't see his.
    expect(s.addresses.find((a) => a.localPart === 'blake')).toMatchObject({
      reader: 'me',
      aiReads: true,
    });
    expect((await state(dana)).addresses.find((a) => a.localPart === 'blake')).toMatchObject({
      reader: 'other',
      aiReads: false,
    });
    // The last step: its mail record still has to change.
    expect(emailGuidedLeft(s.domains[0]!)).toBe('mail');
    expect(emailGuidedOldRecords(s.domains[0]!, s)).toEqual(OLD);
  });

  it('sees the old mail records go, one check at a time', async () => {
    const d = (await state()).domains[0]!;
    const ours = { host: 'inbound.postmarkapp.com', priority: 10 };
    await sys(emailDomainRecordReceiving, {
      workspaceId: wsId,
      emailDomainId: d.id,
      mxFound: false,
      mailHost: 'handsfreeos',
      mxRecords: [ours, OLD[1]],
    });
    let s = await state();
    expect(s.domains[0]).toMatchObject({ receiving: 'pending', mailHost: 'handsfreeos' });
    expect(emailGuidedOldRecords(s.domains[0]!, s)).toEqual([OLD[1]]);
    await sys(emailDomainRecordReceiving, {
      workspaceId: wsId,
      emailDomainId: d.id,
      mxFound: true,
      mxRecords: [ours],
    });
    s = await state();
    expect(s.domains[0]).toMatchObject({ receiving: 'on' });
    expect(emailGuidedLeft(s.domains[0]!)).toBe('done');
    expect(emailGuidedOldRecords(s.domains[0]!, s)).toEqual([]);
  });

  it('adds more to a name that already works, at once, and leaves what’s there as it is', async () => {
    const out = await apply({
      name: 'Burroughs',
      addresses: [
        { local: 'sales', reader: 'team' },
        { local: 'b', reader: 'me', aiReads: true },
      ],
      sender: 'info',
      receive: false,
    });
    expect(out).toMatchObject({ sender: `info@${DOMAIN}`, left: 'done' });
    expect(await stored()).toEqual([
      { local_part: 'b', owner_user_id: blake.id, ai_reads: true, is_default: false },
      { local_part: 'blake', owner_user_id: blake.id, ai_reads: true, is_default: false },
      { local_part: 'dana', owner_user_id: dana.id, ai_reads: false, is_default: false },
      { local_part: 'info', owner_user_id: null, ai_reads: false, is_default: true },
      { local_part: 'office', owner_user_id: null, ai_reads: false, is_default: false },
      { local_part: 'sales', owner_user_id: null, ai_reads: false, is_default: false },
    ]);
    const s = await state();
    expect(s.sender).toMatchObject({ address: `info@${DOMAIN}`, displayName: 'Burroughs' });
    // Its mail already comes here: the questions never turn that off.
    expect(s.domains[0]).toMatchObject({ receiving: 'on', plan: {} });
    // An address that's there already can't be asked for again.
    await expectHfos(() => apply({ addresses: [{ local: 'office' }] }), 'validation');
  });
});
