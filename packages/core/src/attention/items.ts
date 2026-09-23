/**
 * Attention items as people see them (M8): who may decide an approval item, looked up in the database. The rest —
 * one stored row as the list, the banners and the commands show it — is browser-safe in `view.ts` (the phone ranks
 * its copy with it) and re-exported here. Server-only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import type { Grants } from '../permissions';
import type { AttentionItemRow } from './load';
import { mayDecideApproval, type AttentionViewer } from './view';

export {
  chipsOf,
  itemOut,
  mayAct,
  NO_HINTS,
  scorableOf,
  userIdsOf,
  visibleTo,
  type AttentionViewer,
  type ItemHints,
} from './view';

/**
 * The approvals (workflow approval steps and AI teammate drafts) this person may decide, by id: a workflow's by
 * the people it names or anyone who manages workflows; a teammate's reply draft by anyone in the inbox, what it
 * asks approval for by owners and admins. One they can't read isn't theirs to decide.
 */
export async function decidableApprovals(
  tx: Tx,
  workspaceId: string,
  who: Grants,
  userId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const list = await rows<{
    id: string;
    source: 'workflow' | 'teammate';
    approvers: string[] | null;
    kind: string | null;
  }>(
    tx,
    sql`select id, 'workflow' as source, approvers, null as kind from app.workflow_approvals
        where workspace_id = ${workspaceId} and id = any(${uuidArray(ids)})
        union all
        select id, 'teammate', array[]::uuid[], kind from app.ai_teammate_drafts
        where workspace_id = ${workspaceId} and id = any(${uuidArray(ids)})`,
  );
  for (const a of list) {
    if (mayDecideApproval(who, userId, a)) out.add(a.id);
  }
  return out;
}

/** The viewer for a set of rows: their approval items are looked up once. */
export async function viewerFor(
  tx: Tx,
  workspaceId: string,
  who: Grants,
  userId: string,
  items: readonly Pick<AttentionItemRow, 'kind' | 'subjectId'>[],
): Promise<AttentionViewer> {
  const ids = items.filter((i) => i.kind === 'ai_approval').map((i) => i.subjectId);
  return {
    userId,
    role: who.role,
    permissions: who.permissions ?? null,
    decidable: await decidableApprovals(tx, workspaceId, who, userId, ids),
  };
}
