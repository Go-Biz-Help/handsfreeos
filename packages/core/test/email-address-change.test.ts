/**
 * Changing addresses after setup (Settings → Email, 2026-11-22): the default address becomes one person's own
 * with another taking over in the same go, its own person hands an address back to the team, and one address is
 * removed with its mail left where it is.
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
  emailAddressRemove,
  emailAddressUpdate,
  emailReceive,
  emailSetupStatus,
  organizationCreate,
} from '../src/server';

const db = () => testDbs().api.db;
const admin$ = () => testDbs().admin.db;
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
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

async function expectRule(fn: () => Promise<unknown>, rule: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule).toBe(rule);
    return e as HfosError;
  }
  throw new Error(`expected ${rule}, but the call succeeded`);
}

let blake: TestUser;
let dana: TestUser;
let wsId: string;
let orgId: string;
let domainId: string;
let domain: string;
let free: { id: string; address: string };

const add = (localPart: string, over: Record<string, unknown> = {}, as: TestUser = blake) =>
  run(
    emailAddressCreate,
    {
      workspaceId: wsId,
      emailDomainId: domainId,
      localPart,
      displayName: 'Burroughs Digital',
      ...over,
    },
    as,
  );
const address = async (id: string) =>
  (
    await rows<{ is_default: boolean; owner_user_id: string | null }>(
      admin$(),
      sql`select is_default, owner_user_id from app.email_addresses where id = ${id}`,
    )
  )[0] ?? null;
const receive = (from: string, emailAddressId: string) =>
  executeCommand(
    testDbs().worker.db,
    emailReceive,
    {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: `pm-${token()}`,
      messageIdHeader: `<${randomUUID()}@mail.example.com>`,
      from: { address: from },
      to: [{ address: 'someone@example.com' }],
      subject: 'About Friday',
      bodyText: 'Are we still on for Friday?',
      emailAddressId,
    },
    system(),
    meta(),
  ).then((r) => r.output);
const thread = async (id: string) =>
  (
    await rows<{ private_to: string | null; email_address_id: string | null }>(
      admin$(),
      sql`select private_to, email_address_id from app.conversations where id = ${id}`,
    )
  )[0]!;

beforeAll(async () => {
  [blake, dana] = await Promise.all([
    createTestUser('addr-change-blake'),
    createTestUser('addr-change-dana'),
  ]);
  const created = await run(organizationCreate, { businessName: 'Burroughs Digital' }, blake);
  wsId = created.workspaceId;
  orgId = created.organizationId;
  await rows(
    admin$(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${dana.id}, 'admin')`,
  );
  domain = `${token()}.example.com`;
  const [d] = await rows<{ id: string }>(
    admin$(),
    sql`insert into app.email_domains (workspace_id, domain, status, receiving, ownership_proved_at)
        values (${wsId}, ${domain}, 'verified', 'on', now()) returning id`,
  );
  domainId = d!.id;
  free = (
    await rows<{ id: string; address: string }>(
      admin$(),
      sql`select id, address from app.email_addresses where workspace_id = ${wsId} and is_default`,
    )
  )[0]!;
});
afterAll(closeTestDbs);

describe('the default address becomes one person’s own', () => {
  it('asks which address takes over, then does both in one go', async () => {
    // What happened to Burroughs Digital: the first address added on the domain became the default.
    const mine = await add('blake', { isDefault: true });
    const office = await add('office');
    const err = await expectRule(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: mine.emailAddressId, ownerUserId: blake.id },
          blake,
        ),
      'email_address_owner_default',
    );
    expect(err.message).toContain(`blake@${domain}`);
    expect(err.message).toContain('takes over');
    // Nothing moved.
    expect(await address(mine.emailAddressId)).toEqual({ is_default: true, owner_user_id: null });

    const out = await run(
      emailAddressUpdate,
      {
        workspaceId: wsId,
        emailAddressId: mine.emailAddressId,
        ownerUserId: blake.id,
        defaultToId: office.emailAddressId,
      },
      blake,
    );
    expect(out.updated).toEqual(['ownerUserId']);
    expect(await address(mine.emailAddressId)).toEqual({
      is_default: false,
      owner_user_id: blake.id,
    });
    expect(await address(office.emailAddressId)).toEqual({ is_default: true, owner_user_id: null });
  });

  it('refuses a takeover by itself, by a person’s own address, and takes the free address', async () => {
    const sales = await add('sales', { isDefault: true });
    const danas = await add('dana', { ownerUserId: dana.id });
    for (const defaultToId of [sales.emailAddressId, danas.emailAddressId])
      await expectRule(
        () =>
          run(
            emailAddressUpdate,
            {
              workspaceId: wsId,
              emailAddressId: sales.emailAddressId,
              ownerUserId: blake.id,
              defaultToId,
            },
            blake,
          ),
        'email_default_takeover',
      );
    expect(await address(sales.emailAddressId)).toEqual({ is_default: true, owner_user_id: null });
    await run(
      emailAddressUpdate,
      {
        workspaceId: wsId,
        emailAddressId: sales.emailAddressId,
        ownerUserId: blake.id,
        defaultToId: free.id,
      },
      blake,
    );
    expect(await address(free.id)).toEqual({ is_default: true, owner_user_id: null });
    expect((await address(sales.emailAddressId))!.owner_user_id).toBe(blake.id);
  });
});

describe('an address handed back to the team', () => {
  it('is its own person’s to hand back; their old mail stays theirs and new mail is the team’s', async () => {
    const own = await add('hello', { ownerUserId: blake.id });
    const before = await receive(`ann-${token()}@example.com`, own.emailAddressId);
    expect((await thread(before.conversationId!)).private_to).toBe(blake.id);

    // Not someone else, even an admin, while Blake works here.
    await expectRule(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: own.emailAddressId, ownerUserId: null },
          dana,
        ),
      'email_address_owner_is_theirs',
    );
    // And never straight to another person.
    await expectRule(
      () =>
        run(
          emailAddressUpdate,
          { workspaceId: wsId, emailAddressId: own.emailAddressId, ownerUserId: dana.id },
          blake,
        ),
      'email_address_owner_is_theirs',
    );

    const out = await run(
      emailAddressUpdate,
      { workspaceId: wsId, emailAddressId: own.emailAddressId, ownerUserId: null },
      blake,
    );
    expect(out.updated).toEqual(['ownerUserId']);
    expect((await address(own.emailAddressId))!.owner_user_id).toBeNull();
    expect((await thread(before.conversationId!)).private_to).toBe(blake.id);
    const after = await receive(`cy-${token()}@example.com`, own.emailAddressId);
    expect((await thread(after.conversationId!)).private_to).toBeNull();

    // The settings page knows whose each one is.
    const status = await ask(emailSetupStatus, { workspaceId: wsId }, blake);
    const row = status.addresses.find((a) => a.id === own.emailAddressId)!;
    expect(row).toMatchObject({ ownerUserId: null, mine: false, renamable: false });
  });

  it('can be handed back and made the default in one go', async () => {
    const own = await add('bookings', { ownerUserId: blake.id });
    await run(
      emailAddressUpdate,
      {
        workspaceId: wsId,
        emailAddressId: own.emailAddressId,
        ownerUserId: null,
        isDefault: true,
      },
      blake,
    );
    expect(await address(own.emailAddressId)).toEqual({ is_default: true, owner_user_id: null });
    // Put the default back on the free address for the tests after this one.
    await run(
      emailAddressUpdate,
      { workspaceId: wsId, emailAddressId: free.id, isDefault: true },
      blake,
    );
  });
});

describe('one address removed', () => {
  it('keeps the mail it carried, and never takes the default or the free backup', async () => {
    const billing = await add('billing');
    const got = await receive(`pat-${token()}@example.com`, billing.emailAddressId);

    await expectRule(
      () => run(emailAddressRemove, { workspaceId: wsId, emailAddressId: free.id }, blake),
      'email_default_required',
    );
    const out = await run(
      emailAddressRemove,
      { workspaceId: wsId, emailAddressId: billing.emailAddressId },
      blake,
    );
    expect(out).toMatchObject({ address: `billing@${domain}`, threads: 1 });
    expect(await address(billing.emailAddressId)).toBeNull();
    expect(await thread(got.conversationId!)).toEqual({ private_to: null, email_address_id: null });

    // With another address as the default, the one free address still stays: it is the backup.
    const main = await add('main', { isDefault: true });
    await expectRule(
      () => run(emailAddressRemove, { workspaceId: wsId, emailAddressId: free.id }, blake),
      'email_address_backup_stays',
    );
    await run(
      emailAddressUpdate,
      { workspaceId: wsId, emailAddressId: free.id, isDefault: true },
      blake,
    );
    await run(
      emailAddressRemove,
      { workspaceId: wsId, emailAddressId: main.emailAddressId },
      blake,
    );
  });

  it('removes a person’s own address only for them, and their mail stays theirs', async () => {
    const own = await add('private', { ownerUserId: blake.id });
    const got = await receive(`lee-${token()}@example.com`, own.emailAddressId);
    await expectRule(
      () =>
        run(emailAddressRemove, { workspaceId: wsId, emailAddressId: own.emailAddressId }, dana),
      'email_address_owner_is_theirs',
    );
    const out = await run(
      emailAddressRemove,
      { workspaceId: wsId, emailAddressId: own.emailAddressId },
      blake,
    );
    expect(out.threads).toBe(1);
    expect(await thread(got.conversationId!)).toEqual({
      private_to: blake.id,
      email_address_id: null,
    });
    // The history says an address went, not whose mail it carried.
    const events = await rows<{ event_type: string; payload: Record<string, unknown> }>(
      admin$(),
      sql`select event_type, payload from app.events where entity_id = ${own.emailAddressId}
          order by created_at desc limit 1`,
    );
    expect(events[0]).toMatchObject({
      event_type: 'email_address.removed',
      payload: { threads: 1, private: true },
    });
  });

  it('leaves the address of someone who has left to an owner', async () => {
    const danas = (
      await rows<{ id: string }>(
        admin$(),
        sql`select id from app.email_addresses where workspace_id = ${wsId} and owner_user_id = ${dana.id}`,
      )
    )[0]!;
    await rows(
      admin$(),
      sql`delete from app.workspace_memberships where workspace_id = ${wsId} and user_id = ${dana.id}`,
    );
    await expectRule(
      () => run(emailAddressRemove, { workspaceId: wsId, emailAddressId: danas.id }, blake),
      'email_address_owner_left',
    );
  });
});
