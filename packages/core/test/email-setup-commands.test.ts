/**
 * The business email step's commands against the database (commands/email-setup.ts): the free address renamed
 * without its random letters, the business's own domain added with a plan, the plan carried out once the domain's
 * records check out (the team address made the default, the person's own address, its mail coming here), and the
 * steps emailed to whoever adds the records.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
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
import { emailSetupHomeOf, type EmailSetupAnswersInput } from '../src';
import {
  emailDomainRecord,
  emailDomainSendSteps,
  emailSetupGet,
  emailSetupSave,
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

// Domains and shared-subdomain addresses are unique across every workspace, so each run uses its own.
const u = uniq();
const DOMAIN = `bellas-${u}.com`;
const FREE = `bellas${u}`.replace(/[^a-z0-9]/g, '');

let owner: TestUser;
let member: TestUser;
let orgId: string;
let wsId: string;

const answers = (over: EmailSetupAnswersInput = {}): EmailSetupAnswersInput => ({
  with: 'domain',
  domain: DOMAIN,
  local: 'hello',
  freeLocal: FREE,
  name: 'Bella’s Salon',
  receive: null,
  mine: false,
  mineLocal: 'maria',
  ...over,
});
const save = (part: 'sender' | 'records' | 'own', over: EmailSetupAnswersInput = {}) =>
  run(emailSetupSave, { workspaceId: wsId, part, email: answers(over) }, owner);
const state = () => ask(emailSetupGet, { workspaceId: wsId }, owner).then((g) => g.state);

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('email-setup-owner'),
    createTestUser('email-setup-member'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Bella’s Salon' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('setting up the business email', () => {
  it('starts from the address the business was made with, and asks Home to set it up', async () => {
    const got = await ask(emailSetupGet, { workspaceId: wsId }, owner);
    expect(got.state.sender?.domain).toBeNull();
    expect(got.state.free?.isDefault).toBe(true);
    expect(got.state.canManage).toBe(true);
    expect(emailSetupHomeOf(got.state)).toMatchObject({ kind: 'start' });
    await expectHfos(() => ask(emailSetupGet, { workspaceId: wsId }, member), 'forbidden');
  });

  it('checks a screen’s answers before saving them', async () => {
    await expectHfos(() => save('sender', { domain: 'gmail.com' }), 'validation');
    await expectHfos(() => save('sender', { name: ' ' }), 'validation');
    await expectHfos(
      () => run(emailSetupSave, { workspaceId: wsId, part: 'sender', email: answers() }, member),
      'forbidden',
    );
  });

  it('renames the free address without its random letters, keeping it', async () => {
    const before = await state();
    const out = await save('sender', { with: 'free' });
    expect(out.sender).toBe(`${FREE}@mail.handsfreeos.com`);
    const after = await state();
    expect(after.free).toMatchObject({
      id: before.free!.id,
      localPart: FREE,
      displayName: 'Bella’s Salon',
      isDefault: true,
    });
    expect(emailSetupHomeOf(after)).toBeNull();
  });

  it('adds the business’s own domain with a plan, and mail keeps going from the free address', async () => {
    const out = await save('sender');
    expect(out.emailDomainId).not.toBeNull();
    expect(out.sender).toBe(`${FREE}@mail.handsfreeos.com`);
    const s = await state();
    expect(s.domains).toHaveLength(1);
    expect(s.domains[0]).toMatchObject({
      domain: DOMAIN,
      status: 'pending',
      plan: { team: { localPart: 'hello', displayName: 'Bella’s Salon' } },
    });
    expect(emailSetupHomeOf(s)).toMatchObject({
      kind: 'records',
      domain: DOMAIN,
      to: `hello@${DOMAIN}`,
    });
    // Saved again, it's the same domain, not another one.
    await save('sender', { local: 'office' });
    const again = await state();
    expect(again.domains).toHaveLength(1);
    expect(again.domains[0]!.plan.team?.localPart).toBe('office');
  });

  it('keeps the person’s own address and the domain’s mail in the plan', async () => {
    await save('own', { local: 'office', mine: true });
    let d = (await state()).domains[0]!;
    expect(d.plan.own).toEqual({ localPart: 'maria', userId: owner.id });
    // Nobody gets email there yet, once the worker has looked: Get email here too is offered (5a).
    await sys(emailDomainRecord, {
      workspaceId: wsId,
      emailDomainId: d.id,
      providerDomainId: '4410999',
      dkimHost: `20261110pm._domainkey.${DOMAIN}`,
      dkimValue: 'k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1',
      returnPathHost: `pm-bounces.${DOMAIN}`,
      returnPathValue: 'pm.mtasv.net',
      dkimVerified: false,
      returnPathVerified: false,
      mailHost: 'none',
      dnsHost: 'godaddy',
    });
    await save('records', { local: 'office', mine: true, receive: true });
    d = (await state()).domains[0]!;
    expect(d).toMatchObject({ mailHost: 'none', dnsHost: 'godaddy', plan: { receive: true } });
    expect(d.records.length).toBeGreaterThan(0);
  });

  it('emails the records to whoever adds them, a few times a day at most', async () => {
    const d = (await state()).domains[0]!;
    const out = await run(
      emailDomainSendSteps,
      { workspaceId: wsId, emailDomainId: d.id, to: 'webguy@example.com' },
      owner,
    );
    expect(out).toEqual({ emailDomainId: d.id, to: 'webguy@example.com' });
    const [event] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events
          where entity_id = ${d.id} and event_type = 'email_domain.steps_requested'`,
    );
    expect(event?.payload).toMatchObject({ domain: DOMAIN, to: 'webguy@example.com' });
    await expectHfos(
      () =>
        run(
          emailDomainSendSteps,
          { workspaceId: wsId, emailDomainId: d.id, to: 'webguy@example.com' },
          member,
        ),
      'forbidden',
    );
  });

  it('carries out the plan once the records check out', async () => {
    const d = (await state()).domains[0]!;
    expect(
      await sys(emailDomainRecord, {
        workspaceId: wsId,
        emailDomainId: d.id,
        dkimVerified: true,
        returnPathVerified: true,
        ownershipFound: true,
      }),
    ).toMatchObject({ status: 'verified', changed: true });
    const s = await state();
    expect(s.sender).toMatchObject({ address: `office@${DOMAIN}`, domain: DOMAIN });
    expect(s.mine).toEqual({ address: `maria@${DOMAIN}` });
    expect(s.domains[0]).toMatchObject({ status: 'verified', receiving: 'pending', plan: {} });
    expect(emailSetupHomeOf(s)).toBeNull();
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events
          where workspace_id = ${wsId} and event_type in ('email_address.created', 'email_domain.receiving_requested')`,
    );
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['email_address.created', 'email_domain.receiving_requested']),
    );
  });
});
