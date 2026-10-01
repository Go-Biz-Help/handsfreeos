/**
 * Viewing the app as a teammate (20261016000200). Opening a view is all these do: what makes a request read as the
 * teammate is the kernel, once the request names a view that private.teammate_view() says is the caller's and still
 * holds. Both run outside the business (account scope), so they work while the viewer is in a view, in a support look
 * or in the founder's session, none of which may change the business itself.
 *
 * Someone in the business may view as a teammate below them who can do nothing they can't (members.view_as).
 * HandsFreeOS, with the business open, may view as anyone in it. The database decides (private.may_view_as(), in the
 * insert's own policy); the questions asked first only find the words for a refusal.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { teammateViews } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  CUSTOMIZABLE_PERMISSIONS,
  ROLE_LABELS,
  roleRank,
  type WorkspaceRole,
} from '../permissions';
import {
  TeammateViewEndInput,
  TeammateViewEndOutput,
  TeammateViewStartInput,
  TeammateViewStartOutput,
  type TeammateViewBy,
} from '../schemas/teammate-view';

const account = () => ({ kind: 'account' as const });

/** Someone's name as a screen would say it: their name, else their email. */
const nameOf = (p: { readonly fullName: string | null; readonly email: string }): string =>
  p.fullName?.trim() || p.email;

/** How the caller reaches a business: their own role there, and whether HandsFreeOS has it open (and how). */
export async function howTheyReach(
  tx: Tx,
  workspaceId: string,
): Promise<{
  readonly org: string | null;
  readonly role: WorkspaceRole | null;
  readonly permissions: readonly string[];
  readonly by: TeammateViewBy | null;
}> {
  const [row] = await rows<{
    org: string | null;
    role: WorkspaceRole | null;
    permissions: string[] | null;
    session: string | null;
    acts: boolean | null;
  }>(
    tx,
    sql`select private.workspace_organization(${workspaceId}::uuid) as org,
               private.my_workspace_role(${workspaceId}::uuid) as role,
               private.my_permissions(${workspaceId}::uuid) as permissions,
               m.session_id as session,
               (select v.acts from platform.view_as_sessions v where v.id = m.session_id) as acts
        from (select 1) one
        left join lateral (select session_id from private.my_view_as(${workspaceId}::uuid) limit 1) m on true`,
  );
  const open = row?.session ? (row.acts ? 'founder' : 'support') : null;
  return {
    org: row?.org ?? null,
    role: row?.role ?? null,
    permissions: row?.permissions ?? [],
    // HandsFreeOS with it open views as HandsFreeOS, whatever else they are; anyone else is on its team.
    by: open ?? (row?.role ? 'team' : null),
  };
}

