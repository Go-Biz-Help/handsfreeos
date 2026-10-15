/**
 * A business with Social Outreach on, the way the worker leaves it when the add-on arrives, and a way to run its
 * operations as someone there. For the add-on's database tests.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { testDbs, type TestUser } from '@hfos/db/testing';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { outreachAddonServer } from '../../src/addons/outreach/server';
import {
  commands,
  executeCommand,
  executeQuery,
  organizationCreate,
  queries,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type RequestMeta,
} from '../../src/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
export const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
/** The extension's requests: its channel, its command id and the moment it was done. */
export const fromExtension = () => ({
  correlationId: randomUUID(),
  channel: 'extension' as const,
  commandId: randomUUID(),
  occurredAt: new Date(),
});

/**
 * Businesses whose people the fixture gets ready (../../src/addons/outreach/readiness.ts, decision 63) just before
 * Today's list, Start my day or the helpful post: what the add-on's tests of those were written for. A business made
 * with `{ ready: false }` isn't, for the tests of getting ready.
 */
const gettingReady = new Set<string>();
const GATED = new Set(['outreach.today', 'outreach.day.start', 'outreach.helpful.next']);

/** A new business owned by `u`, with the add-on on. Its id. */
export async function outreachBusiness(
  u: TestUser,
  name: string,
  opts: { readonly ready?: boolean } = {},
): Promise<string> {
  const made = await executeCommand(api(), organizationCreate, { businessName: name }, human(u), {
    correlationId: randomUUID(),
    channel: 'test',
  });
  const id = made.output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${id}, 'outreach', 'enabled', ${outreachAddon.version})`,
  );
  if (opts.ready !== false) gettingReady.add(id);
  return id;
}

/** The main offer the fixture puts live: version 1, with no proof, so a playbook needs none either. */
const READY_OFFER = {
  who: { work: 'Owners of small businesses', problem: 'Too little time to follow up' },
  outcome: { result: 'More booked calls' },
  timeframe: { typical: '30 days' },
  method: { steps: ['Find them', 'Talk to them', 'Book them'] },
  guarantee: { promise: 'Or you don’t pay' },
  price: { amount: '$100 a month' },
  line: 'We help owners of small businesses get more booked calls in 30 days.',
  inAFewWords: { outcome: 'more booked calls', guarantee: 'you only pay for results' },
};

/** The short video the fixture links on each playbook in use without one (Your messages waits on one). */
export const READY_VIDEO = 'https://www.loom.com/share/abc123';

/**
 * Gets `ws` ready for `userIds`: a live main offer (unless it has one), a niche, its problem and a short video on each
 * playbook in use without them, and each person's profile read and checked right, and ticked, against the live
 * version, their messages OK'd, and a goal set.
 * Safe to run again.
 */
export async function getReady(ws: string, userIds: readonly string[]): Promise<void> {
  await rows(
    admin(),
    sql`with v as (
          insert into app.main_offer_versions (workspace_id, version, parts, line, score)
          values (${ws}, 1, ${JSON.stringify(READY_OFFER)}::jsonb, ${READY_OFFER.line}, '{}'::jsonb)
          on conflict (workspace_id, version) do nothing returning version)
        insert into app.main_offers (workspace_id, live_version) select ${ws}, version from v
        on conflict (workspace_id) do nothing`,
  );
  await rows(
    admin(),
    sql`update addon_outreach.playbooks
        set details = details || jsonb_strip_nulls(jsonb_build_object(
          'niche', case when coalesce(details->>'niche', '') = '' then 'Owners of small businesses' end,
          'problem', case when coalesce(details->>'problem', '') = '' then 'Too little time to follow up' end,
          'videoLink', case when coalesce(details->>'videoLink', '') = '' then ${READY_VIDEO} end))
        where workspace_id = ${ws} and archived_at is null`,
  );
  for (const userId of userIds)
    await rows(
      admin(),
      sql`insert into addon_outreach.setup (workspace_id, user_id, calls_goal, numbers_at, profile, profile_check)
          select ${ws}, ${userId}, 8, now(), jsonb_object_agg(item, jsonb_build_object(
            'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'version', (select live_version from app.main_offers where workspace_id = ${ws}))),
            jsonb_build_object(
              'items', jsonb_object_agg(item, jsonb_build_object('ok', true, 'why', 'Looks right.', 'fix', null)),
              'bios', '[]'::jsonb, 'coverLine', null, 'feature', '[]'::jsonb,
              'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'version', (select live_version from app.main_offers where workspace_id = ${ws}))
          from unnest(array['picture', 'cover', 'bio', 'work', 'featured', 'posts']) item
          on conflict (workspace_id, user_id) do update
            set calls_goal = coalesce(addon_outreach.setup.calls_goal, excluded.calls_goal),
              numbers_at = coalesce(addon_outreach.setup.numbers_at, excluded.numbers_at),
              profile = excluded.profile, profile_check = excluded.profile_check`,
    );
  // Their messages OK'd against the live version (Your messages).
  await rows(
    admin(),
    sql`update addon_outreach.setup
        set messages_at = now(),
          messages_version = (select live_version from app.main_offers where workspace_id = ${ws})
        where workspace_id = ${ws} and user_id = any (${`{${userIds.join(',')}}`}::uuid[])`,
  );
}

/** Turns the add-on off or back on in a business. */
export async function setOutreach(ws: string, state: 'enabled' | 'disabled'): Promise<void> {
  await rows(
    admin(),
    sql`update app.addon_installations set state = ${state}
        where workspace_id = ${ws} and addon_id = 'outreach'`,
  );
}

const op = (name: string) =>
  [
    ...(outreachAddonServer.commands ?? []),
    ...(outreachAddonServer.queries ?? []),
    ...commands,
    ...queries,
  ].find((x) => x.name === name)!;

/**
 * Runs one of the add-on's operations as `u` in `ws`, from the extension. A command is done now, or at `at`: one that
 * waited to send.
 */
export async function runAs(
  u: TestUser,
  ws: string,
  name: string,
  input: Record<string, unknown>,
  at?: Date,
): Promise<Any> {
  const found = op(name);
  if (GATED.has(name) && gettingReady.has(ws)) await getReady(ws, [u.id]);
  return found.kind === 'command'
    ? executeCommand(api(), found as CommandDef, { workspaceId: ws, ...input }, human(u), {
        ...fromExtension(),
        ...(at ? { occurredAt: at } : {}),
      }).then((r) => r.output)
    : executeQuery(api(), found as QueryDef, { workspaceId: ws, ...input }, human(u), {
        correlationId: randomUUID(),
        channel: 'extension',
      });
}

/**
 * Runs one of the add-on's commands as `u` in `ws` with the request's details as given: the web (`channel: 'web'`,
 * no id), or the extension with its own clock (`sentAt`).
 */
export async function runWith(
  u: TestUser,
  ws: string,
  name: string,
  input: Record<string, unknown>,
  meta: Partial<RequestMeta> & Pick<RequestMeta, 'channel'>,
): Promise<Any> {
  if (GATED.has(name) && gettingReady.has(ws)) await getReady(ws, [u.id]);
  return executeCommand(api(), op(name) as CommandDef, { workspaceId: ws, ...input }, human(u), {
    correlationId: randomUUID(),
    ...meta,
  }).then((r) => r.output);
}

/** A refusal's rule (or its code), or "went through". */
export const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

/** Runs one of the add-on's commands as its system actor in `ws`, as the worker does. */
export async function runAsSystem(
  ws: string,
  name: string,
  input: Record<string, unknown>,
): Promise<Any> {
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  return executeCommand(
    testDbs().worker.db,
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    {
      type: 'system',
      workspaceId: ws,
      organizationId: w!.organization_id,
      addon: { id: outreachAddon.id, name: outreachAddon.name, version: outreachAddon.version },
    },
    { correlationId: randomUUID(), channel: 'test' },
  ).then((r) => r.output);
}
