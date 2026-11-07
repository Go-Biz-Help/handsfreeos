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
import { scopedInput, type ScopeKey } from '../addons/ai';
import type { Registry } from '../kernel/registry';
import type { QueryDef } from '../kernel/types';
import { isOrgPermission, isStaffPermission, type Permission } from '../permissions';
import type { AssistantTool } from './tool-kit';

/** The screens' queries the Assistant reads through these tools, by name. */
export const SCREEN_READS = [
  'account.deletion_check',
  'activity.get',
  'addon.news',
  'addon.settings',
  'addon.suggestion',
  'addon_connection.list',
  'affiliate.mine',
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
  'document.get',
  'document.list',
  'document.prefill',
  'document_template.get',
  'document_template.list',
  'email_sender_rule.list',
  'estimate.list',
  'form.catalogs',
  'founding.mine',
  'funnel.get',
  'funnel.list',
  'funnel.of_person',
  'funnel.people',
  'funnel.suggestions',
  'idea.areas',
  'idea.roadmap',
  'import.get',
  'inbox.summary',
  'invoice.list',
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
  'payment.list',
  'portal_access.get',
  'record_hold.list',
  'registration.get_draft',
  'registration.review.get',
  'safety.alert',
  'safety.mine',
  'schedule.team',
  'search.everything',
  'search.kind',
  'subscription.get',
  'subscription.list',
  'support_access.list',
  'teammate_instruction.list',
  'timeline.list',
  'twilio_connection.list',
  'usage.prices',
  'usage.statement',
  'user_phone.get',
  'video_call.chat',
  'video_call.get',
  'video_call.leads',
  'video_call.polls',
  'whats_new.list',
  'whats_new.unseen',
  'workflow.proposal_get',
  'workflow.stats',
  // HandsFreeOS's own staff screens (the owner, 2026-10-27): offered only to staff, by their staff permissions.
  'addon_pick.overview',
  'idea.team_view',
  'idea.triage',
  'platform.affiliate',
  'platform.affiliate_of_business',
  'platform.affiliates',
  'platform.ai_provider.get',
  'platform.assistant_ledger',
  'platform.business.get',
  'platform.business.glance',
  'platform.business.list',
  'platform.founding',
  'platform.founding.business',
  'platform.health.summary',
  'platform.learned_way.list',
  'platform.me',
  'platform.onboarding.counts',
  'platform.partner_payouts.get',
  'platform.problem_report.get',
  'platform.problem_report.groups',
  'platform.problem_report.list',
  'platform.rates',
  'platform.wallet.get',
  'registration.review.for_staff',
  'support.canned_reply.list',
  'support.queue.summary',
  'support.staff.list',
  'support.ticket.get',
  'support.ticket.list',
] as const;

/**
 * What a screen loads that the Assistant never reads, and why: the panel's own history, signed-out pages and the
 * extension's, a download, what a screen shows while someone looks as another person, and steps of something only a
 * person does.
 */
export const NOT_FOR_THE_ASSISTANT: Readonly<Record<string, string>> = {
  'assistant_thread.get': 'the panel’s own history, which it already has',
  'assistant_thread.list': 'the panel’s own history, which it already has',
  'invitation.preview': 'the signed-out page an invitation opens',
  'extension_sign_in.pending': 'the browser extension signing in',
  'founding.checkout_status': 'paying for a founding seat, which is the person’s own card',
  'founding.code_preview': 'a code typed on the plan page, before paying on the person’s own card',
  'founding.claim_preview': 'the signed-out page a founding seat is claimed on',
  'founding.counts':
    'the plan page a new business pays on, before it is set up and has an Assistant',
  'file.fingerprints': 'the upload box telling a file it already has',
  'outreach.lookup': 'what the browser extension reads off a network',
  'outreach.ticker':
    'the ticker’s light read of what the person’s computer is doing, which the Assistant reads through outreach_live',
  'form.response_export': 'a spreadsheet download',
  'pm.lease.list': 'an add-on’s, which reaches the Assistant through its own `ai`',
  'platform.view_as.current':
    'which business a staff member is looking at, which this screen shows',
  'teammate_view.current': 'whether the person is looking as a teammate, which this screen shows',
  'teammate_view.lens': 'what the screens show while someone looks as a teammate',
};

