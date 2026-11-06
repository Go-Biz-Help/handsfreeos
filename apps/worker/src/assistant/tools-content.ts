/**
 * The Assistant's content tools (packages/core/src/assistant/tools-content.ts): what each does when it runs on its own
 * ("auto"), and the card it shows and the command it runs once the person presses Confirm ("confirm").
 *
 * Campaigns, reviews, forms beyond building and sending, the knowledge base (items, suggestions, the website scan and
 * offers), workflows and their runs, and the AI teammate's drafts. Every card is read from the same queries the
 * screens use, and says what will happen in the screen's own words; every change is the screen's own command, run
 * as the person and marked as done through the Assistant.
 *
 * Where a screen holds something back, the card does too, as a line saying why with no Confirm: a Facebook review
 * (Facebook won't let an app answer), a campaign still being written, a question customers asked with no answer yet.
 * Anything that reaches customers, or can't be taken back, says so on the card.
 */
import {
  allSteps,
  applyWorkflowOps,
  approvalDecidedLine,
  closedStageWords,
  decisionLines,
  decisionsOf,
  describeOps,
  describeSettings,
  DRAFT_WORDS,
  draftDecidedLine,
  describeStep,
  describeTrigger,
  diffWorkflows,
  endReasonText,
  failedStep,
  campaignCallWords,
  campaignStatusWords,
  findStep,
  FORM_SOURCE_WORDS,
  HfosError,
  isLiveRun,
  KnowledgeEditableContent,
  knowledgeUsed,
  latestRows,
  lineCheckCostWords,
  messageOf,
  MONEY_DRAFT_ACTIONS,
  normalizeSiteUrl,
  parseDefinition,
  plainSpaces,
  RUN_STATUS,
  RUN_STATUS_FILTERS,
  RUN_STEP_STATUS,
  runLine,
  runStepFields,
  runStepTitle,
  stepKeyParts,
  stepNote,
  testOutcome,
  unusedPaths,
  workflowTextsNewLeads,
  type ApprovalFacts,
  type AssistantCard,
  type RunStatus,
  type RunStepRow,
  type WorkflowCatalogs,
  type WorkflowDefinition,
  type WorkflowNames,
  type WorkflowOp,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import { command, query, quoted, rehearse, when } from './tools-read';
import type { SettingsConfirmTool } from './tools-settings-calendar';
import { wholeFormLink } from './tools-forms';
import { lastRunOut, sourceOut, type WorkflowItem } from './tools-workflow';

type Args = Record<string, unknown>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type ListCard = Extract<AssistantCard, { type: 'list' }>;
type Tone = ListCard['items'][number]['tone'];
type Field = { label: string; value: string };
type Warning = { kind: string; text: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const ids = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const peopleOf = (n: number) => plural(n, 'person', 'people');
const firstName = (full: string) => full.split(' ')[0] || full;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const action = (args: Args) => String(args['action'] ?? '');
/** "Nothing would change.", and why, so the model can tell the person what already matches. */
const nothingChanges = (why: string) => HfosError.validation([], `Nothing would change. ${why}`);
const need = (what: string) => HfosError.validation([], what);

/** The pages the cards link to. */
const contentPaths = (ws: string) => ({
  campaigns: () => `/app/w/${ws}/campaigns`,
  campaign: (id: string) => `/app/w/${ws}/campaigns/${id}`,
  reviews: () => `/app/w/${ws}/reviews`,
  forms: () => `/app/w/${ws}/forms`,
  form: (id: string) => `/app/w/${ws}/forms/${id}`,
  knowledge: () => `/app/w/${ws}/knowledge/items`,
  item: (id: string) => `/app/w/${ws}/knowledge/items/${id}`,
  suggestions: () => `/app/w/${ws}/knowledge/suggestions`,
  website: () => `/app/w/${ws}/knowledge/website`,
  offers: () => `/app/w/${ws}/knowledge/offers`,
  workflow: (id: string) => `/app/w/${ws}/workflows/${id}`,
  workflows: () => `/app/w/${ws}/workflows`,
  run: (id: string) => `/app/w/${ws}/workflows/runs/${id}`,
  runs: () => `/app/w/${ws}/workflows/runs`,
  drafts: () => `/app/w/${ws}/ai-team/approvals`,
  conversation: (id: string) => `/app/w/${ws}/inbox/${id}`,
});

/** A confirm card; one with no confirmLabel can't be confirmed and carries a 'blocked' line saying why. */
function card(
  toolCallId: string,
  tool: string,
  c: {
    title: string;
    fields: Field[];
    confirmLabel: string;
    body?: string | null;
    warnings?: Warning[];
    personId?: string | null;
  },
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: c.personId ?? null,
    conversationId: null,
    title: c.title,
    fields: c.fields.filter((f) => f.value).slice(0, 10),
    body: c.body ?? null,
    stageFrom: null,
    stageTo: null,
    warnings: (c.warnings ?? []).slice(0, 3),
    reasons: [],
    confirmLabel: c.confirmLabel,
    editable: false,
  };
}

/** The card's words when something stops it, or the ones given when nothing does. */
const orBlocked = (blocked: string | null, confirmLabel: string, warnings: Warning[] = []) =>
  blocked
    ? { confirmLabel: '', warnings: [{ kind: 'blocked', text: blocked }] }
    : { confirmLabel, warnings };

/** A local date the way people say it: "Oct 31, 2026". */
const dayWords = (date: string) =>
  plainSpaces(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${date}T12:00:00Z`)),
  );

// ================================================================================================
// Outreach campaigns
// ================================================================================================

type Channel = 'sms' | 'email' | 'call';
interface CampaignSummary {
  id: string;
  name: string;
  goal: string;
  channel: Channel;
  status: 'drafting' | 'review' | 'sending' | 'paused' | 'done' | 'cancelled';
  pausedReason: string | null;
  perHour: number;
  /** A call campaign that adds anyone who comes to fit, and never finishes while it's on. */
  keepAdding: boolean;
  counts: {
    total: number;
    drafting: number;
    ready: number;
    approved: number;
    sent: number;
    skipped: number;
    removed: number;
    failed: number;
  };
  offer: { id: string; name: string } | null;
  createdAt: string;
}
interface Recipient {
  id: string;
  personId: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: 'drafting' | 'ready' | 'skipped' | 'removed' | 'approved' | 'sent' | 'failed';
  skipReason: string | null;
  draft: string | null;
  edited: boolean;
  sentAt: string | null;
  error: string | null;
  call: { status: string; outcome: string | null; summary: string | null } | null;
}
interface CampaignGet {
  campaign: CampaignSummary & {
    audience: { tagIds: string[]; stageIds: string[] };
    email: {
      subject: string | null;
      body: string | null;
      edited: boolean;
      postalAddress: string | null;
    } | null;
    call: { opening: string | null; edited: boolean } | null;
  };
  recipients: Recipient[];
  nextSendAt: string | null;
}
interface Pipeline {
  id: string;
  name: string;
  archivedAt: string | null;
  stages: { id: string; name: string; kind: string }[];
}
interface Offer {
  id: string;
  name: string;
  details: string;
  startsOn: string | null;
  endsOn: string | null;
  state: 'live' | 'upcoming' | 'ended';
}

const NOUN: Record<Channel, [string, string]> = {
  sms: ['text', 'texts'],
  email: ['email', 'emails'],
  call: ['call', 'calls'],
};
const SENDS_AS: Record<Channel, string> = {
  sms: 'Texts, one written for each person',
  email: 'One email to them all, with their first name',
  call: 'AI calls from your AI teammate',
};
/** A campaign's state, as its badge says it (core's, which the Campaigns pages use). */
const CAMPAIGN_STATUS = (c: Pick<CampaignSummary, 'status' | 'channel'>) =>
  campaignStatusWords(c.status, c.channel);
/** The Campaigns screen's words for why someone was left out. */
const SKIP_WORDS: Record<string, string> = {
  no_phone: 'no mobile number',
  not_opted_in: 'hasn’t agreed to texts',
  texted_recently: 'texted in the last 14 days',
  in_conversation: 'in a conversation or has an open item on Home',
  booked_soon: 'booked in the next 30 days',
  no_draft: 'the AI couldn’t write one',
  not_sent: 'not sent',
  no_email: 'no email address',
  unsubscribed: 'unsubscribed from your emails',
  email_stopped: 'email to them bounced or was marked as spam',
  emailed_recently: 'sent another campaign email in the last 14 days',
  no_call_consent: 'hasn’t agreed to calls in writing',
  called_recently: 'called by another campaign in the last 14 days',
  not_business_landline: 'no yes to calls, and not a business landline',
};
/** Why HandsFreeOS paused a campaign, and what to do about it (the campaign page's words). */
const PAUSED_WORDS: Record<string, string> = {
  email_campaigns_not_ready: 'Email campaigns aren’t switched on for this business yet.',
  no_postal_address:
    'Every campaign email has to show the business address: add it in Settings → Payments.',
  no_email_address:
    'The business has no address to send email from: set one up in Settings → Email.',
  email_domain_unverified: 'The email domain isn’t verified yet: finish it in Settings → Email.',
  texting_not_ready: 'Texting isn’t set up yet: finish it in Settings → Texting & calls.',
  messaging_not_ready: 'Texting isn’t set up yet: finish it in Settings → Texting & calls.',
  no_number: 'The business has no phone number to text from.',
  ai_calls_not_ready: 'The AI teammate isn’t taking calls: turn its phone on under AI teammate.',
};
const RECIPIENT_WORD: Record<Recipient['status'], string> = {
  drafting: 'Being written',
  ready: 'Waiting for approval',
  approved: 'Waiting its turn',
  sent: 'Sent',
  failed: 'Didn’t go',
  skipped: 'Left out',
  removed: 'Taken out',
};

const skipWords = (reason: string | null) => (reason && SKIP_WORDS[reason]) || 'left out';
/** "4 people: 1 hasn’t agreed to texts, 3 no mobile number". */
function leftOutLine(byReason: Record<string, number>): string {
  const parts = Object.entries(byReason).filter(([, n]) => n > 0);
  const total = parts.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return '';
  return `${peopleOf(total)}: ${parts.map(([why, n]) => `${n} ${skipWords(why)}`).join(', ')}`;
}
const paceLine = (c: { channel: Channel; perHour: number }) =>
  `${c.perHour} ${NOUN[c.channel][1]} an hour, while you’re open and never in quiet hours`;
function whereItIs(c: CampaignSummary): string {
  const [one, many] = NOUN[c.channel];
  const going = c.counts.sent + c.counts.approved + c.counts.failed;
  switch (c.status) {
    case 'drafting':
      // As the page counts them: the ones left out aren't written.
      return c.channel === 'sms'
        ? `The AI is writing the texts: ${c.counts.total - c.counts.drafting - c.counts.skipped} of ${c.counts.total - c.counts.skipped} written`
        : `The AI is writing the ${one}, to ${peopleOf(c.counts.total - c.counts.skipped)}`;
    case 'review':
      return `${peopleOf(c.counts.ready)} to ${c.channel === 'call' ? 'call' : 'get it'}, waiting for approval`;
    case 'sending':
      return `${c.counts.sent} of ${going} ${c.channel === 'call' ? 'called' : 'sent'}`;
    case 'paused':
      return `Paused after ${c.counts.sent} of ${going} ${many}`;
    case 'done':
      return `Done: ${c.counts.sent} ${c.channel === 'call' ? 'called' : 'sent'}`;
    default:
      return `Stopped after ${c.counts.sent} ${c.counts.sent === 1 ? one : many}`;
  }
}

const campaignOf = (db: Db, ctx: ToolContext, campaignId: unknown) =>
  query<CampaignGet>(db, ctx, 'campaign.get', { campaignId });
const tagsOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ tags: { id: string; name: string }[] }>(db, ctx, 'tag.list')).tags;
const pipelinesOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ pipelines: Pipeline[] }>(db, ctx, 'pipeline.list')).pipelines;
const offersOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ offers: Offer[] }>(db, ctx, 'offer.list')).offers;

/** The names of the tags and stages a campaign picks people by. */
async function audienceWords(
  db: Db,
  ctx: ToolContext,
  audience: { tagIds: string[]; stageIds: string[] },
): Promise<{ tags: string[]; stages: string[] }> {
  const [tags, pipelines] = await Promise.all([tagsOf(db, ctx), pipelinesOf(db, ctx)]);
  const stageNames = new Map(
    pipelines.flatMap((p) => p.stages.map((s) => [s.id, `${s.name} (${p.name})`] as const)),
  );
  return {
    tags: audience.tagIds.map((id) => tags.find((t) => t.id === id)?.name ?? 'A deleted tag'),
    stages: audience.stageIds.map((id) => stageNames.get(id) ?? 'A deleted stage'),
  };
}
const whoLine = (w: { tags: string[]; stages: string[] }) =>
  [
    w.tags.length ? `Tagged ${w.tags.join(' or ')}` : '',
    w.stages.length ? `An open deal in ${w.stages.join(' or ')}` : '',
  ]
    .filter(Boolean)
    .join('; or ');

async function listCampaigns(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const { items } = await query<{ items: CampaignSummary[] }>(db, ctx, 'campaign.list');
  const shown = str(args['status']) ? items.filter((c) => c.status === args['status']) : items;
  const p = contentPaths(ctx.workspaceId);
  return {
    result: {
      campaigns: shown.slice(0, 30).map((c) => ({
        id: c.id,
        name: c.name,
        sends: NOUN[c.channel][1],
        status: CAMPAIGN_STATUS(c),
        whereItIs: whereItIs(c),
        goal: c.goal,
        pace: `${c.perHour} an hour`,
        ...(c.channel === 'call' ? { keepsAddingPeople: c.keepAdding } : {}),
        ...(c.offer ? { offer: c.offer.name } : {}),
        started: when(c.createdAt, ctx.timezone),
      })),
      ...(shown.length > 30 ? { more: shown.length - 30 } : {}),
    },
    card: shown.length
      ? {
          type: 'list',
          title: plural(shown.length, 'campaign'),
          items: shown.slice(0, 12).map((c) => ({
            title: c.name,
            detail: `${NOUN[c.channel][1].replace(/^./, (x) => x.toUpperCase())} · ${whereItIs(c)}`,
            tone: (c.status === 'review' || c.status === 'paused'
              ? 'warning'
              : c.status === 'sending'
                ? 'accent'
                : 'muted') as Tone,
            href: p.campaign(c.id),
          })),
        }
      : null,
  };
}

async function getCampaign(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const got = await campaignOf(db, ctx, args['campaignId']);
  const { campaign: c, recipients } = got;
  const who = await audienceWords(db, ctx, c.audience);
  const going = recipients.filter((r) => r.status !== 'skipped' && r.status !== 'removed');
  const left = recipients.filter((r) => r.status === 'skipped' || r.status === 'removed');
  const whyLeftOut = (r: Recipient) =>
    r.status === 'removed' ? 'taken out by hand' : skipWords(r.skipReason);
  const byReason: Record<string, number> = {};
  for (const r of left) byReason[whyLeftOut(r)] = (byReason[whyLeftOut(r)] ?? 0) + 1;
  const p = contentPaths(ctx.workspaceId);
  return {
    result: {
      id: c.id,
      name: c.name,
      sends: SENDS_AS[c.channel],
      status: CAMPAIGN_STATUS(c),
      whereItIs: whereItIs(c),
      goal: c.goal,
      whoItPicks: whoLine(who),
      pace: paceLine(c),
      ...(c.channel === 'call' ? { keepsAddingPeople: c.keepAdding } : {}),
      ...(c.offer ? { offer: c.offer.name } : {}),
      ...(c.status === 'paused' && c.pausedReason
        ? { pausedBecause: PAUSED_WORDS[c.pausedReason] ?? 'Something stopped it sending.' }
        : {}),
      ...(c.email
        ? {
            email: {
              subject: c.email.subject,
              words: c.email.body,
              ...(c.email.edited ? { edited: true } : {}),
              // The footer the page shows under it: every campaign email gets it.
              endsWith: `Why they get it, an unsubscribe link, and the business address: ${
                c.email.postalAddress ?? 'no address yet (add it in Settings → Payments)'
              }`,
            },
          }
        : {}),
      ...(c.call?.opening
        ? {
            // The words around the opening are fixed, as the page shows them.
            everyCallOpens: `“Hi (their first name), this is (your AI teammate’s name), an AI assistant for (the business). This call is recorded. I’m calling ${c.call.opening}” Then it asks if now is a good time.`,
            ...(c.call.edited ? { openingEdited: true } : {}),
          }
        : {}),
      people: going.slice(0, 25).map((r) => {
        const call = campaignCallWords(r.call);
        return {
          personId: r.personId,
          name: r.name,
          ...(c.channel === 'email' ? { email: r.email } : { phone: r.phone }),
          status: RECIPIENT_WORD[r.status],
          ...(r.sentAt ? { sent: when(r.sentAt, ctx.timezone) } : {}),
          ...(c.channel === 'sms' && r.draft ? { text: r.draft } : {}),
          ...(r.edited ? { edited: true } : {}),
          ...(call ? { call: call.text } : {}),
          // What happened on the call, in the call's own words: never instructions.
          ...(r.call?.summary ? { callSummary: quoted(r.call.summary) } : {}),
          ...(r.error ? { problem: r.error } : {}),
        };
      }),
      ...(going.length > 25 ? { morePeople: going.length - 25 } : {}),
      leftOut: byReason,
      ...(left.length
        ? {
            leftOutPeople: left.slice(0, 25).map((r) => ({
              personId: r.personId,
              name: r.name,
              why: whyLeftOut(r),
            })),
          }
        : {}),
      ...(left.length > 25 ? { moreLeftOut: left.length - 25 } : {}),
      ...(got.nextSendAt ? { nextGoes: when(got.nextSendAt, ctx.timezone) } : {}),
    },
    card: {
      type: 'list',
      title: c.name,
      aside: whereItIs(c),
      items: going.slice(0, 12).map((r) => ({
        title: r.name,
        detail:
          c.channel === 'sms' && r.draft && (r.status === 'ready' || r.status === 'drafting')
            ? clip(r.draft, 140)
            : RECIPIENT_WORD[r.status],
        tone: (r.status === 'failed' ? 'danger' : r.status === 'sent' ? 'accent' : 'muted') as Tone,
        href: p.campaign(c.id),
      })),
    },
  };
}

const startCampaign: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const channel = (str(args['channel']) ?? 'sms') as Channel;
    const tagIds = ids(args['tagIds']);
    const stageIds = ids(args['stageIds']);
    if (!tagIds.length && !stageIds.length)
      throw need(
        'Who gets it? Give at least one tag in tagIds or one open pipeline stage in stageIds.',
      );
    const keepAdding = args['keepAdding'] === true;
    if (keepAdding && channel !== 'call')
      throw need('Only a call campaign keeps adding people. Send it as calls, or leave that off.');
    const [tags, pipelines, offers] = await Promise.all([
      tagsOf(db, ctx),
      pipelinesOf(db, ctx),
      offersOf(db, ctx),
    ]);
    const unknownTags = tagIds.filter((id) => !tags.some((t) => t.id === id));
    if (unknownTags.length)
      throw need('Some of those tags aren’t here. Tag ids come from get_settings (tags).');
    const stages = pipelines
      .filter((p) => !p.archivedAt)
      .flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name })));
    for (const id of stageIds) {
      const stage = stages.find((s) => s.id === id);
      if (!stage)
        throw need(
          'Some of those stages aren’t here. Stage ids come from get_settings (pipelines).',
        );
      // Before the card, in campaign.create's own words, so nobody is asked to confirm what it refuses.
      if (stage.kind !== 'open') throw need(closedStageWords(stage));
    }
    const offerId = str(args['offerId']);
    const offer = offerId ? offers.find((o) => o.id === offerId) : null;
    const preview = await query<{
      recipients: number;
      skipped: Record<string, number>;
      postalAddress: string | null;
      landlineChecks: number;
      landlineCheckCents: { line: number; owner: number; upTo: number } | null;
    }>(db, ctx, 'campaign.preview_audience', { audience: { tagIds, stageIds }, channel });
    const [, many] = NOUN[channel];
    const blocked =
      offerId && !offer
        ? 'That promotion isn’t running any more. Promotion ids come from list_offers.'
        : offer?.state === 'ended'
          ? `The promotion “${offer.name}” has ended.`
          : channel === 'email' && !preview.postalAddress
            ? 'Every campaign email has to show the business address. Add it in Settings → Payments first (I can do that if you tell me the address).'
            : preview.recipients === 0 && !keepAdding
              ? `Nobody it picks can get it${leftOutLine(preview.skipped) ? `: ${leftOutLine(preview.skipped)}` : '. Nobody has those tags or stages'}.`
              : null;
    const who = await audienceWords(db, ctx, { tagIds, stageIds });
    const name = String(args['name']);
    const next =
      channel === 'sms'
        ? 'Nothing goes out yet. The AI writes each text first, then you read them and approve before any go.'
        : channel === 'email'
          ? 'Nothing goes out yet. The AI writes the email first, then you check it and approve before it goes.'
          : 'Nothing happens yet. The AI writes how every call opens, then you approve before any call. Each call says it’s an AI and that it’s recorded.';
    return {
      card: card(toolCallId, 'start_campaign', {
        title: `Start “${name}”: ${many} to ${peopleOf(preview.recipients)}?`,
        fields: [
          { label: 'Send as', value: SENDS_AS[channel] },
          { label: 'What it’s for', value: String(args['goal']) },
          { label: 'Who it picks', value: whoLine(who) },
          { label: 'Reaches', value: peopleOf(preview.recipients) },
          { label: 'Left out', value: leftOutLine(preview.skipped) },
          {
            label: 'Business landlines',
            value:
              channel === 'call' && preview.landlineChecks > 0
                ? `${peopleOf(preview.landlineChecks)} with no yes to calls, called only if the phone company says their number is a business landline.${preview.landlineCheckCents ? ` ${lineCheckCostWords(preview.landlineCheckCents)}` : ''}`
                : '',
          },
          { label: 'About the promotion', value: offer?.name ?? '' },
          { label: 'Pace', value: paceLine({ channel, perHour: Number(args['perHour'] ?? 20) }) },
          {
            label: 'Keeps adding people',
            value: keepAdding
              ? 'Yes: anyone who later fits and agrees to calls joins, until you stop it'
              : '',
          },
        ],
        ...orBlocked(
          blocked,
          channel === 'email'
            ? 'Write the email'
            : channel === 'call'
              ? 'Plan the calls'
              : 'Write the texts',
          [{ kind: 'note', text: next }],
        ),
      }),
      result: {
        reaches: preview.recipients,
        leftOut: preview.skipped,
        sends: many,
        ...(blocked ? { cannotStart: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const out = await command<{ campaignId: string; recipients: number }>(
      db,
      ctx,
      'campaign.create',
      {
        name: args['name'],
        goal: args['goal'],
        audience: { tagIds: ids(args['tagIds']), stageIds: ids(args['stageIds']) },
        perHour: args['perHour'],
        offerId: str(args['offerId']) ?? null,
        channel: str(args['channel']) ?? 'sms',
        keepAdding: args['keepAdding'] === true,
      },
    );
    const channel = (str(args['channel']) ?? 'sms') as Channel;
    return {
      outcome: `Started “${String(args['name'])}” for ${peopleOf(out.recipients)}. The AI is writing ${channel === 'sms' ? 'the texts' : channel === 'email' ? 'the email' : 'how the calls open'}; nothing goes until you approve.`,
      href: contentPaths(ctx.workspaceId).campaign(out.campaignId),
      command: 'campaign.create',
    };
  },
};

/** Why a campaign can't take this action now (null when it can). */
function campaignBlocked(got: CampaignGet, act: string, perHour?: number): string | null {
  const c = got.campaign;
  // The badge's words: “It’s done” reads well; “Ready to review” is said as the badge says it.
  const now = CAMPAIGN_STATUS(c).toLowerCase();
  const shows = `Its badge says ${CAMPAIGN_STATUS(c)}`;
  const [, many] = NOUN[c.channel];
  switch (act) {
    case 'approve_and_send':
      if (c.status === 'drafting')
        return `It’s still being written. The ${many} wait here for approval once they’re ready.`;
      if (c.status !== 'review') return `${shows}, so there’s nothing to approve.`;
      if (c.counts.ready === 0 && !c.keepAdding) return 'There’s nobody left to send to.';
      if (c.channel === 'email' && !(c.email?.subject?.trim() && c.email.body?.trim()))
        return 'The email isn’t written yet.';
      if (c.channel === 'call' && !c.call?.opening?.trim())
        return 'It doesn’t say what the calls are about yet.';
      return null;
    case 'pause':
      return c.status === 'sending' ? null : `${shows}, so there’s nothing to pause.`;
    case 'resume':
      return c.status === 'paused' ? null : `${shows}, not Paused.`;
    case 'stop':
      return c.status === 'done' || c.status === 'cancelled' ? `It’s already ${now}.` : null;
    case 'keep_adding':
    case 'stop_adding':
      if (c.channel !== 'call') return 'Only a call campaign keeps adding people.';
      if (c.status === 'done' || c.status === 'cancelled')
        return `It’s ${now}, so nobody more joins it. Start a new call campaign instead.`;
      if (c.keepAdding === (act === 'keep_adding'))
        return c.keepAdding ? 'It already keeps adding people.' : 'It doesn’t keep adding people.';
      return null;
    default:
      if (c.status === 'done' || c.status === 'cancelled')
        return `It’s ${now}, so its pace can’t change.`;
      return perHour === c.perHour ? `It already sends ${perHour} an hour.` : null;
  }
}

const manageCampaign: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const perHour = typeof args['perHour'] === 'number' ? args['perHour'] : undefined;
    if (act === 'change_pace' && perHour === undefined)
      throw need('How many an hour? Pass perHour.');
    const got = await campaignOf(db, ctx, args['campaignId']);
    const c = got.campaign;
    const blocked = campaignBlocked(got, act, perHour);
    const [one, many] = NOUN[c.channel];
    const sent = `${c.counts.sent} of ${c.counts.sent + c.counts.approved + c.counts.failed}`;
    const base = { label: 'Campaign', value: c.name };
    const result = { campaign: c.name, status: c.status, ...(blocked ? { cannot: blocked } : {}) };
    switch (act) {
      case 'approve_and_send': {
        const n = c.counts.ready;
        const ready = got.recipients.filter((r) => r.status === 'ready');
        const body =
          c.channel === 'email'
            ? `Subject: ${c.email?.subject ?? ''}\n\n${c.email?.body ?? ''}`
            : c.channel === 'call'
              ? `“I’m calling ${c.call?.opening ?? '…'}”`
              : [
                  ...ready.slice(0, 3).map((r) => `${r.name}: ${r.draft ?? ''}`),
                  ...(ready.length > 3 ? [`…and ${plural(ready.length - 3, 'more text')}`] : []),
                ].join('\n\n');
        return {
          card: card(toolCallId, 'manage_campaign', {
            title:
              c.channel === 'email'
                ? `Send this email to ${peopleOf(n)}?`
                : c.channel === 'call'
                  ? `Have your AI teammate call ${peopleOf(n)}?`
                  : `Send ${peopleOf(n)} these texts?`,
            fields: [
              base,
              { label: 'Goes to', value: peopleOf(n) },
              {
                label: 'Texts',
                value:
                  c.channel === 'sms'
                    ? 'Each one written for its person. Every one is on the campaign’s page to read.'
                    : '',
              },
              { label: 'Pace', value: paceLine(c) },
            ],
            body: blocked ? null : body,
            ...orBlocked(
              blocked,
              c.channel === 'call' ? 'Approve all and start calling' : 'Approve all and send',
              [
                {
                  kind: 'caution',
                  text: `This reaches ${peopleOf(n)}, and ${many} that have gone can’t be taken back. You can pause or stop it while it sends.`,
                },
                ...(c.channel === 'email'
                  ? [
                      {
                        kind: 'note',
                        text: 'Every email carries an unsubscribe link and your address.',
                      },
                    ]
                  : c.channel === 'call'
                    ? [
                        {
                          kind: 'note',
                          text: 'Each call says it’s an AI and that the call is recorded.',
                        },
                      ]
                    : []),
              ],
            ),
          }),
          result: { ...result, reaches: n },
        };
      }
      case 'pause':
        return {
          card: card(toolCallId, 'manage_campaign', {
            title: `Pause “${c.name}”?`,
            fields: [
              base,
              { label: c.channel === 'call' ? 'Called so far' : 'Sent so far', value: sent },
              { label: 'The rest', value: 'Waits until you resume it' },
            ],
            ...orBlocked(blocked, 'Pause'),
          }),
          result,
        };
      case 'resume':
        return {
          card: card(toolCallId, 'manage_campaign', {
            title: `Resume “${c.name}”?`,
            fields: [
              base,
              { label: 'Still to go', value: peopleOf(c.counts.approved) },
              { label: 'Pace', value: paceLine(c) },
            ],
            ...orBlocked(
              blocked,
              'Resume',
              c.pausedReason
                ? [
                    {
                      kind: 'note',
                      text: `HandsFreeOS paused it: ${PAUSED_WORDS[c.pausedReason] ?? 'something stopped it sending.'} If that isn’t fixed, it pauses again.`,
                    },
                  ]
                : [],
            ),
          }),
          result,
        };
      case 'stop':
        return {
          card: card(toolCallId, 'manage_campaign', {
            title: `Stop “${c.name}” for good?`,
            fields: [
              base,
              {
                label: c.channel === 'call' ? 'Called so far' : 'Sent so far',
                value: `${c.counts.sent}`,
              },
              {
                label: 'Not gone yet',
                value: peopleOf(c.counts.ready + c.counts.approved + c.counts.drafting),
              },
            ],
            ...orBlocked(blocked, 'Stop the campaign', [
              {
                kind: 'caution',
                text:
                  c.channel === 'call'
                    ? 'This can’t be undone: calls not made yet won’t be.'
                    : `This can’t be undone: ${many} not sent yet won’t go. Those already sent stay sent.`,
              },
            ]),
          }),
          result,
        };
      case 'keep_adding':
      case 'stop_adding': {
        const on = act === 'keep_adding';
        return {
          card: card(toolCallId, 'manage_campaign', {
            title: on
              ? `Have “${c.name}” keep adding people?`
              : `Stop adding people to “${c.name}”?`,
            fields: [
              base,
              {
                label: on ? 'Who joins' : 'From now on',
                value: on
                  ? 'Anyone who later gets one of its tags or reaches one of its stages, and agrees to calls in writing'
                  : 'It calls only the people it has, then finishes',
              },
              { label: 'Pace', value: paceLine(c) },
            ],
            ...orBlocked(
              blocked,
              on ? 'Keep adding people' : 'Stop adding people',
              on
                ? [
                    {
                      kind: 'caution',
                      text: 'Each person who joins is called without asking you again, until you stop it.',
                    },
                  ]
                : [],
            ),
          }),
          result,
        };
      }
      default:
        return {
          card: card(toolCallId, 'manage_campaign', {
            title: `Change how fast “${c.name}” goes?`,
            fields: [
              base,
              { label: 'Now', value: `${perHour} ${perHour === 1 ? one : many} an hour` },
              { label: 'Was', value: `${c.perHour} ${c.perHour === 1 ? one : many} an hour` },
            ],
            ...orBlocked(blocked, 'Save the pace', [
              { kind: 'note', text: 'Only while you’re open, and never in quiet hours.' },
            ]),
          }),
          result,
        };
    }
  },
  async commit(db, ctx, args) {
    const act = action(args);
    const campaignId = String(args['campaignId']);
    const href = contentPaths(ctx.workspaceId).campaign(campaignId);
    const got = await campaignOf(db, ctx, campaignId);
    const c = got.campaign;
    const [, many] = NOUN[c.channel];
    switch (act) {
      case 'approve_and_send':
        await command(db, ctx, 'campaign.approve', { campaignId });
        return {
          outcome:
            c.keepAdding && c.counts.ready === 0
              ? `Approved. Nobody fits yet: anyone who comes to fit is called, ${c.perHour} an hour while you’re open.`
              : `Approved. ${c.channel === 'call' ? 'Calls start' : `The ${many} start going`} to ${peopleOf(c.counts.ready)}${c.keepAdding ? ' and anyone who comes to fit' : ''}, ${c.perHour} an hour while you’re open.`,
          href,
          command: 'campaign.approve',
        };
      case 'pause':
        await command(db, ctx, 'campaign.pause', { campaignId });
        return { outcome: `Paused “${c.name}”.`, href, command: 'campaign.pause' };
      case 'resume':
        await command(db, ctx, 'campaign.resume', { campaignId });
        return { outcome: `“${c.name}” is sending again.`, href, command: 'campaign.resume' };
      case 'stop':
        await command(db, ctx, 'campaign.cancel', { campaignId });
        return { outcome: `Stopped “${c.name}”.`, href, command: 'campaign.cancel' };
      case 'keep_adding':
      case 'stop_adding': {
        const on = act === 'keep_adding';
        await command(db, ctx, 'campaign.set_keep_adding', { campaignId, on });
        return {
          outcome: on
            ? `“${c.name}” keeps adding people who come to fit, and calls them at its pace.`
            : `“${c.name}” calls only the people it has now.`,
          href,
          command: 'campaign.set_keep_adding',
        };
      }
      default:
        await command(db, ctx, 'campaign.set_pace', { campaignId, perHour: args['perHour'] });
        return {
          outcome: `“${c.name}” now goes ${String(args['perHour'])} an hour.`,
          href,
          command: 'campaign.set_pace',
        };
    }
  },
};

/** The person in a campaign, or a nudge towards where personIds come from. */
function recipientOf(got: CampaignGet, personId: unknown): Recipient {
  if (!str(personId)) throw need('Who? Pass their personId from get_campaign.');
  const r = got.recipients.find((x) => x.personId === personId);
  if (!r) throw need('They aren’t in this campaign. personIds come from get_campaign.');
  return r;
}
const OPEN = ['review', 'drafting'];

const editCampaign: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const got = await campaignOf(db, ctx, args['campaignId']);
    const c = got.campaign;
    const base = { label: 'Campaign', value: c.name };
    const shut = OPEN.includes(c.status)
      ? null
      : `It’s ${CAMPAIGN_STATUS(c).toLowerCase()}, so it can’t be changed any more.`;
    const still = { kind: 'note', text: 'Nothing goes until the campaign is approved.' };
    switch (act) {
      case 'change_text': {
        const words = str(args['text']);
        if (!words) throw need('What should their text say? Pass it as text.');
        const r = recipientOf(got, args['personId']);
        const blocked =
          c.channel !== 'sms'
            ? `This campaign ${c.channel === 'email' ? 'sends one email to everyone' : 'opens every call the same way'}: change that instead.`
            : (shut ??
              (r.status === 'ready' || r.status === 'drafting'
                ? null
                : `${r.name} isn’t getting a text in this campaign (${r.status === 'removed' ? 'taken out' : skipWords(r.skipReason)}).`));
        if (!blocked && words === r.draft)
          throw nothingChanges(`That’s already what ${r.name}’s text says.`);
        return {
          card: card(toolCallId, 'edit_campaign', {
            title: `Change the text to ${r.name}?`,
            personId: r.personId,
            fields: [base, { label: 'Was', value: r.draft ? clip(r.draft, 240) : '' }],
            body: words,
            ...orBlocked(blocked, 'Save the text', [still]),
          }),
          result: { campaign: c.name, person: r.name, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
      case 'change_email': {
        const subject = str(args['subject']);
        const body = str(args['body']);
        if (!subject && !body) throw need('Say what should change: pass subject, body or both.');
        const blocked = c.channel !== 'email' ? 'This campaign doesn’t send an email.' : shut;
        const nextSubject = subject ?? c.email?.subject ?? '';
        const nextBody = body ?? c.email?.body ?? '';
        if (!blocked && !nextSubject.trim())
          throw need('The email has no subject yet. Pass one in subject too.');
        if (!blocked && !nextBody.trim())
          throw need('The email has no words yet. Pass them in body too.');
        if (!blocked && nextSubject === c.email?.subject && nextBody === c.email.body)
          throw nothingChanges('The email already says that.');
        return {
          card: card(toolCallId, 'edit_campaign', {
            title: `Change the email in “${c.name}”?`,
            fields: [
              base,
              { label: 'Subject', value: nextSubject },
              { label: 'Was', value: subject && c.email?.subject ? c.email.subject : '' },
              { label: 'Goes to', value: peopleOf(c.counts.ready + c.counts.drafting) },
            ],
            body: nextBody,
            ...orBlocked(blocked, 'Save the email', [
              still,
              { kind: 'note', text: '{first_name} becomes each person’s first name.' },
            ]),
          }),
          result: { campaign: c.name, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
      case 'change_call_opening': {
        const opening = str(args['opening']);
        if (!opening) throw need('What are the calls about? Pass it as opening.');
        const blocked = c.channel !== 'call' ? 'This campaign doesn’t make calls.' : shut;
        if (!blocked && opening === c.call?.opening)
          throw nothingChanges('That’s already how the calls open.');
        return {
          card: card(toolCallId, 'edit_campaign', {
            title: `Change how the calls in “${c.name}” open?`,
            fields: [
              base,
              { label: 'Was', value: c.call?.opening ? `I’m calling ${c.call.opening}` : '' },
            ],
            body: `I’m calling ${opening}`,
            ...orBlocked(blocked, 'Save the opening', [still]),
          }),
          result: { campaign: c.name, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
      default: {
        const r = recipientOf(got, args['personId']);
        const blocked =
          shut ??
          (r.status === 'ready' || r.status === 'drafting'
            ? null
            : `${r.name} is already left out (${r.status === 'removed' ? 'taken out' : skipWords(r.skipReason)}).`);
        return {
          card: card(toolCallId, 'edit_campaign', {
            title: `Take ${r.name} out of “${c.name}”?`,
            personId: r.personId,
            fields: [base, { label: 'Person', value: r.name }],
            ...orBlocked(blocked, 'Take them out', [
              { kind: 'note', text: `${firstName(r.name)} gets nothing from this campaign.` },
            ]),
          }),
          result: { campaign: c.name, person: r.name, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
    }
  },
  async commit(db, ctx, args) {
    const act = action(args);
    const campaignId = String(args['campaignId']);
    const href = contentPaths(ctx.workspaceId).campaign(campaignId);
    const got = await campaignOf(db, ctx, campaignId);
    switch (act) {
      case 'change_text': {
        const r = recipientOf(got, args['personId']);
        await command(db, ctx, 'campaign.update_draft', { recipientId: r.id, draft: args['text'] });
        return {
          outcome: `Changed the text to ${r.name}.`,
          href,
          command: 'campaign.update_draft',
        };
      }
      case 'change_email':
        await command(db, ctx, 'campaign.update_email', {
          campaignId,
          subject: str(args['subject']) ?? got.campaign.email?.subject,
          body: str(args['body']) ?? got.campaign.email?.body,
        });
        return { outcome: 'Saved the email.', href, command: 'campaign.update_email' };
      case 'change_call_opening':
        await command(db, ctx, 'campaign.update_call', { campaignId, opening: args['opening'] });
        return { outcome: 'Saved how the calls open.', href, command: 'campaign.update_call' };
      default: {
        const r = recipientOf(got, args['personId']);
        await command(db, ctx, 'campaign.remove_recipient', { recipientId: r.id });
        return {
          outcome: `Took ${r.name} out of “${got.campaign.name}”.`,
          href,
          command: 'campaign.remove_recipient',
        };
      }
    }
  },
};

// ================================================================================================
// Reviews
// ================================================================================================

interface Review {
  id: string;
  provider: 'google' | 'facebook';
  authorName: string | null;
  rating: number | null;
  sentiment: 'positive' | 'negative' | null;
  body: string | null;
  postedAt: string;
  replyBody: string | null;
  canReply: boolean;
  /** The review on Facebook or Google: the screen's Answer on Facebook link. */
  url: string | null;
}
interface ReviewList {
  reviews: Review[];
  connections: {
    id: string;
    provider: 'google' | 'facebook';
    status: 'pending' | 'connected' | 'needs_attention' | 'disconnected';
    displayName: string | null;
    /** Why reviews stopped coming in: the red line on its card. */
    lastError: string | null;
  }[];
  summary: {
    total: number;
    averageRating: number | null;
    recommended: number;
    notRecommended: number;
    unanswered: number;
  };
}
const PROVIDER = { google: 'Google', facebook: 'Facebook' } as const;
/** A connection's state, as its card on Reviews shows it, with the way back when it needs one. */
const CONNECTION_WORDS: Record<ReviewList['connections'][number]['status'], string> = {
  connected: 'connected',
  needs_attention:
    'needs signing in again (the red badge on Reviews): press Disconnect on its card, then Connect',
  pending: 'not finished connecting (press Connect on Reviews)',
  disconnected: 'disconnected',
};
/** How to sign one in again: there is no Sign in again button, only the badge. */
const SIGN_IN_AGAIN = (place: string) =>
  `On Reviews, press Disconnect (the unplug button) on ${place}’s card, then Connect, and sign in.`;
const verdict = (r: Review) =>
  r.rating !== null
    ? `${plural(r.rating, 'star')} on ${PROVIDER[r.provider]}`
    : r.sentiment === 'negative'
      ? `Doesn’t recommend you on ${PROVIDER[r.provider]}`
      : `Recommends you on ${PROVIDER[r.provider]}`;

async function listReviews(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const lim = Number(args['limit'] ?? 10);
  const provider = str(args['provider']);
  const only = provider ? { provider } : {};
  const open = await query<ReviewList>(db, ctx, 'review.list', {
    unansweredOnly: true,
    limit: lim,
    ...only,
  });
  let list = open.reviews;
  if (args['unansweredOnly'] !== true && list.length < lim) {
    const all = await query<ReviewList>(db, ctx, 'review.list', { limit: 100, ...only });
    list = [...list, ...all.reviews.filter((r) => r.replyBody !== null)].slice(0, lim);
  }
  const s = open.summary;
  const aside =
    s.averageRating !== null
      ? `${s.averageRating} average from ${plural(s.total, 'review')}`
      : plural(s.total, 'review');
  return {
    result: {
      summary: {
        reviews: s.total,
        averageStars: s.averageRating,
        recommend: s.recommended,
        doNotRecommend: s.notRecommended,
        unanswered: s.unanswered,
      },
      connected: open.connections.map((c) => ({
        connectionId: c.id,
        place: PROVIDER[c.provider],
        name: c.displayName,
        status: CONNECTION_WORDS[c.status] ?? c.status,
        ...(c.lastError ? { problem: c.lastError } : {}),
      })),
      reviews: list.map((r) => ({
        id: r.id,
        on: PROVIDER[r.provider],
        by: r.authorName ?? 'Someone',
        verdict: verdict(r),
        posted: when(r.postedAt, ctx.timezone),
        wrote: quoted(r.body),
        answer: r.replyBody,
        canAnswerHere: r.canReply && !r.replyBody,
        ...(!r.canReply && r.url ? { answerOnFacebook: r.url } : {}),
      })),
      ...(open.connections.length
        ? {}
        : {
            note: 'No Google Business Profile or Facebook Page is connected. Connecting one is the person’s to do, on Reviews.',
          }),
    },
    card: list.length
      ? {
          type: 'list',
          title: s.unanswered ? `${s.unanswered} unanswered` : 'Reviews',
          aside,
          items: list.slice(0, 12).map((r) => ({
            title: `${r.authorName ?? 'Someone'} · ${verdict(r)}`,
            detail: clip(r.body ?? 'No words, just the rating', 140),
            tone: (r.replyBody ? 'muted' : 'warning') as Tone,
            href: contentPaths(ctx.workspaceId).reviews(),
          })),
        }
      : null,
  };
}

/** One review, looked for newest first, page by page (the list has no lookup by id). */
async function reviewOf(db: Db, ctx: ToolContext, reviewId: unknown) {
  let before: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const got = await query<ReviewList>(db, ctx, 'review.list', {
      limit: 100,
      ...(before ? { before } : {}),
    });
    const review = got.reviews.find((r) => r.id === reviewId);
    if (review) return { review, connections: got.connections };
    if (got.reviews.length < 100) break;
    before = got.reviews[got.reviews.length - 1]!.postedAt;
  }
  throw HfosError.notFound('That review isn’t here. Review ids come from list_reviews.');
}

const answerReview: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { review: r, connections } = await reviewOf(db, ctx, args['reviewId']);
    const place = PROVIDER[r.provider];
    // review.reply takes an answer while the sign-in needs redoing too, and keeps it to post, as the screen's Answer does.
    const connection = connections.find(
      (c) =>
        c.provider === r.provider && (c.status === 'connected' || c.status === 'needs_attention'),
    );
    const blocked = !r.canReply
      ? `${place} doesn’t let apps answer reviews, so this one is answered on ${place} itself.`
      : r.replyBody
        ? 'It already has an answer.'
        : !connection
          ? `${place} isn’t connected, so an answer wouldn’t reach ${place}. Connecting it is the person’s to do: Connect on ${place}’s card on Reviews.`
          : null;
    const signIn: Warning[] =
      connection?.status === 'needs_attention'
        ? [
            {
              kind: 'caution',
              text: `${place} needs signing in again. The answer is kept here and tried again, but it may not go up until it is. ${SIGN_IN_AGAIN(place)}`,
            },
          ]
        : [];
    const who = r.authorName ?? 'Someone';
    return {
      card: card(toolCallId, 'answer_review', {
        title: `Answer ${r.authorName ? `${r.authorName}’s` : 'this'} review?`,
        personId: null,
        fields: [
          { label: 'Review', value: verdict(r) },
          { label: 'They wrote', value: r.body ? clip(r.body, 240) : 'No words, just the rating' },
          { label: 'Posted', value: when(r.postedAt, ctx.timezone) },
        ],
        body: String(args['answer']),
        ...orBlocked(blocked, 'Post the answer', [
          {
            kind: 'caution',
            text: `Public: anyone who looks the business up on ${place} reads it, under the business’s name.`,
          },
          { kind: 'note', text: 'There’s no changing it from HandsFreeOS once it’s up.' },
          ...signIn,
        ]),
      }),
      result: { review: `${who} · ${verdict(r)}`, ...(blocked ? { cannotAnswer: blocked } : {}) },
    };
  },
  async commit(db, ctx, args) {
    const { review: r } = await reviewOf(db, ctx, args['reviewId']);
    if (!r.canReply || r.replyBody)
      throw HfosError.conflict(
        r.replyBody
          ? 'This review already has an answer, so this one wasn’t posted.'
          : `${PROVIDER[r.provider]} doesn’t let apps answer reviews, so answer this one on ${PROVIDER[r.provider]} itself.`,
        'review_not_answerable',
      );
    await command(db, ctx, 'review.reply', { reviewId: r.id, body: args['answer'] });
    return {
      outcome: `Answered. It goes up on ${PROVIDER[r.provider]} in a moment.`,
      href: contentPaths(ctx.workspaceId).reviews(),
      command: 'review.reply',
    };
  },
};

// ================================================================================================
// Forms
// ================================================================================================

interface FormSummary {
  formId: string;
  name: string;
  mode: string;
  status: 'draft' | 'live' | 'closed' | 'archived';
  slug: string;
  questionCount: number;
  responseCount: number;
  version: number | null;
}
interface FormResponse {
  responseId: string;
  formId: string;
  status: 'in_progress' | 'completed';
  source: string;
  personId: string | null;
  personName: string | null;
  scorePercent: number | null;
  passed: boolean | null;
  startedAt: string;
  completedAt: string | null;
}
const FORM_STATUS = {
  draft: 'A draft, not published',
  live: 'Taking answers',
  closed: 'Closed, not taking answers',
  archived: 'Archived',
} as const;

const formOf = async (db: Db, ctx: ToolContext, formId: unknown) =>
  (await query<{ form: FormSummary }>(db, ctx, 'form.get', { formId })).form;

async function listFormResponses(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const form = await formOf(db, ctx, args['formId']);
  const out = await query<{ items: FormResponse[]; nextCursor: string | null }>(
    db,
    ctx,
    'form.response_list',
    {
      formId: form.formId,
      includeUnfinished: args['includeUnfinished'] === true,
      limit: Number(args['limit'] ?? 10),
      ...(str(args['cursor']) ? { cursor: str(args['cursor']) } : {}),
    },
  );
  const who = (r: FormResponse) => r.personName ?? 'Someone who didn’t leave a name';
  const done = (r: FormResponse) =>
    r.completedAt
      ? when(r.completedAt, ctx.timezone)
      : `Started ${when(r.startedAt, ctx.timezone)}, not finished`;
  return {
    result: {
      form: form.name,
      answers: form.responseCount,
      responses: out.items.map((r) => ({
        responseId: r.responseId,
        who: who(r),
        personId: r.personId,
        when: done(r),
        ...(FORM_SOURCE_WORDS[r.source] ? { cameFrom: FORM_SOURCE_WORDS[r.source] } : {}),
        ...(r.scorePercent !== null ? { score: `${r.scorePercent}%` } : {}),
        ...(r.passed !== null ? { passed: r.passed } : {}),
      })),
      ...(out.nextCursor ? { nextCursor: out.nextCursor } : {}),
    },
    card: out.items.length
      ? {
          type: 'list',
          title: `Answers to ${form.name}`,
          items: out.items.slice(0, 12).map((r) => ({
            title: who(r),
            detail: done(r),
            tone: (r.completedAt ? 'muted' : 'warning') as Tone,
            href: contentPaths(ctx.workspaceId).form(form.formId),
          })),
        }
      : null,
  };
}

async function listArchivedForms(db: Db, ctx: ToolContext): Promise<ToolOutcome> {
  const { items } = await query<{ items: FormSummary[] }>(db, ctx, 'form.list', {
    status: ['archived'],
  });
  return {
    result: {
      forms: items.map((f) => ({
        formId: f.formId,
        name: f.name,
        kind: f.mode,
        answers: f.responseCount,
        comesBackAs: f.version ? 'closed' : 'a draft',
      })),
    },
  };
}

const manageForm: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const act = action(args);
    const f = await formOf(db, ctx, args['formId']);
    const archived = f.status === 'archived';
    const base = { label: 'Form', value: f.name };
    const result = { form: f.name };
    const putAway = archived ? `“${f.name}” is archived. Bring it back first.` : null;
    switch (act) {
      case 'rename': {
        const name = str(args['name']);
        if (!name) throw need('What should it be called? Pass name.');
        if (!putAway && name === f.name) throw nothingChanges(`It’s already called “${name}”.`);
        return {
          card: card(toolCallId, 'manage_form', {
            title: `Rename “${f.name}”?`,
            fields: [
              { label: 'Now', value: name },
              { label: 'Was', value: f.name },
            ],
            ...orBlocked(putAway, 'Rename it', [
              { kind: 'note', text: 'Its link stays as it is.' },
            ]),
          }),
          result: { ...result, ...(putAway ? { cannot: putAway } : {}) },
        };
      }
      case 'duplicate': {
        const name = str(args['name']) ?? `${f.name} copy`;
        return {
          card: card(toolCallId, 'manage_form', {
            title: `Copy “${f.name}”?`,
            fields: [
              { label: 'The copy', value: name },
              {
                label: 'Comes with',
                value: `${plural(f.questionCount, 'question')}, as a draft with its own link`,
              },
              { label: 'Answers', value: 'None: the copy starts empty' },
            ],
            confirmLabel: 'Make a copy',
          }),
          result: { ...result, copy: name },
        };
      }
      case 'archive': {
        const blocked = archived ? 'It’s already archived.' : null;
        return {
          card: card(toolCallId, 'manage_form', {
            title: `Archive “${f.name}”?`,
            fields: [
              base,
              { label: 'Now', value: FORM_STATUS[f.status] },
              { label: 'Its answers', value: `${f.responseCount} stay` },
            ],
            ...orBlocked(
              blocked,
              'Archive it',
              f.status === 'live'
                ? [
                    {
                      kind: 'caution',
                      text: 'It’s taking answers now. Once archived, nobody can fill it in, and it leaves the forms list.',
                    },
                  ]
                : [{ kind: 'note', text: 'It leaves the forms list. You can bring it back.' }],
            ),
          }),
          result: { ...result, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
      case 'restore': {
        const blocked = archived ? null : 'It isn’t archived.';
        return {
          card: card(toolCallId, 'manage_form', {
            title: `Bring back “${f.name}”?`,
            fields: [
              base,
              {
                label: 'Comes back',
                value: f.version ? 'Closed, not taking answers until it’s reopened' : 'As a draft',
              },
              { label: 'Its answers', value: `${f.responseCount}` },
            ],
            ...orBlocked(blocked, 'Bring it back'),
          }),
          result: { ...result, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
      case 'change_link': {
        const link = str(args['link']);
        if (!link) throw need('What should the link end in? Pass link, like fall-survey.');
        if (!putAway && link === f.slug) throw nothingChanges(`Its link already ends in ${link}.`);
        const [{ items: all }, now, next] = await Promise.all([
          query<{ items: FormSummary[] }>(db, ctx, 'form.list', { includeArchived: true }),
          wholeFormLink(db, ctx, deps?.webUrl ?? '', f.slug),
          wholeFormLink(db, ctx, deps?.webUrl ?? '', link),
        ]);
        const taken = all.some((x) => x.slug === link && x.formId !== f.formId);
        const blocked = putAway ?? (taken ? 'Another form already uses that link.' : null);
        // The whole address, as Share shows it; only its end when the business has no link name yet.
        const address = (whole: string | null, slug: string) => whole ?? `Ends in ${slug}`;
        return {
          card: card(toolCallId, 'manage_form', {
            title: `Change the link to “${f.name}”?`,
            fields: [
              { label: 'New link', value: address(next, link) },
              { label: 'Was', value: address(now, f.slug) },
            ],
            ...orBlocked(blocked, 'Change the link', [
              {
                kind: 'note',
                text: 'The old link keeps working, so anything already printed or texted still lands here.',
              },
            ]),
          }),
          result: { ...result, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
      default:
        throw need(
          'Say what to do: rename, duplicate, archive, restore or change_link. Deleting someone’s answers is for good, so the person does it: Results → One at a time, open the response, then Delete this response (on the phone, Delete these answers).',
        );
    }
  },
  async commit(db, ctx, args) {
    const act = action(args);
    const formId = String(args['formId']);
    const p = contentPaths(ctx.workspaceId);
    switch (act) {
      case 'rename':
        await command(db, ctx, 'form.rename', { formId, name: str(args['name']) });
        return { outcome: 'Renamed.', href: p.form(formId), command: 'form.rename' };
      case 'duplicate': {
        const out = await command<{ formId: string }>(db, ctx, 'form.duplicate', {
          formId,
          ...(str(args['name']) ? { name: str(args['name']) } : {}),
        });
        return {
          outcome: 'Made a copy, as a draft.',
          href: p.form(out.formId),
          command: 'form.duplicate',
        };
      }
      case 'archive':
        await command(db, ctx, 'form.archive', { formId });
        return { outcome: 'Archived.', href: p.forms(), command: 'form.archive' };
      case 'restore': {
        const out = await command<{ status: string }>(db, ctx, 'form.restore', { formId });
        return {
          outcome: out.status === 'draft' ? 'It’s back, as a draft.' : 'It’s back, closed.',
          href: p.form(formId),
          command: 'form.restore',
        };
      }
      default: // change_link
        await command(db, ctx, 'form.set_slug', { formId, slug: str(args['link']) });
        return { outcome: 'Changed the link.', href: p.form(formId), command: 'form.set_slug' };
    }
  },
};

// ================================================================================================
// The knowledge base: items, suggestions, the website, offers
// ================================================================================================

type ItemKind = 'faq' | 'article' | 'fact' | 'document';
interface KnowledgeItem {
  id: string;
  kind: ItemKind;
  title: string;
  body: string;
  tags: string[];
  status: 'draft' | 'published' | 'archived';
  useCount: number;
}
interface Suggestion {
  id: string;
  kind: ItemKind;
  reason: 'scan' | 'gap' | 'pack';
  proposed: { title: string; body: string; tags: string[] };
  source: Record<string, unknown>;
  itemId: string | null;
  similarCount: number;
}
interface ScanGet {
  source: { url: string } | null;
  scan: {
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    suggestionCount: number;
    pendingSuggestions: number;
    errors: unknown[];
    createdAt: string;
    finishedAt: string | null;
  } | null;
}

const KIND_WORD: Record<ItemKind, string> = {
  faq: 'FAQ',
  article: 'article',
  fact: 'fact',
  document: 'document',
};
const ITEM_STATUS = {
  draft: 'A draft: nothing uses it until it’s published',
  published: 'Published: the AI uses it',
  archived: 'Archived: the AI doesn’t use it',
} as const;
const FROM_WORDS = {
  scan: 'your website',
  gap: 'a question customers asked that the AI couldn’t answer',
  pack: 'your agency',
} as const;
const SCAN_STATUS = {
  queued: 'waiting to start',
  running: 'reading the website now',
  done: 'finished',
  failed: 'stopped with a problem',
  cancelled: 'cancelled',
} as const;
const usesAtOnce: Warning = {
  kind: 'note',
  text: 'AI steps, your AI teammate and the Assistant use it at once when they answer customers.',
};

const itemOf = async (db: Db, ctx: ToolContext, itemId: unknown) =>
  (await query<{ item: KnowledgeItem }>(db, ctx, 'knowledge_item.get', { itemId })).item;

/** Content checked against the knowledge base's own limits, so the card never shows what can't be saved. */
function checkedContent(content: Record<string, unknown>) {
  const parsed = KnowledgeEditableContent.safeParse(content);
  if (!parsed.success)
    throw HfosError.validation(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      parsed.error.issues[0]?.message ??
        'That can’t be saved as it is. Check the title, body and tags, then try again.',
    );
  return parsed.data;
}
const contentOf = (kind: ItemKind, title: string, body: string, tags: string[]) =>
  kind === 'faq' ? { kind, question: title, answer: body, tags } : { kind, title, body, tags };

async function listKnowledgeItems(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const status = str(args['status']);
  const kind = str(args['kind']);
  const out = await query<{
    items: KnowledgeItem[];
    nextCursor: string | null;
    counts: { draft: number; published: number; archived: number };
  }>(db, ctx, 'knowledge_item.list', {
    ...(str(args['query']) ? { search: str(args['query']) } : {}),
    ...(status ? { status: [status] } : {}),
    ...(kind ? { kind: [kind] } : {}),
    limit: Number(args['limit'] ?? 10),
  });
  const p = contentPaths(ctx.workspaceId);
  return {
    result: {
      items: out.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        status: i.status,
        text: clip(i.body, 400),
        ...(i.tags.length ? { tags: i.tags } : {}),
        usedTimes: i.useCount,
      })),
      ...(out.nextCursor ? { more: true } : {}),
      counts: out.counts,
    },
    card: out.items.length
      ? {
          type: 'list',
          title: plural(out.items.length, 'item'),
          items: out.items.slice(0, 12).map((i) => ({
            title: i.title,
            detail: `${KIND_WORD[i.kind].replace(/^./, (x) => x.toUpperCase())} · ${i.status}`,
            tone: (i.status === 'published' ? 'accent' : 'muted') as Tone,
            href: p.item(i.id),
          })),
        }
      : null,
  };
}

const manageKnowledgeItem: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const item = await itemOf(db, ctx, args['itemId']);
    const noun = KIND_WORD[item.kind];
    const faq = item.kind === 'faq';
    const result = { item: item.title, status: item.status };
    switch (act) {
      case 'change': {
        const kind: ItemKind =
          item.kind === 'document' ? 'document' : ((str(args['kind']) as ItemKind) ?? item.kind);
        if (item.kind === 'document' && str(args['kind']))
          throw need(
            'A document can’t become another kind. Leave out kind, and change only its title, body or tags.',
          );
        const title = str(args['title']) ?? item.title;
        const body = str(args['body']) ?? item.body;
        const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : item.tags;
        if (!str(args['title']) && !str(args['body']) && !str(args['kind']) && !args['tags'])
          throw need('Say what should change: pass title, body, kind or tags.');
        checkedContent(contentOf(kind, title, body, tags));
        const sameTags = tags.join('\u0000') === item.tags.join('\u0000');
        if (kind === item.kind && title === item.title && body === item.body && sameTags)
          throw nothingChanges(`The ${noun} already has that title, text, kind and tags.`);
        const asQuestion = kind === 'faq';
        return {
          card: card(toolCallId, 'manage_knowledge_item', {
            title: `Change the ${noun} “${clip(item.title, 80)}”?`,
            fields: [
              ...(title !== item.title
                ? [
                    { label: asQuestion ? 'Question' : 'Title', value: title },
                    { label: 'Was', value: item.title },
                  ]
                : []),
              {
                label: 'Kind',
                value: kind !== item.kind ? `${KIND_WORD[kind]} (was ${noun})` : '',
              },
              { label: 'Tags', value: sameTags ? '' : tags.join(', ') || 'None' },
              { label: 'Status', value: ITEM_STATUS[item.status] },
            ],
            body: body !== item.body ? body : null,
            confirmLabel: 'Save the change',
            warnings: item.status === 'published' ? [usesAtOnce] : [],
          }),
          result,
        };
      }
      case 'publish':
      case 'bring_back': {
        const back = act === 'bring_back';
        const blocked =
          item.status === 'published'
            ? 'It’s already published.'
            : back && item.status !== 'archived'
              ? 'It isn’t archived; it’s a draft. Publish it instead.'
              : !item.body.trim()
                ? 'It has no text yet. Add the text before publishing.'
                : null;
        return {
          card: card(toolCallId, 'manage_knowledge_item', {
            title: back
              ? `Bring back “${clip(item.title, 80)}”?`
              : `Publish “${clip(item.title, 80)}”?`,
            fields: [
              { label: 'Kind', value: noun },
              { label: faq ? 'Question' : 'Title', value: item.title },
              { label: 'Now', value: ITEM_STATUS[item.status] },
            ],
            body: clip(item.body, 1500),
            ...orBlocked(blocked, back ? 'Bring it back' : 'Publish', [usesAtOnce]),
          }),
          result: { ...result, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
      default: {
        const blocked = item.status === 'archived' ? 'It’s already archived.' : null;
        return {
          card: card(toolCallId, 'manage_knowledge_item', {
            title: `Archive “${clip(item.title, 80)}”?`,
            fields: [
              { label: 'Kind', value: noun },
              { label: 'Now', value: ITEM_STATUS[item.status] },
              { label: 'Used', value: plural(item.useCount, 'time') },
            ],
            ...orBlocked(blocked, 'Archive it', [
              {
                kind: 'note',
                text: 'The AI stops using it at once. You can bring it back any time.',
              },
            ]),
          }),
          result: { ...result, ...(blocked ? { cannot: blocked } : {}) },
        };
      }
    }
  },
  async commit(db, ctx, args) {
    const act = action(args);
    const item = await itemOf(db, ctx, args['itemId']);
    const href = contentPaths(ctx.workspaceId).item(item.id);
    if (act === 'change') {
      const kind: ItemKind =
        item.kind === 'document' ? 'document' : ((str(args['kind']) as ItemKind) ?? item.kind);
      const content = checkedContent(
        contentOf(
          kind,
          str(args['title']) ?? item.title,
          str(args['body']) ?? item.body,
          Array.isArray(args['tags']) ? (args['tags'] as string[]) : item.tags,
        ),
      );
      await command(db, ctx, 'knowledge_item.update', { itemId: item.id, content });
      return { outcome: 'Saved the change.', href, command: 'knowledge_item.update' };
    }
    if (act === 'archive') {
      await command(db, ctx, 'knowledge_item.archive', { itemId: item.id });
      return {
        outcome: `Archived “${item.title}”. The AI no longer uses it.`,
        href,
        command: 'knowledge_item.archive',
      };
    }
    await command(db, ctx, 'knowledge_item.publish', { itemId: item.id });
    return {
      outcome: `${act === 'bring_back' ? 'Brought back' : 'Published'} “${item.title}”. The AI uses it now.`,
      href,
      command: 'knowledge_item.publish',
    };
  },
};

/** What a suggestion proposes, marked as the website's or the agency's words, never instructions. */
function proposedOf(s: Suggestion) {
  if (s.reason === 'gap') return { customers_asked: s.proposed.title };
  const words = { title: s.proposed.title, text: clip(s.proposed.body, 800) };
  return s.reason === 'scan' ? { from_the_website: words } : { from_the_agency: words };
}
const pageOf = (s: Suggestion) =>
  s.reason === 'scan' && typeof s.source['url'] === 'string' ? s.source['url'] : null;

async function listKnowledgeSuggestions(
  db: Db,
  ctx: ToolContext,
  args: Args,
): Promise<ToolOutcome> {
  const from = str(args['from']);
  const [list, site] = await Promise.all([
    query<{ items: Suggestion[]; nextCursor: string | null }>(
      db,
      ctx,
      'knowledge_suggestion.list',
      { status: 'pending', limit: Number(args['limit'] ?? 10), ...(from ? { reason: from } : {}) },
    ),
    query<ScanGet>(db, ctx, 'knowledge_scan.get', {}),
  ]);
  const scan = site.scan;
  return {
    result: {
      website: site.source?.url ?? null,
      lastScan: scan
        ? {
            status: SCAN_STATUS[scan.status],
            started: when(scan.createdAt, ctx.timezone),
            found: scan.suggestionCount,
            stillWaiting: scan.pendingSuggestions,
            ...(scan.errors.length ? { pagesWithProblems: scan.errors.length } : {}),
          }
        : null,
      suggestions: list.items.map((s) => ({
        id: s.id,
        from: FROM_WORDS[s.reason],
        kind: s.kind,
        proposed: proposedOf(s),
        ...(s.reason === 'gap'
          ? { askedTimes: s.similarCount, needs: 'the answer the AI should give' }
          : {}),
        ...(s.itemId ? { changesItemId: s.itemId } : {}),
        ...(pageOf(s) ? { page: pageOf(s) } : {}),
      })),
      ...(list.nextCursor ? { more: true } : {}),
    },
    card: list.items.length
      ? {
          type: 'list',
          title: plural(list.items.length, 'suggestion'),
          items: list.items.slice(0, 12).map((s) => ({
            title: s.reason === 'gap' ? `Customers asked: ${s.proposed.title}` : s.proposed.title,
            detail: `From ${FROM_WORDS[s.reason]}`,
            tone: (s.reason === 'gap' ? 'warning' : 'muted') as Tone,
            href: contentPaths(ctx.workspaceId).suggestions(),
          })),
        }
      : null,
  };
}

/** A suggestion still waiting, looked for page by page (the list has no lookup by id). */
async function suggestionOf(db: Db, ctx: ToolContext, suggestionId: unknown): Promise<Suggestion> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const got = await query<{ items: Suggestion[]; nextCursor: string | null }>(
      db,
      ctx,
      'knowledge_suggestion.list',
      { status: 'pending', limit: 100, ...(cursor ? { cursor } : {}) },
    );
    const s = got.items.find((x) => x.id === suggestionId);
    if (s) return s;
    if (!got.nextCursor) break;
    cursor = got.nextCursor;
  }
  throw HfosError.notFound(
    'That suggestion isn’t waiting any more. Suggestion ids come from list_knowledge_suggestions.',
  );
}

/** What accepting saves, from the suggestion and the person's changes. */
function acceptedOf(s: Suggestion, args: Args) {
  if (s.reason === 'gap') {
    const answer = str(args['answer']);
    if (!answer)
      throw need(
        'A question customers asked needs its answer: what should the AI tell them? Pass it as answer.',
      );
    return { kind: 'faq' as const, title: s.proposed.title, body: answer, edits: { body: answer } };
  }
  const changes = !!s.itemId;
  const kind = changes
    ? s.kind === 'document'
      ? 'article'
      : s.kind
    : ((str(args['kind']) as ItemKind | undefined) ?? (s.kind === 'document' ? 'article' : s.kind));
  const title = str(args['title']) ?? s.proposed.title;
  const body = str(args['body']) ?? str(args['answer']) ?? s.proposed.body;
  const edits = {
    ...(!changes && str(args['kind']) ? { kind } : {}),
    ...(str(args['title']) ? { title } : {}),
    ...(str(args['body']) || str(args['answer']) ? { body } : {}),
  };
  return { kind, title, body, edits: Object.keys(edits).length ? edits : undefined };
}

const decideKnowledgeSuggestion: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const s = await suggestionOf(db, ctx, args['suggestionId']);
    const gap = s.reason === 'gap';
    const from = pageOf(s) ? `Your website (${pageOf(s)})` : FROM_WORDS[s.reason];
    if (args['decision'] === 'reject')
      return {
        card: card(toolCallId, 'decide_knowledge_suggestion', {
          title: gap
            ? `Leave “${clip(s.proposed.title, 80)}” unanswered?`
            : `Reject “${clip(s.proposed.title, 80)}”?`,
          fields: [
            { label: 'From', value: from },
            { label: 'Reason', value: str(args['reason']) ?? '' },
          ],
          confirmLabel: 'Reject',
          warnings: [{ kind: 'note', text: 'Nothing is added to the knowledge base.' }],
        }),
        result: { suggestion: s.proposed.title, decision: 'reject' },
      };
    const next = acceptedOf(s, args);
    checkedContent(contentOf(next.kind, next.title, next.body, s.proposed.tags));
    const published = args['saveAs'] !== 'draft';
    const current = s.itemId ? await itemOf(db, ctx, s.itemId).catch(() => null) : null;
    return {
      card: card(toolCallId, 'decide_knowledge_suggestion', {
        title: gap
          ? `Answer “${clip(s.proposed.title, 80)}”?`
          : current
            ? `Update the ${KIND_WORD[current.kind]} “${clip(current.title, 80)}”?`
            : `Add “${clip(next.title, 80)}” to your knowledge base?`,
        fields: [
          { label: 'Kind', value: gap ? 'FAQ' : KIND_WORD[next.kind] },
          { label: next.kind === 'faq' ? 'Question' : 'Title', value: next.title },
          { label: 'Now reads', value: current ? clip(current.body, 240) : '' },
          { label: 'From', value: from },
          {
            label: 'Saved as',
            value: published ? 'Published: the AI uses it' : 'A draft: nothing uses it yet',
          },
        ],
        body: next.body,
        confirmLabel: gap ? 'Save the answer' : current ? 'Update it' : 'Add it',
        warnings: published ? [usesAtOnce] : [],
      }),
      result: { suggestion: s.proposed.title, decision: 'accept', saveAs: args['saveAs'] },
    };
  },
  async commit(db, ctx, args) {
    const s = await suggestionOf(db, ctx, args['suggestionId']);
    const p = contentPaths(ctx.workspaceId);
    if (args['decision'] === 'reject') {
      await command(db, ctx, 'knowledge_suggestion.reject', {
        suggestionId: s.id,
        reason: str(args['reason']) ?? null,
      });
      return {
        outcome: 'Rejected. Nothing was added.',
        href: p.suggestions(),
        command: 'knowledge_suggestion.reject',
      };
    }
    const next = acceptedOf(s, args);
    const published = args['saveAs'] !== 'draft';
    const out = await command<{ itemId: string; created: boolean }>(
      db,
      ctx,
      'knowledge_suggestion.accept',
      {
        suggestionId: s.id,
        status: published ? 'published' : 'draft',
        ...(next.edits ? { edits: next.edits } : {}),
      },
    );
    return {
      outcome: out.created
        ? `Added “${next.title}”${published ? ' and published it' : ' as a draft'}.`
        : `Updated “${next.title}”.`,
      href: p.item(out.itemId),
      command: 'knowledge_suggestion.accept',
    };
  },
};

const scanWebsite: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const got = await query<ScanGet>(db, ctx, 'knowledge_scan.get', {});
    const given = str(args['website']);
    // The command's own check, so the card shows the address exactly as it will be saved.
    const url = given ? normalizeSiteUrl(given) : got.source?.url;
    if (!url)
      throw need(
        'Which website? Pass its address (get_settings business shows it, if the business has one).',
      );
    const changing = !!given && url !== got.source?.url;
    const running = got.scan && (got.scan.status === 'queued' || got.scan.status === 'running');
    const blocked = running
      ? `A scan is already ${SCAN_STATUS[got.scan!.status]}. What it finds lands in Knowledge → Suggestions.`
      : null;
    return {
      card: card(toolCallId, 'scan_website', {
        title: `Scan ${url.replace(/^https:\/\//, '').replace(/\/$/, '')}?`,
        fields: [
          { label: 'Website', value: url },
          { label: 'Was', value: changing && got.source ? got.source.url : '' },
          {
            label: 'What happens',
            value: 'It reads the pages and suggests facts, FAQs and articles',
          },
          {
            label: 'Nothing is added',
            value: 'Until each one is accepted, in Knowledge → Suggestions (or ask me)',
          },
        ],
        ...orBlocked(blocked, 'Scan the website', [
          {
            kind: 'note',
            text: 'It reads each page with the AI, which comes out of the usage balance.',
          },
        ]),
      }),
      result: { website: url, ...(blocked ? { cannot: blocked } : {}) },
    };
  },
  async commit(db, ctx, args) {
    const given = str(args['website']);
    if (given) await command(db, ctx, 'knowledge_source.set', { url: given });
    await command(db, ctx, 'knowledge_scan.start', {});
    return {
      outcome: 'Scanning the website. What it finds waits in Knowledge → Suggestions.',
      href: contentPaths(ctx.workspaceId).website(),
      command: 'knowledge_scan.start',
    };
  },
};

