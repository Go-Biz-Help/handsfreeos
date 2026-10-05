/** The holds on a record, or on every record in a business the person sees (Real Estate round six). */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import { RecordHoldListInput, RecordHoldListOutput } from '../schemas/record-hold';

export const recordHoldList = defineQuery({
  name: 'record_hold.list',
  description:
    'The holds on a record (or on every record you see here): legal holds with who placed them and why, and how long closed records are kept.',
  input: RecordHoldListInput,
  output: RecordHoldListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const found = await rows<{
      id: string;
      custom_record_id: string;
      name: string;
      kind: 'legal' | 'retention';
      held_until: Date | string | null;
      reason: string | null;
      placed_by: string | null;
      placed_name: string | null;
      placed_at: Date | string;
    }>(
      ctx.tx,
      sql`select h.id, h.custom_record_id, r.name, h.kind, h.held_until, h.reason, h.placed_by,
            coalesce(nullif(u.full_name, ''), u.email::text) as placed_name, h.placed_at
          from app.record_holds h
          join app.custom_records r on r.id = h.custom_record_id
          left join app.users u on u.id = h.placed_by
          where h.workspace_id = ${input.workspaceId}::uuid and h.lifted_at is null
            and (h.kind = 'legal' or h.held_until is null or h.held_until > now())
            ${input.customRecordId ? sql`and h.custom_record_id = ${input.customRecordId}::uuid` : sql``}
            ${input.kind ? sql`and h.kind = ${input.kind}` : sql``}
          order by h.kind, h.placed_at desc
          limit 500`,
    );
    return {
      holds: found.map((h) => ({
        id: h.id,
        customRecordId: h.custom_record_id,
        recordName: h.name,
        kind: h.kind,
        heldUntil: h.held_until ? new Date(h.held_until).toISOString() : null,
        reason: h.reason,
        placedBy: h.placed_by
          ? { id: h.placed_by, fullName: h.placed_name ?? 'Former member' }
          : null,
        placedAt: new Date(h.placed_at).toISOString(),
      })),
    };
  },
});

export const recordHoldQueries = [recordHoldList];