/**
 * How a look-up is offered when it isn't as its query alone. `offeredTo`: a permission the Assistant can check in place
 * of the query's own, when that is the agency's (`org.*`), which no business permission holds: workspace.update, which
 * every agency owner and admin holds in each of its businesses. The kernel still checks the organization's own
 * permission when it runs. `agencyDoor`: a query either door reads (a business's own part, or the agency's whole), so
 * the model may ask it of the whole agency (`wholeAgency`).
 */
export interface ScreenReadWay {
  readonly offeredTo?: Permission;
  readonly agencyDoor?: true;
}
const SCREEN_READ_WAYS: Readonly<Record<string, ScreenReadWay>> = {
  'ai_setup_template.list': { offeredTo: 'workspace.update' },
  'onboarding.clients': { offeredTo: 'workspace.update' },
  'migration.get': { agencyDoor: true },
  'migration.review_queue': { agencyDoor: true },
  // Every signed-in person may ask it, but only HandsFreeOS's support people have anything in it: staff alone.
  'platform.me': { offeredTo: 'support.read' },
};

/**
 * What a look-up or a change either door takes adds to its input: whether it is asked of the whole agency. Left out,
 * it is this business's own part, as the business's own screen shows it. The executor then leaves the business's id
 * off, so the kernel checks the agency's own permission, and only the agency's owners and admins are let through.
 */
export const WHOLE_AGENCY = z
  .boolean()
  .optional()
  .describe(
    'true: as the agency’s own page shows it (Agency area → Migrations), every business it reaches, which only the agency’s owners and admins may. Left out: this business’s own part, as its Settings → Migrations shows it',
  );

/** The model's view of an input, with `wholeAgency` added when it may be asked of the whole agency. */
export const withAgencyDoor = (input: z.ZodObject, agencyDoor: boolean): z.ZodObject =>
  agencyDoor ? input.extend({ wholeAgency: WHOLE_AGENCY }) : input;

/** What a look-up's answer adds to what the screen shows, said after its description. */
const SCREEN_READ_MORE: Readonly<Record<string, string>> = {
  'idea.areas':
    'Every area comes with its description, its sort (the order the board lists them in) and whether it’s archived.',
  'platform.me':
    'Their own: the name customers see on their replies and their sign-off as saved (Support people, How you sign off), their support role and what it lets them do.',
  'platform.problem_report.get':
    'Its answer adds forClaude, what its Copy for Claude copies (the phone’s Share for Claude shares the same): the report, and the page’s outline when one was kept, ready to paste into a session on the code. The outline is there and nowhere else.',
  'platform.onboarding.counts':
    'Its answer adds matomoUrl, the Matomo pages report over the same days, which the page’s Open the pages report in Matomo opens: how far people get through the wizard’s pages.',
  'addon.settings':
    'Its settings come as the add-on’s settings page shows them, its defaults filled in where nothing was saved yet, and labels says what each one is in the page’s words. update_addon_settings changes them.',
  'onboarding.clients':
    'Its answer comes as Client businesses shows it: each business with where its setup stands (Stuck, Setting up or Done, and why), its owner and when they last signed in, whether a reminder went today, and each open step with its title and the link its Do it for them opens. group narrows it to one filter, and businessId to one business (from get_agency_area); counts are every business either way. do_onboarding_remind emails a business’s own owners a reminder, once a day.',
  'ai_setup_template.list':
    'These are the agency’s Saved setups (Agency area → Saved setups). do_ai_setup_template_save saves one from any of its businesses, and do_ai_setup_template_rename and do_ai_setup_template_delete rename and remove one; none of them changes a business.',
  'migration.get':
    'Its status comes with statusLabel, the words the move’s page shows, and each thing left to do with the link to its screen.',
  'lead.board':
    'Its answer comes summed up as the board shows it: the open leads and their value, each stage’s count and total value (Won and Lost too), then each stage’s first 5 cards in order (shown with a stage’s id and a limit lists more of it). Pipeline ids are in its pipelines.',
  'schedule.team':
    'The Calendar’s Team, Week and Day views show it. Its answer comes summed up, each person with their weekly hours (or that none are saved, so weekdays 9 to 5 apply) and the zone they’re in, their time off and extra open time with its note and exceptionId (update_my_hours takes it out), when they’re busy in their own Google or Outlook calendar, on a private deal or in another business, and how their calendar link stands. userIds narrows it to some teammates (list_team).',
  'video_call.get':
    'Its answer adds join, the address the team joins the call at, and for a webinar linkAnyoneCanUse, its Link anyone can use as the screen copies it. The customer’s own link went to them by text or email and is never shown. A call that isn’t for an appointment is found by its callId: start_video_call’s answer has it, and once it has been held it is on the customer’s timeline (read_timeline_list, a call’s meta.videoCallId).',
};

