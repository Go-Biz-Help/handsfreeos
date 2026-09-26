/**
 * The builder's test console (plan M7, "Other work"): POST /v1/ai-team/test, for people with ai_team.manage
 * (routes.ts). A manager writes as a customer and the teammate answers as it would, streamed back. The request and
 * event contract is @hfos/core's ai-team/test-console.ts, which the web's and the phone app's consoles read too.
 *
 * It runs on the settings being tested (the builder's unsaved draft, or the saved ones), for someone in
 * Customers or an unknown visitor, at a pretend time when asked.
 * - Look-ups are real queries: Knowledge, open times, the customer's record and visits.
 * - Anything that would change something is only described ("Would have: booked Thu 10 AM"). No command runs
 *   (the kernel refuses a test actor's commands anyway), and nothing is sent.
 * - Nothing is stored but a run marked is_test, with its tokens, so the AI limit counts them. Test runs never
 *   count toward training wheels.
 * - A phone test plays a call, one caller turn per request, as the voice agent thinks (voice-agent/brain.ts): its
 *   first request has no messages and gets the greeting (the pick-up, or the opening of a call it places to confirm
 *   a visit, ring back a missed call, follow up a quote or for a campaign); then each turn has the phone's tools and
 *   words, and a hand-off connects them to the team, which ends the call, as a goodbye does. It thinks with the
 *   model the business's calls do (its phone model, else VOICE_MODEL). A reply it would start saying while it's
 *   still written (voice-agent/early-speech.ts) says so, with how long the first words took, and streams each of
 *   those sentences as it's ready (`say`), so talking out loud starts early too.
 */
import type { AiMessage, AiProvider, AiToolCall, AiUsage } from '@hfos/ai';
import type { Geocoder } from '../geo/geocoder';
import { ADDRESS_NOT_FOUND, serviceAreaAnswer, whereabouts } from './areas';
import {
  addDays,
  APPROVALS_NEEDED_MAX,
  APPROVALS_NEEDED_MIN,
  calendarAvailability,
  EMERGENCY_SAFETY_TEXT,
  executeQuery,
  formatDuration,
  HfosError,
  isLocalDate,
  loadTeammate,
  loadTerritories,
  localDateOf,
  money,
  parseTeammateConfig,
  plainSmsText,
  quietHoursState,
  quoteData,
  REPLY_RULES,
  startOfLocalDay,
  teammateTools,
  TEAMMATE_TURN_ENDERS,
  TEST_CALL_REASONS,
  TestConsoleInput,
  uuidArray,
  workspaceMessaging,
  type AiCallPurpose,
  type DraftAction,
  type ReplyCheck,
  type TeammateConfig,
  type TeammateRow,
  type TeammateTool,
  type TeammateToolName,
  type TestEvent,
  type TestOutcome,
  type WouldKind,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { campaignFacts, quoteFacts, spokenWhen } from '../ai-calls';
import { aiBudget, recordAndChargeAi } from '../ai/budget';
import type { WalletDeps } from '../money/wallet';
import { runToolLoop, toolErrorContent, type ToolLoopAnswer } from '../ai/tool-loop';
import { atLabel, isoWithOffset } from '../assistant/calendar-format';
import { fallbackOpening } from '../automations/campaigns';
import { anyOfWords, findKnowledge } from '../knowledge/find';
import { systemActor, type TenantScope } from '../services';
import { EarlySpeech, streamSpoken } from '../voice-agent/early-speech';
import { callModel } from '../voice-agent/index';
import {
  alreadySaid,
  CANT_GO_ON,
  CONNECTING,
  greetingOf,
  outboundGreetingOf,
  PHONE_MAX_TOKENS,
  phoneChannelLines,
  phoneTurn,
  type CallLine,
} from '../voice-agent/prompt';
import { runtimeConfigOf } from './config';
import {
  HELD_MAX,
  MAX_TOKENS,
  MONEY_LIST_MAX,
  SEARCH_MATCHES,
  TIMES_MAX_DAYS,
  TIMES_SHOWN,
} from './constants';
import {
  jobsOf,
  jobStatusContent,
  loadRunContext,
  pastAppointments,
  upcomingAppointments,
  type BatchMessage,
  type HistoryLine,
  type RunContext,
} from './context';
import { withinHours, workingNow } from './gates';
import { handoffExpectation, handoffLine } from './hours';
import { contextText, conversationTurn, rewriteFeedback, TEAMMATE_SYSTEM } from './prompt';
import { checkReply, closeRun, immediateHandOff } from './run';
import { newRunState, timeKey, toolDefinition, type RunState } from './tools';

export { TestConsoleInput };

/** What the console streams (@hfos/core's TestEvent). */
export type ConsoleEvent = TestEvent;

export interface ConsoleDeps {
  readonly db: Db;
  readonly ai: { readonly provider: AiProvider | null; readonly dailyTokens: number };
  /** The model that thinks on a call (VOICE_MODEL), when it isn't the usual one. */
  readonly voiceAi?: AiProvider | null;
  /** The AI with a model named at run time: the business's phone model, when support picked one. */
  readonly aiFor?: ((model: string) => AiProvider) | null;
  readonly webUrl: string;
  readonly log: Logger;
  /** The test chat's tokens are real tokens: a business trying its teammate out is charged for it like anything else. */
  readonly wallet: WalletDeps;
  /** Finds where a customer's address is (M18), for distance and drawn service areas. */
  readonly geocoder: Geocoder;
}

/** A test checked and ready to stream: refusals come before the stream opens, as the API's JSON errors. */
export interface PreparedTest {
  readonly scope: TenantScope;
  readonly teammate: TeammateRow;
  readonly config: TeammateConfig;
  readonly provider: AiProvider;
  readonly input: TestConsoleInput;
  /** The moment it pretends it is. */
  readonly now: number;
  readonly timeZone: string;
  readonly runId: string;
  /** A phone test: the call, and for one it places, why. Null for a written test. */
  readonly phone: { readonly outbound: TestOutbound | null } | null;
}

/** A call the teammate places in a phone test: why, and what it says (as a real one's app.ai_calls row gives). */
export interface TestOutbound {
  readonly purpose: AiCallPurpose;
  /** It finishes "I'm calling …". */
  readonly goal: string;
  /** A quote's or a campaign's facts, for the AI (data); null for the other reasons. */
  readonly brief: string | null;
  readonly firstName: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nowIso = () => new Date().toISOString();

/**
 * The builder's draft, read strictly (its problems come back at config.*), except for the approvals threshold,
 * which doesn't change how it replies (runtimeConfigOf's rule).
 */
function draftConfig(raw: unknown): TeammateConfig {
  let failure: unknown;
  for (const doc of [raw, withThresholdInRange(raw)]) {
    if (doc === null) continue;
    try {
      return parseTeammateConfig(doc);
    } catch (e) {
      failure ??= e;
    }
  }
  throw HfosError.validation(
    failure instanceof ZodError
      ? failure.issues.map((i) => ({
          path: ['config', ...i.path.map(String)].join('.'),
          message: i.message,
        }))
      : [{ path: 'config', message: 'These settings can’t be read.' }],
  );
}

function withThresholdInRange(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw['autonomy'])) return null;
  const n = Number(raw['autonomy']['approvalsNeeded']);
  const approvalsNeeded = Math.min(
    APPROVALS_NEEDED_MAX,
    Math.max(APPROVALS_NEEDED_MIN, Number.isFinite(n) ? Math.round(n) : APPROVALS_NEEDED_MIN),
  );
  return { ...raw, autonomy: { ...raw['autonomy'], approvalsNeeded } };
}

