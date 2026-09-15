/**
 * The AI teammate's hands (plan M7, "Worker runtime" step 5): each tool the model calls, run for the customer
 * in this run's conversation and nobody else. No tool takes a person, lead or conversation id: the worker fills
 * them in from the run, and core checks them again.
 *
 * - Every call is recorded before it runs (ai_teammate_tool_calls, once per run and provider call id), and a
 *   command's writes commit with its record. A retried job that meets the same call reads back what it did
 *   instead of doing it twice.
 * - Customer-facing changes (book, reschedule, cancel) are held: the finish runs them with the reply
 *   (automatic) or puts them in the draft (training), so a run that's superseded or fails its checks changes
 *   nothing a customer sees. Internal work (notes, tasks, answers, stage moves) runs at once. A discount becomes
 *   an approval draft at the finish, in any mode.
 * - reply, no_reply and hand_off end the turn; a refusal that means the conversation isn't the teammate's
 *   anymore (a person took it over, they opted out) ends the run.
 */
import type { AiToolCall, AiToolDefinition } from '@hfos/ai';
import {
  activityLog,
  addDays,
  calendarAvailability,
  conversationHandoffReasonOf,
  executeCommandIn,
  executeQuery,
  formatDuration,
  HfosError,
  isLocalDate,
  leadMoveStage,
  leadRecordAnswers,
  localDateOf,
  personUpdate,
  quoteData,
  startOfLocalDay,
  taskCreate,
  toolInputSchema,
  type AiEmployeeActor,
  type ConversationHandoffReason,
  type DraftAction,
  type HandOffReason,
  type RequestMeta,
  type TeammateTool,
  type TeammateToolName,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { toolErrorContent, type ToolLoopAnswer } from '../ai/tool-loop';
import { atLabel, isoWithOffset } from '../assistant/calendar-format';
import { anyOfWords, findKnowledge } from '../knowledge/find';
import type { TenantScope } from '../services';
import { HELD_MAX, SEARCH_MATCHES, TIMES_MAX_DAYS, TIMES_SHOWN } from './constants';
import { upcomingAppointments, type RunContext } from './context';
import { emergencyIn, handOffInConversation } from './handoff';

// ---- What a run has done so far ----

/** A time find_times offered in this run: only these can be booked. */
export interface OfferedTime {
  readonly calendarId: string;
  /** UTC ISO. */
  readonly startsAt: string;
  readonly sessionId: string | null;
  readonly serviceId: string | null;
  readonly durationMinutes: number | null;
  readonly label: string;
}

export interface FoundItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export type RunEnd =
  | { readonly kind: 'reply'; readonly message: string }
  | { readonly kind: 'no_reply'; readonly reason: string }
  | {
      readonly kind: 'hand_off';
      readonly reason: ConversationHandoffReason;
      readonly note: string;
    };

/** superseded: a person took the conversation over; opted_out: they said STOP; outside: it reached past its conversation. */
export type RunAbort = 'superseded' | 'opted_out' | 'outside';

export interface Discount {
  readonly percent: number;
  readonly reason: string;
  readonly message: string;
}

export interface RunState {
  readonly offered: Map<string, OfferedTime>;
  readonly held: DraftAction[];
  readonly found: Map<string, FoundItem>;
  /** A knowledge search ran (whether or not it found anything). */
  searched: boolean;
  discount: Discount | null;
  end: RunEnd | null;
  abort: RunAbort | null;
}

export function newRunState(): RunState {
  return {
    offered: new Map(),
    held: [],
    found: new Map(),
    searched: false,
    discount: null,
    end: null,
    abort: null,
  };
}

/** What one call changed in the run, stored with it so a replay puts it back. */
interface Effect {
  readonly offered?: readonly OfferedTime[];
  readonly found?: readonly FoundItem[];
  readonly searched?: boolean;
  readonly held?: DraftAction;
  readonly discount?: Discount;
  readonly end?: RunEnd;
  readonly abort?: RunAbort;
}

export const timeKey = (calendarId: string, startsAt: string): string =>
  `${calendarId}|${new Date(startsAt).toISOString()}`;

const END_RANK: Readonly<Record<RunEnd['kind'], number>> = { no_reply: 0, reply: 1, hand_off: 2 };

function applyEffect(state: RunState, effect: Effect | undefined): void {
  if (!effect) return;
  for (const o of effect.offered ?? []) state.offered.set(timeKey(o.calendarId, o.startsAt), o);
  for (const f of effect.found ?? []) state.found.set(f.id, f);
  if (effect.searched) state.searched = true;
  if (effect.held) state.held.push(effect.held);
  if (effect.discount) state.discount = effect.discount;
  // A hand-off outranks a reply, which outranks "no reply"; a later reply replaces an earlier one.
  if (effect.end && (!state.end || END_RANK[effect.end.kind] >= END_RANK[state.end.kind]))
    state.end = effect.end;
  if (effect.abort) state.abort ??= effect.abort;
}

// ---- The executor ----

export interface ExecutorDeps {
  readonly db: Db;
  readonly scope: TenantScope;
  readonly runId: string;
  /** The teammate, tied to this run's conversation. */
  readonly ai: AiEmployeeActor;
  readonly meta: RequestMeta;
  readonly rc: RunContext;
  readonly state: RunState;
  /** The tools this run offers the model. */
  readonly tools: readonly TeammateTool[];
  /** Training wheels: the held changes go into a draft. */
  readonly training: boolean;
  readonly log: Logger;
}

type Status = 'done' | 'held' | 'refused' | 'failed';

interface Outcome {
  readonly status: Status;
  readonly content: unknown;
  readonly effect?: Effect;
  readonly command?: string | null;
  readonly error?: string | null;
  readonly stop?: boolean;
}

const refused = (content: Record<string, unknown>): Outcome => ({
  status: 'refused',
  content,
  error: typeof content['error'] === 'string' ? content['error'] : null,
});

export function toolDefinition(tool: TeammateTool): AiToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: toolInputSchema(tool) };
}

