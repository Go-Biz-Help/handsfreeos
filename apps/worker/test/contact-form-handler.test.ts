/**
 * Every new business gets its contact form (the owner, 2026-11-22: "we should just automatically create an a2p
 * compliant contact form when someone creates an account"): `workspace.created` reaches the worker, which runs
 * `registration.ensure_contact_form` as the system for whoever made the business.
 * - The first business of a sign-up and a business added later both get "Get in touch", published, under the
 *   business's public name.
 * - It is made in the name of the person who made the business.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  workspaceCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let s: TestServices;

/** Hands the worker the business's `workspace.created`, and nothing else waiting in the outbox. */
async function runCreated(ws: string) {
  const runner = `vitest-contact-form-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${runner}
        where status = 'pending' and event_id in
          (select id from app.events where event_type = 'workspace.created' and entity_id = ${ws})`,
  );
  return processOnce({ ...s, handlers, workerId: runner, batchSize: 20, reservedOnly: true });
}

const formsOf = (ws: string) =>
  rows<{
    name: string;
    slug: string;
    status: string;
    created_by: string | null;
    versions: number;
    site: string | null;
  }>(
    admin(),
    sql`select f.name, f.slug, f.status::text as status, f.created_by,
          (select count(*)::int from app.form_versions v where v.form_id = f.id) as versions,
          (select bs.slug::text from app.booking_sites bs where bs.workspace_id = f.workspace_id) as site
        from app.forms f where f.workspace_id = ${ws}`,
  );

beforeAll(async () => {
  owner = await createTestUser('contact-form-handler-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Form At Sign Up Plumbing' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  s = testServices();
}, 60_000);

afterAll(closeTestDbs);

describe('a new business’s contact form', () => {
  it('is made when a sign-up makes its first business: published, under the business’s public name', async () => {
    expect(await formsOf(workspaceId)).toEqual([]);
    await runCreated(workspaceId);
    const forms = await formsOf(workspaceId);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({
      name: 'Get in touch',
      slug: 'get-in-touch',
      status: 'live',
      created_by: owner.id,
      versions: 1,
    });
    expect(forms[0]?.site).toMatch(/^form-at-sign-up-plumbing/);
  });

  it('is made for a business added later too', async () => {
    const { output } = await executeCommand(
      api(),
      workspaceCreate,
      { organizationId, name: 'Form For The Second Shop', joinAsOwner: true },
      actor(owner),
      meta(),
    );
    await runCreated(output.workspaceId);
    const forms = await formsOf(output.workspaceId);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ name: 'Get in touch', status: 'live', versions: 1 });
    // The first business still has its one form.
    expect(await formsOf(workspaceId)).toHaveLength(1);
  });
});
