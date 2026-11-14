/**
 * Admin → Try onboarding's list (20261027027200): the practice businesses you have going, with when each goes.
 */
import { rows, sql } from '@hfos/db/client';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { PracticeListInput, PracticeListOutput } from '../schemas/practice';

export const practiceList = defineQuery({
  name: 'practice.list',
  description:
    'Admin → Try onboarding: the practice businesses you have going, newest first, with when each is deleted.',
  input: PracticeListInput,
  output: PracticeListOutput,
  permission: 'platform.practice.use',
  scope: () => ({ kind: 'platform' as const }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    // A business being deleted is hidden from everybody (0093), so one on its way out comes back with none.
    const found = await rows<{
      organization_id: string;
      workspace_id: string | null;
      name: string;
      created_at: Date | string;
      ends_at: Date | string;
    }>(
      ctx.tx,
      sql`select o.id as organization_id, w.id as workspace_id, coalesce(w.name, o.name) as name,
            o.created_at, o.practice_ends_at as ends_at
          from app.organizations o
          left join app.workspaces w on w.organization_id = o.id and w.deletion_requested_at is null
          where o.practice_by = ${me}::uuid and o.practice_ends_at is not null
          order by o.created_at desc`,
    );
    return {
      businesses: found.map((b) => ({
        organizationId: b.organization_id,
        workspaceId: b.workspace_id,
        name: b.name,
        createdAt: new Date(b.created_at).toISOString(),
        endsAt: new Date(b.ends_at).toISOString(),
        ending: !b.workspace_id,
      })),
    };
  },
});

export const practiceQueries = [practiceList];
