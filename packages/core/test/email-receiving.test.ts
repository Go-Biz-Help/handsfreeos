/**
 * A business receiving its own mail (M19, step 1): turning it on and off, what the worker's MX checks say, and
 * HandsFreeOS's own business using handsfreeos.com, which a staff admin marks and nobody else can.
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
import {
  emailAddressCreate,
  emailDomainAdd,
  emailDomainReceive,
  emailDomainRecord,
  emailDomainRecordInbound,
  emailDomainRecordReceiving,
  emailDomainRemove,
  emailDomainStopReceiving,
  emailSetupStatus,
  organizationCreate,
  ownBusinessSet,
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
const sys = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  scope: { workspaceId: string; organizationId: string },
) => {
  const actor: SystemActor = { type: 'system', ...scope };
  return executeCommand(testDbs().worker.db, cmd, input, actor, meta()).then((r) => r.output);
};
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

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

/**
 * handsfreeos.com belongs to one business at a time, and the database suite uses it too, in parallel: take turns
 * on a lock held for as long as this suite holds the name.
 */
async function holdingOurDomain(fn: () => Promise<void>): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hfos-test:handsfreeos.com'))`);
    await fn();
  });
}

let staffAdmin: TestUser;
let agent: TestUser;
let owner: TestUser;
let member: TestUser;
/** HandsFreeOS's own business, once a staff admin marks it. */
let ours: { workspaceId: string; organizationId: string };
/** Any other business. */
let theirs: { workspaceId: string; organizationId: string };

const beStaff = (u: TestUser, role: 'admin' | 'agent') =>
  admin().execute(
    sql`insert into platform.staff (user_id, role) values (${u.id}, ${role})
        on conflict (user_id) do update set role = ${role}, status = 'active'`,
  );

/** A domain of the business's, verified the way the worker's check would. */
async function verifiedDomain(
  ws: { workspaceId: string; organizationId: string },
  domain: string,
): Promise<string> {
  const { emailDomainId } = await run(
    emailDomainAdd,
    { workspaceId: ws.workspaceId, domain },
    owner,
  );
  await rows(
    admin(),
    sql`update app.email_domains set status = 'verified', dkim_verified_at = now(), return_path_verified_at = now(), ownership_proved_at = now()
        where id = ${emailDomainId}`,
  );
  return emailDomainId;
}

const receivingOf = async (id: string) =>
  (
    await rows<{ receiving: string; mx: boolean }>(
      admin(),
      sql`select receiving::text as receiving, mx_verified_at is not null as mx
          from app.email_domains where id = ${id}`,
    )
  )[0]!;

