/**
 * The business's postal address, for anything a customer is shown that must carry it: a quote or invoice, and
 * every campaign email (CAN-SPAM). The one they typed in Settings → Payments; failing that, the address the
 * onboarding setup asked for; failing that, the first calendar that says where "at our place" is, which is the
 * same string the booking page already shows customers. Null when they have given none.
 */
import { eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { loadMoneySettings } from '../commands/money-shared';
import { addressLines, businessAddressOf } from '../onboarding-setup/address';

export async function businessPostalAddress(tx: Tx, workspaceId: string): Promise<string | null> {
  const settings = await loadMoneySettings(tx, workspaceId);
  const typed = settings.businessAddress.trim();
  if (typed) return typed;
  const [ws] = await tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const asked = businessAddressOf((ws?.settings ?? {}) as Record<string, unknown>);
  if (asked) return addressLines(asked);
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
