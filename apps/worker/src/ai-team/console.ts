/**
 * The builder's test console (plan M7, "Other work"): POST /v1/ai-team/test, for people with ai_team.manage
 * (routes.ts). A manager writes as a customer and the teammate answers as it would, streamed back. The event
 * contract is at the top of apps/web/src/lib/ai-team/test-stream.ts, and the two stay in step.
 *
 * It runs on the settings being tested (the builder's unsaved draft, or the saved ones), for someone in
 * Customers or an unknown visitor, at a pretend time when asked.
 * - Look-ups are real queries: Knowledge, open times, the customer's record and visits.
 * - Anything that would change something is only described ("Would have: booked Thu 10 AM"). No command runs
 *   (the kernel refuses a test actor's commands anyway), and nothing is sent.
 * - Nothing is stored but a run marked is_test, with its tokens, so the AI limit counts them. Test runs never
 *   count toward training wheels.
 */
import type { AiMessage, AiProvider, AiToolCall, AiUsage } from '@hfos/ai';
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
  uuidArray,
  workspaceMessaging,
  zip5,
  type DraftAction,
  type ReplyCheck,
  type TeammateConfig,
  type TeammateRow,
  type TeammateTool,
  type TeammateToolName,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { z, ZodError } from 'zod';
import { aiBudget, recordAndChargeAi } from '../ai/budget';
import type { WalletDeps } from '../money/wallet';
import { runToolLoop, toolErrorContent, type ToolLoopAnswer } from '../ai/tool-loop';
import { atLabel, isoWithOffset } from '../assistant/calendar-format';
import { anyOfWords, findKnowledge } from '../knowledge/find';
import { systemActor, type TenantScope } from '../services';
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
  loadRunContext,
  pastAppointments,
  upcomingAppointments,
  type BatchMessage,
  type HistoryLine,
  type RunContext,
} from './context';
import { workingNow } from './gates';
import { handoffExpectation, handoffLine } from './hours';
import { contextText, conversationTurn, rewriteFeedback, TEAMMATE_SYSTEM } from './prompt';
import { checkReply, closeRun, immediateHandOff } from './run';
import { newRunState, timeKey, toolDefinition, type RunState } from './tools';

