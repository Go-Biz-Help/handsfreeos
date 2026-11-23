/**
 * "Let Ava read this mail" (owner, 2026-11-22), through the commands: a person turns the switch on for their own
 * address and nobody does it for them; the AI teammate's draft is kept on their thread where only they read it;
 * and it goes when they answer, put it away, share the thread, get new mail or turn the switch off.
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
  conversationAiDraftDismiss,
  conversationAiDraftSave,
  conversationGet,
  conversationShare,
  emailAddressCreate,
  emailAddressSetAiReads,
  emailAddressUpdate,
  emailReceive,
  emailSetupStatus,
  messageSend,
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

let owner: TestUser;
let dana: TestUser;
let wsId: string;
let orgId: string;
let domainId: string;
let domain: string;
let danas: string;
let team: string;

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
      subject: 'A quote',
      bodyText: 'Could you send me a quote for the patio?',
      emailAddressId,
    },
    system(),
    meta(),
  ).then((r) => r.output);
/** The AI teammate's draft, as the worker keeps it. */
const draft = (conversationId: string, forMessageId: string, body = 'Hi Sam, happy to. Dana') =>
  executeCommand(
    testDbs().worker.db,
    conversationAiDraftSave,
    { workspaceId: wsId, conversationId, forMessageId, body },
    system(),
    meta(),
  ).then((r) => r.output);
const kept = async (conversationId: string) =>
  (
    await rows<{ d: { body: string; forMessageId: string } | null }>(
      admin$(),
      sql`select ai_draft as d from app.conversations where id = ${conversationId}`,
    )
  )[0]!.d;
const switchOf = async (id: string) =>
  (
    await rows<{ ai_reads: boolean }>(
      admin$(),
      sql`select ai_reads from app.email_addresses where id = ${id}`,
    )
  )[0]!.ai_reads;
const turn = (on: boolean, u: TestUser = dana, emailAddressId: string = danas) =>
  run(emailAddressSetAiReads, { workspaceId: wsId, emailAddressId, aiReads: on }, u);

