/**
 * Admin → Try onboarding's list (20261027027400): the practice businesses you have going, with when each goes.
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
    requireHuman(ctx);
    // A business being deleted is hidden from everybody (0093), so one on its way out comes back with none. One you
    // were invited to join is listed before you're in it, which row security alone wouldn't show.
    const found = await rows<{
      organization_id: string;
      workspace_id: string | null;
      name: string;
      created_at: Date | string;
      ends_at: Date | string;
      joined: boolean;
      invited: boolean;
    }>(ctx.tx, sql`select * from private.practice_mine()`);
    return {
      businesses: found.map((b) => ({
        organizationId: b.organization_id,
        workspaceId: b.workspace_id,
        name: b.name,
        createdAt: new Date(b.created_at).toISOString(),
        endsAt: new Date(b.ends_at).toISOString(),
        ending: !b.workspace_id,
        joined: b.joined,
        invited: b.invited,
      })),
    };
  },
});

export const practiceQueries = [practiceList];
