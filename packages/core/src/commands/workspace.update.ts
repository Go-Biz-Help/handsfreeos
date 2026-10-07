import { eq } from 'drizzle-orm';
import { workspaces } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { lookOf, lookSearchDue } from '../look/look';
import { WorkspaceUpdateInput, WorkspaceUpdateOutput } from '../schemas/workspace';
import { askForLogo } from './look';

export const workspaceUpdate = defineCommand({
  name: 'workspace.update',
  description: 'Change a workspace name, time zone, industry or settings.',
  risk: 2,
  input: WorkspaceUpdateInput,
  output: WorkspaceUpdateOutput,
  permission: 'workspace.update',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['workspace.updated', 'look.find_requested'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    if (!current)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
    const patch: Partial<typeof current> = {};
    if (input.name !== undefined && input.name !== current.name) patch.name = input.name;
    if (input.timezone !== undefined && input.timezone !== current.timezone)
      patch.timezone = input.timezone;
    if (input.industry !== undefined && input.industry !== current.industry)
      patch.industry = input.industry;
    if (input.settings !== undefined) patch.settings = { ...current.settings, ...input.settings };
    const updated = Object.keys(patch);
    if (updated.length === 0) return { workspaceId: current.id, updated: [] };
    const [row] = await ctx.tx
      .update(workspaces)
      .set(patch)
      .where(eq(workspaces.id, current.id))
      .returning({ id: workspaces.id });
    if (!row) throw HfosError.forbidden();
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as Record<string, unknown>)[k];
      after[k] = (patch as Record<string, unknown>)[k];
    }
    await ctx.emit({
      type: 'workspace.updated',
      entityType: 'workspace',
      entityId: current.id,
      payload: { fields: updated },
      before,
      after,
    });
    // A new website is looked at for the logo, while the business has none (look/look.ts).
    const settings = (patch.settings ?? {}) as Record<string, unknown>;
    const website = settings['website'];
    const was = (current.settings ?? {}) as Record<string, unknown>;
    if (typeof website === 'string' && website && website !== was['website']) {
      const look = lookOf(settings);
      if (lookSearchDue(look, website, new Date())) await askForLogo(ctx, look, website);
    }
    return { workspaceId: current.id, updated };
  },
});
