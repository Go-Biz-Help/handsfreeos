import { randomUUID } from 'node:crypto';
import {
  AssistantCard,
  assistantToolByName,
  executeCommand,
  executeQuery,
  organizationCreate,
  registry,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * Settings → Email, by asking: an address on the business's own domain, and one that is a person's own, each drawn
 * as a card that says whose it is and changes nothing until Confirm.
 */

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let member: TestUser;
let workspaceId: string;
let organizationId: string;
let domainId: string;
const mark = randomUUID().slice(0, 8);
const domain = `own-${mark}.example.com`;

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const tool = assistantToolByName.get('manage_email_settings')!;
const argsOf = (args: Record<string, unknown>) => tool.input.parse(args) as Record<string, unknown>;
const prepare = async (args: Record<string, unknown>) => {
  const out = await createToolExecutor(api()).prepare(tool, argsOf(args), ctx(), randomUUID());
  expect(AssistantCard.safeParse(out.card).success).toBe(true);
  return out as { card: ConfirmCard };
};
const commit = (args: Record<string, unknown>) =>
  createToolExecutor(api()).commit(tool, argsOf(args), ctx(), { toolCallId: randomUUID() });
const addresses = async () =>
  (
    (await executeQuery(
      api(),
      registry.query('email.setup_status')!,
      { workspaceId },
      actor(owner),
      meta(),
    )) as { addresses: { address: string; ownerUserId?: string | null }[] }
  ).addresses;
const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('aemail-dale', { fullName: 'Dale Owner' }),
    createTestUser('aemail-priya', { fullName: 'Priya Member' }),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: `Email HVAC ${mark}`, timezone: CHI },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
  // The business's own domain, already checked.
  domainId = (
    await rows<{ id: string }>(
      admin(),
      sql`insert into app.email_domains (workspace_id, domain, status, created_by, ownership_proved_at)
          values (${workspaceId}, ${domain}, 'verified', ${owner.id}, now()) returning id`,
    )
  )[0]!.id;
}, 60_000);

afterAll(closeTestDbs);

describe('Settings → Email', () => {
  it('adds a person’s own address on the business’s domain, saying whose, only on Confirm', async () => {
    const args = {
      action: 'add_address',
      localPart: 'priya',
      displayName: 'Priya at Email HVAC',
      emailDomainId: domainId,
      ownerUserId: member.id,
    };
    const { card } = await prepare(args);
    expect(field(card, 'Address')).toBe(`priya@${domain}`);
    expect(field(card, 'Whose')).toBe('Priya Member’s own');
    expect(card.warnings.map((w) => w.text)).toContain(
      'Only Priya Member sends from it, and mail to it reaches only them: the rest of the team stops seeing it in the Inbox. It stays Priya Member’s while they work here.',
    );
    expect((await addresses()).some((a) => a.address === `priya@${domain}`)).toBe(false);

    await commit(args);
    const made = (await addresses()).find((a) => a.address === `priya@${domain}`);
    expect(made?.ownerUserId).toBe(member.id);
  });

  it('turns away a person or a domain that isn’t this business’s, before any card', async () => {
    await expect(
      prepare({
        action: 'add_address',
        localPart: 'nobody',
        displayName: 'Nobody',
        emailDomainId: domainId,
        ownerUserId: randomUUID(),
      }),
    ).rejects.toThrow('Nobody on this business’s team has that id.');
    await expect(
      prepare({
        action: 'add_address',
        localPart: 'elsewhere',
        displayName: 'Elsewhere',
        emailDomainId: randomUUID(),
      }),
    ).rejects.toThrow('That isn’t one of this business’s domains.');
  });
});

describe('the address of someone who has left', () => {
  const reassign = allScreenActionTools().find((t) => t.name === 'do_email_address_reassign')!;
  let leaver: TestUser;
  let addressId: string;
  const run = () => createToolExecutor(api());

  beforeAll(async () => {
    leaver = await createTestUser('aemail-lee', { fullName: 'Lee Leaver' });
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${workspaceId}, ${leaver.id}, 'member')`,
    );
    await commit({
      action: 'add_address',
      localPart: 'lee',
      displayName: 'Lee at Email HVAC',
      emailDomainId: domainId,
      ownerUserId: leaver.id,
    });
    addressId = ((await addresses()) as unknown as { id: string; address: string }[]).find(
      (a) => a.address === `lee@${domain}`,
    )!.id;
    // Lee leaves: the address stays Lee's, with its mail sealed, until an owner decides.
    await rows(
      admin(),
      sql`delete from app.workspace_memberships
          where workspace_id = ${workspaceId} and user_id = ${leaver.id}`,
    );
  }, 60_000);

  it('never offers removing it, and refuses it by name if asked anyway', async () => {
    // Removing it deletes the address and its mail for good, which stays the person's (the owner, 2026-10-26).
    expect(reassign.input.safeParse({ emailAddressId: addressId, to: 'remove' }).success).toBe(
      false,
    );
    expect(reassign.input.safeParse({ emailAddressId: addressId, to: 'team' }).success).toBe(true);
    await expect(
      run().prepare(reassign, { emailAddressId: addressId, to: 'remove' }, ctx(), randomUUID()),
    ).rejects.toMatchObject({ rule: 'not_for_the_assistant' });
    await expect(
      run().commit(reassign, { emailAddressId: addressId, to: 'remove' }, ctx(), {
        toolCallId: randomUUID(),
      }),
    ).rejects.toMatchObject({ rule: 'not_for_the_assistant' });
    expect((await addresses()).some((a) => a.address === `lee@${domain}`)).toBe(true);
  });

  it('says on its card whose it was and that its mail opens to the team, and gives it on Confirm', async () => {
    const args = { emailAddressId: addressId, to: 'team' };
    const { card } = (await run().prepare(reassign, args, ctx(), randomUUID())) as {
      card: ConfirmCard;
    };
    expect(AssistantCard.safeParse(card).success).toBe(true);
    expect(card.title).toBe(`Give lee@${domain} to the team`);
    // Once Lee has left the team no longer sees Lee's name, so the address reads as a former member's, as the screen's.
    expect(field(card, 'Was')).toBe('Former member’s, who no longer works here');
    expect(field(card, 'Goes to')).toBe('The team, in the Inbox');
    expect(card.warnings[0]!.text).toContain('opens to everyone who reads email here');
    // Nothing changed before Confirm.
    expect((await addresses()).find((a) => a.address === `lee@${domain}`)?.ownerUserId).toBe(
      leaver.id,
    );

    const done = await run().commit(reassign, args, ctx(), { toolCallId: randomUUID() });
    expect(done.outcome).toMatch(/^lee@.* and its mail \(0 conversations\) are the team’s now$/);
    expect(
      (await addresses()).find((a) => a.address === `lee@${domain}`)?.ownerUserId ?? null,
    ).toBeNull();
  });
});