/** Checks the request, the settings and the budget, and opens the test's run. */
export async function prepareTest(
  deps: ConsoleDeps,
  input: TestConsoleInput,
): Promise<PreparedTest> {
  const last = input.messages[input.messages.length - 1];
  if (last && last.from !== 'customer')
    throw HfosError.validation([
      {
        path: `messages.${input.messages.length - 1}`,
        message: 'End with the customer’s new message.',
      },
    ]);
  const [ws] = await asWorker(deps.db, { workspaceId: input.workspaceId }, (tx) =>
    rows<{ organization_id: string; timezone: string | null; phone_model: string | null }>(
      tx,
      sql`select organization_id, timezone, phone_model from app.workspaces where id = ${input.workspaceId}`,
    ),
  );
  if (!ws) throw HfosError.notFound('Workspace not found.');
  const scope: TenantScope = { workspaceId: input.workspaceId, organizationId: ws.organization_id };
  const timeZone = ws.timezone || 'UTC';
  const now = input.at ? Date.parse(input.at) : Date.now();
  const provider = input.channel === 'phone' ? callModel(deps, ws.phone_model) : deps.ai.provider;
  if (!provider)
    throw HfosError.rule(
      'ai_not_configured',
      503,
      'The AI isn’t set up yet, so the test console can’t answer.',
    );
  const { teammate, config, outbound } = await asWorker(deps.db, scope, async (tx) => {
    const row = await loadTeammate(tx, scope.workspaceId);
    if (!row) throw HfosError.rule('no_teammate', 409, 'Set up your AI teammate first.');
    let firstName: string | null = null;
    if (input.personId) {
      const [p] = await rows<{ first_name: string | null }>(
        tx,
        sql`select first_name from app.people where id = ${input.personId} and workspace_id = ${scope.workspaceId}
              and archived_at is null`,
      );
      if (!p) throw HfosError.notFound('Customer not found.');
      firstName = p.first_name?.trim() || null;
    }
    const call = input.channel === 'phone' ? input.call : null;
    return {
      teammate: row,
      config: input.config === null ? runtimeConfigOf(row.config) : draftConfig(input.config),
      outbound:
        call?.direction === 'outbound' && call.purpose && input.personId
          ? await outboundFor(tx, scope, {
              purpose: call.purpose,
              goal: call.goal,
              personId: input.personId,
              firstName,
              timeZone,
              now,
            })
          : null,
    };
  });
  const room = await aiBudget.teammateHasRoom(deps.db, scope, {
    teammateId: teammate.id,
    dailyTokens: deps.ai.dailyTokens,
    sharePercent: config.limits.dailySharePercent,
    timeZone,
  });
  if (!room)
    throw HfosError.rule(
      'ai_limit',
      429,
      `${teammate.name} reached its share of today’s AI limit. It resets at midnight.`,
    );
  const [made] = await asWorker(deps.db, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.ai_teammate_runs
            (workspace_id, teammate_id, person_id, triggered_by, is_test, message_ids, model)
          values (${scope.workspaceId}, ${teammate.id}, ${input.personId}, 'test', true, ${uuidArray([])},
            ${provider.model.slice(0, 100)})
          returning id`,
    ),
  );
  return {
    scope,
    teammate,
    config,
    provider,
    input,
    now,
    timeZone,
    runId: made!.id,
    phone: input.channel === 'phone' ? { outbound } : null,
  };
}

const nothingToCallAbout = (message: string) =>
  HfosError.rule('nothing_to_call_about', 409, message);

/**
 * Why it calls in a phone test, with the words a real call would open with (ai-calls' consider steps): their
 * next visit, the quote they haven't answered, a missed call, or the campaign the manager describes.
 */
async function outboundFor(
  tx: Tx,
  scope: TenantScope,
  o: {
    readonly purpose: AiCallPurpose;
    readonly goal: string | null;
    readonly personId: string;
    readonly firstName: string | null;
    readonly timeZone: string;
    readonly now: number;
  },
): Promise<TestOutbound> {
  const base = { purpose: o.purpose, firstName: o.firstName };
  switch (o.purpose) {
    case 'confirm_visit': {
      const [visit] = await upcomingAppointments(tx, scope.workspaceId, o.personId, o.timeZone);
      if (!visit)
        throw nothingToCallAbout(
          'They have no visit coming up to confirm. Pick someone with one, or another reason.',
        );
      return {
        ...base,
        goal: `about your ${visit.title} ${spokenWhen(new Date(visit.startsAt), visit.timeZone, o.now)}.`,
        brief: null,
      };
    }
    case 'quote': {
      const [q] = await rows<{
        number: string | null;
        title: string | null;
        total_cents: string;
        expires_on: string | null;
      }>(
        tx,
        sql`select number, title, total_cents::text as total_cents, expires_on::text as expires_on
            from app.estimates
            where workspace_id = ${scope.workspaceId} and person_id = ${o.personId}
              and status = 'sent' and voided_at is null
            order by created_at desc limit 1`,
      );
      if (!q)
        throw nothingToCallAbout(
          'They have no open quote to call about. Pick someone with one, or another reason.',
        );
      const title = q.title?.trim();
      return {
        ...base,
        goal: `about the quote we sent you${title ? ` for ${title}` : ''}.`,
        brief: quoteFacts(q),
      };
    }
    case 'campaign': {
      const goal = o.goal?.trim() || 'our latest offer';
      return { ...base, goal: fallbackOpening(goal), brief: campaignFacts({ goal }) };
    }
    case 'missed_call':
      return { ...base, goal: 'back, since we missed your call earlier.', brief: null };
  }
}

/** The run's context from the test chat: the earlier messages are its history, the customer's latest its batch. */
async function contextFor(deps: ConsoleDeps, t: PreparedTest): Promise<RunContext> {
  const msgs = t.input.messages;
  // The caller's words read like a text's, as the voice agent reads them.
  const channel = t.input.channel === 'phone' ? 'sms' : t.input.channel;
  if (t.phone) {
    // A call: what the caller just said is the batch; the call so far is its own transcript (callLinesOf), and the
    // greeting already said who it is.
    const said = msgs[msgs.length - 1];
    const rc = await asWorker(deps.db, t.scope, (tx) =>
      loadRunContext(tx, {
        scope: t.scope,
        teammate: t.teammate,
        config: t.config,
        conversationId: null,
        target: { personId: t.input.personId, channel },
        batch: said
          ? [{ id: 'call', channel, text: said.text, subject: null, at: t.now, photos: [] }]
          : [],
        webUrl: deps.webUrl,
        now: t.now,
      }),
    );
    return { ...rc, history: [], firstAiMessage: false, discloseNow: false };
  }
  const lastTeammate = msgs.map((m) => m.from).lastIndexOf('teammate');
  const at = (i: number) => t.now - (msgs.length - i) * 60_000;
  const batch: BatchMessage[] = msgs.slice(lastTeammate + 1).map((m, j) => ({
    id: `test-${lastTeammate + 1 + j}`,
    channel,
    text: m.text,
    subject: null,
    at: at(lastTeammate + 1 + j),
    photos: [],
  }));
  const rc = await asWorker(deps.db, t.scope, (tx) =>
    loadRunContext(tx, {
      scope: t.scope,
      teammate: t.teammate,
      config: t.config,
      conversationId: null,
      target: { personId: t.input.personId, channel },
      batch,
      webUrl: deps.webUrl,
      now: t.now,
    }),
  );
  const history: HistoryLine[] = msgs.slice(0, lastTeammate + 1).map((m, i) => ({
    at: at(i),
    who: m.from === 'customer' ? 'customer' : 'ai',
    name: null,
    text: m.text,
  }));
  const firstAiMessage = !msgs.some((m) => m.from === 'teammate');
  return {
    ...rc,
    history,
    firstAiMessage,
    discloseNow: firstAiMessage && t.config.identity.disclosure === 'first_message',
  };
}

/** A phone test's call so far, before what the caller just said: the greeting, then each turn. */
const callLinesOf = (t: PreparedTest): CallLine[] =>
  t.input.messages
    .slice(0, -1)
    .map((m) => ({ who: m.from === 'customer' ? 'caller' : 'teammate', text: m.text }));

// ---- The simulating hands ----

interface Hands {
  readonly deps: ConsoleDeps;
  readonly t: PreparedTest;
  readonly rc: RunContext;
  readonly state: RunState;
  readonly send: (e: ConsoleEvent) => void;
}

type Result = ToolLoopAnswer;
type Runner = (h: Hands, args: Record<string, unknown>) => Promise<Result>;

const refuse = (error: string): Result => ({ content: { error }, isError: true });
/** What a hand-off does: on a call, the team's phones ring on the same call. */
const toPerson = (t: PreparedTest) =>
  t.phone ? 'connected them to the team on this call' : 'handed it to a person';
const would = (h: Hands, kind: WouldKind, summary: string) =>
  h.send({ type: 'would', kind, summary: summary.slice(0, 300), at: nowIso() });
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const NOT_THEIRS = 'That isn’t one of this customer’s upcoming appointments.';
const NO_CUSTOMER =
  'There’s no customer on file for this conversation yet, so there’s nowhere to put that.';
const NO_LEAD = 'This customer has no open lead to put that on. Add a note instead.';
const NO_CALLS = 'That isn’t a call in this conversation. Use a callId the history gave you.';
const CHAT_REFUSAL =
  'In website chat you can’t see or change existing bookings or records. Tell them the link in their confirmation changes a booking, or hand off.';
const DONE_NOTE = 'It happens as your reply goes out. You can tell them it’s done.';
const MONEY_NOTE =
  'An owner or admin decides before the customer gets anything. In your reply, say only that you’ve asked the team.';

async function theirVisits(h: Hands) {
  if (!h.rc.customer || h.rc.unverifiedChat) return null;
  const customerId = h.rc.customer.id;
  return asWorker(h.deps.db, h.t.scope, (tx) =>
    upcomingAppointments(tx, h.t.scope.workspaceId, customerId, h.rc.workspace.timeZone),
  );
}

const RUNNERS: Readonly<Record<TeammateToolName, Runner>> = {
  async search_knowledge(h, args) {
    const query = String(args['query']);
    const items = await asWorker(h.deps.db, h.t.scope, (tx) =>
      findKnowledge(tx, {
        workspaceId: h.t.scope.workspaceId,
        queries: [anyOfWords(query), query],
        limit: SEARCH_MATCHES,
      }),
    );
    h.state.searched = true;
    for (const m of items) h.state.found.set(m.id, { id: m.id, title: m.title, body: m.body });
    h.send({
      type: 'knowledge',
      query,
      items: items.map((m) => ({ id: m.id, title: m.title })),
      at: nowIso(),
    });
    return {
      content: items.length
        ? {
            items: items.map((m) => ({
              id: m.id,
              title: quoteData(m.title),
              text: quoteData(m.body.slice(0, 1500)),
            })),
          }
        : {
            items: [],
            note: 'Nothing in the knowledge base matches. Try other words, or follow your rule for when you’re unsure.',
          },
    };
  },

  // The test chat is a made-up conversation, so it has no calls: every callId is one the model invented.
  async read_call_transcript(h, args) {
    h.send({
      type: 'tool',
      name: 'read_call_transcript',
      title: 'Looked for a call’s words',
      detail: 'The test chat has no calls on it.',
      at: nowIso(),
    });
    void args;
    return refuse(NO_CALLS);
  },

  async find_times(h, args) {
    const calendarId = String(args['calendarId']);
    const cal = h.rc.calendars.find((c) => c.id === calendarId);
    if (!cal)
      return refuse('That isn’t one of your calendars. Use a calendar id from the context.');
    const address = str(args['address']);
    if (cal.byAddress && !address && h.deps.geocoder.name !== 'off')
      return refuse(
        `${cal.name} offers times by where the customer is. Ask for their street address and city, then look again with it.`,
      );
    const where = await asWorker(h.deps.db, h.t.scope, (tx) =>
      whereabouts(tx, h.deps.geocoder, { postalCode: str(args['postalCode']), address }),
    );
    if (where.notFound) return refuse(ADDRESS_NOT_FOUND);
    const postalCode = where.zip;
    if (cal.byZip && !postalCode && !where.point)
      return refuse(
        `${cal.name} offers times by ZIP code. Ask for their ZIP code, then look again with it.`,
      );
    const tz = cal.timeZone;
    const from = String(args['from']);
    const to = str(args['to']);
    const fromMs = isLocalDate(from) ? startOfLocalDay(from, tz) : Date.parse(from);
    const start = Math.max(fromMs, h.t.now);
    const asked = to
      ? isLocalDate(to)
        ? startOfLocalDay(addDays(to, 1), tz)
        : Date.parse(to)
      : startOfLocalDay(addDays(localDateOf(fromMs, tz), 1), tz);
    const end = Math.min(asked, start + TIMES_MAX_DAYS * 86_400_000);
    if (!(end > start))
      return { content: { times: [], note: 'That’s past. Ask about a later day.' } };
    const serviceId = str(args['serviceId']);
    const durationMinutes =
      typeof args['durationMinutes'] === 'number' ? args['durationMinutes'] : undefined;
    const out = await executeQuery(
      h.deps.db,
      calendarAvailability,
      {
        workspaceId: h.t.scope.workspaceId,
        calendarId,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        serviceId,
        ...(durationMinutes ? { durationMinutes } : {}),
        ...(postalCode ? { postalCode } : {}),
        ...(where.point ? { point: where.point } : {}),
      },
      systemActor(h.t.scope),
      { correlationId: h.t.runId, channel: 'ai_employee' },
    );
    const shown = out.slots.slice(0, TIMES_SHOWN);
    for (const s of shown) {
      const at = Date.parse(s.startsAt);
      h.state.offered.set(timeKey(calendarId, s.startsAt), {
        calendarId,
        startsAt: new Date(at).toISOString(),
        sessionId: s.sessionId,
        serviceId: out.serviceId,
        durationMinutes: durationMinutes ?? null,
        postalCode: cal.byZip ? postalCode : null,
        point: cal.byZip ? where.point : null,
        label: atLabel(at, tz),
      });
    }
    h.send({
      type: 'tool',
      name: 'find_times',
      title: `Looked up open times on ${cal.name}`,
      detail: shown.length
        ? shown
            .slice(0, 4)
            .map((s) => atLabel(Date.parse(s.startsAt), tz))
            .join(', ') + (shown.length > 4 ? ', …' : '')
        : 'No open times then.',
      at: nowIso(),
    });
    return {
      content: {
        calendar: quoteData(cal.name),
        timezone: tz,
        length: formatDuration(out.durationMinutes),
        times: shown.map((s) => ({
          startsAt: isoWithOffset(Date.parse(s.startsAt), tz),
          label: atLabel(Date.parse(s.startsAt), tz),
        })),
        ...(out.slots.length > shown.length ? { more: true } : {}),
        ...(shown.length ? {} : { note: 'No open times then. Try another day.' }),
      },
    };
  },

  async my_appointments(h, args) {
    if (args['when'] === 'past') {
      if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
      const customerId = h.rc.customer.id;
      const past = await asWorker(h.deps.db, h.t.scope, (tx) =>
        pastAppointments(tx, h.t.scope.workspaceId, customerId, h.rc.workspace.timeZone),
      );
      h.send({
        type: 'tool',
        name: 'my_appointments',
        title: 'Looked up their past visits',
        detail: past.length
          ? past.map((a) => `${a.title}, ${atLabel(a.startsAt, a.timeZone)}`).join('; ')
          : 'No visits yet.',
        at: nowIso(),
      });
      return {
        content: {
          visits: past.map((a) => ({
            what: quoteData(a.title),
            when: atLabel(a.startsAt, a.timeZone),
            calendar: quoteData(a.calendarName),
          })),
        },
      };
    }
    const list = await theirVisits(h);
    if (!list) return refuse(NO_CUSTOMER);
    h.send({
      type: 'tool',
      name: 'my_appointments',
      title: 'Looked up their visits',
      detail: list.length
        ? list.map((a) => `${a.title}, ${atLabel(a.startsAt, a.timeZone)}`).join('; ')
        : 'None coming up.',
      at: nowIso(),
    });
    return {
      content: {
        appointments: list.map((a) => ({
          appointmentId: a.id,
          what: quoteData(a.title),
          when: atLabel(a.startsAt, a.timeZone),
          calendar: quoteData(a.calendarName),
        })),
      },
    };
  },

  async job_status(h) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    const customerId = h.rc.customer.id;
    const list = await asWorker(h.deps.db, h.t.scope, (tx) =>
      jobsOf(tx, h.t.scope.workspaceId, customerId),
    );
    h.send({
      type: 'tool',
      name: 'job_status',
      title: 'Looked up their jobs',
      detail: list.length ? list.map((j) => `${j.title}: ${j.status}`).join(', ') : 'No open jobs.',
      at: nowIso(),
    });
    return { content: jobStatusContent(list, h.rc.workspace.timeZone) };
  },

  async book(h, args) {
    const calendarId = String(args['calendarId']);
    const cal = h.rc.calendars.find((c) => c.id === calendarId);
    if (!cal) return refuse('That isn’t one of your calendars.');
    const slot = h.state.offered.get(timeKey(calendarId, String(args['startsAt'])));
    if (!slot)
      return refuse(
        'Book only one of the times find_times gave you in this conversation. Call find_times first.',
      );
    if (h.state.held.length >= HELD_MAX)
      return refuse('That’s as many changes as one reply can make.');
    const held: DraftAction = {
      kind: 'book',
      calendarId,
      startsAt: slot.startsAt,
      serviceId: str(args['serviceId']) ?? slot.serviceId,
      durationMinutes: slot.durationMinutes,
      sessionId: slot.sessionId,
      notes: str(args['notes']),
      postalCode: slot.postalCode,
      point: slot.point,
      summary: `Book ${slot.label} on ${cal.name}`.slice(0, 300),
    };
    h.state.held.push(held);
    would(h, 'book', `booked ${slot.label} on ${cal.name}`);
    return { content: { status: 'ready', when: slot.label, note: DONE_NOTE } };
  },

  async reschedule(h, args) {
    const list = await theirVisits(h);
    const appt = list?.find((a) => a.id === String(args['appointmentId']));
    if (!appt) return refuse(NOT_THEIRS);
    const slot = h.state.offered.get(timeKey(appt.calendarId, String(args['startsAt'])));
    if (!slot)
      return refuse(
        'Move it only to a time find_times gave you on its calendar in this conversation.',
      );
    if (h.state.held.length >= HELD_MAX)
      return refuse('That’s as many changes as one reply can make.');
    h.state.held.push({
      kind: 'reschedule',
      appointmentId: appt.id,
      startsAt: slot.startsAt,
      sessionId: slot.sessionId,
      summary: `Move ${appt.title} to ${slot.label}`.slice(0, 300),
    });
    would(h, 'reschedule', `moved ${appt.title} to ${slot.label}`);
    return { content: { status: 'ready', when: slot.label, note: DONE_NOTE } };
  },

  /** A rehearsal only says what it would add: whether the extra time fits is checked in a real conversation. */
  async add_to_appointment(h, args) {
    const list = await theirVisits(h);
    const appt = list?.find((a) => a.id === String(args['appointmentId']));
    if (!appt) return refuse(NOT_THEIRS);
    if (h.state.held.length >= HELD_MAX)
      return refuse('That’s as many changes as one reply can make.');
    const service = h.rc.calendars
      .flatMap((c) => c.services)
      .find((x) => x.id === str(args['serviceId']));
    if (str(args['serviceId']) && !service)
      return refuse('That isn’t a service on your calendars. Use an id from the context.');
    const guests = typeof args['guests'] === 'number' ? args['guests'] : null;
    const what = [
      service?.name ?? null,
      guests ? `${guests} more ${guests === 1 ? 'person' : 'people'}` : null,
      str(args['note']) ? 'a note' : null,
    ].filter(Boolean);
    h.state.held.push({
      kind: 'add_to_visit',
      appointmentId: appt.id,
      serviceId: service?.id ?? null,
      guests,
      note: str(args['note']),
      summary: `Add ${what.join(', ')} to ${appt.title}`.slice(0, 300),
    });
    would(h, 'reschedule', `added ${what.join(', ')} to ${appt.title}`);
    return { content: { status: 'ready', note: DONE_NOTE } };
  },

  async cancel(h, args) {
    const list = await theirVisits(h);
    const appt = list?.find((a) => a.id === String(args['appointmentId']));
    if (!appt) return refuse(NOT_THEIRS);
    if (h.state.held.length >= HELD_MAX)
      return refuse('That’s as many changes as one reply can make.');
    h.state.held.push({
      kind: 'cancel',
      appointmentId: appt.id,
      reason: str(args['reason']),
      summary: `Cancel ${appt.title}`.slice(0, 300),
    });
    would(h, 'cancel', `cancelled ${appt.title} on ${atLabel(appt.startsAt, appt.timeZone)}`);
    return { content: { status: 'ready', note: DONE_NOTE } };
  },

  async check_service_area(h, args) {
    const given = { postalCode: str(args['postalCode']), address: str(args['address']) };
    const { areas, where } = await asWorker(h.deps.db, h.t.scope, async (tx) => ({
      areas: await loadTerritories(tx, h.t.scope.workspaceId),
      where: await whereabouts(tx, h.deps.geocoder, given),
    }));
    if (!where.zip && !where.point && !where.notFound)
      return refuse('That isn’t a ZIP code. Ask them for their 5-digit ZIP or address.');
    const answer = serviceAreaAnswer(areas, h.rc.calendars, where, h.deps.geocoder.name !== 'off');
    const served = answer['served'];
    h.send({
      type: 'tool',
      name: 'check_service_area',
      title: `Checked the service area for ${given.address ?? where.zip ?? 'them'}`,
      detail: !areas.length
        ? 'No service areas listed yet.'
        : served === true
          ? `Served: ${(answer['areas'] as string[]).join(', ')}`
          : served === false
            ? 'Not in any of your areas.'
            : String(answer['note'] ?? ''),
      at: nowIso(),
    });
    return { content: answer };
  },

  async book_repeating(h, args) {
    const calendarId = String(args['calendarId']);
    const cal = h.rc.calendars.find((c) => c.id === calendarId);
    if (!cal) return refuse('That isn’t one of your calendars.');
    if (cal.maxRepeats === null) return refuse(`${cal.name} doesn’t take repeat visits.`);
    const slot = h.state.offered.get(timeKey(calendarId, String(args['startsAt'])));
    if (!slot)
      return refuse(
        'Start the repeats at one of the times find_times gave you in this conversation. Call find_times first.',
      );
    if (h.state.held.length >= HELD_MAX)
      return refuse('That’s as many changes as one reply can make.');
    const times = Math.min(Number(args['times']), cal.maxRepeats);
    const every = args['every'] === 'month' ? 'month' : 'week';
    h.state.held.push({
      kind: 'book_series',
      calendarId,
      startsAt: slot.startsAt,
      serviceId: str(args['serviceId']) ?? slot.serviceId,
      durationMinutes: slot.durationMinutes,
      every,
      interval: typeof args['interval'] === 'number' ? args['interval'] : 1,
      times,
      notes: str(args['notes']),
      postalCode: slot.postalCode,
      point: slot.point,
      summary: `Book ${times} visits from ${slot.label} on ${cal.name}`.slice(0, 300),
    });
    would(h, 'repeat', `booked ${times} visits every ${every} from ${slot.label} on ${cal.name}`);
    return { content: { status: 'ready', visits: times, first: slot.label, note: DONE_NOTE } };
  },

  async join_waitlist(h, args) {
    const calendarId = String(args['calendarId']);
    const cal = h.rc.calendars.find((c) => c.id === calendarId);
    if (!cal) return refuse('That isn’t one of your calendars.');
    if (!cal.waitlist) return refuse(`${cal.name} doesn’t keep a waitlist.`);
    if (h.state.held.length >= HELD_MAX)
      return refuse('That’s as many changes as one reply can make.');
    h.state.held.push({
      kind: 'waitlist',
      calendarId,
      appointmentId: str(args['appointmentId']),
      wantedFrom: null,
      wantedTo: null,
      summary: `Add them to the ${cal.name} waitlist`,
    });
    would(h, 'waitlist', `added them to the ${cal.name} waitlist`);
    return {
      content: {
        status: 'ready',
        note: 'It happens as your reply goes out. They hear from us when a spot opens; never promise one.',
      },
    };
  },

  async open_deal(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    if (h.rc.lead) return refuse('They already have an open lead. Use that one.');
    would(h, 'stage', `opened the lead “${String(args['title'])}”`);
    return { content: { opened: true } };
  },

  async set_deal_value(h, args) {
    if (!h.rc.lead) return refuse(NO_LEAD);
    const cents = Math.round(Number(args['dollars']) * 100);
    would(h, 'stage', `set ${h.rc.lead.title} to ${money(cents)}`);
    return { content: { value: money(cents) } };
  },

  async close_deal(h, args) {
    if (!h.rc.lead) return refuse(NO_LEAD);
    const outcome = args['outcome'] === 'lost' ? 'lost' : 'won';
    if (outcome === 'lost' && !str(args['reason']))
      return refuse('Say why it was lost, in their words.');
    would(h, 'stage', `marked ${h.rc.lead.title} ${outcome}`);
    return { content: { status: outcome } };
  },

  // Money (M18): the look-ups are real; what would ask an owner for money is only described.
  async my_bills(h) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    const customerId = h.rc.customer.id;
    const list = await asWorker(h.deps.db, h.t.scope, (tx) =>
      rows<{ id: string; number: string | null; status: string; balance_cents: string }>(
        tx,
        sql`select id, number, status::text as status, balance_cents::text as balance_cents
            from app.invoices where workspace_id = ${h.t.scope.workspaceId} and person_id = ${customerId}
              and status not in ('draft', 'void')
            order by created_at desc limit ${MONEY_LIST_MAX}`,
      ),
    );
    h.send({
      type: 'tool',
      name: 'my_bills',
      title: 'Looked up their bills',
      detail: list.length
        ? list.map((b) => `${b.number ?? 'Bill'}: ${b.status.replace('_', ' ')}`).join('; ')
        : 'None on file.',
      at: nowIso(),
    });
    return {
      content: {
        bills: list.map((b) => ({
          invoiceId: b.id,
          number: b.number,
          owed: money(Number(b.balance_cents)),
          status: b.status.replace('_', ' '),
        })),
      },
    };
  },

  async send_payment_link(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    would(h, 'money', `asked an owner to send a pay link: “${String(args['message'])}”`);
    return { content: { status: 'waiting_for_approval', note: MONEY_NOTE } };
  },

  async propose_bill(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    would(
      h,
      'money',
      `asked an owner to send a bill${str(args['title']) ? ` for ${String(args['title'])}` : ''}`,
    );
    return { content: { status: 'waiting_for_approval', note: MONEY_NOTE } };
  },

  async my_quotes(h) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    const customerId = h.rc.customer.id;
    const list = await asWorker(h.deps.db, h.t.scope, (tx) =>
      rows<{ id: string; number: string | null; status: string; total_cents: string }>(
        tx,
        sql`select id, number, status::text as status, total_cents::text as total_cents
            from app.estimates where workspace_id = ${h.t.scope.workspaceId} and person_id = ${customerId}
              and status not in ('draft', 'void')
            order by created_at desc limit ${MONEY_LIST_MAX}`,
      ),
    );
    h.send({
      type: 'tool',
      name: 'my_quotes',
      title: 'Looked up their quotes',
      detail: list.length
        ? list.map((q) => `${q.number ?? 'Quote'}: ${q.status}`).join('; ')
        : 'None on file.',
      at: nowIso(),
    });
    return {
      content: {
        quotes: list.map((q) => ({
          estimateId: q.id,
          number: q.number,
          total: money(Number(q.total_cents)),
          status: q.status,
        })),
      },
    };
  },

  async send_quote(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    would(h, 'money', `asked an owner to send a quote’s link: “${String(args['message'])}”`);
    return { content: { status: 'waiting_for_approval', note: MONEY_NOTE } };
  },

  async propose_quote(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    would(
      h,
      'money',
      `asked an owner to send a quote${str(args['title']) ? ` for ${String(args['title'])}` : ''}`,
    );
    return { content: { status: 'waiting_for_approval', note: MONEY_NOTE } };
  },

  async record_quote_answer(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    would(
      h,
      'money',
      `asked an owner to record a ${args['accepted'] === true ? 'yes' : 'no'} to a quote`,
    );
    return { content: { status: 'waiting_for_approval', note: MONEY_NOTE } };
  },

  async offer_plan(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(NO_CUSTOMER);
    const plan = h.rc.plans.find((p) => p.id === String(args['planId']));
    if (!plan) return refuse('That isn’t one of the plans in your context.');
    would(h, 'money', `asked an owner to sign them up for ${plan.name}`);
    return { content: { status: 'waiting_for_approval', note: MONEY_NOTE } };
  },

  /** A rehearsal sends no code, and checks none: a real chat does both. */
  async send_verification_code(h) {
    if (!h.rc.unverifiedChat || !h.rc.customer)
      return refuse('There’s nobody on file for this chat to send a code to.');
    would(h, 'note', 'texted a code to the phone on file (or emailed it)');
    return {
      content: {
        sent: true,
        note: 'This is a test: no code went out. Ask them to type the six-digit code here.',
      },
    };
  },

  async check_verification_code(h) {
    if (!h.rc.unverifiedChat || !h.rc.customer)
      return refuse('There’s nobody on file for this chat to check a code for.');
    return refuse(
      'This is a test: codes aren’t checked here. In a real chat, the right code opens their bookings, bills and quotes.',
    );
  },

  async record_answers(h, args) {
    if (!h.rc.lead) return refuse(NO_LEAD);
    const answers = Array.isArray(args['answers']) ? args['answers'] : [];
    would(
      h,
      'answers',
      `saved ${answers.length === 1 ? 'an answer' : `${answers.length} answers`} on ${h.rc.lead.title}`,
    );
    return { content: { status: 'saved', note: 'This is a test: nothing was saved.' } };
  },

  /** The console is a rehearsal: a form is described rather than started, and no sheet is written. */
  async ask_form(h, args) {
    const form = await asWorker(h.deps.db, h.t.scope, (tx) =>
      rows<{
        name: string;
        definition: { pages: { questions: { id: string; title: string }[] }[] };
      }>(
        tx,
        sql`select f.name, v.definition from app.forms f
            join app.form_versions v on v.id = f.active_version_id
            where f.id = ${String(args['formId'])} and f.workspace_id = ${h.t.scope.workspaceId}
              and f.status = 'live' and f.in_chat`,
      ),
    );
    const first = form[0]?.definition.pages.flatMap((p) => p.questions)[0];
    if (!first) return refuse('That form isn’t one you may ask in a conversation.');
    would(h, 'form', `started “${form[0]!.name}”`);
    return {
      content: {
        form: form[0]!.name,
        ask: { questionId: first.id, question: first.title },
        note: 'This is a test: nothing was saved.',
      },
    };
  },

  async answer_form(h, args) {
    would(h, 'form', `saved an answer to ${String(args['questionId'])}`);
    return { content: { saved: true, note: 'This is a test: nothing was saved.' } };
  },

  async move_stage(h, args) {
    if (!h.rc.lead) return refuse(NO_LEAD);
    const stage = h.rc.stages.find((s) => s.id === String(args['stageId']));
    if (!stage || stage.kind !== 'open')
      return refuse('Move the lead only to one of its open stages.');
    would(h, 'stage', `moved the lead to ${stage.name}`);
    return { content: { moved: true } };
  },

  async update_customer(h, args) {
    if (!h.rc.customer || h.rc.unverifiedChat) return refuse(CHAT_REFUSAL);
    const fields = Object.keys(args).filter((k) => args[k] !== null && args[k] !== undefined);
    would(h, 'note', `saved their ${fields.join(' and ') || 'details'}`);
    return { content: { updated: fields } };
  },

  async add_note(h, args) {
    if (!h.rc.customer && !h.rc.lead) return refuse(NO_CUSTOMER);
    would(h, 'note', `added a note: “${String(args['body']).slice(0, 120)}”`);
    return { content: { added: true } };
  },

  /** The test chat has no photos: nothing to note. */
  async note_photos() {
    return refuse('There are no photos in this test chat to note. Use add_note instead.');
  },

  async create_task(h, args) {
    if (!h.rc.customer) return refuse(NO_CUSTOMER);
    would(h, 'task', `created a task: “${String(args['title']).slice(0, 120)}”`);
    return { content: { created: true } };
  },

  async offer_discount(h, args) {
    const money = h.t.config.money;
    const percent = Number(args['percent']);
    if (money.discounts !== 'with_approval')
      return refuse('This business doesn’t let you offer discounts.');
    if (percent > money.maxPercent) return refuse(`At most ${money.maxPercent}%.`);
    if (h.state.discount) return refuse('One discount per reply.');
    h.state.discount = {
      percent,
      reason: String(args['reason']),
      message: String(args['message']),
    };
    would(h, 'discount', `asked a manager to approve ${percent}% off`);
    return {
      content: {
        status: 'waiting_for_approval',
        note: 'A person decides before the customer hears anything. In your reply, say only that you’ve asked the team.',
      },
    };
  },

  async hand_off(h, args) {
    const note = String(args['note']).slice(0, 500);
    h.state.end = { kind: 'hand_off', reason: 'other', note };
    would(h, 'hand_off', `${toPerson(h.t)}: ${note}`);
    return { content: { status: 'handed_off' }, stop: true };
  },

  async reply(h, args) {
    const message = String(args['message']);
    h.state.end = { kind: 'reply', message };
    h.send({ type: 'delta', text: message });
    return { content: { status: 'received' }, stop: true };
  },

  // A phone test: the goodbye, and the call is over.
  async end_call(h, args) {
    const message = String(args['message']);
    h.state.end = { kind: 'end_call', message };
    h.send({ type: 'delta', text: message });
    return { content: { status: 'received' }, stop: true };
  },

  // Only on a call it placed (a phone test's outgoing call): what it would record, described.
  async confirm_visit(h) {
    if (h.t.phone?.outbound?.purpose !== 'confirm_visit')
      return refuse('This call isn’t about confirming a visit.');
    would(h, 'confirm', 'marked their visit confirmed');
    return { content: { status: 'confirmed', already: false } };
  },

  async no_more_calls(h) {
    if (!h.t.phone?.outbound) return refuse('Only on a call you placed.');
    would(h, 'no_calls', 'noted they don’t want calls from the business any more');
    return { content: { status: 'recorded' } };
  },

  async no_reply(h, args) {
    h.state.end = { kind: 'no_reply', reason: String(args['reason']) };
    return { content: { status: 'received' }, stop: true };
  },
};

function simulator(
  h: Hands,
  tools: readonly TeammateTool[],
): (call: AiToolCall) => Promise<Result> {
  const offered = new Map(tools.map((t) => [t.name, t]));
  return async (call) => {
    const tool = offered.get(call.name);
    if (!tool) return refuse('That isn’t one of your tools here.');
    const parsed = tool.input.safeParse(call.arguments);
    if (!parsed.success)
      return {
        content: {
          error: 'Invalid input',
          issues: parsed.error.issues.map(
            (i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`,
          ),
        },
        isError: true,
      };
    try {
      return await RUNNERS[tool.name as TeammateToolName](
        h,
        parsed.data as Record<string, unknown>,
      );
    } catch (e) {
      return { content: toolErrorContent(e), isError: true };
    }
  };
}

