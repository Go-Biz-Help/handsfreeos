/** Where HandsFreeOS support's access to a business's private records stands (Real Estate, step 4). */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import {
  SupportAccessListInput,
  SupportAccessListOutput,
  type SupportAccessStatus,
} from '../schemas/support-access';

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

export const supportAccessList = defineQuery({
  name: 'support_access.list',
  description:
    'HandsFreeOS support’s requests to see this business’s private records, and the access it has been given, newest first.',
  input: SupportAccessListInput,
  output: SupportAccessListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [can] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select private.can_let_support_in(${input.workspaceId}::uuid) as ok`,
    );
    const list = await rows<{
      id: string;
      status: SupportAccessStatus;
      expired: boolean;
      requested_by: string | null;
      requested_name: string | null;
      request_note: string | null;
      granted_by: string | null;
      granted_name: string | null;
      granted_at: string | null;
      expires_at: string | null;
      ended_at: string | null;
      created_at: string;
    }>(
      ctx.tx,
      sql`select g.id, g.status, (g.status = 'active' and g.expires_at <= now()) as expired,
            g.requested_by, coalesce(nullif(r.full_name, ''), r.email::text) as requested_name, g.request_note,
            g.granted_by, coalesce(nullif(u.full_name, ''), u.email::text) as granted_name,
            g.granted_at::text, g.expires_at::text, g.ended_at::text, g.created_at::text
          from app.record_support_grants g
          left join app.users r on r.id = g.requested_by
          left join app.users u on u.id = g.granted_by
          where g.workspace_id = ${input.workspaceId}::uuid
          order by g.created_at desc
          limit 50`,
    );
    return {
      canLetIn: can?.ok === true,
      items: list.map((g) => ({
        id: g.id,
        status: g.status,
        expired: g.expired,
        requestedBy: g.requested_by
          ? { id: g.requested_by, fullName: g.requested_name ?? 'HandsFreeOS support' }
          : null,
        requestNote: g.request_note,
        grantedBy: g.granted_by
          ? { id: g.granted_by, fullName: g.granted_name ?? 'Former member' }
          : null,
        grantedAt: iso(g.granted_at),
        expiresAt: iso(g.expires_at),
        endedAt: iso(g.ended_at),
        createdAt: new Date(g.created_at).toISOString(),
      })),
    };
  },
});