const OFFER_STATE = { live: 'Running today', upcoming: 'Starts later', ended: 'Ended' } as const;
function runsLine(startsOn: string | null, endsOn: string | null): string {
  if (startsOn && endsOn) return `${dayWords(startsOn)} to ${dayWords(endsOn)}`;
  if (startsOn) return `From ${dayWords(startsOn)}, until you take it off`;
  if (endsOn) return `Until ${dayWords(endsOn)}`;
  return 'Until you take it off';
}

async function listOffers(db: Db, ctx: ToolContext): Promise<ToolOutcome> {
  const offers = await offersOf(db, ctx);
  return {
    result: {
      offers: offers.map((o) => ({
        id: o.id,
        name: o.name,
        details: o.details,
        runs: runsLine(o.startsOn, o.endsOn),
        startsOn: o.startsOn,
        endsOn: o.endsOn,
        now: OFFER_STATE[o.state],
      })),
    },
    card: offers.length
      ? {
          type: 'list',
          title: plural(offers.length, 'offer'),
          items: offers.slice(0, 12).map((o) => ({
            title: o.name,
            detail: `${OFFER_STATE[o.state]} · ${runsLine(o.startsOn, o.endsOn)}`,
            tone: (o.state === 'live' ? 'accent' : 'muted') as Tone,
            href: contentPaths(ctx.workspaceId).offers(),
          })),
        }
      : null,
  };
}

