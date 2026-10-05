/**
 * The Action Center's loader for add-on alerts (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md step 5): the rows of
 * app.addon_alerts still raised, and any named whatever their state, so their cards can close. Server-only, beside
 * load.ts.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import type { AddonAlertSeverity } from './detectors/addon-alert';
import type { AttentionFacts } from './registry';

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

export interface AddonAlertInfo {
  readonly facts: AttentionFacts<'addon_alert'>;
  readonly addonId: string;
  readonly personId: string | null;
  readonly title: string;
  readonly detail: string | null;
  /** Why the add-on cleared it (done, waived, addon_off), once it has. */
  readonly clearReason: string | null;
}

export async function loadAddonAlerts(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
): Promise<Map<string, AddonAlertInfo>> {
  if (!all && ids.length === 0) return new Map();
  const found = await rows<{
    id: string;
    addon_id: string;
    person_id: string | null;
    severity: AddonAlertSeverity;
    title: string;
    detail: string | null;
    assignee_user_id: string | null;
    due_at: Date | string | null;
    needs_ack: boolean;
    acknowledged_at: Date | string | null;
    fingerprint: string;
    raised_at: Date | string;
    cleared_at: Date | string | null;
    clear_reason: string | null;
    running: boolean;
  }>(
    tx,
    sql`select a.id, a.addon_id, a.person_id, a.severity, a.title, a.detail, a.assignee_user_id, a.due_at,
          a.needs_ack, a.acknowledged_at, a.fingerprint, a.raised_at, a.cleared_at, a.clear_reason,
          private.addon_in_use(a.workspace_id, a.addon_id, false) as running
        from app.addon_alerts a
        where a.workspace_id = ${workspaceId}
          and (a.id = any(${uuidArray([...ids])}) or (${all} and a.cleared_at is null))`,
  );
  const out = new Map<string, AddonAlertInfo>();
  for (const a of found)
    out.set(a.id, {
      facts: {
        alert: {
          id: a.id,
          severity: a.severity,
          raisedAt: iso(a.raised_at)!,
          dueAt: iso(a.due_at),
          needsAck: a.needs_ack,
          acknowledgedAt: iso(a.acknowledged_at),
          assigneeUserId: a.assignee_user_id,
          fingerprint: a.fingerprint,
          clearedAt: iso(a.cleared_at),
        },
        addonRunning: a.running,
      },
      addonId: a.addon_id,
      personId: a.person_id,
      title: a.title,
      detail: a.detail,
      clearReason: a.clear_reason,
    });
  return out;
}