beforeAll(async () => {
  [owner, dana] = await Promise.all([
    createTestUser('ai-reads-owner'),
    createTestUser('ai-reads-dana'),
  ]);
  const created = await run(organizationCreate, { businessName: 'Patio People' }, owner);
  wsId = created.workspaceId;
  orgId = created.organizationId;
  // Dana is a member: she can't change the business's addresses, and the switch on her own is still hers.
  await rows(
    admin$(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${dana.id}, 'member')`,
  );
  await rows(
    admin$(),
    sql`insert into app.ai_teammates (workspace_id, name, status, training_started_at)
        values (${wsId}, 'Ava', 'training', now())`,
  );
  domain = `${token()}.example.com`;
  const [d] = await rows<{ id: string }>(
    admin$(),
    sql`insert into app.email_domains (workspace_id, domain, status, receiving, ownership_proved_at)
        values (${wsId}, ${domain}, 'verified', 'on', now()) returning id`,
  );
  domainId = d!.id;
  danas = (
    await run(
      emailAddressCreate,
      {
        workspaceId: wsId,
        emailDomainId: domainId,
        localPart: 'dana',
        displayName: 'Patio People',
        ownerUserId: dana.id,
      },
      owner,
    )
  ).emailAddressId;
  team = (
    await rows<{ id: string }>(
      admin$(),
      sql`select id from app.email_addresses where workspace_id = ${wsId} and is_default`,
    )
  )[0]!.id;
});
afterAll(closeTestDbs);

describe('the switch', () => {
  it('starts off, and only the address’s own person turns it on', async () => {
    expect(await switchOf(danas)).toBe(false);
    // Not an owner of the business, for her.
    const theirs = await expectRule(() => turn(true, owner), 'email_address_ai_reads_is_theirs');
    expect(theirs.message).toContain(`dana@${domain}`);
    expect(theirs.message).toContain('Ava');
    // And never on the team's address.
    const teams = await expectRule(() => turn(true, owner, team), 'email_address_ai_reads_team');
    expect(teams.message).toContain('Channels');
    expect(await switchOf(danas)).toBe(false);

    expect(await turn(true)).toMatchObject({ aiReads: true, changed: true });
    expect(await switchOf(danas)).toBe(true);
    expect(await turn(true)).toMatchObject({ aiReads: true, changed: false });
  });

  it('shows on her own Settings only, with who would read', async () => {
    const mine = await ask(emailSetupStatus, { workspaceId: wsId }, dana);
    expect(mine.aiTeammate).toEqual({ name: 'Ava', on: true });
    expect(mine.addresses.find((a) => a.id === danas)).toMatchObject({ mine: true, aiReads: true });
    const others = await ask(emailSetupStatus, { workspaceId: wsId }, owner);
    expect(others.addresses.find((a) => a.id === danas)).toMatchObject({
      mine: false,
      aiReads: false,
    });
  });

  it('says in the history that it changed, and nothing else', async () => {
    const [e] = await rows<{ payload: Record<string, unknown> }>(
      admin$(),
      sql`select payload from app.events
          where entity_id = ${danas} and event_type = 'email_address.ai_reads_changed'
          order by created_at desc limit 1`,
    );
    expect(e!.payload).toEqual({ aiReads: true });
  });
});

describe('the draft', () => {
  it('is kept on her own thread, for her alone', async () => {
    const got = await receive(`sam-${token()}@example.com`, danas);
    const out = await draft(got.conversationId!, got.messageId!);
    expect(out).toEqual({ conversationId: got.conversationId, saved: true, skipped: null });

    const hers = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: got.conversationId },
      dana,
    );
    expect(hers.aiDraft).toMatchObject({
      body: 'Hi Sam, happy to. Dana',
      forMessageId: got.messageId,
      by: 'Ava',
    });
    // The owner of the business can't open her thread, so there is no draft to read.
    await expect(
      ask(conversationGet, { workspaceId: wsId, conversationId: got.conversationId }, owner),
    ).rejects.toMatchObject({ code: 'not_found' });
    // And the history says a draft was made, never what it said.
    const events = await rows<{ payload: Record<string, unknown>; after: unknown }>(
      admin$(),
      sql`select e.payload, a.after from app.events e left join app.audit_logs a on a.event_id = e.id
          where e.entity_id = ${got.conversationId} and e.event_type = 'conversation.ai_drafted'`,
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain('happy to');
  });

  it('is only for the newest mail, on her own mail, while the switch is on', async () => {
    const got = await receive(`kit-${token()}@example.com`, danas);
    expect(await draft(got.conversationId!, randomUUID())).toMatchObject({
      saved: false,
      skipped: 'not_newest',
    });
    const teams = await receive(`lou-${token()}@example.com`, team);
    if (teams.conversationId)
      expect(await draft(teams.conversationId, teams.messageId!)).toMatchObject({
        saved: false,
        skipped: 'not_own_mail',
      });
    await turn(false);
    expect(await draft(got.conversationId!, got.messageId!)).toMatchObject({
      saved: false,
      skipped: 'switched_off',
    });
    expect(await kept(got.conversationId!)).toBeNull();
    await turn(true);
  });

  it('goes when she answers, and when new mail comes', async () => {
    const from = `ann-${token()}@example.com`;
    const got = await receive(from, danas);
    await draft(got.conversationId!, got.messageId!);
    const again = await receive(from, danas);
    expect(again.conversationId).toBe(got.conversationId);
    expect(await kept(got.conversationId!)).toBeNull();

    await draft(got.conversationId!, again.messageId!);
    expect(await kept(got.conversationId!)).not.toBeNull();
    await run(
      messageSend,
      {
        workspaceId: wsId,
        channel: 'email',
        conversationId: got.conversationId,
        emailAddressId: danas,
        body: 'Hi Ann, the quote is on its way. Dana',
      },
      dana,
    );
    expect(await kept(got.conversationId!)).toBeNull();
    // She answered, so the mail it was for is no longer the newest thing in the thread.
    expect(await draft(got.conversationId!, again.messageId!)).toMatchObject({
      saved: false,
      skipped: 'not_newest',
    });
  });

  it('goes when she puts it away, or shares the thread with the team', async () => {
    const got = await receive(`pat-${token()}@example.com`, danas);
    await draft(got.conversationId!, got.messageId!);
    const ref = { workspaceId: wsId, conversationId: got.conversationId };
    expect(await run(conversationAiDraftDismiss, ref, dana)).toMatchObject({ dismissed: true });
    expect(await kept(got.conversationId!)).toBeNull();
    expect(await run(conversationAiDraftDismiss, ref, dana)).toMatchObject({ dismissed: false });

    await draft(got.conversationId!, got.messageId!);
    await run(conversationShare, ref, dana);
    expect(await kept(got.conversationId!)).toBeNull();
  });

  it('goes with the switch, and the switch goes when the address changes hands', async () => {
    const got = await receive(`rae-${token()}@example.com`, danas);
    await draft(got.conversationId!, got.messageId!);
    await turn(false);
    expect(await kept(got.conversationId!)).toBeNull();

    // An address of the owner's own, handed back to the team: the yes was one person's.
    const own = await run(
      emailAddressCreate,
      {
        workspaceId: wsId,
        emailDomainId: domainId,
        localPart: 'boss',
        displayName: 'Patio People',
        ownerUserId: owner.id,
      },
      owner,
    );
    await turn(true, owner, own.emailAddressId);
    await run(
      emailAddressUpdate,
      { workspaceId: wsId, emailAddressId: own.emailAddressId, ownerUserId: null },
      owner,
    );
    expect(await switchOf(own.emailAddressId)).toBe(false);
  });
});