// ---- The run ----

function finalText(messages: readonly AiMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return '';
  return typeof last.content === 'string'
    ? last.content.trim()
    : last.content
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join('\n')
        .trim();
}

function checkEvent(verdict: ReplyCheck, rewritten: boolean): ConsoleEvent {
  const failed = new Set(verdict.problems.map((p) => p.rule));
  return {
    type: 'check',
    ok: verdict.ok,
    passed: REPLY_RULES.filter((r) => !failed.has(r)),
    problems: verdict.problems.map((p) => ({ rule: p.rule, message: p.message })),
    rewritten,
    at: nowIso(),
  };
}

/** Who they are, as the log's first line: someone in Customers, or someone it only knows from what they write. */
function whoLine(t: PreparedTest, rc: RunContext, at: string): ConsoleEvent {
  if (rc.unverifiedChat)
    return {
      type: 'context',
      title: 'A website chat visitor',
      detail:
        'In chat it doesn’t see a customer’s record or visits, even when the details they type match, until they type back a code sent to the phone or email on file.',
      at,
    };
  if (rc.customer)
    return {
      type: 'context',
      title: `Read who ${rc.customer.firstName || 'they are'}${rc.customer.firstName ? ' is' : ''}`,
      detail: [
        rc.lead ? `Lead: ${rc.lead.title} (${rc.lead.stageName})` : 'No open lead',
        rc.appointments.length
          ? `${rc.appointments.length} upcoming ${rc.appointments.length === 1 ? 'visit' : 'visits'}`
          : 'No upcoming visits',
      ].join(' · '),
      at,
    };
  return t.phone
    ? {
        type: 'context',
        title: 'An unknown caller',
        detail: 'Nobody in Customers has their number: it only knows what they say.',
        at,
      }
    : {
        type: 'context',
        title: 'An unknown customer',
        detail: 'Nobody in Customers: it only knows what they write.',
        at,
      };
}

