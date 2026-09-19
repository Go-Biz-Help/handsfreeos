/**
 * The wording a business reuses, on the local database.
 *
 * The things worth holding: two templates cannot share a name (a picker full of "Follow-up" is a picker
 * nobody can use), a text has no subject line and will not be given one, tidying up archives rather than
 * deletes, the picker sorts itself by what the business actually says, and reaching for wording is not the
 * same permission as deciding what the business says.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  organizationCreate,
  templateArchive,
  templateCreate,
  templateList,
  templateUpdate,
  templateUsed,
} from '../src/server';
import { admin, ask, expectHfos, run } from './calendar-helpers';

let owner: TestUser, member: TestUser;
let wsId: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('tpl-owner', { fullName: 'Dale Owner' }),
    createTestUser('tpl-member', { fullName: 'Mike Member' }),
  ]);
  const org = await run(organizationCreate, { businessName: 'Wording Co' }, owner);
  wsId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

const make = (name: string, extra: Record<string, unknown> = {}) =>
  run(
    templateCreate,
    { workspaceId: wsId, name, body: 'Hi {{person.first_name}}.', ...extra },
    owner,
  );

describe('saving wording to use again', () => {
  it('saves it, and says what it needs filling in with', async () => {
    const { templateId } = await make('On our way');
    const list = await ask(templateList, { workspaceId: wsId }, owner);
    const saved = list.templates.find((t) => t.id === templateId)!;
    expect(saved.name).toBe('On our way');
    expect(saved.channel).toBe('sms');
    expect(saved.subject).toBeNull();
    // The same reader a workflow step uses, so "what does this need?" has one answer everywhere.
    expect(saved.placeholders).toEqual(['person.first_name']);
  });

  it('refuses a second one by the same name, whatever the capitals', async () => {
    await make('Quote follow-up');
    await expectHfos(() => make('quote FOLLOW-UP'), 'duplicate');
  });

  it('will not put a subject line on a text message', async () => {
    const error = await expectHfos(() => make('Reminder', { subject: 'Your visit' }), 'validation');
    expect(JSON.stringify(error.details)).toMatch(/no subject line/i);
  });

  it('drops the subject when an email becomes a text, rather than keeping something unsendable', async () => {
    const { templateId } = await make('Winter service', {
      channel: 'email',
      subject: 'Time for your winter service',
    });
    await run(templateUpdate, { workspaceId: wsId, templateId, channel: 'sms' }, owner);
    const [row] = await rows<{ subject: string | null; channel: string }>(
      admin(),
      sql`select subject, channel::text as channel from app.message_templates
          where id = ${templateId}::uuid`,
    );
    expect(row!.channel).toBe('sms');
    expect(row!.subject).toBeNull();
  });
});

describe('the library looking after itself', () => {
  it('puts what gets used most at the top, and counts the reaching', async () => {
    const rare = await make('Rarely said');
    const often = await make('Often said');
    for (let i = 0; i < 3; i++)
      await run(templateUsed, { workspaceId: wsId, templateId: often.templateId }, owner);
    const list = await ask(templateList, { workspaceId: wsId, channel: 'sms' }, owner);
    const names = list.templates.map((t) => t.name);
    expect(names.indexOf('Often said')).toBeLessThan(names.indexOf('Rarely said'));
    expect(list.templates.find((t) => t.id === rare.templateId)!.usedCount).toBe(0);
    expect(list.templates.find((t) => t.id === often.templateId)!.usedCount).toBe(3);
  });

  it('archives rather than deletes, and frees the name again', async () => {
    const { templateId } = await make('Seasonal note');
    await run(templateArchive, { workspaceId: wsId, templateId }, owner);
    const open = await ask(templateList, { workspaceId: wsId }, owner);
    expect(open.templates.some((t) => t.id === templateId)).toBe(false);
    // Still there, because a template that was used is part of why a message reads as it does.
    const [row] = await rows<{ archived_at: Date | null }>(
      admin(),
      sql`select archived_at from app.message_templates where id = ${templateId}::uuid`,
    );
    expect(row!.archived_at).not.toBeNull();
    // And the name is free again.
    const again = await make('Seasonal note');
    expect(again.templateId).not.toBe(templateId);
    // Putting the old one back would collide with the new one, and says so rather than guessing.
    await expectHfos(
      () => run(templateArchive, { workspaceId: wsId, templateId, restore: true }, owner),
      'duplicate',
    );
  });

  it('files them, and lists the folders for the picker to group by', async () => {
    await make('Deposit asked for', { folder: 'Money' });
    await make('Deposit received', { folder: 'Money' });
    const list = await ask(templateList, { workspaceId: wsId }, owner);
    expect(list.folders).toContain('Money');
    // One heading, not two, for two templates filed together.
    expect(list.folders.filter((f) => f === 'Money')).toHaveLength(1);
  });

  it('finds wording by what it says, not just by its name', async () => {
    await make('Apology', { body: 'Sorry the van was late this morning.' });
    const found = await ask(templateList, { workspaceId: wsId, search: 'van was late' }, owner);
    expect(found.templates.map((t) => t.name)).toEqual(['Apology']);
  });
});

describe('who may do what', () => {
  it('lets anyone who can use the inbox reach for the wording', async () => {
    const { templateId } = await make('Anyone may send this');
    const seen = await ask(templateList, { workspaceId: wsId }, member);
    expect(seen.templates.some((t) => t.id === templateId)).toBe(true);
    await run(templateUsed, { workspaceId: wsId, templateId }, member);
  });

  it('leaves what the business says to the people who run it', async () => {
    await expectHfos(
      () => run(templateCreate, { workspaceId: wsId, name: 'Mine', body: 'Hello.' }, member),
      'forbidden',
    );
  });
});
