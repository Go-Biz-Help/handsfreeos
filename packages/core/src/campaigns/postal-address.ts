/**
 * The business's postal address, for anything a customer is shown that must carry it: a quote or invoice, and
 * every campaign email (CAN-SPAM). The one they typed in Settings → Payments; failing that, the first calendar
 * that says where "at our place" is, which is the same string the booking page already shows customers. Null
 * when they have given neither, and never parsed into parts.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { loadMoneySettings } from '../commands/money-shared';

export async function businessPostalAddress(tx: Tx, workspaceId: string): Promise<string | null> {
  const settings = await loadMoneySettings(tx, workspaceId);
  const typed = settings.businessAddress.trim();
  if (typed) return typed;
  const [place] = await rows<{ address: string | null }>(
    tx,
    sql`select opt ->> 'address' as address
        from app.calendars c,
          lateral jsonb_array_elements(coalesce(c.config -> 'locations' -> 'options', '[]'::jsonb)) as opt
        where c.workspace_id = ${workspaceId} and c.status <> 'archived'
          and opt ->> 'kind' = 'business' and length(btrim(coalesce(opt ->> 'address', ''))) > 0
        order by c.created_at, c.id
        limit 1`,
  );
  return place?.address?.trim() || null;
}