/** A phone test's first lines, as the call is picked up or placed: who, why, and whether a real call would be. */
async function tellAboutTheCall(
  deps: ConsoleDeps,
  t: PreparedTest,
  rc: RunContext,
  send: Hands['send'],
) {
  const at = nowIso();
  const out = t.phone?.outbound ?? null;
  send(whoLine(t, rc, at));
  if (out) {
    send({
      type: 'context',
      title: `Called ${out.firstName ?? 'them'}: ${TEST_CALL_REASONS[out.purpose].toLowerCase()}`,
      detail: `It opens by saying it’s an AI, that the call is recorded, and “I’m calling ${out.goal}”`,
      at,
    });
    if (out.brief)
      send({
        type: 'note',
        title: 'What it knows about the call',
        detail: out.brief.split('\n').join(' · '),
        at,
      });
  }
  const { openHours, timeZone } = rc.workspace;
  const closed = !withinHours(openHours, timeZone, t.now);
  if (!t.config.phone.enabled)
    send({
      type: 'note',
      title: 'Phone calls are off',
      detail: out
        ? 'It only places calls once it answers the phone. Here it calls anyway.'
        : 'A real call doesn’t reach it until it answers the phone. Here it answers anyway, so you can hear how.',
      at,
    });
  else if (out) {
    const m = await asWorker(deps.db, t.scope, (tx) => workspaceMessaging(tx, t.scope.workspaceId));
    const quiet = quietHoursState(
      m.settings.quietHours,
      m.timezone || t.timeZone,
      new Date(t.now),
    ).quiet;
    if (closed || quiet)
      send({
        type: 'note',
        title: 'Outside calling hours',
        detail:
          'It places real calls in open hours and never in quiet hours, so this one would wait. Here it calls anyway.',
        at,
      });
  } else if (t.config.phone.answer === 'no_answer')
    send({
      type: 'note',
      title: 'Picks up when the team doesn’t',
      detail: 'A real call rings your team first, and it answers when nobody does.',
      at,
    });
  else if (t.config.phone.answer === 'after_hours' && !closed)
    send({
      type: 'note',
      title: 'You’re open now',
      detail:
        'A real call at this time rings your team: it only picks up while you’re closed. Here it answers anyway.',
      at,
    });
}

