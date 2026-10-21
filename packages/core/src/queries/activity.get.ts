import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { ActivityGetInput, ActivityGetOutput } from '../schemas/activity';
import { RECORD_READS } from '../search/server/sql';
import { TIMELINE_COLUMNS, timelineEntryOf, type TimelineRow } from './timeline.list';

/**
 * One timeline line, as the timeline shows it: what a search result's `?activity=<id>` opens over the record's page
 * (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web: where a result opens"). Row security decides, sealing included;
 * a line on a record of the business's own kinds also needs that record to read, so a turned-off add-on's lines stay
 * hidden here as they do in search.
 */
export const activityGet = defineQuery({
  name: 'activity.get',
  description: 'One entry on a timeline: a note, a call, a visit or anything else that happened.',
  input: ActivityGetInput,
  output: ActivityGetOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await rows<TimelineRow>(
      ctx.tx,
      sql`select ${TIMELINE_COLUMNS}
          from app.activities a
          left join app.users u on u.id = a.author_user_id
          where a.id = ${input.activityId} and a.workspace_id = ${input.workspaceId}
            and ${RECORD_READS(sql`a.custom_record_id`)}`,
    );
    if (!row)
      throw HfosError.notFound(
        'That timeline entry isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    return { activity: timelineEntryOf(row) };
  },
});
