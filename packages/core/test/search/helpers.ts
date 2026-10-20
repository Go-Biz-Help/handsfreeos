/**
 * A business to search, for the suites against the local database: Bayou Plumbing's owner and three members (from
 * the calendar suites' team), and the rows boards 1 to 4 search for, written straight into the tables.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { testDbs, type TestUser } from '@hfos/db/testing';
import { expect } from 'vitest';
import type { z } from 'zod';
import type { QueryContext, RequestMeta } from '../../src/kernel/types';
import { scopeCan } from '../../src/kernel/execute';
import {
  SearchEverythingInput,
  SearchKindInput,
  type SearchEverythingOutput,
  type SearchGroup,
  type SearchHit,
} from '../../src/schemas/search';
import { searchEverything, searchKind } from '../../src/server';
import type { RunOptions } from '../../src/search/server/run';
import { runSearch } from '../../src/search/server/run';
import { admin, ask, human, setupTeam, type Team } from '../calendar-helpers';

export { admin, ask, expectHfos, run } from '../calendar-helpers';

/** Search everything as someone. */
export const everything = (
  t: { wsId: string },
  u: TestUser,
  q: string,
  more: Partial<z.input<typeof SearchEverythingInput>> = {},
) => ask(searchEverything, { workspaceId: t.wsId, q, ...more }, u);

/** One kind as someone. */
export const oneKind = (
  t: { wsId: string },
  u: TestUser,
  q: string,
  kind: string,
  more: Partial<z.input<typeof SearchKindInput>> = {},
) => ask(searchKind, { workspaceId: t.wsId, q, kind, ...more }, u);

/** A group of an answer by kind. */
export const groupOf = (a: SearchEverythingOutput, kind: string): SearchGroup | undefined =>
  a.groups.find((g) => g.kind === kind);

/** The titles in a group, in order. */
export const titles = (g: SearchGroup | null | undefined): string[] =>
  (g?.items ?? []).map((h: SearchHit) => h.title);

/** Every title in an answer, every group, Archived and the bin included. */
export const allTitles = (a: SearchEverythingOutput): string[] => [
  ...a.groups.flatMap((g) => titles(g)),
  ...titles(a.archived),
  ...titles(a.bin),
];

const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

/**
 * Runs a search straight through `runSearch`, as the person under row security, with test-only searchers or a
 * budget: the query's own path, minus the kernel. Their permissions are what the business gives them.
 */
export async function runAs(
  t: { wsId: string; orgId: string },
  u: TestUser,
  input: z.input<typeof SearchEverythingInput> | z.input<typeof SearchKindInput>,
  opts: RunOptions = {},
) {
  return asUser(testDbs().api.db, u.claims, async (tx) => {
    const [row] = await rows<{ role: 'owner' | 'admin' | 'member'; permissions: string[] }>(
      tx,
      sql`select private.my_workspace_role(${t.wsId})::text as role,
                 private.my_permissions(${t.wsId}) as permissions`,
    );
    const ctx: QueryContext = {
      tx,
      actor: human(u),
      scope: {
        workspaceId: t.wsId,
        organizationId: t.orgId,
        workspaceRole: row!.role,
        workspacePermissions: row!.permissions,
        orgRole: null,
      },
      meta: meta(),
    };
    expect(scopeCan(ctx.scope, 'workspace.read')).toBe(true);
    const parsed =
      'kind' in input ? SearchKindInput.parse(input) : SearchEverythingInput.parse(input);
    return runSearch(ctx, parsed as never, opts) as Promise<unknown>;
  });
}

export interface World extends Team {
  readonly ids: Readonly<Record<string, string>>;
}

const one = async (query: ReturnType<typeof sql>): Promise<string> => {
  const [r] = await rows<{ id: string }>(admin(), query);
  return r!.id;
};

