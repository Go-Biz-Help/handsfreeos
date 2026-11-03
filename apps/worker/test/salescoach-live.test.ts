/**
 * AI Sales Coach on a live call, end to end with the fake carrier, the stand-in speech (audio is words) and the
 * scripted model (docs/salescoach.md, telephony/live.ts):
 * - **Hearing it:** a call someone who's coached answers streams here, both sides, with a sealed ticket; a stream
 *   without a good ticket is closed.
 * - **Coaching it:** a customer worried about price gets the playbook's answer on the rep's screen, and the step
 *   the call is at; small talk gets nothing.
 * - **After it:** what was said is kept, the write-up is made, the notes land on the customer's timeline and what
 *   the rep promised is in their tasks.
 * - **Not hearing it:** on a number that doesn't tell callers the call may be recorded, nor while the add-on is off.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { salescoachAddon } from '@hfos/core/addons/salescoach/manifest';
import { playbookSave } from '@hfos/core/addons/salescoach/ops/playbooks';
import {
  callRecord,
  callUpdateStatus,
  executeCommand,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  pushDeviceRegister,
  type HumanActor,
  type SystemActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { scriptedAi } from '../src/ai/scripted';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { fakeSid } from '../src/telephony/fake';
import { openLiveTicket } from '../src/telephony/live';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-coach-${process.pid}`;
const MIKE = '+17135550142';
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const tollFree = () =>
  `+1833${String(100 + Math.floor(Math.random() * 899))}${String(1001 + Math.floor(Math.random() * 8998))}`;

let owner: TestUser;
let rep: TestUser;
let workspaceId: string;
let organizationId: string;
let mikeId: string;
let businessNumber: string;
let s: TestServices;
let app: FastifyInstance;
let port: number;

const system = (): SystemActor => ({ type: 'system', workspaceId, organizationId });

/** Runs the outbox and the jobs over this workspace's due work until it is idle. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const table of ['outbox', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${workspaceId}`,
      );
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [await processOnce({ ...d, handlers }), await processJobs({ ...d, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select event_type as what, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'
            union all select kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

async function waitFor<T>(
  what: string,
  get: () => Promise<T | null | undefined | false>,
  ms = 8_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A customer calls the business and the rep answers in their browser: the call's id and sid. */
async function answeredCall(): Promise<{ callId: string; callSid: string }> {
  const callSid = fakeSid('CA');
  const recorded = await executeCommand(
    testDbs().worker.db,
    callRecord,
    {
      workspaceId,
      providerSid: callSid,
      direction: 'inbound',
      from: MIKE,
      to: businessNumber,
      status: 'ringing',
    },
    system(),
    meta(),
  );
  await executeCommand(
    testDbs().worker.db,
    callUpdateStatus,
    {
      workspaceId,
      providerSid: callSid,
      status: 'in_progress',
      answeredVia: 'browser',
      answeredByUserId: rep.id,
    },
    system(),
    meta(),
  );
  return { callId: recorded.output.callId, callSid };
}