/** A tool name as the table allows it (a made-up tool is still recorded). */
const safeToolName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z_]/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64) || 'unknown';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Runs one tool call for the loop, recorded once. */
export function createExecutor(d: ExecutorDeps): (call: AiToolCall) => Promise<ToolLoopAnswer> {
  const offered = new Map(d.tools.map((t) => [t.name, t]));
  return async (call) => {
    const tool = offered.get(call.name);
    const callId = (call.id || 'call').slice(0, 200);
    const claim = await claimCall(d, callId, tool?.name ?? safeToolName(call.name), call.arguments);
    if (claim.replay) {
      const stored = isRecord(claim.result) ? claim.result : {};
      applyEffect(d.state, stored['effect'] as Effect | undefined);
      return {
        content: stored['content'] ?? {},
        isError: claim.status === 'refused' || claim.status === 'failed',
        ...(stored['stop'] ? { stop: true } : {}),
      };
    }
    let outcome: Outcome;
    try {
      outcome = await asWorker(d.db, d.scope, async (tx) => {
        const o = await runCall(d, tx, tool, call);
        await finishCall(tx, d.runId, callId, o);
        return o;
      });
    } catch (e) {
      d.log.warn({ err: e, tool: call.name, runId: d.runId }, 'an AI teammate tool failed');
      const failed: Outcome = {
        status: 'failed',
        content: toolErrorContent(e),
        error: e instanceof Error ? e.message : String(e),
      };
      outcome = failed;
      await asWorker(d.db, d.scope, (tx) => finishCall(tx, d.runId, callId, failed)).catch(
        () => undefined,
      );
    }
    applyEffect(d.state, outcome.effect);
    return {
      content: outcome.content,
      isError: outcome.status === 'refused' || outcome.status === 'failed',
      ...(outcome.stop ? { stop: true } : {}),
    };
  };
}

