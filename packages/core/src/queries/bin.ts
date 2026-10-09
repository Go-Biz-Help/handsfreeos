/**
 * The Deleted bin (20261027000400): what a delete would take with it, before it's done, and what's in the bin now.
 * Only who may delete for good sees either.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { rows, sql as raw } from '@hfos/db/client';
import { binItems, users } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { decodeTimeCursor, encodeCursor } from '../kernel/pagination';
import {
  BinListInput,
  BinListOutput,
  BinPreviewInput,
  BinPreviewOutput,
  type BinContents,
  type BinKind,
} from '../schemas/bin';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The counts as the database keeps them, with a booking's start as an ISO time. */
function contentsOf(raw: unknown): BinContents {
  const c = { ...((raw ?? {}) as Record<string, unknown>) };
  if (typeof c.startsAt === 'string') c.startsAt = new Date(c.startsAt).toISOString();
  return c as BinContents;
}

export const binPreview = defineQuery({
  name: 'bin.preview',
  description:
    'What deleting these customers, conversations or bookings would take with them, or why one can’t go yet.',
  input: BinPreviewInput,
  output: BinPreviewOutput,
  permission: 'records.delete',
  scope: inWorkspace,
  async handler(ctx, input) {
    const found = await rows<{
      record_id: string;
      name: string | null;
      contents: unknown;
      rule: string | null;
      message: string | null;
    }>(
      ctx.tx,
      raw`select * from private.bin_preview(${input.kind}, ${`{${input.ids.join(',')}}`}::uuid[])`,
    );
    return {
      items: found.map((f) => {
        // A booking still to come doesn't stop it: deleting cancels it first (contents.upcoming says how many).
        const stops = f.rule !== 'bin_upcoming_booking';
        return {
          id: f.record_id,
          name: f.name,
          contents: contentsOf(f.contents),
          rule: stops ? f.rule : null,
          message: stops ? f.message : null,
        };
      }),
    };
  },
});

export const binList = defineQuery({
  name: 'bin.list',
  description:
    'What’s in the Deleted bin, newest first: who deleted it, when, and when it empties for good.',
  input: BinListInput,
  output: BinListOutput,
  permission: 'records.delete',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeTimeCursor(input.cursor);
    const conditions = [eq(binItems.workspaceId, input.workspaceId)];
    // Keyed on (deleted_at, id) at full precision: several deleted at once share their now().
    if (cursor)
      conditions.push(
        sql`(${binItems.deletedAt}, ${binItems.id}) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)`,
      );
    const list = await ctx.tx
      .select({
        b: binItems,
        byName: sql<string | null>`coalesce(nullif(${users.fullName}, ''), ${users.email}::text)`,
        sortKey: sql<string>`to_char(${binItems.deletedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(binItems)
      .leftJoin(users, eq(users.id, binItems.deletedBy))
      .where(and(...conditions))
      .orderBy(desc(binItems.deletedAt), desc(binItems.id))
      .limit(input.limit + 1);
    const page = list.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ b, byName }) => ({
        id: b.id,
        kind: b.kind as BinKind,
        recordId: b.recordId,
        name: b.name,
        contents: contentsOf(b.contents),
        deletedBy: b.deletedBy ? { id: b.deletedBy, name: byName ?? 'Former member' } : null,
        deletedAt: b.deletedAt.toISOString(),
        purgeAfter: b.purgeAfter.toISOString(),
        emptying: b.purgingSince !== null,
      })),
      nextCursor:
        list.length > input.limit && last
          ? encodeCursor({ sort: last.sortKey, id: last.b.id })
          : null,
    };
  },
});

export const binQueries = [binPreview, binList];