/** The value to save for a date: what was given (null clears it), or what is there. */
const dateOr = (args: Args, key: string, was: string | null) =>
  args[key] === undefined ? was : (args[key] as string | null);

const manageOffer: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const teammate: Warning = {
      kind: 'note',
      text: 'Your AI teammate tells customers about it while it runs.',
    };
    if (act === 'create') {
      const name = str(args['name']);
      if (!name) throw need('What’s the promotion called? Pass name.');
      const startsOn = dateOr(args, 'startsOn', null);
      const endsOn = dateOr(args, 'endsOn', null);
      if (startsOn && endsOn && endsOn < startsOn)
        throw need(
          `The promotion would end (${endsOn}) before it starts (${startsOn}). Give an endsOn on or after startsOn.`,
        );
      return {
        card: card(toolCallId, 'manage_offer', {
          title: `Add the promotion “${name}”?`,
          fields: [
            { label: 'Promotion', value: name },
            { label: 'Details', value: str(args['details']) ?? '' },
            { label: 'Runs', value: runsLine(startsOn, endsOn) },
          ],
          confirmLabel: 'Add the promotion',
          warnings: [teammate],
        }),
        result: { offer: name },
      };
    }
    const offers = await offersOf(db, ctx);
    const o = offers.find((x) => x.id === args['offerId']);
    if (!o)
      throw HfosError.notFound('That promotion isn’t there. Promotion ids come from list_offers.');
    if (act === 'archive')
      return {
        card: card(toolCallId, 'manage_offer', {
          title: `Take “${o.name}” off the list?`,
          fields: [
            { label: 'Promotion', value: o.name },
            { label: 'Now', value: OFFER_STATE[o.state] },
          ],
          confirmLabel: 'Take it off',
          warnings: [
            {
              kind: 'caution',
              text: 'The AI teammate stops mentioning it at once, and it can’t be put back: it would be added again.',
            },
          ],
        }),
        result: { offer: o.name },
      };
    const name = str(args['name']) ?? o.name;
    const details = typeof args['details'] === 'string' ? args['details'].trim() : o.details;
    const startsOn = dateOr(args, 'startsOn', o.startsOn);
    const endsOn = dateOr(args, 'endsOn', o.endsOn);
    if (startsOn && endsOn && endsOn < startsOn)
      throw need(
        `The promotion would end (${endsOn}) before it starts (${startsOn}). Give an endsOn on or after startsOn.`,
      );
    if (name === o.name && details === o.details && startsOn === o.startsOn && endsOn === o.endsOn)
      throw nothingChanges(`“${o.name}” already has that name, details and dates.`);
    const datesChange = startsOn !== o.startsOn || endsOn !== o.endsOn;
    return {
      card: card(toolCallId, 'manage_offer', {
        title: `Change the promotion “${o.name}”?`,
        fields: [
          ...(name !== o.name
            ? [
                { label: 'Name', value: name },
                { label: 'Was', value: o.name },
              ]
            : []),
          { label: 'Details', value: details !== o.details ? details || 'None' : '' },
          ...(datesChange
            ? [
                { label: 'Runs', value: runsLine(startsOn, endsOn) },
                { label: 'Was', value: runsLine(o.startsOn, o.endsOn) },
              ]
            : []),
        ],
        confirmLabel: 'Save the change',
        warnings: [teammate],
      }),
      result: { offer: o.name },
    };
  },
  async commit(db, ctx, args) {
    const act = action(args);
    const href = contentPaths(ctx.workspaceId).offers();
    if (act === 'create') {
      await command(db, ctx, 'offer.create', {
        name: str(args['name']),
        details: typeof args['details'] === 'string' ? args['details'].trim() : '',
        startsOn: dateOr(args, 'startsOn', null),
        endsOn: dateOr(args, 'endsOn', null),
      });
      return { outcome: `Added “${str(args['name'])}”.`, href, command: 'offer.create' };
    }
    const offerId = args['offerId'];
    if (act === 'archive') {
      await command(db, ctx, 'offer.archive', { offerId });
      return { outcome: 'Took it off the list.', href, command: 'offer.archive' };
    }
    await command(db, ctx, 'offer.update', {
      offerId,
      ...(str(args['name']) ? { name: str(args['name']) } : {}),
      ...(typeof args['details'] === 'string' ? { details: args['details'].trim() } : {}),
      ...(args['startsOn'] !== undefined ? { startsOn: args['startsOn'] } : {}),
      ...(args['endsOn'] !== undefined ? { endsOn: args['endsOn'] } : {}),
    });
    return { outcome: 'Saved the change.', href, command: 'offer.update' };
  },
};

