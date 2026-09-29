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
 * reads — is the database's, through the `workspaces_inbox_switch` trigger, which calls
 * `private.inbox_repaint_access` and `private.inbox_repaint_workspace` the moment the setting moves.
 *
 * **The trigger, not this handler, is what does it.** The first run of these migrations against a real
 * database showed why: the Assistant's settings tools write `workspaces.settings` too, and so does a support
 * fix. Repainting here only would mean the switch could be flipped by any of those paths with nothing
 * re-labelled — a business told its team sees only their own threads while the database still shows them
 * everything. A promise about who can read a customer's messages cannot depend on which path moved the flag.
 *
 * **It happens in the same transaction as the flip**, rather than in a job, because the half-way state is a
 * business whose members can see nothing at all: the policies switch the moment the setting is written and
 * the lists are still empty. Seconds of that is a support call. So the size is checked here **before**
 * anything is written, and a business too large for one transaction is told so plainly and left untouched.
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
    if (!w)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
    const stored = (w.settings ?? {}) as Record<string, unknown>;
    const inbox = (stored['inbox'] ?? {}) as Record<string, unknown>;
    const was = inbox['perPerson'] === true;
    if (was === input.perPerson) return { perPerson: was, conversationsChanged: 0 };

    // Before the write, not after: the trigger repaints everything the moment the setting moves, so a
    // business too big to do in one transaction has to be turned away while nothing has happened yet.
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.conversations where workspace_id = ${ws}`,
    );
    const conversations = Number(count?.n ?? 0);
    if (conversations > INBOX_REPAINT_LIMIT)
      throw HfosError.rule(
        'inbox_repaint_too_large',
        409,
        `This business has ${conversations.toLocaleString()} conversations, which is too many to change in one go. Nothing was changed. Ask HandsFreeOS support to make the change for you, through Get help in the sidebar.`,
      );

    const [row] = await ctx.tx
      .update(workspaces)
      .set({ settings: { ...stored, inbox: { ...inbox, perPerson: input.perPerson } } })
      .where(eq(workspaces.id, ws))
      .returning({ id: workspaces.id });
    if (!row) throw HfosError.forbidden();
    // `workspaces_inbox_switch` has now repainted every access row and every thread, in this transaction.

    await ctx.emit({
      type: 'inbox.visibility_changed',
      entityType: 'workspace',
      entityId: ws,
      payload: { perPerson: input.perPerson },
      before: { inbox: was ? 'each person sees their own' : 'everyone sees everything' },
      after: { inbox: input.perPerson ? 'each person sees their own' : 'everyone sees everything' },
    });
    return { perPerson: input.perPerson, conversationsChanged: conversations };
  },
});

export const inboxVisibilityCommands = [inboxSetVisibility];