export const teammateViewStart = defineCommand({
  name: 'teammate_view.start',
  description:
    'Start viewing the app as a teammate below you: read-only, until you stop. Written in the business’s audit log. HandsFreeOS support and the founder, with the business open, may view as anyone in it.',
  risk: 2,
  input: TeammateViewStartInput,
  output: TeammateViewStartOutput,
  permission: null,
  scope: account,
  // HandsFreeOS's views belong to no business, so they're platform events the worker reads with no tenant scope.
  emits: ['teammate_view.started', 'platform.teammate_view_started'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const reach = await howTheyReach(ctx.tx, input.workspaceId);
    if (!reach.org || !reach.by)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
    if (input.userId === me)
      throw HfosError.validation(
        [{ path: 'userId', message: 'That’s you. Pick someone else on the team.' }],
        'That’s you. Pick someone else on the team to view as.',
      );
    const [person] = await rows<{
      full_name: string | null;
      email: string;
      role: WorkspaceRole | null;
      permissions: string[] | null;
      works_here: boolean;
    }>(
      ctx.tx,
      sql`select u.full_name, u.email::text as email,
                 private.user_workspace_role(u.id, ${input.workspaceId}::uuid) as role,
                 (select p.permissions from private.workspace_member_permissions(${input.workspaceId}::uuid) p
                  where p.user_id = u.id) as permissions,
                 private.works_in(u.id, ${input.workspaceId}::uuid) as works_here
          from app.users u where u.id = ${input.userId}::uuid`,
    );
    if (!person?.works_here || !person.role)
      throw HfosError.notFound(
        'That person isn’t on this business’s team anymore. Refresh Members and pick someone again.',
      );
    const name = nameOf({ fullName: person.full_name, email: person.email });
    if (reach.by === 'team') {
      if (!reach.permissions.includes('members.view_as'))
        throw HfosError.forbidden(
          'Viewing the app as someone is turned off for you here. An owner of this business can turn on “View the app as someone” for you in Settings → Permissions.',
          'teammate_view_not_allowed',
        );
      if (roleRank(person.role) >= roleRank(reach.role))
        throw HfosError.forbidden(
          person.role === 'owner'
            ? `${name} is an owner, and nobody in the business can view as an owner. If something looks wrong for them, HandsFreeOS support can check from Get help.`
            : `You can view as someone whose role is below yours, and ${name} is ${person.role === 'admin' ? 'an' : 'a'} ${ROLE_LABELS[person.role]} here, like you. Ask an owner of this business to view as them instead.`,
          'teammate_view_rank',
        );
      const beyond = (person.permissions ?? []).filter((p) => !reach.permissions.includes(p));
      if (beyond.length > 0) {
        const labels = beyond
          .map((p) => CUSTOMIZABLE_PERMISSIONS.find((c) => c.permission === p)?.label ?? p)
          .slice(0, 3);
        throw HfosError.forbidden(
          `${name} can do things here you can’t (${labels.join(', ')}), so viewing as them would show you more than you can see. Ask an owner of this business to view as them instead.`,
          'teammate_view_beyond',
        );
      }
    }
    // One at a time in a business: the last one ends as this one opens.
    const now = new Date();
    await ctx.tx
      .update(teammateViews)
      .set({ endedAt: now })
      .where(
        and(
          eq(teammateViews.viewerId, me),
          eq(teammateViews.workspaceId, input.workspaceId),
          isNull(teammateViews.endedAt),
        ),
      );
    const [view] = await ctx.tx
      .insert(teammateViews)
      .values({
        workspaceId: input.workspaceId,
        organizationId: reach.org,
        viewerId: me,
        personId: input.userId,
      })
      .returning({ id: teammateViews.id, startedAt: teammateViews.startedAt });
    // Someone in the business: in its own audit log, under their name. Support: the worker tells the business as it
    // does of the look, in the words read here, where both names can be read. The founder: nobody, as with their
    // session.
    const inTheBusiness = reach.by === 'team';
    const [staffer] =
      reach.by === 'support'
        ? await rows<{ name: string }>(
            ctx.tx,
            sql`select coalesce(nullif(s.display_name, ''), nullif(u.full_name, ''), u.email::text) as name
                from platform.staff s join app.users u on u.id = s.user_id where s.user_id = ${me}::uuid`,
          )
        : [];
    await ctx.emit({
      type: inTheBusiness ? 'teammate_view.started' : 'platform.teammate_view_started',
      entityType: 'teammate_view',
      entityId: view!.id,
      organizationId: inTheBusiness ? reach.org : null,
      workspaceId: inTheBusiness ? input.workspaceId : null,
      payload: {
        viewId: view!.id,
        workspaceId: input.workspaceId,
        organizationId: reach.org,
        personId: input.userId,
        by: reach.by,
        ...(staffer ? { staff: staffer.name, person: name } : {}),
      },
      after: { person: name, role: person.role, readOnly: true },
      broadcast: false,
    });
    return {
      view: {
        id: view!.id,
        workspaceId: input.workspaceId,
        person: {
          userId: input.userId,
          fullName: person.full_name ?? '',
          email: person.email,
          role: person.role,
        },
        by: reach.by,
        startedAt: view!.startedAt.toISOString(),
      },
    };
  },
});

export const teammateViewEnd = defineCommand({
  name: 'teammate_view.end',
  description:
    'Stop viewing the app as a teammate: one view, the one open in a business, or every one you have open.',
  risk: 1,
  input: TeammateViewEndInput,
  output: TeammateViewEndOutput,
  permission: null,
  scope: account,
  emits: ['teammate_view.ended'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ended = await ctx.tx
      .update(teammateViews)
      .set({ endedAt: new Date() })
      .where(
        and(
          eq(teammateViews.viewerId, me),
          isNull(teammateViews.endedAt),
          ...(input.viewId ? [eq(teammateViews.id, input.viewId)] : []),
          ...(input.workspaceId ? [eq(teammateViews.workspaceId, input.workspaceId)] : []),
        ),
      )
      .returning({ id: teammateViews.id, workspaceId: teammateViews.workspaceId });
    for (const v of ended)
      await ctx.emit({
        type: 'teammate_view.ended',
        entityType: 'teammate_view',
        entityId: v.id,
        organizationId: null,
        workspaceId: null,
        payload: { viewId: v.id, workspaceId: v.workspaceId },
        broadcast: false,
      });
    return { ended: ended.length };
  },
});

export const teammateViewCommands = [teammateViewStart, teammateViewEnd];
