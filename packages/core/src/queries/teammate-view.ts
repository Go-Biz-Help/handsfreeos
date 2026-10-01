/**
 * Viewing the app as a teammate (20261018000100): whether a view is open, and what the phone needs to show its copy
 * of the business through one.
 */
import { rows, sql } from '@hfos/db/client';
import { howTheyReach } from '../commands/teammate-view';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import type { WorkspaceRole } from '../permissions';
import {
  TeammateViewCurrentInput,
  TeammateViewCurrentOutput,
  TeammateViewLensInput,
  TeammateViewLensOutput,
} from '../schemas/teammate-view';

/** As many threads or bills as a lens lists; a narrowed teammate's own are far fewer. */
const LENS_LIMIT = 5000;

export const teammateViewCurrent = defineQuery({
  name: 'teammate_view.current',
  description:
    'The view you have open in a business, while it still holds; null when there is none, it has ended, or you may no longer view as that person.',
  input: TeammateViewCurrentInput,
  output: TeammateViewCurrentOutput,
  permission: null,
  // Asked about the viewer, never through the view: account scope is never read as anyone else.
  scope: () => ({ kind: 'account' }),
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [row] = await rows<{
      id: string;
      started_at: Date | string;
      person_id: string;
      person_email: string;
      person_name: string | null;
      person_role: WorkspaceRole | null;
      live: boolean;
    }>(
      ctx.tx,
      sql`select v.id, v.started_at, t.person_id, t.person_email, t.person_name, t.person_role, t.live
          from app.teammate_views v
          cross join lateral private.teammate_view(v.id) t
          where v.viewer_id = ${me}::uuid and v.workspace_id = ${input.workspaceId}::uuid and v.ended_at is null
          order by v.started_at desc
          limit 1`,
    );
    if (!row?.live || !row.person_role) return { view: null };
    const reach = await howTheyReach(ctx.tx, input.workspaceId);
    return {
      view: {
        id: row.id,
        workspaceId: input.workspaceId,
        person: {
          userId: row.person_id,
          fullName: row.person_name ?? '',
          email: row.person_email,
          role: row.person_role,
        },
        by: reach.by ?? 'team',
        startedAt: new Date(row.started_at).toISOString(),
      },
    };
  },
});

export const teammateViewLens = defineQuery({
  name: 'teammate_view.lens',
  description:
    'Through a view: the teammate’s role and permissions, and the threads, Action Center items and bills they see where that is fewer than the whole business. The phone shows its copy through it.',
  input: TeammateViewLensInput,
  output: TeammateViewLensOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    if (!ctx.scope.teammateView)
      throw HfosError.notFound(
        'You’re not viewing as anyone in this business. Pick someone on Members to view as, or refresh if you just stopped.',
      );
    // Read through the view: the actor, the rules and the scope are all the teammate's.
    const them = requireHuman(ctx);
    const permissions = [...(ctx.scope.workspacePermissions ?? [])];
    const ws = input.workspaceId;
    const [who] = await rows<{ full_name: string | null; narrowed: boolean }>(
      ctx.tx,
      sql`select u.full_name, coalesce(private.inbox_narrowed(${ws}::uuid), false) as narrowed
          from app.users u where u.id = ${them.userId}::uuid`,
    );
    const ids = async (query: ReturnType<typeof sql>): Promise<string[]> =>
      (await rows<{ id: string }>(ctx.tx, query)).map((r) => r.id);
    const narrowed = who?.narrowed === true;
    const managesMoney = permissions.includes('money.manage');
    const readsMoney = permissions.includes('money.read');
    return {
      person: {
        userId: them.userId,
        fullName: who?.full_name ?? '',
        email: them.email,
        role: ctx.scope.workspaceRole ?? 'member',
        permissions,
      },
      conversationIds: narrowed
        ? await ids(
            sql`select id from app.conversations where workspace_id = ${ws}::uuid
                order by last_message_at desc nulls last limit ${LENS_LIMIT}`,
          )
        : null,
      attentionItemIds: narrowed
        ? await ids(
            sql`select id from app.attention_items
                where workspace_id = ${ws}::uuid and state in ('open', 'snoozed', 'handled', 'dismissed')
                limit ${LENS_LIMIT}`,
          )
        : null,
      estimateIds: managesMoney
        ? null
        : readsMoney
          ? await ids(
              sql`select id from app.estimates where workspace_id = ${ws}::uuid
                  order by created_at desc limit ${LENS_LIMIT}`,
            )
          : [],
      invoiceIds: managesMoney
        ? null
        : readsMoney
          ? await ids(
              sql`select id from app.invoices where workspace_id = ${ws}::uuid
                  order by created_at desc limit ${LENS_LIMIT}`,
            )
          : [],
    };
  },
});

export const teammateViewQueries = [teammateViewCurrent, teammateViewLens];
