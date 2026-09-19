/**
 * The two doors a lead arrives through from outside (M14 slice B), end to end through the worker: a form on
 * the business's own website, and a service sending one over with a secret key.
 */
import {
  executeCommand,
  intakeSourceCreate,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { admin, makeWorld, type World } from './booking-world';

let w: World;
let formKey: string;
let secret: string;

const actorOf = (): HumanActor => ({
  type: 'human',
  userId: w.owner.id,
  email: w.owner.email,
  claims: w.owner.claims,
});
const run = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().api.db, cmd, input, actorOf(), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output);

const SITE = 'https://lonestarhvac.example';

/** A form post, the way a browser sends one. */
const postForm = (
  key: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  w.app.inject({
    method: 'POST',
    url: `/intake/f/${key}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: SITE,
      'x-forwarded-for': '203.0.113.11',
      ...headers,
    },
    payload: new URLSearchParams(fields).toString(),
  });

const postApi = (body: unknown, token = secret) =>
  w.app.inject({
    method: 'POST',
    url: '/v1/intake',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-forwarded-for': '203.0.113.12',
    },
    payload: JSON.stringify(body),
  });

const personByEmail = async (email: string) =>
  (
    await rows<{ id: string; first_name: string; last_name: string; source: string | null }>(
      admin(),
      sql`select id, first_name, last_name, source from app.people
          where workspace_id = ${w.workspaceId} and email = ${email}`,
    )
  )[0] ?? null;

beforeAll(async () => {
  w = await makeWorld('intake');
  const form = await run(intakeSourceCreate, {
    workspaceId: w.workspaceId,
    kind: 'website_form',
    name: 'Contact form',
    allowedOrigins: [SITE],
  });
  formKey = form.publicKey!;
  const app = await run(intakeSourceCreate, {
    workspaceId: w.workspaceId,
    kind: 'api',
    name: 'Zapier',
  });
  secret = app.secret!;
});
afterAll(closeTestDbs);

describe('a form on the business’s own website', () => {
  it('opens a customer and a lead from a plain HTML form post', async () => {
    const res = await postForm(formKey, {
      name: 'Dana Reyes',
      email: 'dana@example.com',
      phone: '512-555-0134',
      message: 'Upstairs unit is out',
      'How did you hear about us': 'A neighbour',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, received: true });
    const person = await personByEmail('dana@example.com');
    expect(person).toMatchObject({
      first_name: 'Dana',
      last_name: 'Reyes',
      source: 'Contact form',
    });
    const [lead] = await rows<{ title: string }>(
      admin(),
      sql`select title from app.leads where person_id = ${person!.id}`,
    );
    expect(lead!.title).toBe('Dana Reyes (Contact form)');
    // What else they were asked is kept with the lead.
    const [note] = await rows<{ body: string }>(
      admin(),
      sql`select body from app.activities where person_id = ${person!.id} and subtype = 'intake'`,
    );
    expect(note!.body).toContain('How did you hear about us: A neighbour');
  });

  it('turns a robot away without saying so, and writes nothing', async () => {
    const res = await postForm(formKey, {
      name: 'Robot',
      email: 'robot@example.com',
      website: 'http://spam.example',
    });
    expect(res.statusCode).toBe(200);
    expect(await personByEmail('robot@example.com')).toBeNull();
  });

  it('refuses a post from a site that isn’t on its list', async () => {
    const res = await postForm(
      formKey,
      { name: 'Elsewhere', email: 'elsewhere@example.com' },
      { origin: 'https://someone-else.example' },
    );
    expect(res.statusCode).toBe(403);
    expect(await personByEmail('elsewhere@example.com')).toBeNull();
  });

  it('is a 404 for a key that isn’t one', async () => {
    expect((await postForm('ik_00000000000000000000', { name: 'Nobody' })).statusCode).toBe(404);
  });

  it('opens one lead however many times the page is sent', async () => {
    const fields = { name: 'Ray Tran', email: 'ray@example.com', _id: 'submission-7' };
    await postForm(formKey, fields);
    await postForm(formKey, fields);
    const person = await personByEmail('ray@example.com');
    const opened = await rows<{ id: string }>(
      admin(),
      sql`select id from app.leads where person_id = ${person!.id}`,
    );
    expect(opened).toHaveLength(1);
  });
});

describe('a service with a secret key', () => {
  it('sends a lead over and is told what happened', async () => {
    const res = await postApi({
      name: 'Pat Rivera',
      phone: '+15125550190',
      message: 'Facebook lead ad',
      dedupeKey: 'fb-1001',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, outcome: 'opened', duplicate: false });
    const sent = await postApi({ name: 'Pat Rivera', phone: '+15125550190', dedupeKey: 'fb-1001' });
    expect(sent.json()).toMatchObject({ outcome: 'opened', duplicate: true });
  });

  it('says plainly when there is no way to reach them', async () => {
    const res = await postApi({ message: 'no contact details', dedupeKey: 'fb-1002' });
    expect(res.json()).toMatchObject({ ok: false, outcome: 'refused', reason: 'no_contact' });
  });

  it('turns away a key that is not one', async () => {
    expect((await postApi({ name: 'Nope' }, 'hfos_not-a-real-key')).statusCode).toBe(401);
    expect(
      (
        await w.app.inject({
          method: 'POST',
          url: '/v1/intake',
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(401);
  });
});
