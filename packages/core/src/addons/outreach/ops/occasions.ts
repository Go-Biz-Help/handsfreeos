/**
 * Birthdays and new jobs read on the person's computer (../occasions.ts, docs/outreach.md decision 108): kept for
 * today, among the people already kept, each person's own. Today's pick of them is in ./today.ts. Server-only.
 */
import { sql } from 'drizzle-orm';
import { workspaceTimezone } from '../../../crm/records';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import { outreachAddon } from '../manifest';
import { OCCASIONS_ON, OccasionsSaveInput, OccasionsSaveOutput } from '../occasions';
import { inWorkspace, profilesFor } from './common';
import { tally } from './tallies';

export const occasionsSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.occasions.save',
  description:
    'The person’s computer read Facebook’s Birthdays page or LinkedIn’s Catch up, once a day: whose birthday it is today, or who started a new job. Those among the people already kept are kept for today, the person’s own; nobody new is added. Today offers a note to the ones they’ve chatted with or who fit a playbook, and it always waits for their OK.',
  risk: 0,
  input: OccasionsSaveInput,
  output: OccasionsSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.occasions.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const zone = await workspaceTimezone(ctx.tx, ws);
    const shown = OCCASIONS_ON[input.platform];
    let kept = 0;
    let left = 0;
    for (const o of input.occasions) {
      const [profile] = shown.includes(o.kind)
        ? await profilesFor(ctx, input.platform, o.profile)
        : [];
      if (!profile) {
        left += 1;
        continue;
      }
      // Seen again the same day: kept once, its words the latest.
      await ctx.tx.execute(
        sql`insert into addon_outreach.occasions (workspace_id, user_id, profile_id, kind, on_day, detail, seen_at)
            values (${ws}, ${me}, ${profile.id}, ${o.kind},
              (${at.toISOString()}::timestamptz at time zone ${zone})::date, ${o.detail},
              ${at.toISOString()}::timestamptz)
            on conflict (workspace_id, user_id, profile_id, kind, on_day)
            do update set detail = coalesce(excluded.detail, addon_outreach.occasions.detail)`,
      );
      kept += 1;
    }
    // Each birthday or piece of news read counts (decision 140).
    await tally(ctx, me, input.platform, 'occasion', kept, at);
    await ctx.emit({
      type: 'outreach.occasions.saved',
      entityType: 'workspace',
      entityId: ws,
      payload: { platform: input.platform, kept, left },
    });
    return { kept, left };
  },
});

export const occasionCommands = [occasionsSave] as const;
