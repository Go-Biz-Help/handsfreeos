import {
  emptyKnowledgeProfile,
  formatPhone,
  KnowledgeProfile,
  type KnowledgeBusiness,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';

/** What every grounded AI call starts from: the business profile and the business itself. */
export interface Grounding {
  readonly profile: KnowledgeProfile;
  readonly business: KnowledgeBusiness;
}

/**
 * The business profile (its allow_prices column wins over the document's copy, as knowledge.profile reads
 * it) and the business: its name, its main number and its website. Read in a transaction scoped to the
 * workspace (asWorker). Website scans, Try it, and next workflow AI steps and the Assistant use it.
 */
export async function loadGrounding(tx: Tx, workspaceId: string): Promise<Grounding> {
  const [row] = await rows<{
    name: string;
    profile: unknown;
    allow_prices: boolean | null;
    website: string | null;
    phone: string | null;
  }>(
    tx,
    sql`select w.name, p.profile, p.allow_prices, s.url as website,
          (select n.e164 from app.phone_numbers n where n.workspace_id = w.id and n.status = 'active'
            order by n.created_at, n.id limit 1) as phone
        from app.workspaces w
        left join app.knowledge_profiles p on p.workspace_id = w.id
        left join app.knowledge_sources s on s.workspace_id = w.id
        where w.id = ${workspaceId}`,
  );
  if (!row) throw new Error(`workspace ${workspaceId} is not visible in this scope`);
  const parsed = KnowledgeProfile.safeParse(row.profile ?? {});
  return {
    profile: {
      ...(parsed.success ? parsed.data : emptyKnowledgeProfile()),
      allowPrices: row.allow_prices ?? false,
    },
    business: {
      name: row.name,
      phone: row.phone ? formatPhone(row.phone) : null,
      website: row.website,
    },
  };
}
