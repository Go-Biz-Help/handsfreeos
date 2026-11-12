import { randomUUID } from 'node:crypto';
import {
  chatWidgetCreate,
  chatWidgetHideUntilTexting,
  chatWidgetUpdate,
  createTokenVerifier,
  executeCommand,
  formCreate,
  organizationCreate,
  registrationEmailWebPerson,
  registrationSaveDraft,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

/**
 * "Email your web person" (the owner, 2026-11-12), the worker's half: the dialog's preview is the files that go, the
 * email goes from HandsFreeOS in the business's name with each change as its own text file, replies and a copy go to
 * whoever pressed Send, and nothing goes half right when the business changed in between. A chat hidden until texting
 * is approved comes back on when it is.
 */
const env = testEnv();
const WORKER_ID = `vitest-web-person-${process.pid}`;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, actor(u), meta()).then((r) => r.output);

/** The database keeps rows between runs, so this run's business and addresses are its own. */
const mark = randomUUID().slice(0, 8);
const BUSINESS = `Web Person Solar ${mark}`;
let s: TestServices;
let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let workspaceId: string;
let organizationId: string;
let chat: { widgetId: string; publicKey: string };

const post = async (who: TestUser, url: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${await signInTestUser(who)}`,
      'content-type': 'application/json',
    },
    payload,
  });

/** Runs the outbox over this business's events and nothing else. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
    const pass = await processOnce({
      ...s,
      workerId: WORKER_ID,
      batchSize: 200,
      reservedOnly: true,
      handlers,
    });
    if (pass.retried + pass.failed > 0) {
      const errors = await rows(
        admin(),
        sql`select event_type, last_error from app.outbox
            where locked_by = ${WORKER_ID} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (pass.claimed === 0) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

interface Address {
  Name: string;
  Address: string;
}
interface MailpitMessage {
  ID: string;
  Subject: string;
  Text: string;
  From: Address;
  Cc: Address[];
  ReplyTo: Address[];
  Attachments: { FileName: string; ContentType: string; PartID: string }[];
}
async function mailsTo(to: string): Promise<{ ID: string; Subject: string }[]> {
  const res = await fetch(
    `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  return ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}
async function mailTo(to: string): Promise<MailpitMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [hit] = await mailsTo(to);
    if (hit)
      return (await (
        await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)
      ).json()) as MailpitMessage;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email reached ${to}`);
}
const partOf = async (id: string, part: string) =>
  (await fetch(`${env.mailpitUrl}/api/v1/message/${id}/part/${part}`)).text();

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('web-person-mail-owner', { fullName: 'Chris Lee' }),
    createTestUser('web-person-mail-member'),
  ]);
  const org = await run(organizationCreate, { businessName: BUSINESS }, owner);
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
  await run(
    registrationSaveDraft,
    {
      workspaceId,
      answers: {
        at: 3,
        form: {
          legalName: `${BUSINESS} LLC`,
          website: 'https://webperson.example.com',
          contactEmail: 'owner@example.com',
          useCase: 'customer_care',
          optInPath: 'own_site',
          optInUrl: 'https://webperson.example.com/contact',
          otherWays: [],
        },
      },
    },
    owner,
  );
  chat = await run(
    chatWidgetCreate,
    { workspaceId, allowedOrigins: ['webperson.example.com'], smsConsent: true },
    owner,
  );
  s = testServices({});
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
  await drain();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('Email your web person', () => {
  it('previews the files, then emails exactly those, from HandsFreeOS in the business’s name', async () => {
    const res = await post(owner, '/v1/telephony/web-person-preview', {
      workspaceId,
      fixes: ['chat', 'policy'],
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json() as {
      business: string;
      website: string;
      files: { filename: string; text: string }[];
    };
    expect(preview.business).toBe(BUSINESS);
    expect(preview.files.map((f) => f.filename)).toEqual([
      'privacy-policy-and-terms.txt',
      'add-the-chat.txt',
    ]);
    expect(preview.files[1]!.text).toContain(
      `<script async src="http://localhost:3000/embed/v1/${chat.publicKey}.js"></script>`,
    );

    const to = `dana-${mark}@example.com`;
    await run(
      registrationEmailWebPerson,
      { workspaceId, to, name: 'Dana', fixes: ['chat', 'policy'], note: 'By Friday, please.' },
      owner,
    );
    await drain();
    const mail = await mailTo(to);
    expect(mail.Subject).toBe(`Website changes for ${BUSINESS}’s texting approval`);
    expect(mail.From).toEqual({
      Name: `${BUSINESS} via HandsFreeOS`,
      Address: 'hello@handsfreeos.local',
    });
    expect(mail.ReplyTo.map((a) => a.Address)).toEqual([owner.email]);
    expect(mail.Cc.map((a) => a.Address)).toEqual([owner.email]);
    expect(mail.Text).toMatch(/^Hi Dana,/);
    expect(mail.Text).toContain('A note from Chris Lee:');
    expect(mail.Attachments.map((a) => a.FileName)).toEqual([
      'privacy-policy-and-terms.txt',
      'add-the-chat.txt',
    ]);
    for (const [i, a] of mail.Attachments.entries()) {
      expect(a.ContentType).toBe('text/plain');
      expect(await partOf(mail.ID, a.PartID)).toBe(preview.files[i]!.text);
    }
  });

  it('is for owners and admins, and a refusal comes back with its rule', async () => {
    const asMember = await post(member, '/v1/telephony/web-person-preview', {
      workspaceId,
      fixes: ['policy'],
    });
    expect(asMember.statusCode).toBe(403);
    const draft = await run(
      formCreate,
      { workspaceId, name: 'Contact form', starter: 'quote' },
      owner,
    );
    const notLive = await post(owner, '/v1/telephony/web-person-preview', {
      workspaceId,
      fixes: ['form'],
      formId: draft.formId,
    });
    expect(notLive.statusCode).toBe(409);
    expect(notLive.json().error).toMatchObject({ rule: 'web_person_form_not_live' });
    expect(notLive.json().error.message).toContain('Publish it in Forms');
  });

  it('sends nothing when the website changed in between', async () => {
    const to = `half-${mark}@example.com`;
    await run(registrationEmailWebPerson, { workspaceId, to, fixes: ['chat'] }, owner);
    // Before the worker gets to it, the chat is moved to another site.
    await run(
      chatWidgetUpdate,
      { workspaceId, widgetId: chat.widgetId, allowedOrigins: ['other.example.com'] },
      owner,
    );
    await drain();
    await new Promise((r) => setTimeout(r, 500));
    expect(await mailsTo(to)).toEqual([]);
    await run(
      chatWidgetUpdate,
      { workspaceId, widgetId: chat.widgetId, allowedOrigins: ['webperson.example.com'] },
      owner,
    );
    await drain();
  });

  it('a chat hidden until texting is approved comes back on when it is', async () => {
    await run(chatWidgetHideUntilTexting, { workspaceId, hide: true }, owner);
    const state = () =>
      rows<{ paused: boolean; hidden: boolean }>(
        admin(),
        sql`select paused_at is not null as paused, hidden_until_texting as hidden
            from app.chat_widgets where id = ${chat.widgetId}`,
      ).then((r) => r[0]);
    expect(await state()).toEqual({ paused: true, hidden: true });
    await drain();

    // The carriers approve the campaign: the event the worker hears.
    const eventId = randomUUID();
    await rows(
      admin(),
      sql`insert into app.events (id, organization_id, workspace_id, event_type, actor_type, entity_type, entity_id,
            payload, correlation_id)
          values (${eventId}, ${organizationId}, ${workspaceId}, 'registration.status_changed', 'system',
            'telephony_registration', ${randomUUID()},
            ${JSON.stringify({ kind: 'a2p_campaign', to: 'approved' })}::jsonb, ${randomUUID()})`,
    );
    await rows(
      admin(),
      sql`insert into app.outbox (event_id, organization_id, workspace_id, event_type)
          values (${eventId}, ${organizationId}, ${workspaceId}, 'registration.status_changed')`,
    );
    await drain();
    expect(await state()).toEqual({ paused: false, hidden: false });
  });
});
