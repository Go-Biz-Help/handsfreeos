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
import { ADDON_CATEGORIES } from '../addons/manifest';
import type { Registry } from '../kernel/registry';
import type { QueryDef } from '../kernel/types';
import { isOrgPermission, isStaffPermission, type Permission } from '../permissions';
import type { AssistantTool } from './tool-kit';

/** The screens' queries the Assistant reads through these tools, by name. */
export const SCREEN_READS = [
  'account.deletion_check',
  'activity.get',
  'addon.news',
  'addon.roadmap',
  'addon.settings',
  'addon.suggestion',
  'addon_connection.list',
  'affiliate.mine',
  'billing.pay_day_quote',
  'billing.status',
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
  'email_setup.get',
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
  'idea.similar',
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
  'platform.billing.business',
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
 * the model may ask it of the whole agency (`wholeAgency`). `more`: what the model may add that the query doesn't
 * take, which the executor reads to shape the answer and leaves off the query's input.
 */
export interface ScreenReadWay {
  readonly offeredTo?: Permission;
  readonly agencyDoor?: true;
  readonly more?: z.ZodRawShape;
}
const SCREEN_READ_WAYS: Readonly<Record<string, ScreenReadWay>> = {
  // A funnel can be longer than one answer holds: one stage of it always reads whole.
  'funnel.get': {
    more: {
      stageId: z
        .uuid()
        .optional()
        .describe(
          'Only this stage of the funnel, read whole: a stageId from its stages. Left out, the whole funnel, or its outline when it is too long to read whole',
        ),
    },
  },
  // A template can be longer than one answer holds: one page of it always reads whole.
  'document_template.get': {
    more: {
      page: z
        .int()
        .min(0)
        .max(99)
        .optional()
        .describe(
          'Only this page’s fields and changes to its words, read whole: counted from 0. Left out, the whole template, or its outline when it is too long to read whole',
        ),
    },
  },
  // Vote on what's next, as the page filters it: over a hundred planned add-ons are far more than one answer holds.
  'addon.roadmap': {
    more: {
      search: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe(
          'As Search add-ons: every word must be in its name, what it does, its category or its groups',
        ),
      category: z.enum(ADDON_CATEGORIES).optional().describe('One category chip; left out, All'),
      group: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe('One of its groups, as the Group filter'),
      sort: z
        .enum(['votes', 'az'])
        .optional()
        .describe('votes (Most votes, the default) or az (A to Z)'),
      limit: z.int().min(1).max(30).optional().describe('How many to list; 20 when left out'),
    },
  },
  // The roadmap's three columns hold up to 100 cards each: one column always reads whole.
  'idea.roadmap': {
    more: {
      column: z
        .enum(['planned', 'in_progress', 'done'])
        .optional()
        .describe(
          'Only this column, up to 60 of its cards. Left out, each column’s count and its first 15 cards',
        ),
    },
  },
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
  'email_setup.get':
    'Its answer is what Set up your business email (Home, and the guided setup’s Your business email stop) starts from: state, the business’s addresses, domains with their records (each found or waiting) and where each domain’s DNS is managed, the person’s own address and connected mailboxes; and answers, the screens’ starting picks. do_email_setup_save saves one part at a time (sender, records, own), and do_email_domain_send_steps emails a domain’s records to whoever adds them.',
  'audit.list':
    'Each entry comes as the Audit log’s row says it: who did it, what they did in words (did), its kind (the label on the row), and noticedByHandsFree on what the Action Center noticed on its own, rows the log hides until Show what HandsFreeOS noticed is ticked. Filter by person is actorId for a person or one workflow, channel workflow for All workflows, actorType system for HandsFreeOS, and for the AI teammate both actorType ai_employee (what it did) and category ai_team (what people did about it: hand-offs, its answers on a lead). Filter by activity is category (customers is Contacts, inbox is Inbox & texting, ai_team is the AI teammate); its Workflows choice also shows what workflows did (actorType workflow), and its Assistant choice is channel assistant. Today, 7 days and 30 days are since; nextCursor reads the next page.',
  'idea.areas':
    'Every area comes with its description, its sort (the order the board lists them in) and whether it’s archived.',
  'idea.roadmap':
    'Its answer comes as the Roadmap tab shows it: Planned, In progress and Done lately (what shipped in the last 90 days, newest first), each with what it means, its count, and each card’s idea number, title, area, votes, whether they voted and since when it’s been there. Without column, each column’s first 15 cards; column reads up to 60 of one. find_ideas reads one idea with its comments and its story, and a column’s status pages through all of it.',
  'idea.similar':
    'text is what someone typed: a title, or a few words of one. Its answer is up to five ideas still on the board (none taken down or merged), most alike first, each with its id, number, title, status, votes and whether they voted: what Share an idea shows under its title as they type, and what the team’s Duplicate box on an idea finds (excludeIdeaId leaves that idea out). find_ideas reads one in full.',
  'addon.roadmap':
    'Its answer comes as Add-ons shows it to owners and admins: Coming soon (what the weekly vote picked, with whether this business voted for it), then Vote on what’s next, filtered and sorted as the page does, with the category chips and their counts, the groups to filter by, how many match, and each planned add-on’s addonId, summary, category, groups, Already in HandsFreeOS (what HandsFreeOS already does of it), votes and whether this business voted. The business has one vote on each, cast or taken back by its owners and admins: do_addon_vote and do_addon_unvote take the addonId. A planned add-on is never something to add.',
  'addon_connection.list':
    'Its answer adds page, the link to the add-on’s Connections, which opens its own Connections tab when it keeps one among its settings. Connecting an account with a sign-in or a key is the person’s own, on that page: settings_help (area add_ons) gives the steps, and a key is never typed into this chat. Nobody can read a key back once it’s saved, only replace or remove it. do_addon_connection_disconnect disconnects one of the business’s own.',
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
  'partner.get':
    'Its answer reads as the partner’s page does: who they are, their share, their link and what they’ve earned, then how they’re paid (their bank and each payout), then their clients and each line of what they’ve earned, the newest first. A list too long to read whole is cut from its end, and its note says how many show.',
  'import.get':
    'Its answer comes as the import’s page shows it: its progress and result, then the rows that did not import, each with why. A wide sheet’s rows come without their own cells, keeping each row’s number and why. do_import_cancel stops one still going; rows already in stay.',
  'lead.board':
    'Its answer comes summed up as the board shows it: the open leads and their value, each stage’s count and total value (Won and Lost too), then each stage’s first 5 cards in order (shown with a stage’s id and a limit lists more of it). Pipeline ids are in its pipelines.',
  'schedule.team':
    'The Calendar’s Team, Week and Day views show it. Its answer comes summed up, each person with their weekly hours (or that none are saved, so weekdays 9 to 5 apply) and the zone they’re in, their time off and extra open time with its note and exceptionId (update_my_hours takes it out), when they’re busy in their own Google or Outlook calendar, on a private deal or in another business, and how their calendar link stands. userIds narrows it to some teammates (list_team).',
  'funnel.get':
    'Its answer comes as the funnel’s builder shows it: its definition whole while it fits, with inWords saying who gets in and each stage’s messages and moves in the builder’s words. A funnel too long to read whole comes as an outline, each message cut short, and stageId then reads one stage whole. do_funnel_save takes the whole definition back, with the revision read here, so read every stage whole before saving a long one.',
  'document.get':
    'Its answer comes as the document’s page shows it: its state (Out for signing, Making the signed copy, Signed, Declined, Voided, Out of time) and the note under it, then Who signs, each with their state in the screen’s words (Not their turn yet, Link on its way, Signs with you in person, Opened, Signed, Gets a copy) and theirTurn, then What happened, the proof trail in words. What’s filled in comes in words: a signature only as whose it is, never its picture. get_document_file opens the signed copy, get_signing_link gives a signer’s own link, and do_document_remind and do_document_void remind and void it.',
  'document.list': 'Each document and signer comes with its state as the Sent tab’s badges say it.',
  'document_template.get':
    'Its answer comes as the template’s editor shows it: what stops it going out (Before it can go out), When it’s sent, Who signs with each one’s key, then each field and each change to the PDF’s words, with the ids change_document_template takes. A template too long to read whole comes as an outline, and page reads one page whole. get_document_pages reads the PDF’s own words.',
  'document.prefill':
    'Its answer comes as the Send screen shows it: what stops it going out and who each role suggests first, then the fields filled in before it goes, When it’s sent, and the template’s changes to the words whole, as do_document_send’s edits take them.',
  'safety.alert':
    'checkInId is the end of a Safety notification’s path under the bell (/app/w/…/safety/<checkInId>), and the check in named by the screen they ask from when that is a safety alert. Its answer adds mapUrl, the map link Where their phone was opens, with when the phone was there. Null when it isn’t theirs to answer: it was answered already, or they weren’t one of those told. Once they have reached the person and know they’re OK, do_safety_resolve stops the alerts for everyone.',
  'safety.mine':
    'Their own, and nobody else’s: who is told if they don’t check out, with how each is told (a teammate in the app; someone outside by text and email once they reply OK, nothing while asked, never after STOP), and the check-in open now, with whether it shares where their phone is (follows) and when it was last there (locatedAt). my_check_in adds time or checks out, ask_for_help asks for help, and manage_my_safety_contacts changes who is told.',
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
  /** What its input adds to the query's (its way's `more`): read by the executor, never given to the query. */
  readonly more?: readonly string[];
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
        input: way.more
          ? withAgencyDoor(view.input, agencyDoor).extend(way.more)
          : withAgencyDoor(view.input, agencyDoor),
        autonomy: 'auto' as const,
        permission: (way.offeredTo ?? query.permission ?? 'assistant.use') as Permission,
        query,
        scope: view.scope,
        staff,
        agencyDoor,
        agencyOnly: !!query.permission && isOrgPermission(query.permission),
        ...(way.more ? { more: Object.keys(way.more) } : {}),
      },
    ];
  });
}
