/**
 * "Email your web person" and "Hide the website chat until texting is approved" (the owner, 2026-11-12).
 *
 * `registration.email_web_person` asks the worker to email the website's changes, each in its own text file, and
 * refuses what couldn't be written as it would go (a form that isn't published or isn't allowed on the site, no chat),
 * so the person reads why while they can fix it. `chat_widget.hide_until_texting` pauses every chat until texting is
 * approved, never while the chat is how customers agree, and turns back on only the chats it hid.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeCommandIn } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import { WEB_PERSON_EMAILS_A_DAY } from '../src/messaging/website-fixes';
import {
  chatWidgetCreate,
  chatWidgetHideUntilTexting,
  chatWidgetPause,
  chatWidgetResume,
  formCreate,
  formPublish,
  formSetDelivery,
  organizationCreate,
  registrationEmailWebPerson,
  registrationSaveDraft,
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

async function expectRule(fn: () => Promise<unknown>, rule: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule ?? (e as HfosError).code).toBe(rule);
    return e as HfosError;
  }
  throw new Error(`expected ${rule}, but the call succeeded`);
}

let owner: TestUser;
let member: TestUser;

async function freshBusiness(name: string, path: 'own_site' | 'hosted' = 'own_site') {
  const org = await run(organizationCreate, { businessName: name }, owner);
  const wsId = org.workspaceId;
  await run(
    registrationSaveDraft,
    {
      workspaceId: wsId,
      answers: {
        at: 3,
        form: {
          legalName: `${name} LLC`,
          website: 'https://webperson.example.com',
          contactEmail: 'owner@example.com',
          useCase: 'customer_care',
          optInPath: path,
          optInUrl: 'https://webperson.example.com/contact',
          otherWays: [],
        },
      },
    },
    owner,
  );
  return { wsId, orgId: org.organizationId };
}

/** A chat with the texts box, which names the business's public pages (so its policy has an address). */
async function addChat(wsId: string, sites = ['webperson.example.com']) {
  return (
    await run(
      chatWidgetCreate,
      { workspaceId: wsId, allowedOrigins: sites, smsConsent: true },
      owner,
    )
  ).widgetId;
}

async function addForm(
  wsId: string,
  status: 'live' | 'draft',
  embedOrigins: string[] = ['https://webperson.example.com'],
) {
  const made = await run(
    formCreate,
    { workspaceId: wsId, name: 'Contact form', starter: 'quote' },
    owner,
  );
  if (status === 'live')
    await run(
      formPublish,
      { workspaceId: wsId, formId: made.formId, baseRevision: made.revision },
      owner,
    );
  await run(formSetDelivery, { workspaceId: wsId, formId: made.formId, embedOrigins }, owner);
  return made.formId;
}

