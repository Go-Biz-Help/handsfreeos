/**
 * Findings, and the words that go with them.
 *
 * A finding is a promise kept: we said we would tell you before the import, not after. The codes are stable so
 * the same gap in forty businesses counts as one gap when we decide what to build next — which is the other
 * half of this milestone's value, and the reason `detail` is sanitized rather than rich.
 */
import type { MigrationCapability } from './capability';

export type FindingSeverity = 'info' | 'review' | 'action' | 'blocking';

export interface Finding {
  readonly code: string;
  readonly category?: string | null;
  readonly capability: MigrationCapability;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly sourceCapability?: string | null;
  readonly targetCapability?: string | null;
  readonly whatImports?: string | null;
  readonly whatChanges?: string | null;
  readonly recommendedAction?: string | null;
  readonly blocksImport?: boolean;
  readonly affectedCount?: number;
  readonly detail?: Record<string, unknown>;
}

/** The ones this side raises. An adapter adds its own with its system's prefix. */
export const FINDING_CODES = {
  /** The sign-in cannot reach a category at all. Not the same as the category being empty. */
  scopeMissing: 'access.scope_missing',
  /** The old system offers no way to read something. */
  sourceLacksApi: 'access.source_has_no_api',
  /** A field type this side has never seen. Kept whole in extensions rather than flattened to text. */
  unknownFieldType: 'mapping.unknown_field_type',
  /** A real field with nowhere to live here yet. */
  noTargetField: 'mapping.no_target_field',
  /** Two sub-accounts landing in one business. */
  scopesShareWorkspace: 'plan.scopes_share_workspace',
  /** The phone number, email consent or money settings two sub-accounts disagree about. */
  scopeCollision: 'plan.scope_collision',
  /** Automations, by design. */
  workflowsNotImported: 'design.workflows_not_imported',
  /** Websites and funnels, this release. */
  sitesNotInRelease: 'design.sites_not_in_release',
  /** A customer here and a customer there that might be the same person. */
  mergeNeedsReview: 'merge.needs_review',
  /** The email says one person and the phone another. */
  mergeConflict: 'merge.conflict',
  /** A file the old system would not give us. */
  mediaUnavailable: 'media.unavailable',
  /** Something to reconnect before it works live. */
  reconnectNeeded: 'setup.reconnect_needed',
  /** A phone number that has to be ported. */
  portNeeded: 'setup.port_needed',
  /** DNS to change before mail sends from here. */
  dnsNeeded: 'setup.dns_needed',
} as const;

/** Two sub-accounts pointed at one business. Chris allowed it; this is the page saying what it mixes. */
export function sharedWorkspaceFinding(input: {
  readonly workspaceName: string;
  readonly scopeNames: readonly string[];
}): Finding {
  const names = [...input.scopeNames].sort();
  return {
    code: FINDING_CODES.scopesShareWorkspace,
    capability: 'needs_review',
    severity: 'review',
    summary: `${names.length} sub-accounts will land in ${input.workspaceName}.`,
    whatImports: 'Everything chosen from all of them, in one business.',
    whatChanges:
      'Customers who appear in more than one will be joined into one customer where a phone number or ' +
      'email matches, and left as two where nothing matches. Tags, pipelines and calendars with the same ' +
      'name stay separate, because they were separate over there.',
    recommendedAction:
      'If these were really two businesses, point one of them at a business of its own instead.',
    affectedCount: names.length,
    detail: { scopes: names, workspace: input.workspaceName },
  };
}

export function scopeMissingFinding(input: {
  readonly category: string;
  readonly categoryLabel: string;
  readonly missingScopes: readonly string[];
}): Finding {
  return {
    code: FINDING_CODES.scopeMissing,
    category: input.category,
    capability: 'not_available',
    severity: 'action',
    summary: `This sign-in cannot read ${input.categoryLabel.toLowerCase()}.`,
    whatImports: 'Nothing from this category.',
    whatChanges:
      'The count is not zero — it is unknown. We were not allowed to look, so we will not pretend there is ' +
      'nothing there.',
    recommendedAction: 'Sign in again and allow the extra access, then scan once more.',
    detail: { missingScopes: [...input.missingScopes] },
  };
}

export function workflowsFinding(count: number): Finding {
  return {
    code: FINDING_CODES.workflowsNotImported,
    category: 'workflows',
    capability: 'not_imported',
    severity: 'info',
    summary: `${count.toLocaleString()} automations stay behind, on purpose.`,
    whatImports: 'Nothing, and nothing from them will ever send.',
    whatChanges:
      'HandsFreeOS answers, follows up, reminds and asks for reviews itself, so most of these have no ' +
      'equivalent to rebuild. We read yours to check nothing you rely on is missing.',
    recommendedAction: 'Look at the list we found and tell us if something is not covered.',
    affectedCount: count,
  };
}

export function sitesFinding(category: 'websites' | 'funnels', count: number): Finding {
  const what = category === 'websites' ? 'websites' : 'funnels';
  return {
    code: FINDING_CODES.sitesNotInRelease,
    category,
    capability: 'not_in_release',
    severity: 'info',
    summary: `${count.toLocaleString()} ${what} stay where they are.`,
    whatImports: 'Nothing. They keep working in the old system until you move them yourself.',
    whatChanges:
      'Nothing here. Cancelling the old system would take them down, so plan that separately.',
    recommendedAction: `Keep the old account open until your ${what} live somewhere else.`,
    affectedCount: count,
  };
}

/** Sorted the way the report shows them: what blocks, then what needs doing, then the rest. */
const RANK: Record<FindingSeverity, number> = { blocking: 0, action: 1, review: 2, info: 3 };
export function sortFindings<T extends { severity: FindingSeverity; code: string }>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.code.localeCompare(b.code),
  );
}
