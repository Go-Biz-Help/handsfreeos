/**
 * A visitor to an add-on's public page, as the kernel runs them (Real Estate round three, step 1): only operations made
 * for public pages, only in the business whose page it is, only while the add-on is on, run as the service actor and
 * recorded as the system with the page they used. And the sign-up those pages share with forms: the customer found or
 * made, a lead where Lead intake says, and a yes to texts kept unless they said stop before.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { realestateAddon } from '../src/addons/realestate/manifest';
import { SIGN_UP_EVENTS, signUpFromPage } from '../src/crm/signup';
import {
  composeOperations,
  defineAddonCommand,
  defineAddonQuery,
  executeCommand,
  executeQuery,
  manifestIssues,
  personCreate,
  publicOperationIssues,
  registry,
  requirePublic,
  type PublicActor,
  type RequestMeta,
} from '../src/server';
import { realestateBusiness } from './addons/realestate-fixture';
import { admin, expectHfos, run, type Scope } from './calendar-helpers';

let owner: TestUser;
let scope: Scope;
let visitor: PublicActor;

const worker = () => testDbs().worker.db;
const page = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'booking_page' });

/** A public look-up: what the page shows, and who the database thinks is asking. */
const showPage = defineAddonQuery(realestateAddon, {
  name: 'realestate.public.test_page',
  description: 'Test: a public page’s look-up.',
  input: z.object({ workspaceId: z.string().uuid(), slug: z.string() }),
  output: z.object({ slug: z.string(), role: z.string() }),
  permission: null,
  actors: ['public'],
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [r] = await rows<{ role: string }>(ctx.tx, sql`select current_user::text as role`);
    return { slug: input.slug, role: r!.role };
  },
});

/** A visitor leaving their name: the sign-up a public page shares with forms. */
const leaveName = defineAddonCommand(realestateAddon, {
  name: 'realestate.public.test_sign_in',
  description: 'Test: a visitor leaves their name on a public page.',
  risk: 2,
  input: z.object({
    workspaceId: z.string().uuid(),
    firstName: z.string(),
    phone: z.string(),
    smsConsent: z.boolean(),
  }),
  output: z.object({ personId: z.string(), leadId: z.string().nullable(), role: z.string() }),
  permission: null,
  actors: ['public'],
  emits: ['realestate.test_signed_in', ...SIGN_UP_EVENTS],
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const me = requirePublic(ctx);
    const [r] = await rows<{ role: string }>(ctx.tx, sql`select current_user::text as role`);
    const signed = await signUpFromPage(ctx, {
      firstName: input.firstName,
      lastName: 'Visitor',
      email: null,
      phone: input.phone,
      source: `Open house: ${me.site}`,
      smsConsent: input.smsConsent,
      lead: { title: `Open house: ${input.firstName}`, assigneeUserId: owner.id },
    });
    await ctx.emit({
      type: 'realestate.test_signed_in',
      entityType: 'person',
      entityId: signed.personId,
    });
    return { personId: signed.personId, leadId: signed.leadId, role: r!.role };
  },
});