beforeAll(async () => {
  [staffAdmin, agent, owner, member] = await Promise.all([
    createTestUser('receiving-staff-admin'),
    createTestUser('receiving-staff-agent'),
    createTestUser('receiving-owner'),
    createTestUser('receiving-member'),
  ]);
  const a = await executeCommand(
    db(),
    organizationCreate,
    { businessName: 'HandsFreeOS Test' },
    human(owner),
    meta(),
  );
  ours = { workspaceId: a.output.workspaceId, organizationId: a.output.organizationId };
  const b = await executeCommand(
    db(),
    organizationCreate,
    { businessName: 'Lone Star Receiving' },
    human(owner),
    meta(),
  );
  theirs = { workspaceId: b.output.workspaceId, organizationId: b.output.organizationId };
  await Promise.all([beStaff(staffAdmin, 'admin'), beStaff(agent, 'agent')]);
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${theirs.workspaceId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

/** A business of its own, for tests that add domains (a business holds up to 3). */
async function freshBusiness(name: string) {
  const { output } = await executeCommand(
    db(),
    organizationCreate,
    { businessName: name },
    human(owner),
    meta(),
  );
  return { workspaceId: output.workspaceId, organizationId: output.organizationId };
}

describe('marking HandsFreeOS’s own business', () => {
  it('is a staff admin’s, once; a support agent and the business itself can’t', async () => {
    const set = (u: TestUser, on: boolean) =>
      run(ownBusinessSet, { workspaceId: ours.workspaceId, on }, u);
    // Refused however the kernel words it for a platform command; the flag stays off.
    await expect(set(agent, true)).rejects.toBeInstanceOf(HfosError);
    await expect(set(owner, true)).rejects.toBeInstanceOf(HfosError);
    const [before] = await rows<{ is_platform: boolean }>(
      admin(),
      sql`select is_platform from app.workspaces where id = ${ours.workspaceId}`,
    );
    expect(before!.is_platform).toBe(false);
    expect(await set(staffAdmin, true)).toEqual({
      workspaceId: ours.workspaceId,
      was: false,
      on: true,
      changed: true,
    });
    expect((await set(staffAdmin, true)).changed).toBe(false);
    const events = await rows<{ payload: unknown }>(
      admin(),
      sql`select payload from app.events where event_type = 'own_business.changed' and entity_id = ${ours.workspaceId}`,
    );
    expect(events.map((e) => e.payload)).toEqual([{ workspaceId: ours.workspaceId, on: true }]);
  });
});

describe('handsfreeos.com', () => {
  it('is refused to any other business', async () => {
    await expectHfos(
      () =>
        run(emailDomainAdd, { workspaceId: theirs.workspaceId, domain: 'handsfreeos.com' }, owner),
      'rule_violation',
      'email_domain_ours',
    );
    // Nor is any subdomain anybody's, HandsFreeOS's own business's included.
    await expectHfos(
      () =>
        run(
          emailDomainAdd,
          { workspaceId: ours.workspaceId, domain: 'mail.handsfreeos.com' },
          owner,
        ),
      'rule_violation',
      'email_domain_ours',
    );
  });

  it('is HandsFreeOS’s own business’s, with the support desk’s names kept, and receives through the support server', async () => {
    await holdingOurDomain(async () => {
      const id = await verifiedDomain(ours, 'handsfreeos.com');
      await expectHfos(
        () =>
          run(
            emailAddressCreate,
            {
              workspaceId: ours.workspaceId,
              emailDomainId: id,
              localPart: 'support',
              displayName: 'HandsFreeOS',
              isDefault: false,
            },
            owner,
          ),
        'rule_violation',
        'email_local_part_reserved',
      );
      const chris = await run(
        emailAddressCreate,
        {
          workspaceId: ours.workspaceId,
          emailDomainId: id,
          localPart: 'chris',
          displayName: 'HandsFreeOS',
          isDefault: false,
        },
        owner,
      );
      expect(chris.address).toBe('chris@handsfreeos.com');

      expect(
        await run(emailDomainReceive, { workspaceId: ours.workspaceId, emailDomainId: id }, owner),
      ).toEqual({ emailDomainId: id, receiving: 'pending', changed: true });

      // Unmarking the business while it still uses handsfreeos.com would strand its mail.
      await expectHfos(
        () => run(ownBusinessSet, { workspaceId: ours.workspaceId, on: false }, staffAdmin),
        'rule_violation',
        'platform_holds_our_domain',
      );
      await run(emailDomainRemove, { workspaceId: ours.workspaceId, emailDomainId: id }, owner);
    });
  });
});

describe('receiving at a business’s own domain', () => {
  it('waits for a verified domain, and is open to every business, one at a time per name', async () => {
    const pending = await run(
      emailDomainAdd,
      { workspaceId: ours.workspaceId, domain: `${token()}.example.com` },
      owner,
    );
    await expectHfos(
      () => run(emailDomainReceive, { workspaceId: ours.workspaceId, ...pending }, owner),
      'rule_violation',
      'email_domain_unverified',
    );
    // Any business, not only HandsFreeOS's own (M19 step 6).
    const name = `${token()}.example.com`;
    const elsewhere = await verifiedDomain(theirs, name);
    expect(
      await run(
        emailDomainReceive,
        { workspaceId: theirs.workspaceId, emailDomainId: elsewhere },
        owner,
      ),
    ).toMatchObject({ receiving: 'pending', changed: true });
    // The name moves to another business, which proves it while the first still receives its mail: it waits.
    await rows(
      admin(),
      sql`update app.email_domains set status = 'failed' where id = ${elsewhere}`,
    );
    const next = await freshBusiness('Lone Star Moving');
    const moving = await verifiedDomain(next, name);
    await expectHfos(
      () =>
        run(emailDomainReceive, { workspaceId: next.workspaceId, emailDomainId: moving }, owner),
      'rule_violation',
      'email_domain_receiving_elsewhere',
    );
    await expectHfos(
      () =>
        run(
          emailDomainReceive,
          { workspaceId: theirs.workspaceId, emailDomainId: elsewhere },
          member,
        ),
      'forbidden',
    );
  });

  it('turns on once the worker finds the MX, lapses when it goes, and stops when asked', async () => {
    const id = await verifiedDomain(ours, `${token()}.example.com`);
    const ref = { workspaceId: ours.workspaceId, emailDomainId: id };
    expect(await run(emailDomainReceive, ref, owner)).toMatchObject({ receiving: 'pending' });
    // Asking twice is visibly a no-op.
    expect(await run(emailDomainReceive, ref, owner)).toMatchObject({
      receiving: 'pending',
      changed: false,
    });

    const check = (mxFound: boolean | null) =>
      sys(emailDomainRecordReceiving, { ...ref, mxFound }, ours);
    // Not there yet, then DNS doesn't answer: still waiting either way.
    expect(await check(false)).toMatchObject({ receiving: 'pending', changed: false });
    expect(await check(null)).toMatchObject({ receiving: 'pending', changed: false });
    expect(await check(true)).toMatchObject({ receiving: 'on', changed: true });
    expect(await receivingOf(id)).toEqual({ receiving: 'on', mx: true });
    // A check DNS doesn't answer never turns it off.
    expect(await check(null)).toMatchObject({ receiving: 'on', changed: false });
    expect(await check(false)).toMatchObject({ receiving: 'lapsed', changed: true });
    expect(await check(true)).toMatchObject({ receiving: 'on', changed: true });

    // The worker says only what it saw; a person can't claim the MX answered.
    await expectHfos(
      () => run(emailDomainRecordReceiving, { ...ref, mxFound: true }, owner),
      'forbidden',
    );

    expect(await run(emailDomainStopReceiving, ref, owner)).toEqual({
      emailDomainId: id,
      receiving: 'off',
      changed: true,
    });
    // A check that was already on its way when it stopped changes nothing.
    expect(await check(true)).toMatchObject({ receiving: 'off', changed: false });
    expect((await receivingOf(id)).receiving).toBe('off');

    const events = await rows<{ event_type: string; payload: Record<string, unknown> }>(
      admin(),
      sql`select event_type, payload from app.events
          where entity_id = ${id} and event_type like 'email_domain.receiving%' order by created_at, id`,
    );
    expect(events).toEqual([
      { event_type: 'email_domain.receiving_requested', payload: { domain: expect.any(String) } },
      {
        event_type: 'email_domain.receiving_checked',
        payload: { receiving: 'on', changed: true, from: 'pending' },
      },
      {
        event_type: 'email_domain.receiving_checked',
        payload: { receiving: 'lapsed', changed: true, from: 'on' },
      },
      {
        event_type: 'email_domain.receiving_checked',
        payload: { receiving: 'on', changed: true, from: 'lapsed' },
      },
      {
        event_type: 'email_domain.receiving_stopped',
        payload: { domain: expect.any(String), inboundServerId: null },
      },
    ]);
  });
});

describe('a domain several businesses claim (M19 step 6)', () => {
  it('is verified for the business whose token is published, and waits while another has it working', async () => {
    const [ours, theirs] = await Promise.all([
      freshBusiness('Claims One'),
      freshBusiness('Claims Two'),
    ]);
    const name = `${token()}.example.com`;
    const mine = await run(emailDomainAdd, { workspaceId: ours.workspaceId, domain: name }, owner);
    // A claim still waiting squats nothing: the other business sets the same name up.
    const other = await run(
      emailDomainAdd,
      { workspaceId: theirs.workspaceId, domain: name },
      owner,
    );
    const records = { dkimVerified: true, returnPathVerified: true };
    // Records Postmark shares between the two claims, but not this business's token: not verified.
    expect(
      await sys(
        emailDomainRecord,
        { workspaceId: ours.workspaceId, ...mine, ...records, ownershipFound: false },
        ours,
      ),
    ).toMatchObject({ status: 'pending' });
    expect(
      await sys(
        emailDomainRecord,
        { workspaceId: theirs.workspaceId, ...other, ...records, ownershipFound: true },
        theirs,
      ),
    ).toMatchObject({ status: 'verified' });
    // Proved here too now, but the other business has it working: this one waits, and says so.
    expect(
      await sys(
        emailDomainRecord,
        { workspaceId: ours.workspaceId, ...mine, ...records, ownershipFound: true },
        ours,
      ),
    ).toMatchObject({ status: 'pending' });
    const [waiting] = await rows<{ last_error: string; proved: boolean }>(
      admin(),
      sql`select last_error, ownership_proved_at is not null as proved
          from app.email_domains where id = ${mine.emailDomainId}`,
    );
    expect(waiting).toEqual({
      last_error: `Another HandsFreeOS business still has ${name} working. This one waits until they remove it there; we keep checking.`,
      proved: true,
    });
    // While it's working elsewhere, nobody adds it again.
    await expectHfos(
      () => run(emailDomainAdd, { workspaceId: ours.workspaceId, domain: name }, owner),
      'rule_violation',
      'email_domain_taken',
    );
  });

  it('keeps the server that receives a domain’s mail, and why Postmark refused one', async () => {
    const ours = await freshBusiness('Inbound Servers');
    const id = await verifiedDomain(ours, `${token()}.example.com`);
    const ref = { workspaceId: ours.workspaceId, emailDomainId: id };
    await run(emailDomainReceive, ref, owner);
    expect(await sys(emailDomainRecordInbound, { ...ref, serverId: '5550123' }, ours)).toEqual({
      emailDomainId: id,
      receiving: 'pending',
    });
    const refusal = 'HandsFreeOS can’t take on another domain’s mail right now.';
    expect(
      await sys(emailDomainRecordInbound, { ...ref, serverId: null, error: refusal }, ours),
    ).toEqual({ emailDomainId: id, receiving: 'off' });
    const shown = (
      await ask(emailSetupStatus, { workspaceId: ours.workspaceId }, owner)
    ).domains.find((d) => d.id === id)!;
    expect(shown).toMatchObject({ receiving: 'off', receivingError: refusal });
    // Asking again; the server the worker then records clears it. Only the worker records servers.
    expect(await run(emailDomainReceive, ref, owner)).toMatchObject({ receiving: 'pending' });
    await sys(emailDomainRecordInbound, { ...ref, serverId: '5550123' }, ours);
    expect(
      (await ask(emailSetupStatus, { workspaceId: ours.workspaceId }, owner)).domains.find(
        (d) => d.id === id,
      ),
    ).toMatchObject({ receiving: 'pending', receivingError: null });
    await expectHfos(
      () => run(emailDomainRecordInbound, { ...ref, serverId: '1' }, owner),
      'forbidden',
    );
  });
});