/** A stage of the business's first pipeline: its first open one, or its won one. */
async function stageOf(wsId: string, kind: 'open' | 'won') {
  const [s] = await rows<{ id: string; pipeline_id: string }>(
    admin(),
    sql`select id, pipeline_id from app.pipeline_stages
        where workspace_id = ${wsId} and kind = ${kind} order by position limit 1`,
  );
  return s!;
}

/** Bayou Plumbing and the rows the boards search for. */
export async function searchWorld(label: string): Promise<World> {
  const t = await setupTeam(label);
  const ws = t.wsId;
  const person = (f: Record<string, unknown>) =>
    one(sql`insert into app.people (workspace_id, first_name, last_name, email, phone_e164, address_line1, city,
              state, postal_code, company_id, other_phones, archived_at, owner_user_id)
            values (${ws}, ${f.first as string}, ${f.last as string}, ${(f.email as string) ?? null},
              ${(f.phone as string) ?? null}, ${(f.street as string) ?? null}, ${(f.city as string) ?? null},
              ${(f.state as string) ?? null}, ${(f.zip as string) ?? null}, ${(f.company as string) ?? null},
              ${JSON.stringify(f.otherPhones ?? [])}::jsonb, ${f.archived ? sql`now()` : sql`null`},
              ${(f.owner as string) ?? null})
            returning id`);
  const company = (name: string, f: Record<string, unknown> = {}) =>
    one(sql`insert into app.companies (workspace_id, name, website, phone_e164, owner_user_id)
            values (${ws}, ${name}, ${(f.website as string) ?? null}, ${(f.phone as string) ?? null},
              ${(f.owner as string) ?? null})
            returning id`);
  const smithfield = await company('Smithfield Property Mgmt', { phone: '+15045550900' });
  const gulf = await company('Gulf Coast Realty', { website: 'https://www.gulfcoastrealty.com/' });
  const dana = await person({
    first: 'Dana',
    last: 'Smith',
    email: 'dana.smith@gmail.com',
    phone: '+15045550142',
    street: '1042 Oak St',
    city: 'Metairie',
    state: 'LA',
    zip: '70001',
    owner: t.member.id,
  });
  const dana2 = await person({
    first: 'Dana',
    last: 'Smith',
    email: 'dsmith@yahoo.com',
    phone: '+15045550142',
    city: 'Kenner',
  });
  const marcus = await person({
    first: 'Marcus',
    last: 'Smith',
    phone: '+15045550199',
    otherPhones: [{ phone: '+15045550111', label: 'Work' }],
  });
  const jo = await person({ first: 'Jo', last: 'Smithers', email: 'jo@smithers.net' });
  const jose = await person({ first: 'José', last: 'García', city: 'Chalmette' });
  const kim = await person({
    first: 'Kim',
    last: 'Le',
    email: 'kim@gulfcoastrealty.com',
    company: smithfield,
  });
  const tom = await person({ first: 'Tom', last: 'Becnel', archived: true });

  const open = await stageOf(ws, 'open');
  const won = await stageOf(ws, 'won');
  const lead = (title: string, f: Record<string, unknown>) =>
    one(sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, company_id, title, value_cents,
              status, won_at, assignee_user_id)
            values (${ws}, ${open.pipeline_id}, ${f.won ? won.id : open.id}, ${(f.person as string) ?? null},
              ${(f.company as string) ?? null}, ${title}, ${(f.value as number) ?? 0},
              ${f.won ? 'won' : 'open'}::app.lead_status, ${f.won ? sql`now()` : sql`null`},
              ${(f.assignee as string) ?? null})
            returning id`);
  const backflow = await lead('Backflow test, 4 buildings', {
    company: smithfield,
    person: kim,
    value: 240_000,
  });
  const heater = await lead('Water heater install', {
    person: dana,
    value: 185_000,
    assignee: t.member.id,
  });
  const roof = await lead('Old roof repair', { person: marcus, won: true });

  const invoice = (f: Record<string, unknown>) =>
    one(sql`insert into app.invoices (workspace_id, person_id, number, sent_at, status, title, notes, total_cents,
              subtotal_cents, due_on, public_ref, assignee_user_id)
            values (${ws}, ${f.person as string}, ${(f.number as string) ?? null},
              ${f.number ? sql`now()` : sql`null`}, ${(f.status as string) ?? (f.number ? 'sent' : 'draft')}::app.invoice_status,
              ${(f.title as string) ?? null}, ${(f.notes as string) ?? null}, ${(f.total as number) ?? 0},
              ${(f.total as number) ?? 0}, ${(f.due as string) ?? null}::date,
              ${randomUUID().replace(/-/g, '').slice(0, 8)}, ${(f.assignee as string) ?? null})
            returning id`);
  const estimate = (f: Record<string, unknown>) =>
    one(sql`insert into app.estimates (workspace_id, person_id, number, sent_at, status, title, total_cents,
              subtotal_cents, public_ref)
            values (${ws}, ${f.person as string}, ${(f.number as string) ?? null},
              ${f.number ? sql`now()` : sql`null`}, ${f.number ? 'sent' : 'draft'}::app.estimate_status,
              ${(f.title as string) ?? null}, ${(f.total as number) ?? 0}, ${(f.total as number) ?? 0},
              ${randomUUID().replace(/-/g, '').slice(0, 8)})
            returning id`);
  const inv1042 = await invoice({
    person: marcus,
    number: '2026-1042',
    total: 128_000,
    title: 'Repipe',
  });
  const invOld = await invoice({
    person: jo,
    number: 'INV-001042',
    total: 5_000,
    due: '2026-10-14',
    status: 'overdue',
  });
  const invDraft = await invoice({
    person: dana,
    title: 'Water heater flush',
    total: 22_500,
    notes: 'Gate code 4471',
  });
  const est = await estimate({
    person: dana,
    number: 'LS-0042',
    total: 99_900,
    title: 'New water heater',
  });
  const estDraft = await estimate({ person: kim, title: 'Backflow retest', total: 15_000 });
  const cash = await one(
    sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
        values (${ws}, ${inv1042}, 128000, 'cash', 'succeeded', now() - interval '20 days') returning id`,
  );

  const knowledge = await one(
    sql`insert into app.knowledge_items (workspace_id, kind, title, body, status)
        values (${ws}, 'faq', 'Water heater maintenance', 'Flush the tank once a year so sediment never builds up.', 'published')
        returning id`,
  );
  const petType = await one(
    sql`insert into app.custom_record_types (workspace_id, key, singular, plural, icon)
        values (${ws}, 'pets', 'Pet', 'Pets', 'paw') returning id`,
  );
  const breed = await one(
    sql`insert into app.custom_fields (workspace_id, entity, key, label, type, record_type_id)
        values (${ws}, 'custom_record', 'breed', 'Breed', 'text', ${petType}) returning id`,
  );
  const rex = await one(
    sql`insert into app.custom_records (workspace_id, type_id, name, custom)
        values (${ws}, ${petType}, 'Rex Smith', ${JSON.stringify({ [breed]: 'Golden retriever' })}::jsonb)
        returning id`,
  );
  const gate = await one(
    sql`insert into app.custom_fields (workspace_id, entity, key, label, type)
        values (${ws}, 'person', 'gate', 'Gate code', 'text') returning id`,
  );
  await rows(
    admin(),
    sql`update app.people set custom = ${JSON.stringify({ [gate]: 'Gate 4471' })}::jsonb where id = ${jose}`,
  );
  return {
    ...t,
    ids: {
      smithfield,
      gulf,
      dana,
      dana2,
      marcus,
      jo,
      jose,
      kim,
      tom,
      backflow,
      heater,
      roof,
      inv1042,
      invOld,
      invDraft,
      est,
      estDraft,
      cash,
      knowledge,
      petType,
      rex,
    },
  };
}