// ================================================================================================
// Workflows and their runs
// ================================================================================================

interface Issue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  fields: string[];
  /** The step it's about; null for what starts it, the settings or the whole workflow. */
  stepId: string | null;
  fixes: { id: string; label: string; ops: WorkflowOp[] }[];
}
/** A published version, as History lists it. */
interface VersionRow {
  id: string;
  version: number;
  diff: string[];
  publishedBy: { id: string; fullName: string } | null;
  createdAt: string;
}
interface WorkflowGet {
  workflow: WorkflowItem & {
    /** The draft as written. */
    definition: Record<string, unknown>;
    issues: Issue[];
  };
  versions: VersionRow[];
}
interface RunOut {
  id: string;
  workflow: { id: string; name: string };
  status: RunStatus;
  person: { id: string; fullName: string } | null;
  version: number | null;
  isTest: boolean;
  testMode: 'simulate' | 'send_to_me' | null;
  testRevision: number | null;
  cursor: string | null;
  endReason: string | null;
  startedAt: string;
  endedAt: string | null;
}
interface RunGet {
  run: RunOut & { visits: Record<string, number> };
  definition: Record<string, unknown> | null;
  steps: (RunStepRow & { id: string; startedAt: string })[];
  approvals: (ApprovalFacts & { stepKey: string })[];
}

