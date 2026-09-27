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
  answerProblem,
  findQuestion,
  formResponseSave,
  formResponseStart,
  formResponseSubmit,
  AI_TEAMMATE_SOURCE,
  appointmentAddForCustomer,
  chatCheckCodeForCustomer,
  chatSendCodeForCustomer,
  leadCreate,
  leadMoveStage,
  leadRecordAnswers,
  leadUpdate,
  nextQuestion,
  parseStoredForm,
  responseProblems,
  loadTerritories,
  localDateOf,
  money,
  personUpdate,
  quoteData,
  startOfLocalDay,
  taskCreate,
  toolInputSchema,
  type AiEmployeeActor,
  type AnswerSheet,
  type CatalogueLine,
  type AnswerValue,
  type FormDefinition,
  type Question,
  type ConversationHandoffReason,
  type DraftAction,
  type HandOffReason,
  attendeeConfirmByCall,
  personSetCallConsent,
  type RequestMeta,
  type TeammateTool,
  type TeammateToolName,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { toolErrorContent, type ToolLoopAnswer } from '../ai/tool-loop';
import { atLabel, isoWithOffset } from '../assistant/calendar-format';
import { anyOfWords, findKnowledge } from '../knowledge/find';
import { systemActor, type TenantScope } from '../services';
import { HELD_MAX, MONEY_LIST_MAX, SEARCH_MATCHES, TIMES_MAX_DAYS, TIMES_SHOWN } from './constants';
import { estimateUrlFor, invoiceUrlFor, type MoneyLinks } from '../money/links';
import type { Geocoder } from '../geo/geocoder';
import { ADDRESS_NOT_FOUND, serviceAreaAnswer, whereabouts } from './areas';
import type { ChatCodeSender } from './chat-code';
import {
  jobsOf,
  jobStatusContent,
  pastAppointments,
  upcomingAppointments,
  type RunContext,
} from './context';
import { emergencyIn, handOffInConversation } from './handoff';
import { rememberLanguage } from './translations';

// ---- What a run has done so far ----

/** A time find_times offered in this run: only these can be booked. */
export interface OfferedTime {
  readonly calendarId: string;
  /** UTC ISO. */
  readonly startsAt: string;
  readonly sessionId: string | null;
  readonly serviceId: string | null;
  readonly durationMinutes: number | null;
  /** The ZIP it was found for, on a calendar that goes by ZIP. */
  readonly postalCode: string | null;
  /** M18: where their address is, on a calendar whose areas go by distance or a drawn shape. */
  readonly point: { readonly lat: number; readonly lng: number } | null;
  readonly label: string;
  /** Read when a phone call was picked up (its context lists them), not offered by find_times. */
  readonly preloaded?: boolean;
}

export interface FoundItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export type RunEnd =
  | { readonly kind: 'reply'; readonly message: string }
  | { readonly kind: 'no_reply'; readonly reason: string }
  /** On a phone call: the last thing it says, then it hangs up (M18 step 5). */
  | { readonly kind: 'end_call'; readonly message: string }
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

/**
 * What the teammate asks an owner or admin for, with money in it (M18): the message the customer would get and
 * the change it makes. One per reply, in its own approval draft, in every mode.
 */
export interface MoneyAsk {
  readonly actions: readonly DraftAction[];
  readonly message: string;
  /** What the card and Activity say it's for. */
  readonly summary: string;
}

export interface RunState {
  readonly offered: Map<string, OfferedTime>;
  readonly held: DraftAction[];
  readonly found: Map<string, FoundItem>;
  /** A knowledge search ran (whether or not it found anything). */
  searched: boolean;
  discount: Discount | null;
  moneyAsk: MoneyAsk | null;
  /** A lead open_deal opened in this run (the context loaded before it had one). */
  openedLeadId: string | null;
  /** The chat visitor typed back the right code in this run (M18): the run starts over as theirs. */
  verified: boolean;
  /** How many of the customer's photos it looked at in this run (M18). */
  photos: number;
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
    moneyAsk: null,
    openedLeadId: null,
    verified: false,
    photos: 0,
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
  readonly moneyAsk?: MoneyAsk;
  readonly openedLeadId?: string;
  readonly verified?: boolean;
  readonly end?: RunEnd;
  readonly abort?: RunAbort;
}

export const timeKey = (calendarId: string, startsAt: string): string =>
  `${calendarId}|${new Date(startsAt).toISOString()}`;

const END_RANK: Readonly<Record<RunEnd['kind'], number>> = {
  no_reply: 0,
  reply: 1,
  end_call: 1,
  hand_off: 2,
};