/** Twilio's side of a live stream: each side's words as audio frames. */
async function stream(callSid: string, ticket: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/webhooks/twilio/voice/live`);
  let closed = false;
  ws.on('close', () => {
    closed = true;
  });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ event: 'connected' }));
  ws.send(
    JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZ1', callSid, customParameters: { t: ticket } },
    }),
  );
  // On a call the customer made, Twilio's `inbound` track is the customer and `outbound` the rep.
  const say = (track: 'inbound' | 'outbound', words: string) =>
    ws.send(
      JSON.stringify({
        event: 'media',
        media: { track, payload: Buffer.from(words).toString('base64') },
      }),
    );
  return {
    closed: () => closed,
    customer: (words: string) => say('inbound', words),
    rep: (words: string) => say('outbound', words),
    hangUp: () => {
      ws.send(JSON.stringify({ event: 'stop' }));
      ws.close();
    },
  };
}

const coached = async (callId: string) =>
  (
    await rows<{ id: string; state: string; step: string | null; lines: unknown[] }>(
      admin(),
      sql`select id, state, step, lines from addon_salescoach.calls where call_id = ${callId}`,
    )
  )[0];

beforeAll(async () => {
  [owner, rep] = await Promise.all([
    createTestUser('coachw-owner', { fullName: 'Dale Owner' }),
    createTestUser('coachw-rep', { fullName: 'Marco Member' }),
  ]);
  const org = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Coached HVAC' },
      human(owner),
      meta(),
    )
  ).output;
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${rep.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${workspaceId}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  await executeCommand(
    api(),
    pushDeviceRegister,
    {
      platform: 'ios',
      token: `ExponentPushToken[coach-${randomUUID().slice(0, 12)}]`,
      appVersion: '1.0.0',
      deviceName: 'ios',
    },
    human(rep),
    meta(),
  );
  mikeId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      human(owner),
      meta(),
    )
  ).output.personId;
  await executeCommand(
    api(),
    playbookSave,
    {
      workspaceId,
      name: 'First call',
      details: {
        steps: [
          { id: 's1', title: 'Say hello', say: '' },
          { id: 's2', title: 'Find out what’s wrong', say: '' },
          { id: 's3', title: 'Book the visit', say: '' },
        ],
        objections: [
          {
            id: 'o1',
            objection: 'It’s too expensive',
            answer: 'I hear you. The visit fee goes toward the repair.',
          },
        ],
        points: [{ id: 'p1', topic: 'Warranty', fact: 'Every repair has a one-year warranty.' }],
      },
    },
    human(owner),
    meta(),
  );
  s = testServices({ ai: { provider: scriptedAi() } });
  businessNumber = tollFree();
  await executeCommand(
    api(),
    phoneNumberBuy,
    { workspaceId, e164: businessNumber, numberType: 'toll_free' },
    human(owner),
    meta(),
  );
  await drain();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a coached call', () => {
  it('is heard live, coached, and written up afterwards', async () => {
    const before = s.telephony.streamed.length;
    const { callId, callSid } = await answeredCall();
    await drain();
    expect(s.telephony.streamed).toHaveLength(before + 1);
    const asked = s.telephony.streamed.at(-1)!;
    expect(asked.callSid).toBe(callSid);
    expect(asked.url).toMatch(/^ws.*\/webhooks\/twilio\/voice\/live$/);
    expect(openLiveTicket(s.sealer, asked.params['t'])).toMatchObject({
      callId,
      teamUserId: rep.id,
      direction: 'inbound',
      addons: ['salescoach'],
    });

    const call = await stream(callSid, asked.params['t']!);
    await waitFor('the coached call', async () => (await coached(callId))?.state === 'live');
    call.rep('Hi, this is Marco at Coached HVAC.');
    call.customer('Hello.');
    call.customer('Honestly that sounds really expensive.');
    const card = await waitFor('the card', async () => {
      const [c] = await rows<{ kind: string; title: string; say: string; objection_id: string }>(
        admin(),
        sql`select k.kind, k.title, k.say, k.objection_id from addon_salescoach.cards k
            join addon_salescoach.calls c on c.id = k.coached_call_id where c.call_id = ${callId}`,
      );
      return c;
    });
    expect(card).toMatchObject({ kind: 'objection', objection_id: 'o1' });
    expect(card.say).toContain('goes toward the repair');
    expect((await coached(callId))!.step).toBe('s2');
    // The rep's phone hears about an objection too.
    // The push is queued just after the card is kept.
    const push = await waitFor('the push', async () => {
      const [p] = await rows<{ title: string; path: string; user_ids: string[] }>(
        admin(),
        sql`select payload->>'title' as title, payload->>'path' as path,
              array(select jsonb_array_elements_text(payload->'userIds')) as user_ids
            from app.scheduled_jobs where workspace_id = ${workspaceId} and kind = 'push.send'`,
      );
      return p;
    });
    expect(push).toMatchObject({
      title: card.title,
      path: `/app/w/${workspaceId}/a/salescoach?view=live`,
      user_ids: [rep.id],
    });

    call.rep('No problem. I’ll text you the price by Friday.');
    await new Promise((r) => setTimeout(r, 200));
    call.hangUp();
    await waitFor('the call to end', async () => (await coached(callId))?.state === 'writing');
    expect((await coached(callId))!.lines).toHaveLength(4);

    await drain();
    expect((await coached(callId))!.state).toBe('done');
    const [task] = await rows<{ title: string; assignee_user_id: string; person_id: string }>(
      admin(),
      sql`select title, assignee_user_id, person_id from app.tasks
          where workspace_id = ${workspaceId} and title like 'Text you the price%'`,
    );
    expect(task).toMatchObject({ assignee_user_id: rep.id, person_id: mikeId });
    const [line] = await rows<{ words: string }>(
      admin(),
      sql`select meta ->> 'words' as words from app.activities
          where person_id = ${mikeId} and subtype = 'addon_line'`,
    );
    expect(line?.words).toMatch(/^Marco’s call was coached and scored \d+ out of 100$/);
  });

  it('nudges a rep who names the price before the customer says their problem', async () => {
    const { callId, callSid } = await answeredCall();
    await drain();
    const call = await stream(callSid, s.telephony.streamed.at(-1)!.params['t']!);
    await waitFor('the coached call', async () => (await coached(callId))?.state === 'live');
    call.rep('Hi, this is Marco. The visit is $89 and we can come today.');
    call.customer('Okay, I just need someone to look at it.');
    const card = await waitFor('the nudge', async () => {
      const [c] = await rows<{ kind: string; title: string; tip: string }>(
        admin(),
        sql`select k.kind, k.title, k.tip from addon_salescoach.cards k
            join addon_salescoach.calls c on c.id = k.coached_call_id where c.call_id = ${callId}`,
      );
      return c;
    });
    expect(card).toMatchObject({
      kind: 'nudge',
      title: 'Price before the problem',
      tip: 'Slow down.',
    });
    call.hangUp();
    await waitFor('the call to end', async () => (await coached(callId))?.state === 'writing');
    await drain();
  });

  it('refuses a stream without a good ticket', async () => {
    const call = await stream(fakeSid('CA'), 'not-a-ticket');
    await waitFor('the stream to close', async () => call.closed());
  });

  it('isn’t heard on a number that doesn’t say calls may be recorded, nor while the add-on is off', async () => {
    const before = s.telephony.streamed.length;
    await rows(
      admin(),
      sql`update app.phone_numbers set routing = coalesce(routing, '{}') || '{"announceRecording": false}'
          where workspace_id = ${workspaceId}`,
    );
    await answeredCall();
    await drain();
    expect(s.telephony.streamed).toHaveLength(before);
    await rows(
      admin(),
      sql`update app.phone_numbers set routing = routing - 'announceRecording' where workspace_id = ${workspaceId}`,
    );
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${workspaceId} and addon_id = 'salescoach'`,
    );
    await answeredCall();
    await drain();
    expect(s.telephony.streamed).toHaveLength(before);
  });
});