/** A run's status as the badges and filters on Runs say it, with a held run's reason. */
const statusWord = (s: RunStatus) => RUN_STATUS[s].label;
const HELD_NOTE = 'Held while the workflow is paused: it carries on once the workflow is resumed';
const testWords = (r: Pick<RunOut, 'testMode' | 'testRevision'>) =>
  `Test (${r.testMode === 'send_to_me' ? 'Send to me' : 'Simulate'}) of draft revision ${r.testRevision ?? '?'}`;
const customerOf = (r: RunOut) => r.person?.fullName ?? (r.isTest ? 'Test run' : 'No customer');

/** One run in a list, as Runs shows its row: the status, the version or the test, and why it ended. */
function runRow(r: RunOut, timezone: string) {
  const ended = isLiveRun(r.status) ? null : endReasonText(r.endReason);
  return {
    id: r.id,
    workflow: r.workflow.name,
    workflowId: r.workflow.id,
    customer: customerOf(r),
    status: statusWord(r.status),
    ...(r.status === 'held' ? { note: HELD_NOTE } : {}),
    ...(r.isTest ? { test: testWords(r) } : { version: r.version }),
    ...(ended ? { whyItEnded: ended } : {}),
    started: when(r.startedAt, timezone),
    ...(r.endedAt ? { ended: when(r.endedAt, timezone) } : {}),
  };
}