beforeAll(async () => {
  owner = await createTestUser('public-kernel-owner', { fullName: 'Dana Reyes' });
  const workspaceId = await realestateBusiness(owner, 'Public Kernel Realty');
  const [ws] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${workspaceId}`,
  );
  scope = { workspaceId, organizationId: ws!.organization_id };
  visitor = {
    type: 'public',
    ...scope,
    site: 'public-kernel-realty',
    visitor: 'hmac-of-their-address',
  };
});
afterAll(closeTestDbs);

describe('a visitor’s look-ups', () => {
  it('run as the service actor in the page’s business', async () => {
    expect(
      await executeQuery(
        worker(),
        showPage,
        { workspaceId: scope.workspaceId, slug: 'x' },
        visitor,
        page(),
      ),
    ).toEqual({ slug: 'x', role: 'service_actor' });
  });

  it('are refused anything not made for public pages, and any other business', async () => {
    await expectHfos(
      () =>
        executeQuery(
          worker(),
          registry.query('person.list')!,
          { workspaceId: scope.workspaceId },
          visitor,
          page(),
        ),
      'forbidden',
    );
    await expectHfos(
      () =>
        executeCommand(
          worker(),
          personCreate,
          { workspaceId: scope.workspaceId, firstName: 'Bot' },
          visitor,
          page(),
        ),
      'forbidden',
    );
    await expectHfos(
      () =>
        executeQuery(worker(), showPage, { workspaceId: randomUUID(), slug: 'x' }, visitor, page()),
      'not_found',
    );
  });

  it('stop while the add-on is off', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${scope.workspaceId} and addon_id = 'realestate'`,
    );
    try {
      await expectHfos(
        () =>
          executeQuery(
            worker(),
            showPage,
            { workspaceId: scope.workspaceId, slug: 'x' },
            visitor,
            page(),
          ),
        'addon_inactive',
      );
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${scope.workspaceId} and addon_id = 'realestate'`,
      );
    }
  });
});

describe('a visitor’s changes', () => {
  it('make the customer and a lead, keep their yes to texts, and are recorded as the system from the page', async () => {
    const { output, eventIds } = await executeCommand(
      worker(),
      leaveName,
      {
        workspaceId: scope.workspaceId,
        firstName: 'Kayla',
        phone: '+15125550187',
        smsConsent: true,
      },
      visitor,
      page(),
    );
    expect(output.role).toBe('service_actor');
    expect(output.leadId).not.toBeNull();
    const [person] = await rows<{
      sms_consent: string;
      sms_consent_source: string;
      source: string;
    }>(
      admin(),
      sql`select sms_consent::text, sms_consent_source, source from app.people where id = ${output.personId}`,
    );
    expect(person).toEqual({
      sms_consent: 'opted_in',
      sms_consent_source: 'Open house: public-kernel-realty',
      source: 'Open house: public-kernel-realty',
    });
    const [lead] = await rows<{ assignee_user_id: string; title: string }>(
      admin(),
      sql`select assignee_user_id, title from app.leads where id = ${output.leadId}`,
    );
    expect(lead).toEqual({ assignee_user_id: owner.id, title: 'Open house: Kayla' });
    const audit = await rows<{
      actor_type: string;
      actor_id: string | null;
      actor_role: string;
      channel: string;
    }>(
      admin(),
      sql`select actor_type::text, actor_id, actor_role, channel from app.audit_logs where event_id = ${eventIds.at(-1)!}`,
    );
    expect(audit).toEqual([
      { actor_type: 'system', actor_id: null, actor_role: 'public', channel: 'booking_page' },
    ]);
    const [event] = await rows<{ payload: { _public: unknown } }>(
      admin(),
      sql`select payload from app.events where id = ${eventIds.at(-1)!}`,
    );
    expect(event!.payload._public).toEqual({
      site: 'public-kernel-realty',
      visitor: 'hmac-of-their-address',
    });
  });

  it('never turn a stop back into a yes, and find the customer they already are', async () => {
    const first = await executeCommand(
      worker(),
      leaveName,
      {
        workspaceId: scope.workspaceId,
        firstName: 'Marcus',
        phone: '+17375550110',
        smsConsent: false,
      },
      visitor,
      page(),
    );
    await rows(
      admin(),
      sql`update app.people set sms_consent = 'opted_out' where id = ${first.output.personId}`,
    );
    const again = await executeCommand(
      worker(),
      leaveName,
      {
        workspaceId: scope.workspaceId,
        firstName: 'Marcus',
        phone: '+17375550110',
        smsConsent: true,
      },
      visitor,
      page(),
    );
    expect(again.output.personId).toBe(first.output.personId);
    const [person] = await rows<{ sms_consent: string }>(
      admin(),
      sql`select sms_consent::text from app.people where id = ${first.output.personId}`,
    );
    expect(person!.sms_consent).toBe('opted_out');
  });

  it('open no lead when Lead intake is off for the business’s forms', async () => {
    await rows(
      admin(),
      sql`insert into app.intake_sources (workspace_id, kind, name, active)
          values (${scope.workspaceId}, 'website_form', 'Forms built here', false)
          on conflict do nothing`,
    );
    await rows(
      admin(),
      sql`update app.intake_sources set active = false
          where workspace_id = ${scope.workspaceId} and kind = 'website_form' and public_key is null`,
    );
    const { output } = await executeCommand(
      worker(),
      leaveName,
      {
        workspaceId: scope.workspaceId,
        firstName: 'Sofia',
        phone: '+15125550133',
        smsConsent: false,
      },
      visitor,
      page(),
    );
    expect(output.leadId).toBeNull();
  });

  it('can’t be run by people in the business', async () => {
    await expectHfos(
      () =>
        run(
          leaveName,
          {
            workspaceId: scope.workspaceId,
            firstName: 'Dana',
            phone: '+15125550100',
            smsConsent: false,
          },
          owner,
        ),
      'forbidden',
    );
  });
});

describe('what visitors may run', () => {
  it('is named for public pages, for visitors alone, with no permission, no AI and a form’s risk at most', () => {
    const ops = [...registry.commands, ...registry.queries];
    // Core has none of its own; an add-on's are "<its id>.public.…".
    expect(ops.filter((op) => !op.addon && op.actors?.includes('public'))).toEqual([]);
    expect(
      ops.flatMap((op) => (op.addon ? publicOperationIssues(op, `${op.addon.id}.public.`) : [])),
    ).toEqual([]);
    expect(publicOperationIssues(leaveName, 'realestate.public.')).toEqual([]);
    const as = (op: object) => op as unknown as typeof leaveName;
    expect(
      publicOperationIssues(
        as({ ...leaveName, actors: ['public', 'human'] }),
        'realestate.public.',
      ),
    ).toEqual(['realestate.public.test_sign_in is for visitors alone']);
    expect(publicOperationIssues(as({ ...leaveName, risk: 3 }), 'realestate.public.')).toEqual([
      'realestate.public.test_sign_in is for visitors, so its risk is 2 at most',
    ]);
    expect(
      publicOperationIssues(as({ ...leaveName, name: 'realestate.sign_in' }), 'realestate.public.'),
    ).toEqual([
      'realestate.sign_in is for public pages, so it must be named "realestate.public.…"',
    ]);
  });

  it('shows a public page only through one of the add-on’s public queries', () => {
    const m = {
      ...realestateAddon,
      ui: {
        ...realestateAddon.ui,
        // Its portal pages' queries aren't in this test's module.
        portal: [],
        public: [{ path: ':slug', query: 'realestate.public.test_page' }],
      },
    };
    expect(manifestIssues(m)).toEqual([]);
    expect(() => composeOperations({ commands: [], queries: [] }, [{ manifest: m }])).toThrow(
      /public page ":slug" shows realestate.public.test_page, which isn't one of its public queries/,
    );
    expect(() =>
      composeOperations({ commands: [], queries: [] }, [{ manifest: m, queries: [showPage] }]),
    ).not.toThrow();
    const wrong = {
      ...m,
      ui: {
        ...m.ui,
        public: [
          { path: ':slug', query: 'realestate.deals' },
          { path: ':id', query: 'realestate.public.x' },
        ],
      },
    };
    expect(manifestIssues(wrong).map((i) => i.message)).toEqual([
      'public page ":slug" shows "realestate.deals", which must be one of "realestate.public.*"',
      'public page ":id" is declared twice',
    ]);
  });
});
