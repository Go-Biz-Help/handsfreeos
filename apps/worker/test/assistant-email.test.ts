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
      'Only Priya Member sends from it, and mail to it reaches only them.',
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