/** One of a screen's queries, offered to the Assistant as a look-up. */
export interface ScreenReadTool extends AssistantTool<z.ZodObject> {
  readonly query: QueryDef;
  /** The business ids its input takes, which the executor puts on after the model's arguments. */
  readonly scope: readonly ScopeKey[];
  /**
   * HandsFreeOS's own staff only, looking across businesses: the model names the business (`workspaceId`) it asks
   * about, which the executor keeps, and the kernel checks the staff permission.
   */
  readonly staff: boolean;
  /** Either door: it may be asked of the whole agency (`wholeAgency`). */
  readonly agencyDoor: boolean;
  /**
   * The agency's own (an `org.*` permission): only its owners and admins see it. The executor checks that first, so
   * anyone else is told who can, not that the agency isn't there.
   */
  readonly agencyOnly: boolean;
}

/** Whether an offered tool is one of these (it runs through the one executor for them). */
export const isScreenReadTool = (tool: object): tool is ScreenReadTool =>
  'query' in tool && 'scope' in tool && !('op' in tool);

/** `timeline.list` → `read_timeline_list`. */
export const screenReadName = (query: string) => `read_${query.replace(/\./g, '_')}`;

/**
 * The tools, from the registry: one a query, its permission or, with none, the Assistant's own. The business's ids
 * are put on by the executor, except on a staff screen's, which looks across businesses: the model names the one.
 */
export function screenReadTools(registry: Pick<Registry, 'query'>): ScreenReadTool[] {
  return SCREEN_READS.flatMap((name) => {
    const query = registry.query(name);
    if (!query || !(query.input instanceof z.ZodObject)) return [];
    const staff = !!query.permission && isStaffPermission(query.permission);
    const view = staff ? { input: query.input, scope: [] } : scopedInput(query.input);
    const way = SCREEN_READ_WAYS[name] ?? {};
    const agencyDoor = !!way.agencyDoor && view.scope.includes('workspaceId');
    return [
      {
        name: screenReadName(name),
        description: `${query.description} What the person sees on the screen it’s on.${SCREEN_READ_MORE[name] ? ` ${SCREEN_READ_MORE[name]}` : ''}`,
        input: withAgencyDoor(view.input, agencyDoor),
        autonomy: 'auto' as const,
        permission: (way.offeredTo ?? query.permission ?? 'assistant.use') as Permission,
        query,
        scope: view.scope,
        staff,
        agencyDoor,
        agencyOnly: !!query.permission && isOrgPermission(query.permission),
      },
    ];
  });
}