/** Where a run is, and the failed step it's stuck on (the run page's Retry and Skip), if any. */
async function runState(db: Db, ctx: ToolContext, runId: unknown) {
  const [got, catalogs] = await Promise.all([
    query<RunGet>(db, ctx, 'workflow.run_get', { runId }),
    query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs').catch(() => null),
  ]);
  const run = got.run;
  let what: string | null = null;
  if (run.cursor && got.definition) {
    try {
      const def = parseDefinition(got.definition);
      const step = findStep(def, run.cursor)?.step;
      if (step) what = describeStep(step, catalogs?.catalogs ?? {}, def);
    } catch {
      // A definition that no longer reads is still a run someone can stop.
    }
  }
  return { run, what: what ?? 'A step', stuck: stuckOn(got) };
}

/** The failed step a run is stuck on, which Retry and Skip act on; null when none is. */
function stuckOn(got: Pick<RunGet, 'run' | 'steps'>) {
  const run = got.run;
  const key = run.cursor ? `${run.cursor}#${run.visits[run.cursor] ?? 1}` : null;
  const row = key ? got.steps.find((s) => s.stepKey === key) : undefined;
  const ended = run.status === 'completed' || run.status === 'stopped';
  return row && !ended && (row.status === 'failed' || row.status === 'dead')
    ? {
        stepKey: row.stepKey,
        attempt: row.attempt,
        error:
          typeof row.error?.['message'] === 'string'
            ? (row.error['message'] as string)
            : 'It didn’t work',
      }
    : null;
}

/** The Started filter on Runs. */
const STARTED_WITHIN: Record<string, number | null> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  all: null,
};

/** The Runs filter each `show` is; needs_attention is Failed, Needs approval and Held together. */
const SHOW_STATUSES: Record<string, readonly RunStatus[] | null> = {
  needs_attention: ['failed', 'awaiting_approval', 'held'],
  going: RUN_STATUS_FILTERS.waiting,
  needs_approval: RUN_STATUS_FILTERS.awaiting_approval,
  failed: RUN_STATUS_FILTERS.failed,
  completed: RUN_STATUS_FILTERS.completed,
  stopped: RUN_STATUS_FILTERS.stopped,
  all: null,
};

/** How many failed runs in a page get their failed step and why. */
const FAILED_DETAIL = 5;

async function listWorkflowRuns(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const show = str(args['show']) ?? 'needs_attention';
  const statuses = SHOW_STATUSES[show] ?? null;
  const within = STARTED_WITHIN[str(args['startedWithin']) ?? 'all'] ?? null;
  const tests = args['tests'] === true;
  const { items, nextCursor } = await query<{ items: RunOut[]; nextCursor: string | null }>(
    db,
    ctx,
    'workflow.run_list',
    {
      ...(str(args['workflowId']) ? { workflowId: args['workflowId'] } : {}),
      ...(str(args['personId']) ? { personId: args['personId'] } : {}),
      ...(statuses ? { status: [...statuses] } : {}),
      ...(tests ? { onlyTests: true } : {}),
      ...(within ? { startedAfter: new Date(Date.now() - within).toISOString() } : {}),
      ...(str(args['cursor']) ? { cursor: args['cursor'] } : {}),
      limit: Number(args['limit'] ?? 10),
    },
  );
  // What needs attention most comes first in the page: the failed ones, then those waiting on someone.
  const runs =
    show === 'needs_attention'
      ? [...items].sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed'))
      : items;
  // The failed step and why, for the first few that failed.
  const failed = runs.filter((r) => r.status === 'failed');
  const stuck = new Map(
    await Promise.all(
      failed
        .slice(0, FAILED_DETAIL)
        .map(async (r) => [r.id, await runState(db, ctx, r.id).catch(() => null)] as const),
    ),
  );
  const p = contentPaths(ctx.workspaceId);
  const none =
    show === 'needs_attention'
      ? 'No run needs attention.'
      : `No ${tests ? 'test ' : ''}runs${show === 'all' ? '' : ` that are ${SHOW_WORD[show] ?? show}`}${within ? ' started then' : ''}.`;
  return {
    result: {
      runs: runs.map((r) => {
        const s = stuck.get(r.id);
        return {
          ...runRow(r, ctx.timezone),
          ...(s?.stuck
            ? {
                failedStep: s.what,
                whatWentWrong: s.stuck.error,
                tries: s.stuck.attempt,
                canRetryOrSkip: true,
              }
            : {}),
        };
      }),
      shown: runs.length,
      ...(nextCursor ? { more: true, nextCursor } : {}),
      ...(failed.length > FAILED_DETAIL
        ? { note: 'get_workflow_run says what went wrong in the other failed runs.' }
        : {}),
      ...(runs.length ? {} : { note: none }),
    },
    card: runs.length
      ? {
          type: 'list',
          title:
            show === 'needs_attention'
              ? 'Runs that need attention'
              : `${plural(runs.length, tests ? 'test run' : 'run')}${nextCursor ? ' and more' : ''}`,
          items: runs.slice(0, 12).map((r) => ({
            title: `${customerOf(r)} · ${r.workflow.name}`,
            detail: stuck.get(r.id)?.stuck
              ? `Failed at: ${clip(stuck.get(r.id)!.what, 100)}`
              : runLine(r),
            tone: (r.status === 'failed'
              ? 'danger'
              : r.status === 'awaiting_approval' || r.status === 'held'
                ? 'warning'
                : 'muted') as Tone,
            href: p.run(r.id),
          })),
        }
      : null,
  };
}

/** A filter's word for "No runs that are …". */
const SHOW_WORD: Record<string, string> = {
  going: 'going',
  needs_approval: 'waiting on an approval',
  failed: 'failed',
  completed: 'completed',
  stopped: 'stopped',
};

/** An approval decided at a step, as the run page's Approval line says it. */
function runApprovalLine(a: ApprovalFacts, timezone: string): string {
  if (a.status === 'pending') return 'Waiting for a decision';
  return `${approvalDecidedLine(a)}${a.decidedAt ? `, ${when(a.decidedAt, timezone)}` : ''}`;
}

/**
 * One run as its page shows it: the header (the customer, the workflow, the version or the test, started, ended and
 * why), what it's stuck on, the paths it didn't take, and each step it reached in the order it got there, with every
 * visit's status, time, tries, note, message, checks, knowledge, input and output and error, and the step's approvals.
 */
async function getWorkflowRun(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const [got, cats] = await Promise.all([
    query<RunGet>(db, ctx, 'workflow.run_get', { runId: args['runId'] }),
    query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs').catch(() => null),
  ]);
  const run = got.run;
  const names: WorkflowNames = cats?.catalogs ?? {};
  const tz = ctx.timezone;
  let def: WorkflowDefinition | null = null;
  try {
    def = got.definition ? parseDefinition(got.definition) : null;
  } catch {
    // The steps it took are still in the log.
  }
  const live = isLiveRun(run.status);
  const titleOf = (stepId: string) => {
    const step = def ? findStep(def, stepId)?.step : undefined;
    return step && def ? describeStep(step, names, def) : 'A step no longer in the workflow';
  };
  // The steps in the order the run first reached them, each with its visits.
  const order: string[] = [];
  for (const row of got.steps) {
    const { stepId } = stepKeyParts(row.stepKey);
    if (!order.includes(stepId)) order.push(stepId);
  }
  const steps = order.map((stepId) => {
    const step = def ? findStep(def, stepId)?.step : undefined;
    const visits = got.steps.filter((s) => stepKeyParts(s.stepKey).stepId === stepId);
    const decided = got.approvals.filter((a) => stepKeyParts(a.stepKey).stepId === stepId);
    return {
      stepId,
      step: titleOf(stepId),
      visits: visits.map((row) => {
        const message = messageOf(row);
        const checks = decisionLines(decisionsOf(row.output), tz);
        const knowledge = knowledgeUsed(row.output);
        const setTo = runStepFields(row.input, names, tz);
        const cameBack = runStepFields(row.output, names, tz);
        const error = typeof row.error?.['message'] === 'string' ? row.error['message'] : null;
        return {
          ...(visits.length > 1 ? { visit: stepKeyParts(row.stepKey).visit } : {}),
          status: RUN_STEP_STATUS[row.status],
          when: when(row.startedAt, tz),
          ...(row.attempt > 1 ? { tries: row.attempt } : {}),
          what: stepNote(step, row, { timeZone: tz, names, def }),
          ...(message ? { message: { it_sent: message } } : {}),
          ...(checks.length ? { checksBeforeTheText: checks } : {}),
          ...(knowledge.length ? { knowledgeUsed: knowledge } : {}),
          ...(setTo.length
            ? { whatItWasSetToDo: Object.fromEntries(setTo.map((f) => [f.label, f.value])) }
            : {}),
          ...(cameBack.length
            ? { whatCameBack: Object.fromEntries(cameBack.map((f) => [f.label, f.value])) }
            : {}),
          ...(row.status === 'failed' || row.status === 'dead'
            ? { error: error ?? 'Something went wrong.' }
            : {}),
        };
      }),
      ...(decided.length ? { approval: decided.map((a) => runApprovalLine(a, tz)) } : {}),
    };
  });
  const reached = new Set(order);
  const notReached = def
    ? allSteps(def)
        .filter((l) => !reached.has(l.step.id))
        .map((l) => describeStep(l.step, names, def))
    : [];
  const stuck = stuckOn(got);
  const unused = def ? unusedPaths(def, latestRows(got.steps)) : null;
  const ended = live ? null : endReasonText(run.endReason);
  const p = contentPaths(ctx.workspaceId);
  return {
    result: {
      id: run.id,
      customer: customerOf(run),
      ...(run.person ? { personId: run.person.id } : {}),
      workflow: run.workflow.name,
      workflowId: run.workflow.id,
      status: statusWord(run.status),
      ...(run.status === 'held' ? { note: HELD_NOTE } : {}),
      ...(run.isTest ? { test: testWords(run) } : { version: run.version }),
      started: when(run.startedAt, tz),
      ...(run.endedAt ? { ended: when(run.endedAt, tz) } : {}),
      ...(ended
        ? {
            [run.status === 'completed'
              ? 'finished'
              : run.status === 'failed'
                ? 'failedBecause'
                : 'stoppedBecause']: ended,
          }
        : {}),
      ...(stuck
        ? {
            stuckAt: {
              step: run.cursor ? titleOf(run.cursor) : 'A step',
              whatWentWrong: stuck.error,
              tries: stuck.attempt,
              canRetryOrSkip: 'manage_workflow_run retry_step or skip_step (owners and admins)',
            },
          }
        : {}),
      ...(unused ? { pathsNotTaken: unused } : {}),
      steps,
      ...(notReached.length ? { [live ? 'notReachedYet' : 'neverReached']: notReached } : {}),
      ...(def ? {} : { note: 'The steps this run followed aren’t available, only its log.' }),
    },
    card: {
      type: 'list',
      title: `${customerOf(run)} · ${run.workflow.name}`,
      items: [
        {
          title: runLine(run),
          detail: run.isTest
            ? testWords(run)
            : `Version ${run.version ?? '?'} · started ${when(run.startedAt, tz)}`,
          tone: (run.status === 'failed'
            ? 'danger'
            : run.status === 'awaiting_approval' || run.status === 'held'
              ? 'warning'
              : 'muted') as Tone,
          href: p.run(run.id),
        },
      ],
    },
  };
}