/** What it read before answering, as the console's first lines. */
async function tellWhatItRead(
  deps: ConsoleDeps,
  t: PreparedTest,
  rc: RunContext,
  send: Hands['send'],
) {
  if (t.phone) {
    // Who they are and why it called come with the greeting; each turn after reads the knowledge afresh.
    if (!t.input.messages.length) return tellAboutTheCall(deps, t, rc, send);
    send({
      type: 'knowledge',
      query: null,
      items: rc.matches.map((m) => ({ id: m.id, title: m.title })),
      at: nowIso(),
    });
    return;
  }
  const at = nowIso();
  send(whoLine(t, rc, at));
  if (rc.history.length)
    send({
      type: 'context',
      title: 'Read the conversation so far',
      detail: `${rc.history.length} earlier ${rc.history.length === 1 ? 'message' : 'messages'}`,
      at,
    });
  send({
    type: 'knowledge',
    query: null,
    items: rc.matches.map((m) => ({ id: m.id, title: m.title })),
    at,
  });
  if (!workingNow(t.config, rc.workspace.openHours, rc.workspace.timeZone, t.now))
    send({
      type: 'note',
      title: 'Outside its working hours',
      detail:
        'A real message at this time gets no reply from it. Here it answers anyway, so you can see how.',
      at,
    });
  if (t.input.channel === 'sms') {
    const m = await asWorker(deps.db, t.scope, (tx) => workspaceMessaging(tx, t.scope.workspaceId));
    if (quietHoursState(m.settings.quietHours, m.timezone || t.timeZone, new Date(t.now)).quiet)
      send({
        type: 'note',
        title: 'Quiet hours',
        detail: 'It may answer a text within 15 minutes of it coming in, up to 3 times a night.',
        at,
      });
  }
  if (rc.discloseNow)
    send({
      type: 'note',
      title: 'Disclosure line',
      detail: 'This is its first message to them, so it says it’s an AI assistant.',
      at,
    });
}

