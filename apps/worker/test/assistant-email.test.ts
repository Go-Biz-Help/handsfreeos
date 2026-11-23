import { randomUUID } from 'node:crypto';
import {
  AssistantCard,
  assistantToolByName,
  conversationAiDraftSave,
  emailReceive,
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
      'Only Priya Member sends from it, and mail to it reaches only them: the rest of the team stops seeing it in the Inbox. Only Priya Member can hand it back to the team.',
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

/**
 * Changing addresses after setup (Settings → Email, 2026-11-22), by asking: the address customers hear from becomes
 * the owner's own with another taking over, its person hands it back, and one address is removed with its mail kept.
 */
describe('an address changed after setup', () => {
  const remove = allScreenActionTools().find((t) => t.name === 'do_email_address_remove')!;
  const run = () => createToolExecutor(api());
  const all = async () =>
    (await addresses()) as unknown as {
      id: string;
      address: string;
      isDefault: boolean;
      ownerUserId?: string | null;
    }[];
  const named = async (local: string) =>
    (await all()).find((a) => a.address === `${local}@${domain}`)!;

  it('makes the one customers hear from the person’s own, with the address that takes over on the card', async () => {
    await commit({
      action: 'add_address',
      localPart: 'dale',
      displayName: 'Email HVAC',
      emailDomainId: domainId,
      isDefault: true,
    });
    await commit({
      action: 'add_address',
      localPart: 'office',
      displayName: 'Email HVAC',
      emailDomainId: domainId,
    });
    const [dale, office] = [await named('dale'), await named('office')];
    expect(dale.isDefault).toBe(true);
    const args = {
      action: 'change_address',
      emailAddressId: dale.id,
      ownerUserId: owner.id,
      defaultToId: office.id,
    };
    const { card } = await prepare(args);
    expect(field(card, 'Whose')).toBe('Dale Owner’s own');
    expect(field(card, 'Customers hear from')).toBe(`dale@${domain} → office@${domain}`);
    await commit(args);
    expect(await named('dale')).toMatchObject({ isDefault: false, ownerUserId: owner.id });
    expect((await named('office')).isDefault).toBe(true);
  });

  it('hands the person’s own address back to the team, saying what stays theirs', async () => {
    const dale = await named('dale');
    const args = { action: 'change_address', emailAddressId: dale.id, ownerUserId: null };
    const { card } = await prepare(args);
    expect(card.title).toBe(`Change dale@${domain}`);
    expect(field(card, 'Who reads it')).toBe('The team, in the Inbox');
    expect(card.warnings.map((w) => w.text).join(' ')).toContain(
      'The mail already on it stays Dale Owner’s alone.',
    );
    await commit(args);
    expect((await named('dale')).ownerUserId ?? null).toBeNull();
  });

  it('removes one address on a card that says where new mail goes, and never the one customers hear from', async () => {
    const dale = await named('dale');
    const { card } = (await run().prepare(
      remove,
      { emailAddressId: dale.id },
      ctx(),
      randomUUID(),
    )) as { card: ConfirmCard };
    expect(AssistantCard.safeParse(card).success).toBe(true);
    expect(card.title).toBe(`Remove dale@${domain}`);
    expect(card.warnings[0]!.text).toContain('goes to the team’s Inbox');
    expect(await named('dale')).toBeTruthy();
    const done = await run().commit(remove, { emailAddressId: dale.id }, ctx(), {
      toolCallId: randomUUID(),
    });
    expect(done.outcome).toBe(`dale@${domain} is removed`);
    expect(await named('dale')).toBeUndefined();
    await expect(
      run().commit(remove, { emailAddressId: (await named('office')).id }, ctx(), {
        toolCallId: randomUUID(),
      }),
    ).rejects.toMatchObject({ rule: 'email_default_required' });
  });
});

/**
 * "Let Ava read this mail" (owner, 2026-11-22), by asking: the switch on a person's own address is theirs alone, its
 * card names the address and the AI teammate, and the draft Ava leaves on their mail is read back to them only.
 */
describe('Let Ava read this mail', () => {
  const flip = allScreenActionTools().find((t) => t.name === 'do_email_address_set_ai_reads')!;
  const putAway = allScreenActionTools().find(
    (t) => t.name === 'do_conversation_ai_draft_dismiss',
  )!;
  const getConversation = assistantToolByName.get('get_conversation')!;
  const run = () => createToolExecutor(api());
  const as = (u: TestUser): ToolContext => ({ ...ctx(), actor: actor(u) });
  const system = () => ({ type: 'system' as const, workspaceId, organizationId });
  const priyas = async () =>
    ((await addresses()) as unknown as { id: string; address: string }[]).find(
      (a) => a.address === `priya@${domain}`,
    )!.id;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thread = async (conversationId: string, u: TestUser): Promise<any> =>
    (
      (await run().run(
        getConversation,
        getConversation.input.parse({ conversationId }) as Record<string, unknown>,
        as(u),
      )) as { result: unknown }
    ).result;

  beforeAll(async () => {
    await rows(
      admin(),
      sql`insert into app.ai_teammates (workspace_id, name, status, training_started_at)
          values (${workspaceId}, 'Ava', 'training', now())`,
    );
  });

  it('turns on only for the address’s own person, on a card that names it and says nothing is sent', async () => {
    const args = { emailAddressId: await priyas(), aiReads: true };
    // Not an owner of the business, for her: refused before any card.
    await expect(run().prepare(flip, args, ctx(), randomUUID())).rejects.toMatchObject({
      rule: 'email_address_ai_reads_is_theirs',
    });
    const { card } = (await run().prepare(flip, args, as(member), randomUUID())) as {
      card: ConfirmCard;
    };
    expect(AssistantCard.safeParse(card).success).toBe(true);
    expect(card.title).toBe(`Let Ava read mail sent to priya@${domain}`);
    expect(field(card, 'Let Ava read this mail')).toBe('On');
    expect(card.warnings[0]!.text).toContain('Only you see the draft');
    expect(card.warnings[0]!.text).toContain('nothing is sent until you send it');

    const done = await run().commit(flip, args, as(member), { toolCallId: randomUUID() });
    expect(done.outcome).toBe(
      `Ava now reads mail sent to priya@${domain}, and drafts answers only you see`,
    );
    const again = await run().commit(flip, args, as(member), { toolCallId: randomUUID() });
    expect(again.outcome).toBe(`That was already on for priya@${domain}`);
  });

  it('reads Ava’s draft on her own mail to her alone, and puts it away when she says', async () => {
    const got = (
      await executeCommand(
        testDbs().worker.db,
        emailReceive,
        {
          workspaceId,
          provider: 'postmark',
          providerMessageId: `pm-${randomUUID()}`,
          messageIdHeader: `<${randomUUID()}@mail.example.com>`,
          from: { address: `sam-${mark}@example.com` },
          to: [{ address: `priya@${domain}` }],
          subject: 'Friday',
          bodyText: 'Does Friday still work?',
          emailAddressId: await priyas(),
        },
        system(),
        meta(),
      )
    ).output;
    await executeCommand(
      testDbs().worker.db,
      conversationAiDraftSave,
      {
        workspaceId,
        conversationId: got.conversationId,
        forMessageId: got.messageId,
        body: 'Hi Sam, Friday works. Priya',
      },
      system(),
      meta(),
    );

    const hers = await thread(got.conversationId!, member);
    expect(hers.draftAnswer).toMatchObject({
      draftedBy: 'Ava',
      draft: { ai_teammate_drafted: 'Hi Sam, Friday works. Priya' },
    });
    expect(hers.draftAnswer.note).toContain('nothing was sent');
    // The owner of the business can't open her thread, so there is no draft to read.
    await expect(thread(got.conversationId!, owner)).rejects.toMatchObject({ code: 'not_found' });

    await run().commit(putAway, { conversationId: got.conversationId }, as(member), {
      toolCallId: randomUUID(),
    });
    expect((await thread(got.conversationId!, member)).draftAnswer).toBeUndefined();
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