async function emailedEvents(wsId: string) {
  return rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events
        where workspace_id = ${wsId} and event_type = 'registration.web_person_emailed'
        order by created_at`,
  );
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('web-person-owner'),
    createTestUser('web-person-member'),
  ]);
});
afterAll(closeTestDbs);

describe('Email your web person', () => {
  it('asks the worker to send the changes picked, with the form checked here', async () => {
    const { wsId } = await freshBusiness('Web Person Solar');
    await addChat(wsId);
    const formId = await addForm(wsId, 'live');
    const out = await run(
      registrationEmailWebPerson,
      {
        workspaceId: wsId,
        to: 'dana@example.com',
        name: 'Dana',
        fixes: ['chat', 'form', 'policy'],
        note: 'By Friday, please.',
      },
      owner,
    );
    expect(out).toEqual({
      sentTo: 'dana@example.com',
      files: ['add-the-form.txt', 'privacy-policy-and-terms.txt', 'add-the-chat.txt'],
    });
    const [event] = await emailedEvents(wsId);
    expect(event?.payload).toEqual({
      to: 'dana@example.com',
      name: 'Dana',
      fixes: ['form', 'policy', 'chat'],
      formId,
      note: 'By Friday, please.',
    });
  });

  it('a form of their own needs no form here', async () => {
    const { wsId } = await freshBusiness('Own Form Roofing');
    await addChat(wsId);
    await run(
      registrationEmailWebPerson,
      { workspaceId: wsId, to: 'web@example.com', fixes: ['form'], formId: null },
      owner,
    );
    const [event] = await emailedEvents(wsId);
    expect(event?.payload).toMatchObject({ fixes: ['form'], formId: null });
  });

  it('refuses a form that isn’t published, or that would show blank on the website', async () => {
    const { wsId } = await freshBusiness('Blank Form Plumbing');
    const draft = await addForm(wsId, 'draft');
    const refused = await expectRule(
      () =>
        run(
          registrationEmailWebPerson,
          { workspaceId: wsId, to: 'web@example.com', fixes: ['form'], formId: draft },
          owner,
        ),
      'web_person_form_not_live',
    );
    expect(refused.message).toContain('Publish it in Forms');
    await addChat(wsId);
    const elsewhere = await addForm(wsId, 'live', ['https://other.example.com']);
    const blank = await expectRule(
      () =>
        run(
          registrationEmailWebPerson,
          { workspaceId: wsId, to: 'web@example.com', fixes: ['form'], formId: elsewhere },
          owner,
        ),
      'web_person_form_site',
    );
    expect(blank.message).toContain('webperson.example.com under Sites allowed');
    expect(await emailedEvents(wsId)).toEqual([]);
  });

  it('refuses the chat with no chat, or one not allowed on the website', async () => {
    const { wsId } = await freshBusiness('No Chat Electric');
    const none = await expectRule(
      () =>
        run(
          registrationEmailWebPerson,
          { workspaceId: wsId, to: 'web@example.com', fixes: ['chat'] },
          owner,
        ),
      'web_person_no_chat',
    );
    expect(none.message).toContain('Settings → Website chat');
    await addChat(wsId, ['other.example.com']);
    await expectRule(
      () =>
        run(
          registrationEmailWebPerson,
          { workspaceId: wsId, to: 'web@example.com', fixes: ['chat'] },
          owner,
        ),
      'web_person_chat_site',
    );
  });

  it('is for owners and admins, and a few a day each', async () => {
    const { wsId } = await freshBusiness('Busy Web Person HVAC');
    await addChat(wsId);
    await admin().execute(
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${wsId}, ${member.id}, 'member')`,
    );
    await expect(
      run(
        registrationEmailWebPerson,
        { workspaceId: wsId, to: 'web@example.com', fixes: ['policy'] },
        member,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    for (let i = 0; i < WEB_PERSON_EMAILS_A_DAY; i++)
      await run(
        registrationEmailWebPerson,
        { workspaceId: wsId, to: 'web@example.com', fixes: ['policy'] },
        owner,
      );
    await expectRule(
      () =>
        run(
          registrationEmailWebPerson,
          { workspaceId: wsId, to: 'web@example.com', fixes: ['policy'] },
          owner,
        ),
      'web_person_limit',
    );
  });
});

describe('Hide the website chat until texting is approved', () => {
  const widgets = (wsId: string) =>
    rows<{ id: string; paused: boolean; hidden: boolean }>(
      admin(),
      sql`select id, paused_at is not null as paused, hidden_until_texting as hidden
          from app.chat_widgets where workspace_id = ${wsId} order by created_at`,
    );

  it('pauses every chat that’s on, and shows again only the ones it hid', async () => {
    const { wsId, orgId } = await freshBusiness('Hidden Chat Solar');
    const first = await addChat(wsId);
    const second = await addChat(wsId, ['second.example.com']);
    await run(chatWidgetPause, { workspaceId: wsId, widgetId: second }, owner);
    const hid = await run(chatWidgetHideUntilTexting, { workspaceId: wsId, hide: true }, owner);
    expect(hid).toEqual({ widgetIds: [first], hidden: true });
    expect(await widgets(wsId)).toEqual([
      { id: first, paused: true, hidden: true },
      { id: second, paused: true, hidden: false },
    ]);

    // The worker, once texting is approved: only the chat it hid comes back.
    const system: SystemActor = { type: 'system', workspaceId: wsId, organizationId: orgId };
    await asWorker(testDbs().worker.db, { workspaceId: wsId, organizationId: orgId }, (tx) =>
      executeCommandIn(
        tx,
        chatWidgetHideUntilTexting,
        { workspaceId: wsId, hide: false },
        system,
        meta(),
      ),
    );
    expect(await widgets(wsId)).toEqual([
      { id: first, paused: false, hidden: false },
      { id: second, paused: true, hidden: false },
    ]);
  });

  it('turning a hidden chat on by hand ends the wait', async () => {
    const { wsId } = await freshBusiness('Hand Resume Roofing');
    const chat = await addChat(wsId);
    await run(chatWidgetHideUntilTexting, { workspaceId: wsId, hide: true }, owner);
    await run(chatWidgetResume, { workspaceId: wsId, widgetId: chat }, owner);
    expect(await widgets(wsId)).toEqual([{ id: chat, paused: false, hidden: false }]);
  });

  it('refuses while the chat is how customers agree', async () => {
    const { wsId } = await freshBusiness('Chat Agrees Plumbing', 'hosted');
    await addChat(wsId);
    const refused = await expectRule(
      () => run(chatWidgetHideUntilTexting, { workspaceId: wsId, hide: true }, owner),
      'chat_is_the_opt_in',
    );
    expect(refused.message).toContain('How customers agree');
  });
});