/** Runs the test, sending each event as it happens; the run is closed whatever happens. */
export async function runTest(
  deps: ConsoleDeps,
  t: PreparedTest,
  send: (e: ConsoleEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const began = Date.now();
  /** On a call: how long it took until the first words could be said. */
  let firstWordsMs: number | null = null;
  let steps = 0;
  const checks: unknown[] = [];
  const state = newRunState();
  const phone = t.phone;
  const training = t.teammate.status === 'training';
  let rc: RunContext | null = null;
  const close = (
    outcome: TestOutcome | null,
    summary: string,
    reply: string | null,
    failed = false,
  ) =>
    asWorker(deps.db, t.scope, (tx) =>
      closeRun(tx, t.runId, {
        status: failed ? 'failed' : 'done',
        outcome,
        summary: `Test: ${summary}`,
        replyText: reply,
        checks,
        toolSteps: steps,
        knowledge: [...state.found.values()].map((f) => ({ itemId: f.id, title: f.title })),
        leadId: rc?.lead?.id ?? null,
        ...(failed ? { error: summary } : {}),
      }),
    );
  const finish = async (
    outcome: TestOutcome,
    reply: string | null,
    summary: string,
    ended = false,
  ) => {
    // Training wheels hold a written reply for an OK. On a call the words are said, and only its changes wait.
    const draft = training && !phone && outcome === 'replied';
    const final = draft ? 'drafted' : outcome;
    await close(final, summary, reply);
    send({
      type: 'done',
      outcome: final,
      reply,
      draft,
      ended,
      toolSteps: steps,
      ms: Date.now() - began,
      firstWordsMs,
    });
  };
  // A hand-off on a call connects them to the team, and that's the end of the call.
  const handOff = (why: string, line: string | null) =>
    finish('handed_off', line, `handed to a person: ${why}`, !!phone);
  /** What they hear as it hands off: on a call, that it's connecting them (or can't go on); in writing, the line. */
  const theLine = (cantGoOn = false) =>
    phone
      ? (cantGoOn ? CANT_GO_ON : CONNECTING).en
      : handoffLine(
          t.config.handOff.tellCustomer,
          handoffExpectation(rc!.workspace.openHours, rc!.workspace.timeZone, t.now),
        );
  try {
    send({ type: 'started', runId: t.runId, at: nowIso() });
    rc = await contextFor(deps, t);
    await tellWhatItRead(deps, t, rc, send);

    // A phone test's first request: the call is picked up, or placed, and it says its greeting.
    if (phone && !t.input.messages.length) {
      const business = rc.grounding.business.name;
      const out = phone.outbound;
      const greeting = out
        ? outboundGreetingOf(t.config, business, out.firstName, out.goal, out.purpose)
        : greetingOf(t.config, business);
      send({ type: 'delta', text: greeting });
      return await finish('replied', greeting, out ? 'placed the call' : 'picked up the call');
    }

    // Straight to a person, before any model call: the customer hears the line (or the safety text).
    const immediate = immediateHandOff(rc);
    if (immediate) {
      const safety = immediate.emergency ? EMERGENCY_SAFETY_TEXT[immediate.emergency] : null;
      const line = phone ? (safety ? `${safety} ${theLine()}` : theLine()) : (safety ?? theLine());
      send({
        type: 'note',
        title: immediate.emergency ? 'An emergency' : 'Straight to a person',
        detail: immediate.note,
        at: nowIso(),
      });
      would(
        { deps, t, rc, state, send },
        'hand_off',
        immediate.emergency
          ? phone
            ? 'said the safety steps, alerted every owner and admin, and connected them to the team'
            : 'sent the safety steps, alerted every owner and admin, and handed it to a person'
          : `${toPerson(t)}: ${immediate.note}`,
      );
      return await handOff(immediate.note, line);
    }

    const hands: Hands = { deps, t, rc, state, send };
    const tools = teammateTools(
      t.config,
      phone
        ? { phone: true, outbound: phone.outbound?.purpose ?? null }
        : { unverifiedChat: rc.unverifiedChat },
    );
    const enders = tools.filter((x) => TEAMMATE_TURN_ENDERS.has(x.name as TeammateToolName));
    const hasRoom = () =>
      aiBudget.teammateHasRoom(deps.db, t.scope, {
        teammateId: t.teammate.id,
        dailyTokens: deps.ai.dailyTokens,
        sharePercent: t.config.limits.dailySharePercent,
        timeZone: t.timeZone,
      });
    const base = {
      provider: t.provider,
      system: TEAMMATE_SYSTEM,
      context: phone
        ? contextText(rc, {
            channelLines: phoneChannelLines({
              training,
              personHasIt: false,
              outbound: phone.outbound,
            }),
          })
        : contextText(rc),
      maxTokens: phone ? PHONE_MAX_TOKENS : MAX_TOKENS,
      execute: simulator(hands, tools),
      onText: (text: string) => send({ type: 'delta', text }),
      onTurnUsage: (usage: AiUsage) =>
        recordAndChargeAi(deps, t.scope, {
          source: 'teammate',
          teammateId: t.teammate.id,
          teammateRunId: t.runId,
          model: t.provider.model,
          usage,
        }),
      checkBudget: hasRoom,
      signal,
    };
    const budgetOut = () => {
      would(hands, 'hand_off', `${toPerson(t)}: it reached its share of today’s AI limit`);
      return handOff('the AI limit was reached', theLine(true));
    };

    // In training nothing it holds on a call has happened yet, so it may not say it has.
    const checked = (words: string) =>
      checkReply(rc!, phone && training ? { ...state, held: [] } : state, words);
    // On a call it starts saying a reply while it's still written, as a real call would.
    const early = phone
      ? new EarlySpeech({
          passes: (words) => checked(words).ok,
          mayStart: () => !state.held.length && !state.moneyAsk,
          say: (sentence) => {
            if (firstWordsMs === null) {
              firstWordsMs = Date.now() - began;
              send({
                type: 'note',
                title: 'Starts talking',
                detail: `On a real call it says “${sentence}” now, checked, while it writes the rest.`,
                at: nowIso(),
              });
            }
            // Out loud, the console says it now too.
            send({ type: 'say', text: sentence });
          },
        })
      : null;

    const said = t.input.messages[t.input.messages.length - 1]!.text;
    const loop = await runToolLoop({
      ...base,
      messages: [
        {
          role: 'user',
          content: phone
            ? phoneTurn(rc, { lines: callLinesOf(t), offered: [] }, said)
            : conversationTurn(rc),
        },
      ],
      tools: tools.map((x) => (phone ? streamSpoken(toolDefinition(x)) : toolDefinition(x))),
      maxRounds: t.config.limits.toolRounds,
      ...(early ? { onToolInput: early.onToolInput } : {}),
    });
    steps += loop.rounds;
    if (loop.stoppedBy === 'aborted') return await close(null, 'stopped', null, true);
    if (loop.stoppedBy === 'error') throw loop.error ?? new Error('The AI didn’t answer.');
    if (state.end?.kind === 'hand_off') return await handOff(state.end.note, theLine());
    if (loop.stoppedBy === 'budget') return await budgetOut();
    if (loop.stoppedBy === 'max_rounds') {
      would(
        hands,
        'hand_off',
        `${toPerson(t)}: it needed more than ${t.config.limits.toolRounds} tool steps`,
      );
      return await handOff('too many tool steps', theLine(true));
    }
    if (state.end?.kind === 'no_reply') return await finish('no_reply', null, state.end.reason);
    const spoken = (end: RunState['end'], messages: readonly AiMessage[]) =>
      end?.kind === 'reply' || end?.kind === 'end_call'
        ? { text: end.message, ending: end.kind === 'end_call' }
        : { text: finalText(messages), ending: false };
    let { text, ending } = spoken(state.end, loop.messages);
    if (!text.trim()) {
      would(hands, 'hand_off', `${toPerson(t)}: it didn’t come up with a reply`);
      return await handOff('no reply', theLine());
    }
    // What it already said while writing: a rewrite carries on from there.
    const saidEarly = early?.said ?? '';
    let verdict = checked(text);
    send(checkEvent(verdict, false));
    checks.push(
      ...verdict.problems.map((p) => ({ rule: p.rule, ok: false, message: p.message, attempt: 1 })),
    );
    if (!verdict.ok) {
      send({
        type: 'note',
        title: 'Rewriting its reply',
        detail: verdict.problems.map((p) => p.message).join('; '),
        at: nowIso(),
      });
      if (!(await hasRoom())) return await budgetOut();
      state.end = null;
      const redo = await runToolLoop({
        ...base,
        messages: [
          ...loop.messages,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: saidEarly
                  ? `${rewriteFeedback(verdict.problems)}\n${alreadySaid(saidEarly)}`
                  : rewriteFeedback(verdict.problems),
              },
            ],
          },
        ],
        tools: enders.map(toolDefinition),
        maxRounds: 1,
      });
      steps += redo.rounds;
      if (redo.stoppedBy === 'aborted') return await close(null, 'stopped', null, true);
      if (redo.stoppedBy === 'error') throw redo.error ?? new Error('The AI didn’t answer.');
      const again = state.end as RunState['end'];
      if (again?.kind === 'hand_off') return await handOff(again.note, theLine());
      if (again?.kind === 'no_reply') return await finish('no_reply', null, again.reason);
      ({ text, ending } = spoken(again, redo.messages));
      verdict = checked(text);
      send(checkEvent(verdict, true));
      checks.push(
        ...REPLY_RULES.map((rule) => {
          const p = verdict.problems.find((x) => x.rule === rule);
          return p
            ? { rule, ok: false, message: p.message, attempt: 2 }
            : { rule, ok: true, attempt: 2 };
        }),
      );
      if (!verdict.ok) {
        would(hands, 'hand_off', `${toPerson(t)}: its reply didn’t pass the safety check twice`);
        return await handOff('the safety check failed twice', theLine(true));
      }
    }
    if (phone) {
      if (training && state.held.length)
        send({
          type: 'note',
          title: 'Waits for the team’s OK (training wheels)',
          detail:
            'On a real call it says the team will confirm by text, and the change waits on Approvals until someone approves it.',
          at: nowIso(),
        });
      const words =
        saidEarly && !text.trim().startsWith(saidEarly)
          ? `${saidEarly} ${text.trim()}`
          : text.trim();
      return await finish(
        'replied',
        words,
        `${ending ? 'said goodbye' : 'said'} “${words.slice(0, 80)}” on a call`,
        ending,
      );
    }
    const reply = t.input.channel === 'sms' ? plainSmsText(text) : text.trim();
    return await finish('replied', reply, `replied “${reply.slice(0, 80)}”`);
  } catch (e) {
    await close(null, e instanceof Error ? e.message : 'The test stopped.', null, true).catch(
      () => undefined,
    );
    throw e;
  }
}
