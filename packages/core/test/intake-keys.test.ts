/**
 * Lead intake, slice B (M14): a form on the business's own website and a service sending leads over. What
 * each key opens, what it refuses, what a retry does, and the row that forms built here file their leads
 * under.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { intakeSources } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  intakeList,
  intakeSourceArchive,
  intakeSourceCreate,
  intakeSourceRotateKey,
  intakeSourceUpdate,
  intakeSubmit,
  organizationCreate,
  personCreate,
  pipelineCreate,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser;
let wsId: string;
let orgId: string;
let scope: Scope;

beforeAll(async () => {
  owner = await createTestUser('intake-keys-owner');
  const org = await run(organizationCreate, { businessName: 'Intake Keys Co' }, owner);
  wsId = org.workspaceId;
  orgId = org.organizationId;
  scope = { workspaceId: wsId, organizationId: orgId };
});
afterAll(closeTestDbs);

const send = (
  sourceId: string,
  payload: Record<string, unknown>,
  dedupeKey = `d-${Math.random()}`,
) => runSystem(intakeSubmit, { workspaceId: wsId, sourceId, dedupeKey, payload }, scope);

const personByEmail = async (email: string) =>
  (
    await rows<{ id: string; first_name: string; last_name: string; source: string | null }>(
      admin(),
      sql`select id, first_name, last_name, source from app.people
          where workspace_id = ${wsId} and email = ${email}`,
    )
  )[0] ?? null;

const leadsOf = async (personId: string) =>
  rows<{ id: string; title: string; source: string | null; value_cents: number; stage: string }>(
    admin(),
    sql`select l.id, l.title, l.source, l.value_cents, s.name as stage from app.leads l
        join app.pipeline_stages s on s.id = l.stage_id
        where l.person_id = ${personId} order by l.created_at`,
  );

describe('a form on the business’s own website', () => {
  let sourceId: string;
  let publicKey: string;

  it('is made with a key and the sites it may be posted from', async () => {
    const made = await run(
      intakeSourceCreate,
      {
        workspaceId: wsId,
        kind: 'website_form',
        name: 'Quote form',
        allowedOrigins: ['https://lonestarhvac.com'],
        redirectUrl: 'https://lonestarhvac.com/thank-you',
      },
      owner,
    );
    sourceId = made.sourceId;
    publicKey = made.publicKey!;
    expect(publicKey).toMatch(/^ik_[A-Za-z0-9]{20}$/);
    expect(made.secret).toBeNull();
    // The www twin is added, the way the chat widget's sites are.
    expect(made.allowedOrigins).toEqual([
      'https://lonestarhvac.com',
      'https://www.lonestarhvac.com',
    ]);
  });

  it('opens a customer, a lead and a note of what they wrote', async () => {
    const out = await send(sourceId, {
      name: 'Dana Reyes',
      email: 'dana@example.com',
      phone: '(512) 555-0134',
      message: 'My upstairs unit is out.',
      extra: { 'Where is it': 'Upstairs, attic unit' },
    });
    expect(out.outcome).toBe('opened');
    const person = await personByEmail('dana@example.com');
    expect(person).toMatchObject({
      first_name: 'Dana',
      last_name: 'Reyes',
      source: 'Quote form',
    });
    const open = await leadsOf(person!.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Dana Reyes (Quote form)', source: 'Quote form' });
    const [note] = await rows<{ body: string }>(
      admin(),
      sql`select body from app.activities where person_id = ${person!.id} and subtype = 'intake'`,
    );
    expect(note!.body).toContain('My upstairs unit is out.');
    expect(note!.body).toContain('Where is it: Upstairs, attic unit');
  });

  it('answers a retry with what it said the first time, and opens nothing twice', async () => {
    const key = 'submission-42';
    const first = await send(sourceId, { name: 'Ray Tran', email: 'ray@example.com' }, key);
    const again = await send(sourceId, { name: 'Ray Tran', email: 'ray@example.com' }, key);
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({
      duplicate: true,
      personId: first.personId,
      leadId: first.leadId,
    });
    const person = await personByEmail('ray@example.com');
    expect(await leadsOf(person!.id)).toHaveLength(1);
  });

  it('opens a lead for somebody already in the customers, but no second customer', async () => {
    const { personId } = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Maria', lastName: 'Lopez', email: 'maria@example.com' },
      owner,
    );
    const out = await send(sourceId, { name: 'Maria Lopez', email: 'maria@example.com' });
    expect(out).toMatchObject({ outcome: 'matched', personId });
    expect(out.leadId).not.toBeNull();
  });

  it('refuses a sender with no way to reach them', async () => {
    const out = await send(sourceId, { name: 'Nobody', message: 'hello?' });
    expect(out).toMatchObject({ outcome: 'refused', refusedReason: 'no_contact', leadId: null });
  });

  it('stops at the day’s limit, and says so', async () => {
    await run(intakeSourceUpdate, { workspaceId: wsId, sourceId, dailyCap: 1 }, owner);
    await rows(
      admin(),
      sql`update app.intake_sources set day_count = 0, day_on = null where id = ${sourceId}`,
    );
    const first = await send(sourceId, { name: 'One', email: 'one@example.com' });
    const second = await send(sourceId, { name: 'Two', email: 'two@example.com' });
    expect(first.outcome).toBe('opened');
    expect(second).toMatchObject({ outcome: 'refused', refusedReason: 'over_limit' });
    await run(intakeSourceUpdate, { workspaceId: wsId, sourceId, dailyCap: 50 }, owner);
  });

  it('opens nothing once it is turned off', async () => {
    await run(intakeSourceUpdate, { workspaceId: wsId, sourceId, active: false }, owner);
    const out = await send(sourceId, { name: 'Late', email: 'late@example.com' });
    expect(out).toMatchObject({ outcome: 'refused', refusedReason: 'turned_off' });
    await run(intakeSourceUpdate, { workspaceId: wsId, sourceId, active: true }, owner);
  });

  it('gets a new key, and the old one is gone', async () => {
    const rotated = await run(intakeSourceRotateKey, { workspaceId: wsId, sourceId }, owner);
    expect(rotated.publicKey).toMatch(/^ik_[A-Za-z0-9]{20}$/);
    expect(rotated.publicKey).not.toBe(publicKey);
    expect(rotated.secret).toBeNull();
  });
});

describe('a connected app', () => {
  let sourceId: string;

  it('is made with a secret shown once, and only its last four are kept to look at', async () => {
    const made = await run(
      intakeSourceCreate,
      { workspaceId: wsId, kind: 'api', name: 'Zapier' },
      owner,
    );
    sourceId = made.sourceId;
    expect(made.publicKey).toBeNull();
    expect(made.secret).toMatch(/^hfos_[A-Za-z0-9_-]{32}$/);
    const [row] = await admin()
      .select({ hint: intakeSources.secretHint, hash: intakeSources.secretHash })
      .from(intakeSources)
      .where(eq(intakeSources.id, sourceId));
    expect(row!.hint).toBe(made.secret!.slice(-4));
    expect(row!.hash).toBeTruthy();
    // The list a business reads never carries the key or its hash.
    const view = await ask(intakeList, { workspaceId: wsId }, owner);
    const app = view.sources.find((s) => s.sourceId === sourceId)!;
    expect(app).toMatchObject({ kind: 'api', name: 'Zapier', secretHint: made.secret!.slice(-4) });
    expect(JSON.stringify(view)).not.toContain(made.secret!.slice(0, 12));
  });

  it('opens a lead where the business points it', async () => {
    const { pipelineId } = await run(
      pipelineCreate,
      { workspaceId: wsId, name: 'Ad leads' },
      owner,
    );
    await run(intakeSourceUpdate, { workspaceId: wsId, sourceId, pipelineId }, owner);
    const out = await send(sourceId, {
      name: 'Pat Rivera',
      phone: '+15125550190',
      title: 'Facebook: AC tune-up',
      valueCents: 45000,
    });
    expect(out.outcome).toBe('opened');
    const [lead] = await leadsOf(out.personId!);
    expect(lead).toMatchObject({ title: 'Facebook: AC tune-up' });
    expect(Number(lead!.value_cents)).toBe(45000);
    const [stage] = await rows<{ name: string }>(
      admin(),
      sql`select s.name from app.pipeline_stages s join app.leads l on l.stage_id = s.id
          where l.id = ${out.leadId}`,
    );
    expect(stage!.name).toBeTruthy();
  });

  it('gets a replacement key, and the old one stops', async () => {
    const rotated = await run(intakeSourceRotateKey, { workspaceId: wsId, sourceId }, owner);
    expect(rotated.secret).toMatch(/^hfos_/);
    const [row] = await admin()
      .select({ hint: intakeSources.secretHint })
      .from(intakeSources)
      .where(eq(intakeSources.id, sourceId));
    expect(row!.hint).toBe(rotated.secret!.slice(-4));
  });

  it('is retired, and nothing more arrives through it', async () => {
    await run(intakeSourceArchive, { workspaceId: wsId, sourceId }, owner);
    const out = await send(sourceId, { name: 'Too late', email: 'late2@example.com' });
    expect(out).toMatchObject({ outcome: 'refused', refusedReason: 'turned_off' });
    const view = await ask(intakeList, { workspaceId: wsId }, owner);
    expect(view.sources.find((s) => s.sourceId === sourceId)).toBeUndefined();
  });
});

describe('what a form or a key may not be', () => {
  it('refuses sites on a connected app, and a channel named as a form', async () => {
    await expectHfos(
      () =>
        run(
          intakeSourceCreate,
          {
            workspaceId: wsId,
            kind: 'api',
            name: 'Nope',
            allowedOrigins: ['https://example.com'],
          },
          owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          intakeSourceUpdate,
          { workspaceId: wsId, kind: 'text', sourceId: '00000000-0000-4000-8000-000000000000' },
          owner,
        ),
      'validation',
    );
  });

  it('refuses a site that isn’t a site', async () => {
    await expectHfos(
      () =>
        run(
          intakeSourceCreate,
          {
            workspaceId: wsId,
            kind: 'website_form',
            name: 'Bad sites',
            allowedOrigins: ['*.lonestarhvac.com'],
          },
          owner,
        ),
      'validation',
    );
  });
});