type Claim =
  | { readonly replay: false }
  | { readonly replay: true; readonly status: string; readonly result: unknown };

/**
 * Records the call before it runs. When this run already recorded it (a retried job meeting the same call), the
 * earlier result comes back instead; a call still marked running rolled back with its work, so it runs again.
 */
async function claimCall(
  d: ExecutorDeps,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Claim> {
  const json = JSON.stringify(isRecord(args) ? args : {});
  return asWorker(d.db, d.scope, async (tx) => {
    const made = await rows<{ id: string }>(
      tx,
      sql`insert into app.ai_teammate_tool_calls (workspace_id, run_id, provider_call_id, tool, arguments)
          values (${d.scope.workspaceId}, ${d.runId}, ${callId}, ${tool},
            ${json.length > 60_000 ? '{"truncated":true}' : json}::jsonb)
          on conflict (run_id, provider_call_id) do nothing
          returning id`,
    );
    if (made.length) return { replay: false };
    const [old] = await rows<{ status: string; result: unknown }>(
      tx,
      sql`select status, result from app.ai_teammate_tool_calls
          where run_id = ${d.runId} and provider_call_id = ${callId}`,
    );
    return !old || old.status === 'running'
      ? { replay: false }
      : { replay: true, status: old.status, result: old.result };
  });
}

async function finishCall(tx: Tx, runId: string, callId: string, o: Outcome): Promise<void> {
  const result = {
    content: o.content ?? {},
    ...(o.effect ? { effect: o.effect } : {}),
    ...(o.stop ? { stop: true } : {}),
  };
  await tx.execute(
    sql`update app.ai_teammate_tool_calls
        set status = ${o.status}, result = ${JSON.stringify(result)}::jsonb,
          error = ${o.error ? o.error.slice(0, 2000) : null}, command = ${o.command ?? null}
        where run_id = ${runId} and provider_call_id = ${callId}`,
  );
}

async function runCall(
  d: ExecutorDeps,
  tx: Tx,
  tool: TeammateTool | undefined,
  call: AiToolCall,
): Promise<Outcome> {
  if (!tool) return refused({ error: 'That isn’t one of your tools here.' });
  const parsed = tool.input.safeParse(call.arguments);
  if (!parsed.success)
    return refused({
      error: 'Invalid input',
      issues: parsed.error.issues.map(
        (i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`,
      ),
    });
  try {
    return await RUNNERS[tool.name as TeammateToolName](
      d,
      tx,
      parsed.data as Record<string, unknown>,
    );
  } catch (e) {
    if (e instanceof HfosError) return refusalOf(e);
    throw e;
  }
}

const CHAT_REFUSAL =
  'In website chat you can’t see or change existing bookings or records. Tell them the link in their confirmation changes a booking, or hand off.';

/** A command's refusal, for the model; the ones that mean the conversation isn't the teammate's end the run. */
function refusalOf(e: HfosError): Outcome {
  const base = { status: 'refused' as const, error: e.message, content: toolErrorContent(e) };
  switch (e.rule) {
    case 'not_handled_by_ai':
      return { ...base, effect: { abort: 'superseded' }, stop: true };
    case 'outside_its_conversation':
      return { ...base, effect: { abort: 'outside' }, stop: true };
    case 'opted_out':
      return { ...base, effect: { abort: 'opted_out' }, stop: true };
    case 'chat_identity_unverified':
      return { ...base, content: { error: CHAT_REFUSAL } };
    default:
      return base;
  }
}

// ---- The tools ----

type Runner = (d: ExecutorDeps, tx: Tx, args: Record<string, unknown>) => Promise<Outcome>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const heldNote = (d: ExecutorDeps) =>
  d.training
    ? 'It happens once a person approves your reply. You can tell them it’s done.'
    : 'It happens as your reply goes out. You can tell them it’s done.';

async function customersAppointment(d: ExecutorDeps, tx: Tx, appointmentId: string) {
  if (!d.rc.customer || d.rc.unverifiedChat) return null;
  const list = await upcomingAppointments(
    tx,
    d.scope.workspaceId,
    d.rc.customer.id,
    d.rc.workspace.timeZone,
  );
  return list.find((a) => a.id === appointmentId) ?? null;
}

const NOT_THEIRS = 'That isn’t one of this customer’s upcoming appointments.';
const NO_CUSTOMER =
  'There’s no customer on file for this conversation yet, so there’s nowhere to put that.';
const NO_LEAD = 'This customer has no open lead to put that on. Add a note instead.';

const RUNNERS: Readonly<Record<TeammateToolName, Runner>> = {
  async search_knowledge(d, tx, args) {
    const query = String(args['query']);
    const items = await findKnowledge(tx, {
      workspaceId: d.scope.workspaceId,
      queries: [anyOfWords(query), query],
      limit: SEARCH_MATCHES,
    });
    const found = items.map((m) => ({ id: m.id, title: m.title, body: m.body }));
    return {
      status: 'done',
      content: found.length
        ? {
            items: found.map((f) => ({
              id: f.id,
              title: quoteData(f.title),
              text: quoteData(f.body.slice(0, 1500)),
            })),
          }
        : {
            items: [],
            note: 'Nothing in the knowledge base matches. Try other words, or follow your rule for when you’re unsure.',
          },
      effect: { found, searched: true },
    };
  },

  async find_times(d, _tx, args) {
    const calendarId = String(args['calendarId']);
    const cal = d.rc.calendars.find((c) => c.id === calendarId);
    if (!cal)
      return refused({
        error: 'That isn’t one of your calendars. Use a calendar id from the context.',
      });
    const tz = cal.timeZone;
    const from = String(args['from']);
    const to = str(args['to']);
    const fromMs = isLocalDate(from) ? startOfLocalDay(from, tz) : Date.parse(from);
    const start = Math.max(fromMs, Date.now());
    const asked = to
      ? isLocalDate(to)
        ? startOfLocalDay(addDays(to, 1), tz)
        : Date.parse(to)
      : startOfLocalDay(addDays(localDateOf(fromMs, tz), 1), tz);
    const end = Math.min(asked, start + TIMES_MAX_DAYS * 86_400_000);
    if (!(end > start))
      return {
        status: 'done',
        content: { times: [], note: 'That’s past. Ask about a later day.' },
      };
    const serviceId = str(args['serviceId']);
    const durationMinutes =
      typeof args['durationMinutes'] === 'number' ? args['durationMinutes'] : undefined;
    const out = await executeQuery(
      d.db,
      calendarAvailability,
      {
        workspaceId: d.scope.workspaceId,
        calendarId,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        serviceId,
        ...(durationMinutes ? { durationMinutes } : {}),
      },
      d.ai,
      d.meta,
    );
    const shown = out.slots.slice(0, TIMES_SHOWN);
    const offered: OfferedTime[] = shown.map((s) => {
      const at = Date.parse(s.startsAt);
      return {
        calendarId,
        startsAt: new Date(at).toISOString(),
        sessionId: s.sessionId,
        serviceId: out.serviceId,
        durationMinutes: durationMinutes ?? null,
        label: atLabel(at, tz),
      };
    });
    return {
      status: 'done',
      content: {
        calendar: quoteData(cal.name),
        timezone: tz,
        length: formatDuration(out.durationMinutes),
        times: offered.map((o) => ({
          startsAt: isoWithOffset(Date.parse(o.startsAt), tz),
          label: o.label,
        })),
        ...(out.slots.length > shown.length ? { more: true } : {}),
        ...(shown.length ? {} : { note: 'No open times then. Try another day.' }),
      },
      effect: { offered },
    };
  },

  async my_appointments(d, tx) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    const list = await upcomingAppointments(
      tx,
      d.scope.workspaceId,
      d.rc.customer.id,
      d.rc.workspace.timeZone,
    );
    return {
      status: 'done',
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

  async book(d, _tx, args) {
    const calendarId = String(args['calendarId']);
    const cal = d.rc.calendars.find((c) => c.id === calendarId);
    if (!cal) return refused({ error: 'That isn’t one of your calendars.' });
    const slot = d.state.offered.get(timeKey(calendarId, String(args['startsAt'])));
    if (!slot)
      return refused({
        error:
          'Book only one of the times find_times gave you in this conversation. Call find_times first.',
      });
    if (d.state.held.length >= HELD_MAX)
      return refused({ error: 'That’s as many changes as one reply can make.' });
    const held: DraftAction = {
      kind: 'book',
      calendarId,
      startsAt: slot.startsAt,
      serviceId: str(args['serviceId']) ?? slot.serviceId,
      durationMinutes: slot.durationMinutes,
      sessionId: slot.sessionId,
      notes: str(args['notes']),
      summary: `Book ${slot.label} on ${cal.name}`.slice(0, 300),
    };
    return {
      status: 'held',
      content: { status: 'ready', when: slot.label, note: heldNote(d) },
      effect: { held },
    };
  },

  async reschedule(d, tx, args) {
    const appt = await customersAppointment(d, tx, String(args['appointmentId']));
    if (!appt) return refused({ error: NOT_THEIRS });
    const slot = d.state.offered.get(timeKey(appt.calendarId, String(args['startsAt'])));
    if (!slot)
      return refused({
        error: 'Move it only to a time find_times gave you on its calendar in this conversation.',
      });
    if (d.state.held.length >= HELD_MAX)
      return refused({ error: 'That’s as many changes as one reply can make.' });
    const held: DraftAction = {
      kind: 'reschedule',
      appointmentId: appt.id,
      startsAt: slot.startsAt,
      sessionId: slot.sessionId,
      summary: `Move ${appt.title} to ${slot.label}`.slice(0, 300),
    };
    return {
      status: 'held',
      content: { status: 'ready', when: slot.label, note: heldNote(d) },
      effect: { held },
    };
  },

  async cancel(d, tx, args) {
    const appt = await customersAppointment(d, tx, String(args['appointmentId']));
    if (!appt) return refused({ error: NOT_THEIRS });
    if (d.state.held.length >= HELD_MAX)
      return refused({ error: 'That’s as many changes as one reply can make.' });
    const held: DraftAction = {
      kind: 'cancel',
      appointmentId: appt.id,
      reason: str(args['reason']),
      summary: `Cancel ${appt.title} on ${atLabel(appt.startsAt, appt.timeZone)}`.slice(0, 300),
    };
    return {
      status: 'held',
      content: { status: 'ready', note: heldNote(d) },
      effect: { held },
    };
  },

  async record_answers(d, tx, args) {
    if (!d.rc.lead) return refused({ error: NO_LEAD });
    const r = await executeCommandIn(
      tx,
      leadRecordAnswers,
      { workspaceId: d.scope.workspaceId, leadId: d.rc.lead.id, answers: args['answers'] },
      d.ai,
      d.meta,
    );
    const stage = d.rc.config.qualify.whenQualified.stageId;
    return {
      status: 'done',
      command: 'lead.record_answers',
      content: {
        status: r.output.status,
        missing: r.output.missing,
        qualified: r.output.qualified,
        ...(r.output.qualified && stage
          ? { next: `Move the lead with move_stage (stage id ${stage}).` }
          : {}),
      },
    };
  },

  async move_stage(d, tx, args) {
    if (!d.rc.lead) return refused({ error: NO_LEAD });
    await executeCommandIn(
      tx,
      leadMoveStage,
      { workspaceId: d.scope.workspaceId, leadId: d.rc.lead.id, stageId: args['stageId'] },
      d.ai,
      d.meta,
    );
    return { status: 'done', command: 'lead.move_stage', content: { moved: true } };
  },

  async update_customer(d, tx, args) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: CHAT_REFUSAL });
    const r = await executeCommandIn(
      tx,
      personUpdate,
      { workspaceId: d.scope.workspaceId, personId: d.rc.customer.id, ...args },
      d.ai,
      d.meta,
    );
    return {
      status: 'done',
      command: 'person.update',
      content: {
        updated: r.output.updated,
        ...(r.output.updated.length
          ? {}
          : { note: 'Nothing changed: those details are on file already.' }),
      },
    };
  },

  async add_note(d, tx, args) {
    if (!d.rc.customer && !d.rc.lead) return refused({ error: NO_CUSTOMER });
    await executeCommandIn(
      tx,
      activityLog,
      {
        workspaceId: d.scope.workspaceId,
        kind: 'note',
        body: String(args['body']),
        personId: d.rc.customer?.id ?? null,
        leadId: d.rc.lead?.id ?? null,
      },
      d.ai,
      d.meta,
    );
    return { status: 'done', command: 'activity.log', content: { added: true } };
  },

  async create_task(d, tx, args) {
    if (!d.rc.customer) return refused({ error: NO_CUSTOMER });
    const dueAt = str(args['dueAt']);
    await executeCommandIn(
      tx,
      taskCreate,
      {
        workspaceId: d.scope.workspaceId,
        title: String(args['title']),
        notes: str(args['notes']),
        dueAt,
        allDay: !dueAt,
        assigneeUserId: d.rc.lead?.assigneeUserId ?? d.rc.customer.ownerUserId ?? null,
        personId: d.rc.customer.id,
        leadId: d.rc.lead?.id ?? null,
      },
      d.ai,
      d.meta,
    );
    return { status: 'done', command: 'task.create', content: { created: true } };
  },

  async offer_discount(d, _tx, args) {
    const money = d.rc.config.money;
    const percent = Number(args['percent']);
    if (money.discounts !== 'with_approval')
      return refused({ error: 'This business doesn’t let you offer discounts.' });
    if (percent > money.maxPercent) return refused({ error: `At most ${money.maxPercent}%.` });
    if (d.state.discount) return refused({ error: 'One discount per reply.' });
    const discount: Discount = {
      percent,
      reason: String(args['reason']),
      message: String(args['message']),
    };
    return {
      status: 'held',
      content: {
        status: 'waiting_for_approval',
        note: 'A person decides before the customer hears anything. In your reply, say only that you’ve asked the team.',
      },
      effect: { discount },
    };
  },

  async hand_off(d, tx, args) {
    const reason = conversationHandoffReasonOf(args['reason'] as HandOffReason);
    const note = String(args['note']).slice(0, 500);
    // The customer hears the hand-off line first (the safety text, for an emergency they described).
    const emergency = reason === 'emergency' ? emergencyIn(d.rc.batch.map((b) => b.text)) : null;
    await handOffInConversation(tx, d.ai, d.meta, reason, note, {
      line: emergency ? { emergency } : 'usual',
    });
    return {
      status: 'done',
      command: 'conversation.hand_off',
      content: { status: 'handed_off' },
      effect: { end: { kind: 'hand_off', reason, note } },
      stop: true,
    };
  },

  async reply(_d, _tx, args) {
    return {
      status: 'done',
      content: { status: 'received' },
      effect: { end: { kind: 'reply', message: String(args['message']) } },
      stop: true,
    };
  },

  async no_reply(_d, _tx, args) {
    return {
      status: 'done',
      content: { status: 'received' },
      effect: { end: { kind: 'no_reply', reason: String(args['reason']) } },
      stop: true,
    };
  },
};
