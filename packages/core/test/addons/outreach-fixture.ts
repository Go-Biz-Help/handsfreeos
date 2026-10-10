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
  type CommandDef,
  type HumanActor,
  type QueryDef,
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

/** A new business owned by `u`, with the add-on on. Its id. */
export async function outreachBusiness(u: TestUser, name: string): Promise<string> {
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
  return id;
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
  ].find((x) => x.name === name)!;

/**
 * Runs one of the add-on's operations as `u` in `ws`, from the extension. A command is done now, or at `at`: one that
 * waited to send.
 */
export function runAs(
  u: TestUser,
  ws: string,
  name: string,
  input: Record<string, unknown>,
  at?: Date,
): Promise<Any> {
  const found = op(name);
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

/** A refusal's rule (or its code), or "went through". */
export const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );
