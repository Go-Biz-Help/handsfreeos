import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { WorkspaceDeleteInput, WorkspaceDeleteOutput } from '../schemas/workspace';

/**
 * Deleting a business and everything in it: its customers, messages, calls, calendars, money, workflows,
 * files and history. An owner asks here, with the business's name typed again; from that moment the business
 * is hidden from everybody (private.request_workspace_deletion). The worker's job then lets go of what lives
 * outside the database — the phone sub-account and its numbers, stored files, a connected payment account,
 * sending domains, a branded web address — and purges the rest (apps/worker/src/workspace/delete.ts). One line
 * in the organization's audit log is all that is left.
 */
export const workspaceDelete = defineCommand({
  name: 'workspace.delete',
  description:
    'Delete a business and everything in it — customers, messages, calls, calendars, invoices, workflows, files and its history. Its phone numbers are released. This cannot be undone. Only an owner can do it, and they type the business’s name to confirm.',
  risk: 4,
  input: WorkspaceDeleteInput,
  output: WorkspaceDeleteOutput,
  permission: 'workspace.delete',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['workspace.deletion_requested'],
  async handler(ctx, input) {
    const [ws] = await ctx.tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        organizationId: workspaces.organizationId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    if (!ws)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
    if (input.confirmName.trim().toLowerCase() !== ws.name.trim().toLowerCase())
      throw HfosError.validation([
        { path: 'confirmName', message: 'Type the business’s name exactly as it is shown.' },
      ]);
    // A record under a legal hold keeps the business (round six); the database refuses it too.
    const held = await rows<{ name: string }>(
      ctx.tx,
      sql`select r.name from app.record_holds h join app.custom_records r on r.id = h.custom_record_id
          where h.workspace_id = ${ws.id}::uuid and h.kind = 'legal' and h.lifted_at is null
          order by h.placed_at limit 3`,
    );
    if (held.length)
      throw HfosError.rule(
        'workspace_data_held',
        409,
        held.length === 1
          ? `${held[0]!.name} is under a legal hold, so ${ws.name} can’t be deleted. An owner or admin lifts the hold from its page first.`
          : `Records in ${ws.name} are under a legal hold (${held.map((h) => h.name).join(', ')}${held.length === 3 ? ' and maybe more' : ''}), so it can’t be deleted. An owner or admin lifts each hold from its page first.`,
      );
    // Recorded before the mark on purpose: once marked, nobody can write to the business, this event included.
    // The worker's job picks it up from here.
    await ctx.emit({
      type: 'workspace.deletion_requested',
      entityType: 'workspace',
      entityId: ws.id,
      payload: { name: ws.name },
      before: { name: ws.name },
      after: null,
    });
    const [marked] = await rows<{ requested_at: Date | string }>(
      ctx.tx,
      sql`select private.request_workspace_deletion(${ws.id}) as requested_at`,
    );
    if (!marked?.requested_at)
      throw HfosError.internal(
        'The deletion couldn’t be started just now. Nothing was deleted. Try again in a minute.',
      );
    return { workspaceId: ws.id, requestedAt: new Date(marked.requested_at).toISOString() };
  },
});
