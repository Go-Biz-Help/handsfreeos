/**
 * What every push moment's event handler shares (moments.ts, arrival.ts): the savepoint it runs in, and the small
 * look-ups the words and the recipients need.
 */
import { isWorkspaceUser } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { workspaceManagers } from '../handlers/telephony';
import type { EventHandler, HandlerContext } from '../handlers/types';
import { errorMessage } from '../outbox';
import type { TenantScope } from '../services';

export type Payload = Record<string, unknown>;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 100) : [];
export const payloadOf = (ctx: HandlerContext): Payload => (ctx.event.payload ?? {}) as Payload;
/** The person who did it, when a person did. */
export const personActor = (ctx: HandlerContext): string | null =>
  ctx.event.actorType === 'human' ? ctx.event.actorId : null;

/** A message inside quotes, short enough that the closing one survives the body's length. */
export const quoted = (text: string, max = 140): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;
};

/**
 * Runs one moment's handler in a savepoint: a push never holds up the event's other work. A business where nobody
 * has a phone on (the worker sees only its own people's) costs one look and nothing more.
 */
export function pushMoment(
  what: string,
  queue: (ctx: HandlerContext, scope: TenantScope) => Promise<void>,
): EventHandler {
  return async (ctx) => {
    const { workspaceId, organizationId } = ctx.scope;
    if (!workspaceId || !organizationId) return;
    const [anyPhone] = await rows(
      ctx.tx,
      sql`select 1 from app.push_devices where disabled_at is null limit 1`,
    );
    if (!anyPhone) return;
    try {
      await ctx.tx.transaction((sp) => queue({ ...ctx, tx: sp }, { workspaceId, organizationId }));
    } catch (e) {
      ctx.log.warn({ err: errorMessage(e), moment: what }, 'could not queue a push');
    }
  };
}

export async function personName(
  tx: Tx,
  personId: string | null | undefined,
): Promise<string | null> {
  if (!personId) return null;
  const [p] = await rows<{ name: string }>(
    tx,
    sql`select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) as name
        from app.people where id = ${personId}`,
  );
  return p?.name || null;
}

export async function userName(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await rows<{ name: string }>(
    tx,
    sql`select full_name as name from app.users where id = ${userId}`,
  );
  return u?.name?.trim() || null;
}

/** The people named who still work in the business. */
export async function stillHere(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of new Set(ids)) if (await isWorkspaceUser(tx, workspaceId, id)) out.push(id);
  return out;
}

/** The business's own owners and admins (its agency's when it has none), as a workflow's emails pick them. */
export const managerIds = async (tx: Tx, workspaceId: string): Promise<string[]> =>
  (await workspaceManagers(tx, workspaceId)).map((u) => u.id);
