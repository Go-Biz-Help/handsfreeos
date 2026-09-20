/**
 * Who sees which threads (M17).
 *
 * One switch per business, off by default, and off is exactly how the inbox has always worked. On, a member
 * sees the threads assigned to them and the threads on the numbers they answer; a thread nobody owns yet is
 * still seen by everybody, because a customer writing in for the first time must not vanish. Owners and
 * admins always see all of it.
 *
 * **The switch is the only thing this command writes.** Everything that follows from it — every thread's list
 * of members, every message, call and attention item that follows its thread, and the row each phone's sync
 * reads — is the database's, through `private.inbox_repaint_workspace` and `private.inbox_repaint_access`.
 * That is deliberate: the same repaint runs when a person's role changes or a number's people change, so
 * there is one implementation of the rule and not two.
 *
 * **It repaints in the same transaction as the flip**, rather than handing it to a job, because the half-way
 * state is a business whose members can see nothing at all: the policies switch the moment the setting is
 * written and the lists are still empty. Seconds of that is a support call. So the repaint is bounded instead,
 * and a business too large for one transaction is told so plainly.
 */
import { eq, sql } from 'drizzle-orm';
import { workspaces } from '@hfos/db/schema';
import { rows } from '@hfos/db/client';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { InboxSetVisibilityInput, InboxSetVisibilityOutput } from '../schemas/inbox-visibility';

/** As many threads as one transaction repaints. Past it, we run it for the business by hand. */
export const INBOX_REPAINT_LIMIT = 20_000;

export const inboxSetVisibility = defineCommand({
  name: 'inbox.set_visibility',
  description:
    'Choose whether everyone in the business sees every conversation, or each person sees only the ones assigned to them and the ones on the numbers they answer.',
  // A three, not a two: it changes what people can see, on the web and on their phones at once, and the
  // phones drop what they no longer see.
  risk: 3,
  input: InboxSetVisibilityInput,
  output: InboxSetVisibilityOutput,
  // The same permission as deciding which numbers a business has and who they ring, which is the other half
  // of the same question. No new permission, so packages/core/src/permissions.ts and app.role_permissions
  // stay in step untouched.
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['inbox.visibility_changed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (!w) throw HfosError.notFound('Workspace not found.');
    const stored = (w.settings ?? {}) as Record<string, unknown>;
    const inbox = (stored['inbox'] ?? {}) as Record<string, unknown>;
    const was = inbox['perPerson'] === true;
    if (was === input.perPerson) return { perPerson: was, conversationsChanged: 0 };

    const [row] = await ctx.tx
      .update(workspaces)
      .set({ settings: { ...stored, inbox: { ...inbox, perPerson: input.perPerson } } })
      .where(eq(workspaces.id, ws))
      .returning({ id: workspaces.id });
    if (!row) throw HfosError.forbidden();

    // In this order: the access rows first, so no phone is briefly told it sees everything while the lists
    // already say otherwise. Both are security definer — a person may not write either by hand.
    await rows(ctx.tx, sql`select private.inbox_repaint_access(${ws})`);
    const [painted] = await rows<{ inbox_repaint_workspace: number }>(
      ctx.tx,
      sql`select private.inbox_repaint_workspace(${ws}, ${INBOX_REPAINT_LIMIT})`,
    );

    await ctx.emit({
      type: 'inbox.visibility_changed',
      entityType: 'workspace',
      entityId: ws,
      payload: { perPerson: input.perPerson },
      before: { inbox: was ? 'each person sees their own' : 'everyone sees everything' },
      after: { inbox: input.perPerson ? 'each person sees their own' : 'everyone sees everything' },
    });
    return {
      perPerson: input.perPerson,
      conversationsChanged: Number(painted?.inbox_repaint_workspace ?? 0),
    };
  },
});

export const inboxVisibilityCommands = [inboxSetVisibility];