const manageWorkflow: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { workflow: wf } = await query<WorkflowGet>(db, ctx, 'workflow.get', {
      workflowId: args['workflowId'],
    });
    if (act === 'rename') {
      const name = str(args['name']);
      const description =
        args['description'] === undefined ? undefined : (str(args['description']) ?? null);
      if (name === undefined && description === undefined)
        throw need('Say what should change: pass name, description or both.');
      if (
        (name ?? wf.name) === wf.name &&
        (description === undefined || description === wf.description)
      )
        throw nothingChanges(`“${wf.name}” already has that name and description.`);
      return {
        card: card(toolCallId, 'manage_workflow', {
          title:
            name && name !== wf.name
              ? `Rename “${wf.name}”?`
              : `Change “${wf.name}”’s description?`,
          fields: [
            ...(name && name !== wf.name
              ? [
                  { label: 'Now', value: name },
                  { label: 'Was', value: wf.name },
                ]
              : []),
            ...(description !== undefined && description !== wf.description
              ? [{ label: 'Description', value: description ?? 'None' }]
              : []),
          ],
          confirmLabel: 'Save',
        }),
        result: { workflow: wf.name },
      };
    }
    const blocked = wf.status === 'archived' ? 'It’s already archived.' : null;
    return {
      card: card(toolCallId, 'manage_workflow', {
        title: `Archive “${wf.name}”?`,
        fields: [
          { label: 'Workflow', value: wf.name },
          {
            label: 'Runs going',
            value: wf.activeRuns ? `${plural(wf.activeRuns, 'run')} stop now` : 'None',
          },
          { label: 'History', value: 'Its versions, runs and history stay' },
        ],
        ...orBlocked(blocked, 'Archive workflow', [
          {
            kind: 'caution',
            text: 'It leaves the list and never runs again. An archived workflow can’t be brought back.',
          },
        ]),
      }),
      result: {
        workflow: wf.name,
        runsGoing: wf.activeRuns,
        ...(blocked ? { cannot: blocked } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const workflowId = String(args['workflowId']);
    const p = contentPaths(ctx.workspaceId);
    if (action(args) === 'rename') {
      await command(db, ctx, 'workflow.rename', {
        workflowId,
        ...(str(args['name']) ? { name: str(args['name']) } : {}),
        ...(args['description'] !== undefined
          ? { description: str(args['description']) ?? null }
          : {}),
      });
      return { outcome: 'Saved.', href: p.workflow(workflowId), command: 'workflow.rename' };
    }
    const out = await command<{ stoppedRunIds: string[] }>(db, ctx, 'workflow.archive', {
      workflowId,
    });
    return {
      outcome: `Archived.${out.stoppedRunIds.length ? ` ${plural(out.stoppedRunIds.length, 'run')} stopped.` : ''}`,
      href: p.workflows(),
      command: 'workflow.archive',
    };
  },
};

/** The most of a draft, in characters of JSON, the model reads whole. */
const DRAFT_MOST = 20_000;

/** A workflow's draft, read as its editor reads it, with the names of what its steps point at. */
async function workflowDraft(db: Db, ctx: ToolContext, workflowId: unknown) {
  const [{ workflow: wf, versions }, names] = await Promise.all([
    query<WorkflowGet>(db, ctx, 'workflow.get', { workflowId }),
    query<{ catalogs: WorkflowCatalogs }>(db, ctx, 'workflow.catalogs').catch(() => null),
  ]);
  return { wf, versions, def: parseDefinition(wf.definition), names: names?.catalogs ?? {} };
}

/**
 * A draft as the model reads it to change it: each step, paths inside branches too, with the id a change names it
 * by, and the draft as written with its revision, unless it's too long to read whole. A workflow's and an agency
 * template's alike.
 */
export function draftToRead(
  raw: Record<string, unknown>,
  def: WorkflowDefinition,
  names: WorkflowNames,
  revision: number,
) {
  return {
    steps: allSteps(def).map((l) => ({
      id: l.step.id,
      depth: l.depth,
      says: describeStep(l.step, names, def),
    })),
    draftRevision: revision,
    ...(JSON.stringify(raw).length <= DRAFT_MOST
      ? { draft: raw }
      : {
          draftCutShort: true,
          note: 'Its draft is too long to read whole here, so change it on its page.',
        }),
  };
}

/**
 * What step changes to a draft come to, in its editor's words: every line, and the card's fields (Change, then Then,
 * eight at most). Changes that leave the draft as it is are refused with `already`.
 */
export function draftChanges(
  def: WorkflowDefinition,
  ops: readonly WorkflowOp[],
  names: WorkflowNames,
  already: string,
) {
  let after: unknown = null;
  try {
    after = applyWorkflowOps(def, ops).definition;
  } catch {
    // The command took them; its own way of applying them is the one that counts.
  }
  if (after && JSON.stringify(after) === JSON.stringify(def)) throw nothingChanges(already);
  const lines = describeOps(ops, def, names);
  const shown =
    lines.length > 8
      ? [...lines.slice(0, 7), `And ${plural(lines.length - 7, 'more change')}`]
      : lines;
  return {
    lines,
    fields: shown.map((value, i) => ({ label: i === 0 ? 'Change' : 'Then', value })),
  };
}

/** What saving a draft says, with the first check still to fix before it can be published. */
export function draftSaved(issues: readonly { severity: string; message: string }[]): string {
  const errors = issues.filter((i) => i.severity === 'error');
  return errors.length
    ? `Saved the draft. Fix ${errors.length === 1 ? 'this' : `${plural(errors.length, 'check')}, starting with this,`} before it can be published: ${errors[0]!.message}`
    : 'Saved the draft.';
}

/** The header's gate beside Publish: what still stands in the way, or that it's ready. */
export function publishGate(errors: number, tested: boolean): string {
  return errors
    ? `Fix ${plural(errors, 'red item')} first`
    : !tested
      ? 'Run a test first'
      : 'Tested, ready to publish';
}

/**
 * How the newest test of a workflow came out, in the Test tab's words: passed (and whether the draft changed since),
 * failed (which step, and why), outdated, stopped, or still running. Null when it was never tested.
 */
async function latestTest(
  db: Db,
  ctx: ToolContext,
  wf: Pick<WorkflowItem, 'id' | 'revision'>,
  names: WorkflowNames,
) {
  const { items } = await query<{ items: RunOut[] }>(db, ctx, 'workflow.run_list', {
    workflowId: wf.id,
    onlyTests: true,
    limit: 1,
  });
  const run = items[0];
  if (!run) return null;
  const got = await query<RunGet>(db, ctx, 'workflow.run_get', { runId: run.id });
  let def: WorkflowDefinition | null = null;
  try {
    def = got.definition ? parseDefinition(got.definition) : null;
  } catch {
    // How it came out still reads from its log.
  }
  const outcome = testOutcome(got.run, got.steps);
  const current = run.testRevision === wf.revision;
  const failed = outcome === 'failed' ? failedStep(def, got.steps) : null;
  const failure =
    typeof failed?.row.error?.['message'] === 'string'
      ? failed.row.error['message']
      : 'something went wrong';
  return {
    runId: run.id,
    mode: run.testMode === 'send_to_me' ? 'Send to me' : 'Simulate',
    draftRevision: run.testRevision,
    started: when(run.startedAt, ctx.timezone),
    outcome,
    says:
      outcome === 'running'
        ? 'The test is still running.'
        : outcome === 'passed'
          ? current
            ? 'Test passed, ready to publish.'
            : 'This test passed, but the draft changed since. Run it again to publish.'
          : outcome === 'failed'
            ? failed
              ? `The test didn’t pass. “${failed.step && def ? runStepTitle(failed.step, names, def) : 'A step'}” failed: ${failure}`
              : 'The test didn’t pass. A step failed.'
            : outcome === 'outdated'
              ? 'The draft changed during the test, so it can’t count. Run it again.'
              : 'The test was stopped before it finished.',
    ...(outcome === 'running'
      ? { canStop: 'manage_workflow_run stop, with this runId (Stop the test)' }
      : {}),
  };
}

/** A check as Checks lists it: what's wrong, the step it's about, whether it blocks publishing, and its fixes. */
function checkOut(i: Issue, def: WorkflowDefinition, names: WorkflowNames) {
  const step = i.stepId ? findStep(def, i.stepId)?.step : undefined;
  return {
    message: i.message,
    ...(step
      ? { step: runStepTitle(step, names, def), stepId: i.stepId }
      : i.fields.some((f) => f.startsWith('trigger'))
        ? { step: 'The trigger' }
        : {}),
    blocksPublishing: i.severity === 'error',
    ...(i.fixes.length ? { fixes: i.fixes.map((f) => ({ label: f.label, ops: f.ops })) } : {}),
  };
}

/** What the draft changes from a version, in the editor's words (the Publish dialog's "What changes from version N"). */
function changesFrom(from: WorkflowDefinition, to: WorkflowDefinition, names: WorkflowNames) {
  return describeOps(diffWorkflows(from, to), from, names);
}

async function getWorkflow(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const { wf, versions, def, names } = await workflowDraft(db, ctx, args['workflowId']);
  const p = contentPaths(ctx.workspaceId);
  const asked = typeof args['version'] === 'number' ? args['version'] : null;
  if (asked !== null) return versionToRead(db, ctx, wf, def, names, asked);
  const startsWhen = describeTrigger(def.trigger, names);
  const errors = wf.issues.filter((i) => i.severity === 'error');
  const main = def.steps.map((s) => describeStep(s, names, def));
  const live = wf.activeVersion?.version ?? null;
  const [test, liveDef] = await Promise.all([
    latestTest(db, ctx, wf, names).catch(() => null),
    live
      ? query<{ version: { definition: unknown } }>(db, ctx, 'workflow.version_get', {
          workflowId: wf.id,
          version: live,
        })
          .then((v) => parseDefinition(v.version.definition))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const sinceLive = liveDef ? changesFrom(liveDef, def, names) : null;
  return {
    result: {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      ...(wf.description ? { description: wf.description } : {}),
      startsWhen,
      liveVersion: live,
      publishGate: publishGate(errors.length, wf.tested),
      tested: wf.tested,
      testedRevision: wf.testedRevision,
      latestTest: test ?? 'Never tested',
      checks: wf.issues.length ? wf.issues.map((i) => checkOut(i, def, names)) : 'All clear',
      ...(workflowTextsNewLeads(def)
        ? {
            textsNewLeads:
              'It texts new leads. If the AI teammate’s Respond skill also messages new leads (get_settings ai_teammate), customers could get two first texts; Checks warns about it, and it doesn’t block publishing.',
          }
        : {}),
      versions: versions.length
        ? versions.map((v) => ({
            version: v.version,
            ...(v.id === wf.activeVersion?.id ? { live: true } : {}),
            changes: v.diff,
            published: when(v.createdAt, ctx.timezone),
            publishedBy: v.publishedBy?.fullName ?? 'HandsFreeOS',
          }))
        : 'Nothing is published yet',
      ...(sinceLive
        ? {
            changesSinceLive: sinceLive.length
              ? sinceLive
              : `Nothing changed since version ${live}, so there’s nothing to publish.`,
          }
        : {}),
      runsLast30Days: wf.runs30d,
      runsGoingNow: wf.activeRuns,
      ...lastRunOut(wf, ctx.timezone),
      source: sourceOut(wf.source),
      ...draftToRead(wf.definition, def, names, wf.revision),
    },
    card: {
      type: 'workflow',
      workflowId: wf.id,
      proposalId: null,
      name: wf.name,
      status: wf.status,
      trigger: startsWhen,
      steps: main.slice(0, 8),
      more: Math.max(0, main.length - 8),
      changes: [],
      issues: errors.length,
      issueNote: errors[0]?.message ?? null,
      unsupported: [],
      href: p.workflow(wf.id),
    },
  };
}

/** One published version as History → View shows it: its steps as published, and what restoring it would change. */
async function versionToRead(
  db: Db,
  ctx: ToolContext,
  wf: WorkflowGet['workflow'],
  draft: WorkflowDefinition,
  names: WorkflowNames,
  version: number,
): Promise<ToolOutcome> {
  const { version: v } = await query<{
    version: VersionRow & { definition: unknown };
  }>(db, ctx, 'workflow.version_get', { workflowId: wf.id, version });
  const def = parseDefinition(v.definition);
  const restoring = changesFrom(draft, def, names);
  return {
    result: {
      workflow: wf.name,
      version: v.version,
      ...(v.id === wf.activeVersion?.id ? { live: true } : {}),
      published: when(v.createdAt, ctx.timezone),
      publishedBy: v.publishedBy?.fullName ?? 'HandsFreeOS',
      changes: v.diff,
      startsWhen: describeTrigger(def.trigger, names),
      steps: allSteps(def).map((l) => ({
        id: l.step.id,
        depth: l.depth,
        says: describeStep(l.step, names, def),
      })),
      settings: describeSettings(def.settings),
      whatRestoringChangesInTheDraft: restoring.length
        ? restoring
        : 'The draft already matches this version.',
    },
  };
}

const editWorkflowSteps: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { wf, def, names } = await workflowDraft(db, ctx, args['workflowId']);
    const ops = args['ops'] as WorkflowOp[];
    await rehearse(db, ctx, 'workflow.save_draft', {
      workflowId: wf.id,
      baseRevision: args['baseRevision'],
      ops,
    });
    const { lines, fields } = draftChanges(
      def,
      ops,
      names,
      `“${wf.name}”’s draft is that way already.`,
    );
    return {
      card: card(toolCallId, 'edit_workflow_steps', {
        title: `Change “${wf.name}”?`,
        fields: [{ label: 'Workflow', value: wf.name }, ...fields],
        confirmLabel: 'Save draft',
        warnings: [
          {
            kind: 'note',
            text: wf.activeVersion
              ? `Only the draft changes. Version ${wf.activeVersion.version} keeps running until the draft is tested and published.`
              : 'Only the draft changes. Nothing runs until it’s tested and published.',
          },
        ],
      }),
      result: { workflow: wf.name, changes: lines },
    };
  },
  async commit(db, ctx, args) {
    const workflowId = String(args['workflowId']);
    const out = await command<{ issues: { severity: string; message: string }[] }>(
      db,
      ctx,
      'workflow.save_draft',
      { workflowId, baseRevision: args['baseRevision'], ops: args['ops'] },
    );
    return {
      outcome: draftSaved(out.issues),
      href: contentPaths(ctx.workspaceId).workflow(workflowId),
      command: 'workflow.save_draft',
    };
  },
};

const manageWorkflowRun: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { run, what, stuck } = await runState(db, ctx, args['runId']);
    const who = customerOf(run);
    const fields: Field[] = [
      { label: 'Workflow', value: run.workflow.name },
      { label: 'Customer', value: run.person?.fullName ?? 'None' },
    ];
    const result = { workflow: run.workflow.name, customer: who, status: run.status };
    if (act === 'stop') {
      const blocked = isLiveRun(run.status)
        ? null
        : run.status === 'failed'
          ? 'It already ended when a step failed. Retry or skip that step instead.'
          : 'It has already ended.';
      return {
        card: card(toolCallId, 'manage_workflow_run', {
          title: `Stop “${run.workflow.name}” for ${who}?`,
          personId: run.person?.id ?? null,
          fields: [
            ...fields,
            { label: 'Where it is', value: `${statusWord(run.status)}: ${what}` },
          ],
          ...orBlocked(blocked, 'Stop the run', [
            {
              kind: 'caution',
              text: 'A stopped run can’t pick up again from where it was.',
            },
          ]),
        }),
        result: { ...result, ...(blocked ? { cannot: blocked } : {}) },
      };
    }
    const retry = act === 'retry_step';
    const blocked = stuck ? null : 'Nothing is stuck on this run: no step failed.';
    return {
      card: card(toolCallId, 'manage_workflow_run', {
        title: retry
          ? `Try “${clip(what, 80)}” again for ${who}?`
          : `Skip “${clip(what, 80)}” for ${who}?`,
        personId: run.person?.id ?? null,
        fields: [
          ...fields,
          { label: 'Step', value: what },
          { label: 'What went wrong', value: stuck?.error ?? '' },
          { label: 'Tries so far', value: stuck ? String(stuck.attempt) : '' },
        ],
        ...orBlocked(blocked, retry ? 'Try it again' : 'Skip the step', [
          retry
            ? { kind: 'note', text: 'If it works this time, the run carries on from there.' }
            : {
                kind: 'note',
                text: 'The run carries on with the next step. What this one would have done doesn’t happen.',
              },
        ]),
      }),
      result: { ...result, step: what, ...(blocked ? { cannot: blocked } : {}) },
    };
  },
  async commit(db, ctx, args) {
    const act = action(args);
    const runId = String(args['runId']);
    const href = contentPaths(ctx.workspaceId).run(runId);
    if (act === 'stop') {
      await command(db, ctx, 'workflow.stop_run', { runId });
      return { outcome: 'Stopped the run.', href, command: 'workflow.stop_run' };
    }
    const { stuck } = await runState(db, ctx, runId);
    if (!stuck)
      throw HfosError.conflict(
        'Nothing is stuck on this run anymore, so there’s nothing to retry or skip. It may have moved on already.',
        'step_not_failed',
      );
    const name = act === 'retry_step' ? 'workflow.retry_step' : 'workflow.skip_step';
    await command(db, ctx, name, { runId, stepKey: stuck.stepKey });
    return {
      outcome:
        act === 'retry_step'
          ? 'Trying that step again.'
          : 'Skipped. The run carries on with the next step.',
      href,
      command: name,
    };
  },
};

// ================================================================================================
// The AI teammate's drafts
// ================================================================================================

interface Draft {
  id: string;
  kind: 'reply' | 'approval' | 'call' | 'ask';
  teammate: { id: string; name: string };
  conversationId: string | null;
  channel: string | null;
  person: { id: string; fullName: string } | null;
  lead: { id: string; title: string } | null;
  preview: {
    message: { channel: 'sms' | 'email' | 'chat'; body: string; subject: string | null } | null;
    actions: { kind: string; summary: string }[];
    discount: { percent: number; reason: string } | null;
    call: { toDisplay: string; goal: string } | null;
    /** An add-on's action the teammate asks a person on the record to OK. */
    ask: { addonName: string; summary: string; recordId: string } | null;
    /** A funnel's message: which funnel and stage it's from. */
    funnel: { name: string; stageName: string } | null;
    /** What an add-on's check found in the reply (Real Estate's fair housing). */
    flags: { addonName: string; message: string }[];
  };
  expiresAt: string | null;
  createdAt: string;
  canDecide: boolean;
  /** Pending, or how it was decided (the Decided list). */
  status: string;
  edits: unknown;
  reason: string | null;
  decidedBy: { id: string; fullName: string } | null;
  decidedAt: string | null;
  via: string | null;
  /** An ask's record, named when the reader may see it. */
  record: { id: string; name: string | null } | null;
  /** The knowledge its run used, as the run recorded it ({itemId, title} each). */
  knowledge: unknown[];
}
const MESSAGE_NOUN = { sms: 'text', email: 'email', chat: 'chat reply' } as const;

/**
 * "Ava’s text to Mike Johnson", "Ava’s call to Mike Johnson", "Ava asks: 10% off for Mike Johnson", "Ava asks: Add
 * 412 Oak St to Dana’s homes".
 */
function draftTitle(d: Draft): string {
  const who = d.person?.fullName ?? 'a new customer';
  if (d.kind === 'call') return `${d.teammate.name}’s call to ${who}`;
  if (d.kind === 'ask' && d.preview.ask) return `${d.teammate.name} asks: ${d.preview.ask.summary}`;
  if (d.kind === 'approval' && d.preview.discount)
    return `${d.teammate.name} asks: ${d.preview.discount.percent}% off for ${who}`;
  if (d.kind === 'approval') return `${d.teammate.name} asks to go ahead for ${who}`;
  const noun = d.preview.message ? MESSAGE_NOUN[d.preview.message.channel] : 'reply';
  return `${d.teammate.name}’s ${noun} to ${who}`;
}
const alsoDoes = (d: Draft) => d.preview.actions.map((a) => a.summary).filter(Boolean);
/** Who may decide a draft this person can't: the people on an ask's record, or owners and admins. */
const whoDecides = (d: Draft, name: string) =>
  d.kind === 'ask'
    ? DRAFT_WORDS.askWho(d.record?.name ?? null)
    : `Only owners and admins decide what ${name} asks approval for.`;