/** The request (the web's TestBody). */
export const TestConsoleInput = z.object({
  workspaceId: z.uuid(),
  /** Who to be: someone in Customers, or null for an unknown visitor. */
  personId: z.uuid().nullable().default(null),
  channel: z.enum(['sms', 'email', 'chat']),
  /** Pretend it's this time; null is now. */
  at: z.iso.datetime({ offset: true }).nullable().default(null),
  /** The settings to test (the builder's unsaved draft); null tests the saved ones. */
  config: z.unknown().nullable().default(null),
  /** The test chat so far, oldest first, ending with the customer's new message. */
  messages: z
    .array(
      z.object({
        from: z.enum(['customer', 'teammate']),
        text: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(40),
});
export type TestConsoleInput = z.infer<typeof TestConsoleInput>;

/** A change it would have made (the web's WOULD_KINDS). */
type WouldKind =
  | 'book'
  | 'reschedule'
  | 'cancel'
  | 'repeat'
  | 'waitlist'
  | 'note'
  | 'task'
  | 'stage'
  | 'answers'
  | 'discount'
  | 'money'
  | 'form'
  | 'hand_off';
type Outcome = 'replied' | 'drafted' | 'handed_off' | 'no_reply';

/** What the console streams (the web's TestEvent). */
export type ConsoleEvent =
  | { readonly type: 'started'; readonly runId: string; readonly at: string }
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'context' | 'note';
      readonly title: string;
      readonly detail: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'knowledge';
      readonly query: string | null;
      readonly items: readonly { readonly id: string; readonly title: string }[];
      readonly at: string;
    }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly title: string;
      readonly detail: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'would';
      readonly kind: WouldKind;
      readonly summary: string;
      readonly at: string;
    }
  | {
      readonly type: 'check';
      readonly ok: boolean;
      readonly passed: readonly string[];
      readonly problems: readonly { readonly rule: string; readonly message: string }[];
      readonly rewritten: boolean;
      readonly at: string;
    }
  | {
      readonly type: 'done';
      readonly outcome: Outcome;
      readonly reply: string | null;
      readonly draft: boolean;
      readonly toolSteps: number;
      readonly ms: number;
    }
  | { readonly type: 'error'; readonly message: string };

export interface ConsoleDeps {
  readonly db: Db;
  readonly ai: { readonly provider: AiProvider | null; readonly dailyTokens: number };
  readonly webUrl: string;
  readonly log: Logger;
  /** The test chat's tokens are real tokens: a business trying its teammate out is charged for it like anything else. */
  readonly wallet: WalletDeps;
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
  if (input.messages[input.messages.length - 1]!.from !== 'customer')
    throw HfosError.validation([
      {
        path: `messages.${input.messages.length - 1}`,
        message: 'End with the customer’s new message.',
      },
    ]);
  const [ws] = await asWorker(deps.db, { workspaceId: input.workspaceId }, (tx) =>
    rows<{ organization_id: string; timezone: string | null }>(
      tx,
      sql`select organization_id, timezone from app.workspaces where id = ${input.workspaceId}`,
    ),
  );
  if (!ws) throw HfosError.notFound('Workspace not found.');
  const scope: TenantScope = { workspaceId: input.workspaceId, organizationId: ws.organization_id };
  const timeZone = ws.timezone || 'UTC';
  const provider = deps.ai.provider;
  if (!provider)
    throw HfosError.rule(
      'ai_not_configured',
      503,
      'The AI isn’t set up yet, so the test console can’t answer.',
    );
  const { teammate, config } = await asWorker(deps.db, scope, async (tx) => {
    const row = await loadTeammate(tx, scope.workspaceId);
    if (!row) throw HfosError.rule('no_teammate', 409, 'Set up your AI teammate first.');
    if (input.personId) {
      const [p] = await rows(
        tx,
        sql`select 1 from app.people where id = ${input.personId} and workspace_id = ${scope.workspaceId}
              and archived_at is null`,
      );
      if (!p) throw HfosError.notFound('Customer not found.');
    }
    return {
      teammate: row,
      config: input.config === null ? runtimeConfigOf(row.config) : draftConfig(input.config),
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
    now: input.at ? Date.parse(input.at) : Date.now(),
    timeZone,
    runId: made!.id,
  };
}

/** The run's context from the test chat: the earlier messages are its history, the customer's latest its batch. */
async function contextFor(deps: ConsoleDeps, t: PreparedTest): Promise<RunContext> {
  const msgs = t.input.messages;
  const lastTeammate = msgs.map((m) => m.from).lastIndexOf('teammate');
  const at = (i: number) => t.now - (msgs.length - i) * 60_000;
  const batch: BatchMessage[] = msgs.slice(lastTeammate + 1).map((m, j) => ({
    id: `test-${lastTeammate + 1 + j}`,
    channel: t.input.channel,
    text: m.text,
    subject: null,
    at: at(lastTeammate + 1 + j),
  }));
  const rc = await asWorker(deps.db, t.scope, (tx) =>
    loadRunContext(tx, {
      scope: t.scope,
      teammate: t.teammate,
      config: t.config,
      conversationId: null,
      target: { personId: t.input.personId, channel: t.input.channel },
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
    const postalCode = str(args['postalCode']);
    if (cal.byZip && !postalCode)
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
    const zip = zip5(String(args['postalCode']));
    if (!zip) return refuse('That isn’t a ZIP code. Ask them for their 5-digit ZIP.');
    const areas = await asWorker(h.deps.db, h.t.scope, (tx) =>
      loadTerritories(tx, h.t.scope.workspaceId),
    );
    const covering = areas.filter((a) => a.postalCodes.some((p) => zip5(p) === zip));
    h.send({
      type: 'tool',
      name: 'check_service_area',
      title: `Checked the service area for ${zip}`,
      detail: !areas.length
        ? 'No ZIP codes listed yet.'
        : covering.length
          ? `Served: ${covering.map((a) => a.name).join(', ')}`
          : 'Not in any of your areas.',
      at: nowIso(),
    });
    if (!areas.length)
      return {
        content: {
          served: null,
          note: 'The business hasn’t listed the ZIP codes it serves. Go by the service area in the business profile; if it doesn’t say, follow your “when unsure” rule.',
        },
      };
    return {
      content: {
        served: covering.length > 0,
        ...(covering.length ? { areas: covering.map((a) => quoteData(a.name)) } : {}),
        ...(covering.length
          ? {}
          : {
              note: 'The business doesn’t list this ZIP code. Tell them kindly, and don’t book a visit at their place. Hand off if they want someone to double-check.',
            }),
      },
    };
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
    would(h, 'hand_off', `handed it to a person: ${note}`);
    return { content: { status: 'handed_off' }, stop: true };
  },

  async reply(h, args) {
    const message = String(args['message']);
    h.state.end = { kind: 'reply', message };
    h.send({ type: 'delta', text: message });
    return { content: { status: 'received' }, stop: true };
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

/** What it read before answering, as the console's first lines. */
async function tellWhatItRead(
  deps: ConsoleDeps,
  t: PreparedTest,
  rc: RunContext,
  send: Hands['send'],
) {
  const at = nowIso();
  if (rc.unverifiedChat)
    send({
      type: 'context',
      title: 'A website chat visitor',
      detail:
        'In chat it doesn’t see a customer’s record or visits, even when the details they type match, until they type back a code sent to the phone or email on file.',
      at,
    });
  else if (rc.customer)
    send({
      type: 'context',
      title: `Read who ${rc.customer.firstName || 'they are'}${rc.customer.firstName ? ' is' : ''}`,
      detail: [
        rc.lead ? `Lead: ${rc.lead.title} (${rc.lead.stageName})` : 'No open lead',
        rc.appointments.length
          ? `${rc.appointments.length} upcoming ${rc.appointments.length === 1 ? 'visit' : 'visits'}`
          : 'No upcoming visits',
      ].join(' · '),
      at,
    });
  else
    send({
      type: 'context',
      title: 'An unknown customer',
      detail: 'Nobody in Customers: it only knows what they write.',
      at,
    });
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
  let steps = 0;
  const checks: unknown[] = [];
  const state = newRunState();
  let rc: RunContext | null = null;
  const close = (outcome: Outcome | null, summary: string, reply: string | null, failed = false) =>
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
  const finish = async (outcome: Outcome, reply: string | null, summary: string) => {
    const training = t.teammate.status === 'training' && outcome === 'replied';
    const final = training ? 'drafted' : outcome;
    await close(final, summary, reply);
    send({
      type: 'done',
      outcome: final,
      reply,
      draft: training,
      toolSteps: steps,
      ms: Date.now() - began,
    });
  };
  const handOff = (why: string, line: string | null) =>
    finish('handed_off', line, `handed to a person: ${why}`);
  const theLine = () =>
    handoffLine(
      t.config.handOff.tellCustomer,
      handoffExpectation(rc!.workspace.openHours, rc!.workspace.timeZone, t.now),
    );
  try {
    send({ type: 'started', runId: t.runId, at: nowIso() });
    rc = await contextFor(deps, t);
    await tellWhatItRead(deps, t, rc, send);

    // Straight to a person, before any model call: the customer hears the line (or the safety text).
    const immediate = immediateHandOff(rc);
    if (immediate) {
      const line = immediate.emergency ? EMERGENCY_SAFETY_TEXT[immediate.emergency] : theLine();
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
          ? 'sent the safety steps, alerted every owner and admin, and handed it to a person'
          : `handed it to a person: ${immediate.note}`,
      );
      return await handOff(immediate.note, line);
    }

    const hands: Hands = { deps, t, rc, state, send };
    const tools = teammateTools(t.config, { unverifiedChat: rc.unverifiedChat });
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
      context: contextText(rc),
      maxTokens: MAX_TOKENS,
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
      would(hands, 'hand_off', 'handed it to a person: it reached its share of today’s AI limit');
      return handOff('the AI limit was reached', theLine());
    };

    const loop = await runToolLoop({
      ...base,
      messages: [{ role: 'user', content: conversationTurn(rc) }],
      tools: tools.map(toolDefinition),
      maxRounds: t.config.limits.toolRounds,
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
        `handed it to a person: it needed more than ${t.config.limits.toolRounds} tool steps`,
      );
      return await handOff('too many tool steps', theLine());
    }
    if (state.end?.kind === 'no_reply') return await finish('no_reply', null, state.end.reason);
    let text = state.end?.kind === 'reply' ? state.end.message : finalText(loop.messages);
    if (!text.trim()) {
      would(hands, 'hand_off', 'handed it to a person: it didn’t come up with a reply');
      return await handOff('no reply', theLine());
    }
    let verdict = checkReply(rc, state, text);
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
          { role: 'user', content: [{ type: 'text', text: rewriteFeedback(verdict.problems) }] },
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
      text = again?.kind === 'reply' ? again.message : finalText(redo.messages);
      verdict = checkReply(rc, state, text);
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
        would(
          hands,
          'hand_off',
          'handed it to a person: its reply didn’t pass the safety check twice',
        );
        return await handOff('the safety check failed twice', theLine());
      }
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
