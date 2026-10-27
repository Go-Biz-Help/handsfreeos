/**
 * Everything a person can see, the Assistant can see (the owner, 2026-10-26). Each query a screen loads that the
 * Assistant's own tools don't already read is a look-up tool of its own, derived from the query: its description,
 * its input without the business's ids, its permission. It runs as the person, through the kernel, so it sees exactly
 * what they would on the screen, row security and all, and never more.
 *
 * Server-side: it reads the registry. apps/worker/test/assistant-screen-reads.test.ts fails when a screen loads a
 * query that is neither one of these, read by the Assistant's own tools, an add-on's tool, nor kept out below.
 */
import { z } from 'zod';
import { modelInput, type ScopeKey } from '../addons/ai';
import type { Registry } from '../kernel/registry';
import type { QueryDef } from '../kernel/types';
import type { Permission } from '../permissions';
import type { AssistantTool } from './tool-kit';

/** The screens' queries the Assistant reads through these tools, by name. */
export const SCREEN_READS = [
  'account.deletion_check',
  'activity.get',
  'addon.news',
  'addon.settings',
  'addon.suggestion',
  'addon_connection.list',
  'ai_setup.get',
  'ai_setup_template.list',
  'ai_teammate.activity',
  'ai_teammate.feedback',
  'ai_teammate.review',
  'appointment.transcripts',
  'attention.for_record',
  'attention.summary',
  'attribution.list',
  'audit.list',
  'calendar_connection.list',
  'call_suggestion.list',
  'chat_widget.get',
  'crm.summary',
  'email_sender_rule.list',
  'form.catalogs',
  'founding.mine',
  'funnel.get',
  'funnel.list',
  'funnel.of_person',
  'funnel.people',
  'funnel.suggestions',
  'idea.roadmap',
  'import.get',
  'inbox.summary',
  'lead.board',
  'live_meeting_account.mine',
  'maintenance.for_person',
  'meeting_connection.list',
  'migration.get',
  'migration.review_queue',
  'notification.list',
  'number_import.list',
  'number_port.list',
  'onboarding.clients',
  'onboarding.status',
  'onboarding_setup.get',
  'partner.get',
  'partner.of_person',
  'partner.payout_get',
  'partner.payouts',
  'portal_access.get',
  'record_hold.list',
  'registration.get_draft',
  'safety.alert',
  'safety.mine',
  'search.everything',
  'search.kind',
  'support_access.list',
  'teammate_instruction.list',
  'timeline.list',
  'twilio_connection.list',
  'usage.prices',
  'usage.statement',
  'user_phone.get',
  'video_call.get',
  'whats_new.list',
  'whats_new.unseen',
  'workflow.proposal_get',
  'workflow.stats',
] as const;

/**
 * What a screen loads that the Assistant never reads, and why: HandsFreeOS's own staff screens, the panel's own
 * history, signed-out pages and the extension's, a download, and steps of something only a person does.
 */
export const NOT_FOR_THE_ASSISTANT: Readonly<Record<string, string>> = {
  'assistant_thread.get': 'the panel’s own history, which it already has',
  'assistant_thread.list': 'the panel’s own history, which it already has',
  'invitation.preview': 'the signed-out page an invitation opens',
  'extension_sign_in.pending': 'the browser extension signing in',
  'founding.checkout_status': 'paying for a founding seat, which is the person’s own card',
  'founding.claim_preview': 'the signed-out page a founding seat is claimed on',
  'file.fingerprints': 'the upload box telling a file it already has',
  'bin.preview': 'what a delete would take, and the AI never deletes',
  'outreach.lookup': 'what the browser extension reads off a network',
  'form.response_export': 'a spreadsheet download',
  'pm.lease.list': 'an add-on’s, which reaches the Assistant through its own `ai`',
  'addon_pick.overview': 'HandsFreeOS’s own add-on vote, for its staff',
  'idea.team_view': 'HandsFreeOS’s own ideas desk, for its staff',
  'idea.triage': 'HandsFreeOS’s own ideas desk, for its staff',
};

/** Staff screens, by the start of their queries' names: HandsFreeOS's own desk, never a business's. */
export const STAFF_QUERY_PREFIXES = ['platform.', 'support.', 'teammate_view.'] as const;

/** One of a screen's queries, offered to the Assistant as a look-up. */
export interface ScreenReadTool extends AssistantTool<z.ZodObject> {
  readonly query: QueryDef;
  /** The business ids its input takes, which the executor puts on after the model's arguments. */
  readonly scope: readonly ScopeKey[];
}

/** Whether an offered tool is one of these (it runs through the one executor for them). */
export const isScreenReadTool = (tool: object): tool is ScreenReadTool =>
  'query' in tool && 'scope' in tool && !('op' in tool);

/** `timeline.list` → `read_timeline_list`. */
export const screenReadName = (query: string) => `read_${query.replace(/\./g, '_')}`;

/** The tools, from the registry: one a query, its permission or, with none, the Assistant's own. */
export function screenReadTools(registry: Pick<Registry, 'query'>): ScreenReadTool[] {
  return SCREEN_READS.flatMap((name) => {
    const query = registry.query(name);
    if (!query || !(query.input instanceof z.ZodObject)) return [];
    const view = modelInput(query.input);
    return [
      {
        name: screenReadName(name),
        description: `${query.description} What the person sees on the screen it’s on.`,
        input: view?.input ?? (query.input as z.ZodObject),
        autonomy: 'auto' as const,
        permission: (query.permission ?? 'assistant.use') as Permission,
        query,
        scope: view?.scope ?? [],
      },
    ];
  });
}
