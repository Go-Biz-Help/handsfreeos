/**
 * What the teammate's settings refer to: workspace catalogs and readiness flags. The loader builds this from
 * the database (and the builder from the page's queries); the rules, presets and diff read it.
 */
import type { CatalogPipeline } from '../calendar/catalogs';
import type { WeeklyHours } from '../calendar/config';
import type { QuietHoursWindow } from '../messaging/quiet-hours';
import type { WorkspaceRole } from '../permissions';
import type { WorkflowDefinition } from '../workflows/definition';
import { allSteps } from '../workflows/walk';

export interface TeammateMember {
  readonly userId: string;
  readonly name: string;
  readonly role: WorkspaceRole;
  /** False once they have left the workspace (kept so messages can still name them). */
  readonly active: boolean;
}

export interface TeammateCatalogs {
  /** The workspace's time zone. */
  readonly timeZone: string;
  /** Texting is registered and has a number. */
  readonly textingReady: boolean;
  /** Addresses the business can send email from. */
  readonly emailAddresses: readonly { readonly id: string; readonly address: string }[];
  readonly chatWidgets: readonly { readonly id: string; readonly name: string }[];
  readonly calendars: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
    /** Public on the booking site: the teammate books only where customers could book themselves. */
    readonly bookableOnline: boolean;
  }[];
  /** Published knowledge items. */
  readonly knowledge: { readonly published: number };
  /** `profileCompleteness` of the business profile. */
  readonly profile: { readonly filled: number; readonly total: number };
  /** When the business is open; null when it hasn't said. */
  readonly businessHours: WeeklyHours | null;
  /** Current members, plus anyone the settings still name (active false). */
  readonly members: readonly TeammateMember[];
  /** Active workflows that text new leads (see `workflowTextsNewLeads`). */
  readonly newLeadTextWorkflows: readonly { readonly id: string; readonly name: string }[];
  readonly quietHours: QuietHoursWindow;
  /** The workspace's industry, for suggested qualifying questions. */
  readonly industry?: string | null;
  /** Names for the qualified-lead stage in diffs. */
  readonly pipelines?: readonly CatalogPipeline[];
}

export function emptyTeammateCatalogs(timeZone = 'America/Chicago'): TeammateCatalogs {
  return {
    timeZone,
    textingReady: false,
    emailAddresses: [],
    chatWidgets: [],
    calendars: [],
    knowledge: { published: 0 },
    profile: { filled: 0, total: 7 },
    businessHours: null,
    members: [],
    newLeadTextWorkflows: [],
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  };
}

/** A workflow that texts new leads: it starts on `lead.created` and has a text step anywhere. */
export function workflowTextsNewLeads(def: WorkflowDefinition): boolean {
  return (
    def.trigger.kind === 'event' &&
    def.trigger.event === 'lead.created' &&
    allSteps(def).some(({ step }) => step.type === 'action' && step.action === 'send_text')
  );
}