/** An add-on's check on the reply, in its own words: "Real Estate Agent: …". */
const flagsOf = (d: Draft) => d.preview.flags.map((f) => `${f.addonName}: ${f.message}`);
/** The funnel a message is from, as the card's byline says it: "Spring tune-up, Day 3". */
const funnelOf = (f: { name: string; stageName: string }) => `${f.name}, ${f.stageName}`;
/** The titles of the knowledge the teammate used, as "Used Duct cleaning prices" names them. */
const knowledgeOf = (d: Draft) =>
  (d.knowledge ?? []).flatMap((k) => {
    const title = (k as { title?: unknown } | null)?.title;
    return typeof title === 'string' && title ? [title] : [];
  });
const expired = (d: Draft) => !!d.expiresAt && Date.parse(d.expiresAt) <= Date.now();
/** The held changes that ask the customer for money (core's MONEY_DRAFT_ACTIONS). */
const asksForMoney = (d: Draft) =>
  d.preview.actions.some((a) => (MONEY_DRAFT_ACTIONS as readonly string[]).includes(a.kind));

/**
 * What the customer last said in the draft's conversation, and whether they wrote again after the draft: then it
 * may not fit any more, and the teammate writes a new one (the command refuses it too; the card says so first).
 */
async function lastWords(
  db: Db,
  ctx: ToolContext,
  d: Draft,
): Promise<{ said: string | null; wroteAgain: boolean }> {
  if (!d.conversationId) return { said: null, wroteAgain: false };
  const thread = await query<{
    items: { type: string; direction: string; body: string | null; occurredAt: string }[];
  }>(db, ctx, 'conversation.thread', { conversationId: d.conversationId, limit: 10 }).catch(() => ({
    items: [],
  }));
  const last = thread.items.find((i) => i.type === 'message' && i.direction === 'inbound');
  return {
    said: last?.body?.trim() || null,
    wroteAgain: !!last && Date.parse(last.occurredAt) > Date.parse(d.createdAt),
  };
}

async function listTeammateDrafts(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const kind = str(args['kind']);
  // Waiting ones, oldest first; or the Decided list, newest first, as Approvals → Decided shows it.
  const decided = args['status'] === 'decided';
  const { items } = await query<{ items: Draft[] }>(db, ctx, 'ai_teammate.draft_list', {
    status: decided ? 'decided' : 'pending',
    limit: Number(args['limit'] ?? 10),
    ...(kind ? { kind } : {}),
  });
  const p = contentPaths(ctx.workspaceId);
  if (decided)
    return {
      result: {
        drafts: items.map((d) => ({
          id: d.id,
          what: draftTitle(d),
          kind: d.kind,
          teammate: d.teammate.name,
          for: d.person?.fullName ?? 'Someone not in Contacts yet',
          personId: d.person?.id ?? null,
          conversationId: d.conversationId,
          decided: draftDecidedLine(d),
          ...(d.decidedAt ? { when: when(d.decidedAt, ctx.timezone) } : {}),
          ...(d.status === 'approved' ? { edited: !!d.edits } : {}),
          ...(d.preview.message
            ? {
                drafted: {
                  ai_teammate_wrote: {
                    ...(d.preview.message.subject ? { subject: d.preview.message.subject } : {}),
                    words: d.preview.message.body,
                  },
                },
              }
            : {}),
        })),
        ...(items.length ? {} : { note: 'Nothing decided lately.' }),
      },
      card: items.length
        ? {
            type: 'list',
            title: `${plural(items.length, 'draft')} decided`,
            items: items.slice(0, 12).map((d) => ({
              title: draftTitle(d),
              detail: draftDecidedLine(d),
              tone: (d.status === 'approved' ? 'accent' : 'muted') as Tone,
              href: d.conversationId ? p.conversation(d.conversationId) : p.drafts(),
            })),
          }
        : null,
    };
  return {
    result: {
      drafts: items.map((d) => ({
        id: d.id,
        what: draftTitle(d),
        kind: d.kind,
        teammate: d.teammate.name,
        for: d.person?.fullName ?? 'Someone not in Contacts yet',
        personId: d.person?.id ?? null,
        conversationId: d.conversationId,
        ...(d.preview.message
          ? {
              drafted: {
                ai_teammate_wrote: {
                  ...(d.preview.message.subject ? { subject: d.preview.message.subject } : {}),
                  words: d.preview.message.body,
                },
              },
            }
          : {}),
        ...(alsoDoes(d).length ? { approvingAlso: alsoDoes(d) } : {}),
        ...(d.preview.discount
          ? { discount: `${d.preview.discount.percent}% off: ${d.preview.discount.reason}` }
          : {}),
        ...(d.preview.call
          ? { call: `Calls ${d.preview.call.toDisplay} about ${d.preview.call.goal}` }
          : {}),
        ...(d.preview.ask
          ? {
              ask: {
                addon: d.preview.ask.addonName,
                does: d.preview.ask.summary,
                recordId: d.preview.ask.recordId,
                ...(d.record?.name ? { record: d.record.name } : {}),
              },
            }
          : {}),
        ...(flagsOf(d).length ? { flags: flagsOf(d) } : {}),
        ...(d.preview.funnel ? { fromFunnel: funnelOf(d.preview.funnel) } : {}),
        ...(knowledgeOf(d).length ? { usedKnowledge: knowledgeOf(d) } : {}),
        waitingSince: when(d.createdAt, ctx.timezone),
        ...(d.expiresAt ? { expires: when(d.expiresAt, ctx.timezone) } : {}),
        canDecide: d.canDecide && !expired(d),
        ...(!d.canDecide
          ? d.kind === 'ask'
            ? { whoDecides: whoDecides(d, d.teammate.name) }
            : { onlyOwnersAndAdminsDecide: true }
          : {}),
      })),
      ...(items.length ? {} : { note: 'Nothing is waiting for an OK.' }),
    },
    card: items.length
      ? {
          type: 'list',
          title: `${plural(items.length, 'draft')} waiting`,
          items: items.slice(0, 12).map((d) => ({
            title: draftTitle(d),
            detail: clip(
              d.preview.message?.body ??
                d.preview.call?.goal ??
                d.preview.ask?.summary ??
                alsoDoes(d)[0] ??
                '',
              140,
            ),
            tone: (expired(d) ? 'danger' : 'warning') as Tone,
            href: d.conversationId ? p.conversation(d.conversationId) : p.drafts(),
          })),
        }
      : null,
  };
}

/** A draft still waiting, looked for page by page (the list has no lookup by id). */
async function draftOf(db: Db, ctx: ToolContext, draftId: unknown): Promise<Draft> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const got = await query<{ items: Draft[]; nextCursor: string | null }>(
      db,
      ctx,
      'ai_teammate.draft_list',
      { status: 'pending', limit: 100, ...(cursor ? { cursor } : {}) },
    );
    const d = got.items.find((x) => x.id === draftId);
    if (d) return d;
    if (!got.nextCursor) break;
    cursor = got.nextCursor;
  }
  throw HfosError.notFound(
    'That draft isn’t waiting any more: someone decided it, or it was replaced. Draft ids come from list_teammate_drafts.',
  );
}

/** The approver's changes to the message: only what differs, and a subject only on an email. */
function editsOf(d: Draft, args: Args): { body?: string; subject?: string } {
  const m = d.preview.message;
  if (!m || args['decision'] === 'reject') return {};
  const body = str(args['message']);
  const subject = m.channel === 'email' ? str(args['subject']) : undefined;
  return {
    ...(body && body !== m.body ? { body } : {}),
    ...(subject && subject !== (m.subject ?? '') ? { subject } : {}),
  };
}

const decideTeammateDraft: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const d = await draftOf(db, ctx, args['draftId']);
    const approve = args['decision'] !== 'reject';
    const m = d.preview.message;
    if (approve && !m && (str(args['message']) || str(args['subject'])))
      throw need(
        'This draft doesn’t send a message, so there are no words to change. Leave out message and subject.',
      );
    const edits = editsOf(d, args);
    const name = d.teammate.name;
    const who = d.person?.fullName ?? 'a new customer';
    const first = d.person ? firstName(d.person.fullName) : 'them';
    const { said, wroteAgain } = await lastWords(db, ctx, d);
    const blocked = !d.canDecide
      ? whoDecides(d, name)
      : expired(d)
        ? 'This draft expired.'
        : approve && wroteAgain
          ? `${d.person ? first : 'The customer'} wrote again after this draft, so it may not fit any more. ${name} writes a new one for the new message.`
          : null;
    const fields: Field[] = [
      { label: 'To', value: `${who}${m ? ` · ${MESSAGE_NOUN[m.channel]}` : ''}` },
      { label: 'They wrote', value: said ? clip(said, 240) : '' },
      { label: 'Subject', value: m?.channel === 'email' ? (edits.subject ?? m.subject ?? '') : '' },
      {
        label: 'Asks',
        value: d.preview.ask ? `${d.preview.ask.summary} (${d.preview.ask.addonName})` : '',
      },
      { label: 'From funnel', value: d.preview.funnel ? funnelOf(d.preview.funnel) : '' },
      { label: 'Also', value: alsoDoes(d).join('; ') },
      {
        label: 'Discount',
        value: d.preview.discount
          ? `${d.preview.discount.percent}% off: ${d.preview.discount.reason}`
          : '',
      },
      {
        label: 'Call',
        value: d.preview.call ? `${d.preview.call.toDisplay}: ${d.preview.call.goal}` : '',
      },
      {
        label: 'Edited',
        value: edits.body || edits.subject ? 'Your words go instead of the AI’s' : '',
      },
      { label: 'Reason', value: approve ? '' : (str(args['reason']) ?? '') },
      { label: 'Expires', value: d.expiresAt ? when(d.expiresAt, ctx.timezone) : '' },
    ];
    const result = {
      draft: draftTitle(d),
      decision: approve ? 'approve' : 'reject',
      ...(blocked ? { cannot: blocked } : {}),
    };
    if (!approve)
      return {
        card: card(toolCallId, 'decide_teammate_draft', {
          title: `Reject ${draftTitle(d)}?`,
          personId: d.person?.id ?? null,
          fields,
          body: m?.body ?? null,
          ...orBlocked(blocked, 'Reject', [
            {
              kind: 'note',
              text: `Nothing goes to ${first}. ${name} can write a new one, or you reply yourself.`,
            },
          ]),
        }),
        result,
      };
    const goes: Warning =
      d.kind === 'call'
        ? {
            kind: 'caution',
            text: `${name} calls ${first} once you confirm. The call says it’s an AI and that it’s recorded.`,
          }
        : d.kind === 'ask'
          ? { kind: 'caution', text: DRAFT_WORDS.askThen(first, m?.body ?? null) }
          : m
            ? {
                kind: 'caution',
                text: `It goes to ${first} as soon as you confirm, from ${name} with your name on it.`,
              }
            : { kind: 'caution', text: 'Approving carries it out at once.' };
    return {
      card: card(toolCallId, 'decide_teammate_draft', {
        title:
          d.kind === 'call'
            ? `Let ${name} call ${who}?`
            : d.kind === 'approval'
              ? d.preview.discount
                ? `Approve ${d.preview.discount.percent}% off for ${who}?`
                : `Approve what ${name} asks for ${who}?`
              : d.kind === 'ask' && d.preview.ask
                ? `Approve what ${name} asks: ${d.preview.ask.summary}?`
                : `Send ${draftTitle(d)}?`,
        personId: d.person?.id ?? null,
        fields,
        body: edits.body ?? m?.body ?? null,
        ...orBlocked(
          blocked,
          d.kind === 'call'
            ? 'Approve the call'
            : flagsOf(d).length
              ? DRAFT_WORDS.sendAsItIs
              : m
                ? 'Approve and send'
                : 'Approve',
          [
            // What an add-on's check found in the reply, before anyone sends it as it is.
            ...flagsOf(d).map((f) => ({
              kind: 'caution',
              text: `${DRAFT_WORDS.heldWhy(name)}. ${f}`,
            })),
            goes,
            ...(asksForMoney(d)
              ? [
                  {
                    kind: 'caution',
                    text: `Approving also asks ${first} for money: ${alsoDoes(d).join('; ')}.`,
                  },
                ]
              : []),
            ...(d.kind === 'reply'
              ? [{ kind: 'note', text: `It counts toward ${name}’s training.` }]
              : []),
          ],
        ),
      }),
      result,
    };
  },
  async commit(db, ctx, args) {
    const d = await draftOf(db, ctx, args['draftId']);
    const approve = args['decision'] !== 'reject';
    const edits = editsOf(d, args);
    await command(db, ctx, 'ai_teammate.decide_draft', {
      draftId: d.id,
      decision: approve ? 'approve' : 'reject',
      ...(Object.keys(edits).length ? { edits } : {}),
      ...(!approve && str(args['reason']) ? { reason: str(args['reason']) } : {}),
    });
    const first = d.person ? firstName(d.person.fullName) : 'them';
    const p = contentPaths(ctx.workspaceId);
    return {
      outcome: !approve
        ? `Rejected. Nothing went to ${first}.`
        : d.kind === 'call'
          ? `Approved. ${d.teammate.name} calls ${first} now.`
          : d.preview.message
            ? `Approved. It goes to ${first} now.`
            : 'Approved.',
      href: d.conversationId ? p.conversation(d.conversationId) : p.drafts(),
      command: 'ai_teammate.decide_draft',
    };
  },
};

// ================================================================================================

export const contentAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  list_campaigns: listCampaigns,
  get_campaign: getCampaign,
  list_reviews: listReviews,
  list_form_responses: listFormResponses,
  list_archived_forms: listArchivedForms,
  list_knowledge_items: listKnowledgeItems,
  list_knowledge_suggestions: listKnowledgeSuggestions,
  list_offers: listOffers,
  get_workflow: getWorkflow,
  list_workflow_runs: listWorkflowRuns,
  get_workflow_run: getWorkflowRun,
  list_teammate_drafts: listTeammateDrafts,
};

export const contentConfirmTools: Record<string, SettingsConfirmTool> = {
  start_campaign: startCampaign,
  manage_campaign: manageCampaign,
  edit_campaign: editCampaign,
  answer_review: answerReview,
  manage_form: manageForm,
  manage_knowledge_item: manageKnowledgeItem,
  decide_knowledge_suggestion: decideKnowledgeSuggestion,
  scan_website: scanWebsite,
  manage_offer: manageOffer,
  manage_workflow: manageWorkflow,
  edit_workflow_steps: editWorkflowSteps,
  manage_workflow_run: manageWorkflowRun,
  decide_teammate_draft: decideTeammateDraft,
};

/** What the panel says while each one runs. */
export const contentStepLabels: Record<string, string> = {
  list_campaigns: 'Looking at campaigns',
  get_campaign: 'Looking at the campaign',
  start_campaign: 'Setting up the campaign',
  manage_campaign: 'Getting the campaign ready',
  edit_campaign: 'Changing the campaign',
  list_reviews: 'Looking at reviews',
  answer_review: 'Drafting the answer',
  list_forms: 'Looking at forms',
  get_form: 'Looking at the form',
  form_results: 'Looking at the results',
  build_form: 'Working on the form',
  publish_form: 'Getting the form ready',
  send_form: 'Getting the text ready',
  list_form_responses: 'Looking at who answered',
  get_form_response: 'Looking at their answers',
  fill_in_form: 'Filling in the form',
  list_archived_forms: 'Looking at archived forms',
  manage_form: 'Getting the form change ready',
  list_knowledge_items: 'Looking at your knowledge base',
  manage_knowledge_item: 'Getting the change ready',
  list_knowledge_suggestions: 'Looking at suggestions',
  decide_knowledge_suggestion: 'Getting the suggestion ready',
  scan_website: 'Getting the scan ready',
  list_offers: 'Looking at promotions',
  manage_offer: 'Getting the promotion ready',
  manage_workflow: 'Getting the workflow change ready',
  get_workflow: 'Looking at the workflow',
  edit_workflow_steps: 'Getting the steps ready',
  list_workflow_runs: 'Looking at workflow runs',
  get_workflow_run: 'Looking at the run',
  manage_workflow_run: 'Looking at the run',
  list_teammate_drafts: 'Looking at what the AI teammate wrote',
  decide_teammate_draft: 'Getting the draft ready',
};
