/**
 * The contact form texting approval rests on (the owner, 2026-11-22): "we should just automatically create an a2p
 * compliant contact form when someone creates an account and if it's not there it should be created when they start
 * the a2p process".
 *
 * `registration.ensure_contact_form` gives a business with none the "Get in touch" starter, published, with a public
 * link and its website among the sites it may show on. A business that has a form customers can agree to texts on
 * keeps it. The worker runs it as the system when a business is made; texting approval runs it when it starts.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { starterForm } from '../src/forms/starters';
import { worksAsContactForm } from '../src/forms/texting-box';
import { executeCommand } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import {
  formCreate,
  formPublish,
  formSetStatus,
  organizationCreate,
  registrationEnsureContactForm,
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

let owner: TestUser;

const formsOf = (wsId: string) =>
  rows<{ id: string; name: string; status: string; slug: string; embed_origins: string[] | null }>(
    admin(),
    sql`select id, name, status::text as status, slug, embed_origins from app.forms
        where workspace_id = ${wsId} and archived_at is null order by created_at`,
  );

beforeAll(async () => {
  owner = await createTestUser('contact-form-owner');
});
afterAll(closeTestDbs);

describe('worksAsContactForm', () => {
  it('takes a form that asks who they are and for a phone number, with the box there when it opens', () => {
    expect(worksAsContactForm(starterForm('enquiry'))).toBe(true);
    const anonymous = starterForm('enquiry');
    expect(
      worksAsContactForm({
        ...anonymous,
        settings: { ...anonymous.settings, identity: 'anonymous' },
      }),
    ).toBe(false);
    const noPhone = starterForm('enquiry');
    expect(
      worksAsContactForm({
        ...noPhone,
        pages: noPhone.pages.map((p) => ({
          ...p,
          questions: p.questions.filter((q) => q.type !== 'phone'),
        })),
      }),
    ).toBe(false);
    // A page at a time shows the box on a later page, where a reviewer opening the page never gets.
    const paged = starterForm('enquiry');
    expect(
      worksAsContactForm({
        ...paged,
        settings: { ...paged.settings, onePageAtATime: true },
        pages: [...paged.pages, { ...paged.pages[0]!, id: 'p_second00', questions: [] }],
      }),
    ).toBe(false);
  });
});

describe('registration.ensure_contact_form', () => {
  it('makes “Get in touch”, published and allowed on the website, once', async () => {
    const org = await run(organizationCreate, { businessName: 'Contact Form Salon' }, owner);
    const wsId = org.workspaceId;
    const first = await run(
      registrationEnsureContactForm,
      { workspaceId: wsId, website: 'contactformsalon.com' },
      owner,
    );
    expect(first.created).toBe(true);
    expect(first.name).toBe('Get in touch');
    expect(first.slug).toBe('get-in-touch');
    expect(first.siteSlug).toBeTruthy();
    expect(first.embedOrigins).toEqual([
      'https://contactformsalon.com',
      'https://www.contactformsalon.com',
    ]);
    const [form] = await formsOf(wsId);
    expect(form).toMatchObject({ id: first.formId, status: 'live', slug: 'get-in-touch' });
    const versions = await rows<{ version: number; source: string }>(
      admin(),
      sql`select version, source from app.form_versions where form_id = ${first.formId}`,
    );
    expect(versions).toEqual([{ version: 1, source: 'template' }]);

    // Again: the same form, nothing new.
    const again = await run(registrationEnsureContactForm, { workspaceId: wsId }, owner);
    expect(again).toMatchObject({ formId: first.formId, created: false });
    expect(await formsOf(wsId)).toHaveLength(1);
  });

  it('keeps a form the business already has, and adds its website to the form’s sites', async () => {
    const org = await run(organizationCreate, { businessName: 'Contact Form Roofing' }, owner);
    const wsId = org.workspaceId;
    const made = await run(
      formCreate,
      { workspaceId: wsId, name: 'Ask for a quote', starter: 'quote' },
      owner,
    );
    await run(
      formPublish,
      { workspaceId: wsId, formId: made.formId, baseRevision: made.revision },
      owner,
    );
    const got = await run(
      registrationEnsureContactForm,
      { workspaceId: wsId, website: 'https://roofing.example.com/home' },
      owner,
    );
    expect(got).toMatchObject({ formId: made.formId, name: 'Ask for a quote', created: false });
    expect(got.embedOrigins).toContain('https://roofing.example.com');
    expect(await formsOf(wsId)).toHaveLength(1);

    // Closed, it no longer takes answers, so a new one is made.
    await run(formSetStatus, { workspaceId: wsId, formId: made.formId, status: 'closed' }, owner);
    const next = await run(registrationEnsureContactForm, { workspaceId: wsId }, owner);
    expect(next.created).toBe(true);
    expect(next.formId).not.toBe(made.formId);
  });

  it('runs as the system for whoever made the business, and not for someone who can’t manage channels', async () => {
    const org = await run(organizationCreate, { businessName: 'Contact Form Plumbing' }, owner);
    const wsId = org.workspaceId;
    const system: SystemActor = {
      type: 'system',
      workspaceId: wsId,
      organizationId: org.organizationId,
      onBehalfOf: owner.id,
    };
    const { output } = await executeCommand(
      testDbs().worker.db,
      registrationEnsureContactForm,
      { workspaceId: wsId },
      system,
      meta(),
    );
    expect(output.created).toBe(true);
    const [row] = await rows<{ created_by: string | null }>(
      admin(),
      sql`select created_by from app.forms where id = ${output.formId}`,
    );
    expect(row?.created_by).toBe(owner.id);

    const stranger = await createTestUser('contact-form-stranger');
    await expect(
      run(registrationEnsureContactForm, { workspaceId: wsId }, stranger),
    ).rejects.toBeInstanceOf(HfosError);
  });
});