function applyEffect(state: RunState, effect: Effect | undefined): void {
  if (!effect) return;
  for (const o of effect.offered ?? []) state.offered.set(timeKey(o.calendarId, o.startsAt), o);
  for (const f of effect.found ?? []) state.found.set(f.id, f);
  if (effect.searched) state.searched = true;
  if (effect.held) state.held.push(effect.held);
  if (effect.discount) state.discount = effect.discount;
  if (effect.moneyAsk) state.moneyAsk = effect.moneyAsk;
  if (effect.openedLeadId) state.openedLeadId = effect.openedLeadId;
  if (effect.verified) state.verified = true;
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
  /** Signs the pay and quote links a money ask carries (M18). */
  readonly moneyLinks: MoneyLinks;
  /** Finds where a customer's address is, for distance and drawn service areas (M18). */
  readonly geocoder: Geocoder;
  /** Delivers a website chat visitor's code (M18). */
  readonly chatCodes: ChatCodeSender;
  /** Keeps a run's second pass (after a chat code) from meeting its first pass's calls under the same ids. */
  readonly callPrefix?: string;
  /**
   * A live phone call (M18 step 5): a hand-off is the call's to carry out (it rings the team on the same call),
   * so the tool only says so.
   */
  readonly phone?: boolean;
  /** A call the teammate placed itself (AI outbound calls): why, and what it's about. */
  readonly outboundCall?: {
    readonly aiCallId: string;
    readonly personId: string;
    readonly attendeeId: string | null;
  } | null;
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
    const callId = `${d.callPrefix ?? ''}${call.id || 'call'}`.slice(0, 200);
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

/** Thrown at the end of a try so its savepoint rolls back. */
class RolledBack extends Error {}

/** Runs `fn` in a savepoint that always rolls back: would it work, and what would it give? Nothing is kept. */
async function rolledBack<T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<T> {
  const held: { done: boolean; value?: T } = { done: false };
  try {
    await tx.transaction(async (sp) => {
      held.value = await fn(sp as Tx);
      held.done = true;
      throw new RolledBack();
    });
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  if (!held.done) throw new Error('The try did not finish.');
  return held.value as T;
}

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

/**
 * A calendar that asks for money holds the time only while the customer pays for it, on their own page, where
 * their card is held rather than charged. So the teammate books nothing here: it says what the visit takes and
 * sends them the page. The words are the model's to repeat, so they are the customer's words.
 */
const depositInstead = (cal: {
  name: string;
  deposit: { amountCents: number; mode: 'deposit' | 'full' } | null;
  bookingPath: string | null;
}): string =>
  `Don’t book ${cal.name} yourself. It takes ${money(cal.deposit?.amountCents ?? 0)}${
    cal.deposit?.mode === 'deposit' ? ' as a deposit' : ''
  } before a time is held, and that is paid on the booking page. Tell the customer what it takes and${
    cal.bookingPath ? ` send them ${cal.bookingPath} to book and pay on.` : ' ask them to call us.'
  }`;
const NO_CUSTOMER =
  'There’s no customer on file for this conversation yet, so there’s nowhere to put that.';
const NO_CALLS = 'That isn’t a call in this conversation. Use a callId the history gave you.';
const NO_LEAD = 'This customer has no open lead to put that on. Add a note instead.';

// ---- The forms the teammate may ask ----

interface TeammateForm {
  readonly formId: string;
  readonly definition: FormDefinition;
}

/** A form of this business that is live and that the business let the teammate ask (M15's in_chat). */
async function formForTeammate(
  d: ExecutorDeps,
  tx: Tx,
  formId: string,
): Promise<TeammateForm | { error: string }> {
  if (!d.rc.customer || d.rc.unverifiedChat) return { error: NO_CUSTOMER };
  const [row] = await rows<{ id: string; definition: unknown; in_chat: boolean; status: string }>(
    tx,
    sql`select f.id, v.definition, f.in_chat, f.status::text as status
        from app.forms f join app.form_versions v on v.id = f.active_version_id
        where f.id = ${formId} and f.workspace_id = ${d.scope.workspaceId}`,
  );
  if (!row || row.status !== 'live') return { error: 'That form isn’t taking answers.' };
  if (!row.in_chat) return { error: 'That form isn’t one you may ask in a conversation.' };
  return { formId: row.id, definition: parseStoredForm(row.definition) };
}

interface Sheet {
  readonly responseId: string;
  readonly answers: AnswerSheet;
}

/** This customer's unfinished sheet for that form, or a new one. */
async function openSheet(d: ExecutorDeps, tx: Tx, form: TeammateForm): Promise<Sheet> {
  const personId = d.rc.customer!.id;
  const [open] = await rows<{ id: string; answers: Record<string, unknown> }>(
    tx,
    sql`select id, answers from app.form_responses
        where form_id = ${form.formId} and person_id = ${personId} and status = 'in_progress'
        order by started_at desc limit 1`,
  );
  // An unfinished sheet for this customer is theirs to carry on with. The teammate carries no key: it is
  // inside the business already, and the commands only ask a signed-out page for one.
  if (open) return { responseId: open.id, answers: (open.answers ?? {}) as AnswerSheet };
  const started = await executeCommandIn(
    tx,
    formResponseStart,
    { workspaceId: d.scope.workspaceId, formId: form.formId, source: 'chat', visitorHash: null },
    d.ai,
    d.meta,
  );
  // The sheet belongs to the customer this conversation is with.
  await tx.execute(
    sql`update app.form_responses set person_id = ${personId}
        where id = ${started.output.responseId}`,
  );
  return { responseId: started.output.responseId, answers: {} };
}

/** What the model needs to know to ask one question well. */
function questionShape(question: Question): Record<string, unknown> {
  const config = question.config as { choices?: { id: string; label: string }[] };
  return {
    kind: question.type,
    ...(question.help ? { help: quoteData(question.help) } : {}),
    ...(config.choices
      ? { choices: config.choices.map((c) => ({ id: c.id, label: quoteData(c.label) })) }
      : {}),
    ...(question.required ? { required: true } : {}),
  };
}

/**
 * What the customer said, as the answer that question takes: a choice matched by its wording, yes or no,
 * a number read out of the sentence, otherwise their words as they said them.
 */
function answerFromWords(question: Question, said: string): AnswerValue {
  const text = said.trim();
  const config = question.config as { choices?: { id: string; label: string }[] };
  if (config.choices) {
    const lower = text.toLowerCase();
    const exact = config.choices.find((c) => c.id === text);
    if (exact) return question.type === 'checkboxes' ? [exact.id] : exact.id;
    const named = config.choices.find((c) => lower.includes(c.label.toLowerCase()));
    if (named) return question.type === 'checkboxes' ? [named.id] : named.id;
    return question.type === 'checkboxes' ? [] : text;
  }
  if (question.type === 'yes_no') return /\b(no|nope|nah)\b/i.test(text) ? 'no' : 'yes';
  if (
    question.type === 'number' ||
    question.type === 'money' ||
    question.type === 'rating' ||
    question.type === 'scale'
  ) {
    const n = Number(text.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

/** "a month", "every 3 months", "a year". */
export function planEvery(p: { interval: string; intervalCount: number }): string {
  const unit = p.interval === 'quarter' ? 'quarter' : p.interval === 'year' ? 'year' : 'month';
  return p.intervalCount === 1 ? `a ${unit}` : `every ${p.intervalCount} ${unit}s`;
}

async function theirQuote(d: ExecutorDeps, tx: Tx, estimateId: string) {
  const [q] = await rows<{ number: string | null; status: string; total_cents: string }>(
    tx,
    sql`select number, status::text as status, total_cents::text as total_cents from app.estimates
        where id = ${estimateId} and workspace_id = ${d.scope.workspaceId}
          and person_id = ${d.rc.customer!.id}`,
  );
  return q ?? null;
}

/** A bill's or a quote's lines from the price list in the context, and what they come to before tax. */
function fromCatalogue(
  d: ExecutorDeps,
  args: Record<string, unknown>,
): { lines: CatalogueLine[]; totalCents: number; words: string } | { error: string } {
  if (!d.rc.customer || d.rc.unverifiedChat) return { error: NO_CUSTOMER };
  if (d.state.moneyAsk) return { error: 'One request for money per reply.' };
  const items = (Array.isArray(args['items']) ? args['items'] : []) as {
    productId: string;
    quantity: number;
  }[];
  const lines: CatalogueLine[] = [];
  const names: string[] = [];
  let totalCents = 0;
  for (const i of items) {
    const p = d.rc.catalogue.find((x) => x.id === i.productId);
    if (!p) return { error: 'Use only product ids from the price list in your context.' };
    lines.push({ productId: p.id, quantity: i.quantity });
    names.push(i.quantity === 1 ? p.name : `${i.quantity} × ${p.name}`);
    totalCents += Math.round(p.priceCents * i.quantity);
  }
  return { lines, totalCents, words: names.join(', ') };
}

function askForMoney(d: ExecutorDeps, ask: MoneyAsk): Outcome {
  // A first message has no conversation yet for the approved message to go out in.
  if (!d.rc.conversation.id)
    return refused({ error: 'Wait until they write back before asking the team about money.' });
  return {
    status: 'held',
    content: {
      status: 'waiting_for_approval',
      note: 'An owner or admin decides before the customer gets anything. In your reply, say only that you’ve asked the team and they’ll send it; never say it’s been sent.',
    },
    effect: { moneyAsk: ask },
  };
}

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

  /**
   * What was said on one call of this conversation. Scoped to the run's own conversation in the `where`, not
   * in the id: the model is handed call ids by the history, and a made-up one must find nothing rather than
   * somebody else's call.
   */
  async read_call_transcript(d, tx, args) {
    const callId = String(args['callId']);
    if (!d.rc.conversation.id) return refused({ error: NO_CALLS });
    const [call] = await rows<{
      transcript: string | null;
      is_voicemail: boolean;
      transcript_status: string | null;
      recorded: boolean;
    }>(
      tx,
      sql`select k.transcript, k.is_voicemail, k.transcript_status,
            k.recording_object_path is not null as recorded
          from app.calls k
          where k.id = ${callId} and k.workspace_id = ${d.scope.workspaceId}
            and k.conversation_id = ${d.rc.conversation.id}`,
    );
    if (!call) return refused({ error: NO_CALLS });
    const said = (call.transcript ?? '').trim();
    if (said)
      return {
        status: 'done',
        content: { words: quoteData(said), voicemail: call.is_voicemail },
      };
    return {
      status: 'done',
      content: {
        words: null,
        note:
          !call.recorded || call.transcript_status === 'failed'
            ? 'Nothing was written out from that call, so you don’t know what was said on it. Don’t guess at it.'
            : 'That call hasn’t been written out yet, so you don’t know what was said on it. Don’t guess at it.',
      },
    };
  },

  async find_times(d, tx, args) {
    const calendarId = String(args['calendarId']);
    const cal = d.rc.calendars.find((c) => c.id === calendarId);
    if (!cal)
      return refused({
        error: 'That isn’t one of your calendars. Use a calendar id from the context.',
      });
    const address = str(args['address']);
    if (cal.byAddress && !address && d.geocoder.name !== 'off')
      return refused({
        error: `${cal.name} offers times by where the customer is. Ask for their street address and city, then look again with it.`,
      });
    const where = await whereabouts(tx, d.geocoder, {
      postalCode: str(args['postalCode']),
      address,
    });
    if (where.notFound) return refused({ error: ADDRESS_NOT_FOUND });
    const postalCode = where.zip;
    if (cal.byZip && !postalCode && !where.point)
      return refused({
        error: `${cal.name} offers times by ZIP code. Ask for their ZIP code, then look again with it.`,
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
        ...(postalCode ? { postalCode } : {}),
        ...(where.point ? { point: where.point } : {}),
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
        postalCode: cal.byZip ? postalCode : null,
        point: cal.byZip ? where.point : null,
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
        ...(shown.length
          ? {}
          : {
              note: cal.waitlist
                ? 'No open times then. Try another day, or offer to put them on the waitlist.'
                : 'No open times then. Try another day.',
            }),
      },
      effect: { offered },
    };
  },

  async my_appointments(d, tx, args) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    if (args['when'] === 'past') {
      const past = await pastAppointments(
        tx,
        d.scope.workspaceId,
        d.rc.customer.id,
        d.rc.workspace.timeZone,
      );
      return {
        status: 'done',
        content: {
          visits: past.map((a) => ({
            what: quoteData(a.title),
            when: atLabel(a.startsAt, a.timeZone),
            calendar: quoteData(a.calendarName),
            ...(a.outcome === 'no_show' ? { note: 'they didn’t make it' } : {}),
          })),
          ...(past.length ? {} : { note: 'No visits yet.' }),
        },
      };
    }
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

  /** M18: where their jobs stand. */
  async job_status(d, tx) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    const list = await jobsOf(tx, d.scope.workspaceId, d.rc.customer.id);
    return { status: 'done', content: jobStatusContent(list, d.rc.workspace.timeZone) };
  },

  async book(d, _tx, args) {
    const calendarId = String(args['calendarId']);
    const cal = d.rc.calendars.find((c) => c.id === calendarId);
    if (!cal) return refused({ error: 'That isn’t one of your calendars.' });
    if (cal.deposit) return refused({ error: depositInstead(cal) });
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
      postalCode: slot.postalCode,
      point: slot.point,
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
    const onPaying = d.rc.calendars.find((c) => c.id === appt.calendarId);
    if (onPaying?.deposit) return refused({ error: depositInstead(onPaying) });
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

  /**
   * M18: more on one of their visits. Held like a reschedule, but tried first in a savepoint that always rolls
   * back, so the model hears now whether the extra time fits (and the visit's new end) rather than after it
   * told the customer.
   */
  async add_to_appointment(d, tx, args) {
    const appt = await customersAppointment(d, tx, String(args['appointmentId']));
    if (!appt) return refused({ error: NOT_THEIRS });
    if (d.state.held.length >= HELD_MAX)
      return refused({ error: 'That’s as many changes as one reply can make.' });
    const serviceId = str(args['serviceId']);
    const guests = typeof args['guests'] === 'number' ? args['guests'] : null;
    const note = str(args['note']);
    const tried = await rolledBack(tx, (sp) =>
      executeCommandIn(
        sp,
        appointmentAddForCustomer,
        { workspaceId: d.scope.workspaceId, appointmentId: appt.id, serviceId, guests, note },
        d.ai,
        d.meta,
      ),
    );
    const added = serviceId ? tried.output.services.at(-1) : undefined;
    const what = [
      added ? added.name : null,
      guests ? `${guests} more ${guests === 1 ? 'person' : 'people'}` : null,
      note ? 'a note' : null,
    ].filter(Boolean);
    const held: DraftAction = {
      kind: 'add_to_visit',
      appointmentId: appt.id,
      serviceId,
      guests,
      note,
      summary:
        `Add ${what.join(', ')} to ${appt.title} on ${atLabel(appt.startsAt, appt.timeZone)}`.slice(
          0,
          300,
        ),
    };
    const prices = d.rc.grounding.profile.allowPrices;
    return {
      status: 'held',
      content: {
        status: 'ready',
        ...(added
          ? {
              added: {
                service: quoteData(added.name),
                minutes: added.durationMinutes,
                ...(prices && added.priceCents !== null ? { price: money(added.priceCents) } : {}),
              },
              endsAt: atLabel(Date.parse(tried.output.endsAt), appt.timeZone),
            }
          : {}),
        ...(guests ? { peopleComing: tried.output.seats } : {}),
        note: heldNote(d),
      },
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

  /**
   * M18: whether the business serves a ZIP code, from the ZIP codes of its service areas (territories), and
   * which of the teammate's calendars do. With no areas listed, the business profile's words are all there is.
   */
  async check_service_area(d, tx, args) {
    const where = await whereabouts(tx, d.geocoder, {
      postalCode: str(args['postalCode']),
      address: str(args['address']),
    });
    if (!where.zip && !where.point && !where.notFound)
      return refused({
        error: 'That isn’t a ZIP code. Ask them for their 5-digit ZIP or address.',
      });
    const areas = await loadTerritories(tx, d.scope.workspaceId);
    return {
      status: 'done',
      content: serviceAreaAnswer(areas, d.rc.calendars, where, d.geocoder.name !== 'off'),
    };
  },

  async book_repeating(d, tx, args) {
    if (!d.rc.customer) return refused({ error: NO_CUSTOMER });
    const calendarId = String(args['calendarId']);
    const cal = d.rc.calendars.find((c) => c.id === calendarId);
    if (!cal) return refused({ error: 'That isn’t one of your calendars.' });
    if (cal.deposit) return refused({ error: depositInstead(cal) });
    if (cal.maxRepeats === null)
      return refused({
        error: `${cal.name} doesn’t take repeat visits. Book one visit, and leave the team a task if they want regular ones.`,
      });
    const slot = d.state.offered.get(timeKey(calendarId, String(args['startsAt'])));
    if (!slot)
      return refused({
        error:
          'Start the repeats at one of the times find_times gave you in this conversation. Call find_times first.',
      });
    if (d.state.held.length >= HELD_MAX)
      return refused({ error: 'That’s as many changes as one reply can make.' });
    const every = args['every'] === 'month' ? 'month' : 'week';
    const interval = typeof args['interval'] === 'number' ? args['interval'] : 1;
    const times = Math.min(Number(args['times']), cal.maxRepeats);
    const how =
      every === 'week'
        ? interval === 1
          ? 'weekly'
          : `every ${interval} weeks`
        : interval === 1
          ? 'monthly'
          : `every ${interval} months`;
    const held: DraftAction = {
      kind: 'book_series',
      calendarId,
      startsAt: slot.startsAt,
      serviceId: str(args['serviceId']) ?? slot.serviceId,
      durationMinutes: slot.durationMinutes,
      every,
      interval,
      times,
      notes: str(args['notes']),
      postalCode: slot.postalCode,
      point: slot.point,
      summary: `Book ${times} ${how} visits from ${slot.label} on ${cal.name}`.slice(0, 300),
    };
    return {
      status: 'held',
      content: {
        status: 'ready',
        visits: times,
        first: slot.label,
        note: `${heldNote(d)} If a later date doesn’t fit, it’s skipped and the team sees which, so don’t promise every date.`,
      },
      effect: { held },
    };
  },

  async join_waitlist(d, _tx, args) {
    if (!d.rc.customer) return refused({ error: NO_CUSTOMER });
    const calendarId = String(args['calendarId']);
    const cal = d.rc.calendars.find((c) => c.id === calendarId);
    if (!cal) return refused({ error: 'That isn’t one of your calendars.' });
    if (cal.deposit) return refused({ error: depositInstead(cal) });
    if (!cal.waitlist) return refused({ error: `${cal.name} doesn’t keep a waitlist.` });
    if (d.state.held.length >= HELD_MAX)
      return refused({ error: 'That’s as many changes as one reply can make.' });
    const tz = cal.timeZone;
    const appointmentId = str(args['appointmentId']);
    let wantedFrom: string | null = null;
    let wantedTo: string | null = null;
    let when = '';
    if (!appointmentId) {
      const from = String(args['from']);
      const to = str(args['to']);
      const fromMs = isLocalDate(from) ? startOfLocalDay(from, tz) : Date.parse(from);
      const toMs = to
        ? isLocalDate(to)
          ? startOfLocalDay(addDays(to, 1), tz)
          : Date.parse(to)
        : startOfLocalDay(addDays(localDateOf(fromMs, tz), 1), tz);
      if (!(toMs > Math.max(fromMs, Date.now())))
        return refused({ error: 'Those times are past. Ask what later times suit them.' });
      wantedFrom = new Date(Math.max(fromMs, Date.now())).toISOString();
      wantedTo = new Date(toMs).toISOString();
      when = ` for ${atLabel(Date.parse(wantedFrom), tz)} to ${atLabel(toMs, tz)}`;
    }
    const held: DraftAction = {
      kind: 'waitlist',
      calendarId,
      appointmentId,
      wantedFrom,
      wantedTo,
      summary: `Add them to the ${cal.name} waitlist${when}`.slice(0, 300),
    };
    return {
      status: 'held',
      content: {
        status: 'ready',
        note: `${heldNote(d).replace('it’s done', 'they’re on the waitlist')} They hear from us when a spot opens; never promise one.`,
      },
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

  /**
   * The teammate asking one of the business's forms in the conversation instead of sending a link. It holds
   * no state of its own: the answer sheet is the same row the public page writes, found by this customer and
   * this form, so a conversation that stops halfway can be picked up by the link and finished there.
   */
  async ask_form(d, tx, args) {
    const found = await formForTeammate(d, tx, String(args['formId']));
    if ('error' in found) return refused(found);
    const { definition } = found;
    const sheet = await openSheet(d, tx, found);
    const next = nextQuestion(definition, sheet.answers);
    return {
      status: 'done',
      command: 'form_response.start',
      content: next
        ? {
            form: quoteData(definition.title),
            ask: { questionId: next.id, question: quoteData(next.title), ...questionShape(next) },
            note: 'Ask it in your own words, one at a time, and save each answer with answer_form.',
          }
        : {
            form: quoteData(definition.title),
            done: 'Nothing left to ask; send it with answer_form.',
          },
    };
  },

  async answer_form(d, tx, args) {
    const found = await formForTeammate(d, tx, String(args['formId']));
    if ('error' in found) return refused(found);
    const { definition } = found;
    const sheet = await openSheet(d, tx, found);
    const questionId = String(args['questionId']);
    const question = findQuestion(definition, questionId)?.question;
    if (!question) return refused({ error: 'That question isn’t on this form.' });
    const value = answerFromWords(question, String(args['answer']));
    const answers: AnswerSheet = { ...sheet.answers, [questionId]: value };
    const problem = answerProblem(question, value);
    if (problem)
      return {
        status: 'done',
        content: { saved: false, problem, note: 'Ask them again for that one.' },
      };
    await executeCommandIn(
      tx,
      formResponseSave,
      {
        workspaceId: d.scope.workspaceId,
        responseId: sheet.responseId,
        answers: { [questionId]: value },
      },
      d.ai,
      d.meta,
    );
    const next = nextQuestion(definition, answers);
    if (next)
      return {
        status: 'done',
        command: 'form_response.save',
        content: {
          saved: true,
          ask: { questionId: next.id, question: quoteData(next.title), ...questionShape(next) },
        },
      };
    // Nothing left: sending is what makes it real — the customer's details, the lead, the follow-ups.
    const left = responseProblems(definition, answers);
    if (left.length)
      return {
        status: 'done',
        content: {
          saved: true,
          stillNeeded: left.map((p) => ({
            questionId: p.questionId,
            question: quoteData(findQuestion(definition, p.questionId)?.question.title ?? ''),
            problem: p.message,
          })),
        },
      };
    const sent = await executeCommandIn(
      tx,
      formResponseSubmit,
      {
        workspaceId: d.scope.workspaceId,
        responseId: sheet.responseId,
        answers,
        smsConsent: false,
      },
      d.ai,
      d.meta,
    );
    const landed = definition.results.find((r) => r.id === sent.output.resultId);
    return {
      status: 'done',
      command: 'form_response.submit',
      content: {
        sent: true,
        say: quoteData(landed?.headline ?? 'Thank you.'),
        ...(sent.output.dueCents > 0
          ? { owing: money(sent.output.dueCents), note: 'Tell them the invoice is on its way.' }
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

  async open_deal(d, tx, args) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    if (d.rc.lead || d.state.openedLeadId)
      return refused({ error: 'They already have an open lead. Use that one.' });
    const r = await executeCommandIn(
      tx,
      leadCreate,
      {
        workspaceId: d.scope.workspaceId,
        title: String(args['title']),
        personId: d.rc.customer.id,
        source: AI_TEAMMATE_SOURCE,
      },
      d.ai,
      d.meta,
    );
    return {
      status: 'done',
      command: 'lead.create',
      content: { opened: true },
      effect: { openedLeadId: r.output.leadId },
    };
  },

  async set_deal_value(d, tx, args) {
    const leadId = d.rc.lead?.id ?? d.state.openedLeadId;
    if (!leadId) return refused({ error: NO_LEAD });
    const valueCents = Math.round(Number(args['dollars']) * 100);
    await executeCommandIn(
      tx,
      leadUpdate,
      { workspaceId: d.scope.workspaceId, leadId, valueCents },
      d.ai,
      d.meta,
    );
    return {
      status: 'done',
      command: 'lead.update',
      content: { value: money(valueCents) },
    };
  },

  /** Won or lost goes to the pipeline's first stage of that kind, as a person marking it would. */
  async close_deal(d, tx, args) {
    const leadId = d.rc.lead?.id ?? d.state.openedLeadId;
    if (!leadId) return refused({ error: NO_LEAD });
    const outcome = args['outcome'] === 'lost' ? 'lost' : 'won';
    const reason = str(args['reason']);
    if (outcome === 'lost' && !reason)
      return refused({ error: 'Say why it was lost, in their words.' });
    const [stage] = await rows<{ id: string; name: string }>(
      tx,
      sql`select s.id, s.name from app.pipeline_stages s join app.leads l on l.pipeline_id = s.pipeline_id
          where l.id = ${leadId} and s.kind = ${outcome} order by s.position limit 1`,
    );
    if (!stage) return refused({ error: `Its pipeline has no ${outcome} stage.` });
    await executeCommandIn(
      tx,
      leadMoveStage,
      {
        workspaceId: d.scope.workspaceId,
        leadId,
        stageId: stage.id,
        ...(reason ? { lostReason: reason } : {}),
      },
      d.ai,
      d.meta,
    );
    return {
      status: 'done',
      command: 'lead.move_stage',
      content: { status: outcome, stage: quoteData(stage.name) },
    };
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
    // A visitor who typed an existing customer's number writes nothing onto that customer's record.
    if (d.rc.strangerInChat) return refused({ error: CHAT_REFUSAL });
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

  /** M18: what the customer's photos show, as a note on the customer and their lead. */
  async note_photos(d, tx, args) {
    if (!d.state.photos)
      return refused({ error: 'There are no photos in this reply to note. Use add_note instead.' });
    if (!d.rc.customer && !d.rc.lead) return refused({ error: NO_CUSTOMER });
    if (d.rc.strangerInChat) return refused({ error: CHAT_REFUSAL });
    const fit = {
      yes: 'Looks like work we do',
      no: 'Doesn’t look like work we do',
      unsure: 'Not sure it’s work we do',
    }[String(args['fit']) as 'yes' | 'no' | 'unsure'];
    const asked = str(args['askedFor']);
    await executeCommandIn(
      tx,
      activityLog,
      {
        workspaceId: d.scope.workspaceId,
        kind: 'note',
        body: [
          `What their ${d.state.photos === 1 ? 'photo shows' : `${d.state.photos} photos show`}: ${String(args['shows'])}`,
          `${fit}.`,
          ...(asked ? [`Asked them for: ${asked}`] : []),
        ].join('\n'),
        personId: d.rc.customer?.id ?? null,
        leadId: d.rc.lead?.id ?? d.state.openedLeadId ?? null,
      },
      d.ai,
      d.meta,
    );
    return { status: 'done', command: 'activity.log', content: { added: true } };
  },

  async create_task(d, tx, args) {
    if (!d.rc.customer) return refused({ error: NO_CUSTOMER });
    if (d.rc.strangerInChat) return refused({ error: CHAT_REFUSAL });
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

  // ---- A website chat visitor proving who they are (M18) ----

  async send_verification_code(d, tx) {
    if (!d.rc.unverifiedChat || !d.rc.customer)
      return refused({ error: 'There’s nobody on file for this chat to send a code to.' });
    const canText = await d.chatCodes.canText(tx, d.scope.workspaceId);
    const r = await executeCommandIn(
      tx,
      chatSendCodeForCustomer,
      { workspaceId: d.scope.workspaceId, canText },
      d.ai,
      d.meta,
    );
    const { channel, to, code, sentTo } = r.output;
    await d.chatCodes.send(tx, d.scope.workspaceId, {
      channel,
      to,
      code,
      business: d.rc.workspace.name,
    });
    // Never the code itself: it goes to the customer's phone or email, not into the conversation.
    return {
      status: 'done',
      command: 'chat.send_code_for_customer',
      content: {
        sent: true,
        by: channel === 'sms' ? 'text' : 'email',
        to: sentTo,
        note: 'Ask them to type the six-digit code here. It lasts 10 minutes.',
      },
    };
  },

  async check_verification_code(d, tx, args) {
    if (!d.rc.unverifiedChat || !d.rc.customer)
      return refused({ error: 'There’s nobody on file for this chat to check a code for.' });
    const r = await executeCommandIn(
      tx,
      chatCheckCodeForCustomer,
      { workspaceId: d.scope.workspaceId, code: String(args['code']) },
      d.ai,
      d.meta,
    );
    if (!r.output.verified)
      return refused({
        error:
          r.output.triesLeft > 0
            ? `That isn’t the code. ${r.output.triesLeft} tries left: ask them to check it.`
            : 'That isn’t the code, and it’s used up. Send a new one if they want.',
      });
    // Stops the loop: the run starts over with their bookings, bills and quotes open to you.
    return {
      status: 'done',
      command: 'chat.check_code_for_customer',
      content: { verified: true },
      effect: { verified: true },
      stop: true,
    };
  },

  // ---- Money (M18): the look-ups run at once; anything asking for money becomes an owner's approval draft ----

  async my_bills(d, tx) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    const list = await rows<{
      id: string;
      number: string | null;
      title: string | null;
      status: string;
      total_cents: string;
      balance_cents: string;
      due_on: string | null;
      paying: string | null;
    }>(
      tx,
      sql`select i.id, i.number, i.title, i.status::text as status, i.total_cents::text as total_cents,
            i.balance_cents::text as balance_cents, i.due_on::text as due_on,
            (select p.status::text from app.payments p where p.invoice_id = i.id
              order by p.created_at desc limit 1) as paying
          from app.invoices i
          where i.workspace_id = ${d.scope.workspaceId} and i.person_id = ${d.rc.customer.id}
            and i.status not in ('draft', 'void')
          order by i.created_at desc limit ${MONEY_LIST_MAX}`,
    );
    return {
      status: 'done',
      content: {
        bills: list.map((b) => ({
          invoiceId: b.id,
          what: quoteData(b.title ?? b.number ?? 'Bill'),
          number: b.number,
          total: money(Number(b.total_cents)),
          owed: money(Number(b.balance_cents)),
          status: b.paying === 'processing' ? 'payment on its way' : b.status.replace('_', ' '),
          ...(b.due_on ? { due: b.due_on } : {}),
          ...(b.paying === 'failed' ? { lastPayment: 'didn’t go through' } : {}),
        })),
        ...(list.length ? {} : { note: 'No bills on file for them.' }),
      },
    };
  },

  async send_payment_link(d, tx, args) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    if (d.state.moneyAsk) return refused({ error: 'One request for money per reply.' });
    const [bill] = await rows<{ number: string | null; status: string; balance_cents: string }>(
      tx,
      sql`select number, status::text as status, balance_cents::text as balance_cents from app.invoices
          where id = ${String(args['invoiceId'])} and workspace_id = ${d.scope.workspaceId}
            and person_id = ${d.rc.customer.id}`,
    );
    if (!bill)
      return refused({ error: 'That isn’t one of their bills. Use an invoiceId from my_bills.' });
    if (
      !['sent', 'partly_paid', 'overdue'].includes(bill.status) ||
      Number(bill.balance_cents) <= 0
    )
      return refused({ error: 'Nothing is owed on that bill.' });
    const url = await invoiceUrlFor(tx, d.moneyLinks, String(args['invoiceId']));
    if (!url) return refused({ error: 'That bill has no link to pay on.' });
    const what = `${bill.number ?? 'their bill'} (${money(Number(bill.balance_cents))} owed)`;
    const summary = `Send the link to pay ${what}`.slice(0, 300);
    return askForMoney(d, {
      actions: [
        { kind: 'share_link', document: 'invoice', documentId: String(args['invoiceId']), summary },
      ],
      message: `${String(args['message']).trim()} ${url}`,
      summary,
    });
  },

  async propose_bill(d, _tx, args) {
    const built = fromCatalogue(d, args);
    if ('error' in built) return refused(built);
    const title = str(args['title']);
    const summary = `Bill them ${money(built.totalCents)} for ${built.words}`.slice(0, 300);
    return askForMoney(d, {
      actions: [{ kind: 'create_invoice', title, lines: built.lines, summary }],
      message: String(args['message']).trim(),
      summary,
    });
  },

  async my_quotes(d, tx) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    const list = await rows<{
      id: string;
      number: string | null;
      title: string | null;
      status: string;
      total_cents: string;
      expires_on: string | null;
    }>(
      tx,
      sql`select id, number, title, status::text as status, total_cents::text as total_cents,
            expires_on::text as expires_on
          from app.estimates
          where workspace_id = ${d.scope.workspaceId} and person_id = ${d.rc.customer.id}
            and status not in ('draft', 'void')
          order by created_at desc limit ${MONEY_LIST_MAX}`,
    );
    return {
      status: 'done',
      content: {
        quotes: list.map((q) => ({
          estimateId: q.id,
          what: quoteData(q.title ?? q.number ?? 'Quote'),
          number: q.number,
          total: money(Number(q.total_cents)),
          status: q.status === 'sent' ? 'waiting on their answer' : q.status,
          ...(q.expires_on && q.status === 'sent' ? { goodUntil: q.expires_on } : {}),
        })),
        ...(list.length ? {} : { note: 'No quotes on file for them.' }),
      },
    };
  },

  async send_quote(d, tx, args) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    if (d.state.moneyAsk) return refused({ error: 'One request for money per reply.' });
    const estimateId = String(args['estimateId']);
    const quote = await theirQuote(d, tx, estimateId);
    if (!quote)
      return refused({
        error: 'That isn’t one of their quotes. Use an estimateId from my_quotes.',
      });
    if (quote.status !== 'sent')
      return refused({
        error: `That quote is ${quote.status}, so there’s nothing to answer on it.`,
      });
    const url = await estimateUrlFor(tx, d.moneyLinks, estimateId);
    if (!url) return refused({ error: 'That quote has no link.' });
    const summary =
      `Send the link to ${quote.number ?? 'their quote'} (${money(Number(quote.total_cents))})`.slice(
        0,
        300,
      );
    return askForMoney(d, {
      actions: [{ kind: 'share_link', document: 'estimate', documentId: estimateId, summary }],
      message: `${String(args['message']).trim()} ${url}`,
      summary,
    });
  },

  async propose_quote(d, _tx, args) {
    const built = fromCatalogue(d, args);
    if ('error' in built) return refused(built);
    const summary = `Quote them ${money(built.totalCents)} for ${built.words}`.slice(0, 300);
    return askForMoney(d, {
      actions: [
        { kind: 'create_estimate', title: str(args['title']), lines: built.lines, summary },
      ],
      message: String(args['message']).trim(),
      summary,
    });
  },

  async record_quote_answer(d, tx, args) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    if (d.state.moneyAsk) return refused({ error: 'One request for money per reply.' });
    const estimateId = String(args['estimateId']);
    const quote = await theirQuote(d, tx, estimateId);
    if (!quote)
      return refused({
        error: 'That isn’t one of their quotes. Use an estimateId from my_quotes.',
      });
    if (quote.status !== 'sent')
      return refused({ error: `That quote is already ${quote.status}.` });
    const accepted = args['accepted'] === true;
    const reason = str(args['reason']);
    const summary =
      `Record that they ${accepted ? 'said yes to' : 'turned down'} ${quote.number ?? 'their quote'} (${money(Number(quote.total_cents))})${!accepted && reason ? `: ${reason}` : ''}`.slice(
        0,
        300,
      );
    return askForMoney(d, {
      actions: [
        {
          kind: 'estimate_answer',
          estimateId,
          accepted,
          name: String(args['name']),
          reason,
          summary,
        },
      ],
      message: String(args['message']).trim(),
      summary,
    });
  },

  async offer_plan(d, _tx, args) {
    if (!d.rc.customer || d.rc.unverifiedChat) return refused({ error: NO_CUSTOMER });
    const plan = d.rc.plans.find((p) => p.id === String(args['planId']));
    if (!plan) return refused({ error: 'That isn’t one of the plans in your context.' });
    const summary =
      `Sign them up for ${plan.name} (${money(plan.priceCents)} ${planEvery(plan)})`.slice(0, 300);
    return askForMoney(d, {
      actions: [{ kind: 'start_plan', planId: plan.id, summary }],
      message: String(args['message']).trim(),
      summary,
    });
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
    await rememberLanguage(tx, d.scope, d.rc.conversation.id, str(args['language']));
    if (d.phone)
      return {
        status: 'done',
        content: { status: 'connecting' },
        effect: { end: { kind: 'hand_off', reason, note } },
        stop: true,
      };
    // The customer hears the hand-off line first (the safety text, for an emergency they described).
    const emergency = reason === 'emergency' ? emergencyIn(d.rc.batch.map((b) => b.text)) : null;
    await handOffInConversation(tx, d.ai, d.meta, reason, note, {
      line: emergency ? { emergency } : 'usual',
      translated: str(args['translatedLine']),
    });
    return {
      status: 'done',
      command: 'conversation.hand_off',
      content: { status: 'handed_off' },
      effect: { end: { kind: 'hand_off', reason, note } },
      stop: true,
    };
  },

  async reply(d, tx, args) {
    await rememberLanguage(tx, d.scope, d.rc.conversation.id, str(args['language']));
    return {
      status: 'done',
      content: { status: 'received' },
      effect: { end: { kind: 'reply', message: String(args['message']) } },
      stop: true,
    };
  },

  async end_call(d, tx, args) {
    await rememberLanguage(tx, d.scope, d.rc.conversation.id, str(args['language']));
    return {
      status: 'done',
      content: { status: 'received' },
      effect: { end: { kind: 'end_call', message: String(args['message']) } },
      stop: true,
    };
  },

  /** AI outbound calls: they said tomorrow's visit still works. */
  async confirm_visit(d, tx) {
    const attendeeId = d.outboundCall?.attendeeId;
    if (!attendeeId) return refused({ error: 'This call isn’t about confirming a visit.' });
    const { output } = await executeCommandIn(
      tx,
      attendeeConfirmByCall,
      { workspaceId: d.scope.workspaceId, attendeeId },
      systemActor(d.scope),
      d.meta,
    );
    return { status: 'done', content: { status: 'confirmed', already: !output.changed } };
  },

  /** AI outbound calls: they asked not to be called again. */
  async no_more_calls(d, tx) {
    const personId = d.outboundCall?.personId;
    if (!personId) return refused({ error: 'Only on a call you placed.' });
    await executeCommandIn(
      tx,
      personSetCallConsent,
      {
        workspaceId: d.scope.workspaceId,
        personId,
        consent: 'opted_out',
        source: 'Asked on a call',
      },
      systemActor(d.scope),
      d.meta,
    );
    return { status: 'done', content: { status: 'recorded' } };
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
