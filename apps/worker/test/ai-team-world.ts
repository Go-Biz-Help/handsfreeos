/**
 * A business with the AI teammate, for the runtime's tests (ai-team-*.test.ts), on the booking tests' world
 * (booking-world.ts): texting ready on the fake carrier, quiet hours off, the owner working every hour, and
 * "Ava" from a preset, in training or automatic. Its model is the scripted stand-in, with every request kept,
 * inside a daily limit. Customers text in through message.receive as the worker; a reply runs when a test says
 * (replyNow), not after its debounce.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest } from '@hfos/ai';
import {
  aiTeammateActivity,
  aiTeammateCreate,
  aiTeammateDecideDraft,
  aiTeammateGet,
  aiTeammateSaveConfig,
  aiTeammateSetStatus,
  applyTeammatePatch,
  calendarAvailability,
  chatReceive,
  chatVisitorStart,
  chatWidgetCreate,
  emailReceive,
  executeCommand,
  executeQuery,
  knowledgeItemCreate,
  knowledgeProfileUpdate,
  messageReceive,
  parseTeammateConfig,
  personCreate,
  type HumanActor,
  type TeammatePatch,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { testDbs } from '@hfos/db/testing';
import { scriptedAi } from '../src/ai/scripted';
import { replyJobKey } from '../src/ai-team/index';
import { TEAMMATE_SYSTEM } from '../src/ai-team/prompt';
import { processJobs, type JobStats } from '../src/jobs';
import { jobs } from '../src/scheduled';
import { systemActor } from '../src/services';
import type { TestServices } from './helpers';
import {
  admin,
  api,
  at,
  drain,
  iso,
  makeCalendar,
  makeWorld,
  nextPhone,
  readyTexting,
  run,
  type World,
} from './booking-world';

export * from './booking-world';

export interface TeammateWorld extends World {
  readonly teammateId: string;
  /** Every request the model was sent, in order. */
  readonly requests: AiRequest[];
  /** The calendar made before the teammate (an Appointment Coordinator books on it). */
  readonly calendar: { id: string; slug: string } | null;
}

export interface TeammateWorldOptions {
  readonly preset?: 'lead_responder' | 'lead_qualifier' | 'appointment_coordinator' | 'blank';
  readonly disclosure?: 'first_message' | 'when_asked';
  /** training by default. */
  readonly status?: 'training' | 'automatic';
  /** A calendar's name, made (public and active) before the teammate. */
  readonly calendar?: string;
  readonly dailyTokens?: number;
}

const ownerOf = (w: World): HumanActor => ({
  type: 'human',
  userId: w.owner.id,
  email: w.owner.email,
  claims: w.owner.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
export const scopeOf = (w: World) => ({
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
});

export async function teammateWorld(
  label: string,
  opts: TeammateWorldOptions = {},
): Promise<TeammateWorld> {
  const w = await makeWorld(label);
  await readyTexting(w);
  const calendar = opts.calendar ? await makeCalendar(w, opts.calendar) : null;
  const { teammateId } = await run(w, aiTeammateCreate, {
    workspaceId: w.workspaceId,
    preset: opts.preset ?? 'lead_responder',
    name: 'Ava',
    disclosure: opts.disclosure ?? 'first_message',
  });
  await run(w, aiTeammateSetStatus, { workspaceId: w.workspaceId, teammateId, status: 'training' });
  if (opts.status === 'automatic')
    await run(w, aiTeammateSetStatus, {
      workspaceId: w.workspaceId,
      teammateId,
      status: 'automatic',
    });
  const tw = Object.assign(w, { teammateId, requests: [] as AiRequest[], calendar });
  useModel(tw, scriptedAi(), opts.dailyTokens);
  return tw;
}

/** The world's model from now on (the scripted stand-in by default), with its requests kept. */
export function useModel(w: TeammateWorld, inner: AiProvider, dailyTokens = 5_000_000): void {
  const provider: AiProvider = {
    id: 'recording',
    model: inner.model,
    stream: (request, options) => {
      w.requests.push(request);
      return inner.stream(request, options);
    },
  };
  Object.assign(w, { s: { ...w.s, ai: { provider, dailyTokens } } as TestServices });
}

/** The teammate's requests (not the workflow AI's or the knowledge base's). */
export const teammateRequests = (w: TeammateWorld): AiRequest[] =>
  w.requests.filter((r) => r.system === TEAMMATE_SYSTEM);

/** The teammate's first request in the conversation where the customer wrote `words`. */
export const requestAbout = (w: TeammateWorld, words: string): AiRequest | undefined =>
  teammateRequests(w).find((r) => JSON.stringify(r.messages[0]).includes(words));

/** Saves a patch over the teammate's settings, as the owner. */
export async function saveTeammate(w: TeammateWorld, patch: TeammatePatch): Promise<void> {
  const got = await executeQuery(
    api(),
    aiTeammateGet,
    { workspaceId: w.workspaceId },
    ownerOf(w),
    meta(),
  );
  await run(w, aiTeammateSaveConfig, {
    workspaceId: w.workspaceId,
    teammateId: w.teammateId,
    baseRevision: got.teammate!.revision,
    config: applyTeammatePatch(parseTeammateConfig(got.teammate!.config), patch),
  });
}

export async function setStatus(
  w: TeammateWorld,
  status: 'off' | 'training' | 'automatic',
): Promise<void> {
  await run(w, aiTeammateSetStatus, {
    workspaceId: w.workspaceId,
    teammateId: w.teammateId,
    status,
  });
}

export function decide(w: TeammateWorld, draftId: string, decision: 'approve' | 'reject') {
  return executeCommand(
    api(),
    aiTeammateDecideDraft,
    { workspaceId: w.workspaceId, draftId, decision },
    ownerOf(w),
    meta(),
  ).then((r) => r.output);
}

/** The teammate's Activity (today's counters and its runs), as the owner sees it. */
export function activityOf(w: TeammateWorld) {
  return executeQuery(
    api(),
    aiTeammateActivity,
    { workspaceId: w.workspaceId },
    ownerOf(w),
    meta(),
  );
}

/** A customer on file, with a mobile number (and an email unless told otherwise). */
export async function newCustomer(
  w: World,
  first: string,
  opts: { readonly email?: string | null } = {},
): Promise<{ id: string; phone: string; email: string | null }> {
  const phone = nextPhone();
  const email =
    opts.email === undefined
      ? `${first.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`
      : opts.email;
  const { personId } = await run(w, personCreate, {
    workspaceId: w.workspaceId,
    firstName: first,
    lastName: 'Customer',
    phone,
    ...(email ? { email } : {}),
    ignoreDuplicates: true,
  });
  return { id: personId, phone, email };
}

/** A customer's text to the business number, sent `secondsAgo` seconds ago; then the outbox runs (not due jobs). */
export async function textIn(
  w: World,
  from: string,
  body: string,
  opts: { readonly secondsAgo?: number } = {},
): Promise<{ messageId: string; conversationId: string; at: number }> {
  const at = Date.now() - (opts.secondsAgo ?? 0) * 1000;
  const { output } = await executeCommand(
    testDbs().worker.db,
    messageReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'fake',
      providerMessageId: `SM${randomUUID()}`,
      from,
      to: w.number!,
      body,
      occurredAt: new Date(at).toISOString(),
      reminderAfterMs: 86_400_000,
    },
    systemActor(scopeOf(w)),
    { correlationId: randomUUID(), channel: 'worker' },
  );
  await drain(w);
  return { messageId: output.messageId, conversationId: output.conversationId, at };
}

/** A customer's email to the business. */
export async function emailIn(w: World, from: string, subject: string, body: string) {
  const { output } = await executeCommand(
    testDbs().worker.db,
    emailReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'fake',
      providerMessageId: randomUUID(),
      messageIdHeader: `<${randomUUID()}@example.com>`,
      from: { address: from },
      to: [{ address: 'hello@business.example.com' }],
      subject,
      bodyText: body,
      reminderAfterMs: 86_400_000,
    },
    systemActor(scopeOf(w)),
    { correlationId: randomUUID(), channel: 'worker' },
  );
  await drain(w);
  return output;
}

/**
 * A website chat through the chat commands: a widget the teammate answers (or, with `teammate: false`, one left
 * to people), a visitor, and their message (chat.receive), linked to `personId` as chat.identify would. With
 * `visitorId`, a visitor already here writes again. `aiReply: false` is how the chat route files a message the
 * human check couldn't vouch for (Cloudflare didn't answer). The outbox then runs, and the reply it queued is
 * brought forward to now, so the next drain answers it.
 */
export async function chatIn(
  w: TeammateWorld,
  personId: string | null,
  body: string,
  opts: {
    readonly teammate?: boolean;
    readonly visitorId?: string;
    readonly aiReply?: boolean;
  } = {},
): Promise<{ conversationId: string; messageId: string; visitorId: string }> {
  const asWorkerMeta = () => ({ correlationId: randomUUID(), channel: 'worker' as const });
  let visitorId = opts.visitorId;
  if (!visitorId) {
    const { widgetId } = await run(w, chatWidgetCreate, {
      workspaceId: w.workspaceId,
      allowedOrigins: [`tm-${randomUUID().slice(0, 8)}.example`],
      ...(opts.teammate === false ? {} : { teammateId: w.teammateId }),
    });
    const { output: visitor } = await executeCommand(
      testDbs().worker.db,
      chatVisitorStart,
      { workspaceId: w.workspaceId, widgetId, tokenHash: randomBytes(32).toString('hex') },
      systemActor(scopeOf(w)),
      asWorkerMeta(),
    );
    visitorId = visitor.visitorId;
  }
  const { output: said } = await executeCommand(
    testDbs().worker.db,
    chatReceive,
    {
      workspaceId: w.workspaceId,
      visitorId,
      body,
      clientId: randomUUID(),
      reminderAfterMs: 86_400_000,
      ...(opts.aiReply === undefined ? {} : { aiReply: opts.aiReply }),
    },
    systemActor(scopeOf(w)),
    asWorkerMeta(),
  );
  if (personId)
    await rows(
      admin(),
      sql`update app.conversations set person_id = ${personId} where id = ${said.conversationId}`,
    );
  await drain(w);
  await forceDue(said.conversationId);
  return { conversationId: said.conversationId, messageId: said.messageId, visitorId };
}

/** Brings the conversation's pending reply forward to now. */
export async function forceDue(conversationId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where dedupe_key = ${replyJobKey(conversationId)} and status = 'pending'`,
  );
}

/** Runs the conversation's reply now instead of after its debounce, then everything it queued. */
export async function replyNow(w: World, conversationId: string): Promise<void> {
  await forceDue(conversationId);
  await drain(w);
}

/**
 * Brings the named jobs forward to now and runs them with the world's own services (its model included: the
 * world's HTTP app, and so the run-due route, was built before the model was swapped in), then what they queued.
 */
export async function runNow(w: World, dedupeKeys: readonly string[]): Promise<void> {
  for (const key of dedupeKeys)
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where dedupe_key = ${key} and workspace_id = ${w.workspaceId} and status = 'pending'`,
    );
  await drain(w);
}

/** One pass of the workspace's due jobs, retries allowed (drain refuses them). */
export async function jobsOnce(w: World): Promise<JobStats> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${w.workerId}
        where status = 'pending' and workspace_id = ${w.workspaceId}`,
  );
  return processJobs({ ...w.s, jobs, workerId: w.workerId, batchSize: 50, reservedOnly: true });
}

export async function pendingReply(
  conversationId: string,
): Promise<{ runAt: number; payload: Record<string, unknown>; attempts: number } | null> {
  const [j] = await rows<{
    run_at: Date | string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    admin(),
    sql`select run_at, payload, attempts from app.scheduled_jobs
        where dedupe_key = ${replyJobKey(conversationId)} and status = 'pending'`,
  );
  return j
    ? { runAt: new Date(j.run_at).getTime(), payload: j.payload, attempts: j.attempts }
    : null;
}

export interface RunView {
  id: string;
  status: string;
  outcome: string | null;
  triggered_by: string;
  message_ids: string[];
  summary: string | null;
  reply_text: string | null;
  knowledge: { itemId: string; title: string }[];
  checks: { rule: string; ok: boolean; message?: string; attempt: number }[];
  error: string | null;
  tool_steps: number;
  input_tokens: number;
}

export function runsOf(conversationId: string): Promise<RunView[]> {
  return rows<RunView & Record<string, unknown>>(
    admin(),
    sql`select id, status, outcome, triggered_by, message_ids, summary, reply_text, knowledge, checks, error,
          tool_steps, input_tokens
        from app.ai_teammate_runs where conversation_id = ${conversationId} order by started_at, id`,
  );
}

export function toolCallsOf(runId: string) {
  return rows<{
    tool: string;
    status: string;
    provider_call_id: string;
    result: Record<string, unknown> | null;
    command: string | null;
  }>(
    admin(),
    sql`select tool, status, provider_call_id, result, command from app.ai_teammate_tool_calls
        where run_id = ${runId} order by created_at, id`,
  );
}

/** What the teammate sent in a conversation, oldest first: its replies and its hand-off lines. */
export function aiMessages(conversationId: string) {
  return rows<{
    id: string;
    channel: string;
    status: string;
    body_text: string | null;
    approved_by: string | null;
    ai_run_id: string | null;
    ai_draft_id: string | null;
    client_id: string | null;
  }>(
    admin(),
    sql`select id, channel::text as channel, status::text as status, body_text, approved_by, ai_run_id, ai_draft_id,
          client_id
        from app.messages
        where conversation_id = ${conversationId} and sent_by_teammate_id is not null
        order by created_at, id`,
  );
}

/** The teammate's hand-off lines in a conversation (clientId handoff:<conversation>:<epoch>). */
export async function handoffLines(conversationId: string) {
  return (await aiMessages(conversationId)).filter((m) => m.client_id?.startsWith('handoff:'));
}

/** The teammate's own replies in a conversation, without its hand-off lines. */
export async function aiReplies(conversationId: string) {
  return (await aiMessages(conversationId)).filter((m) => !m.client_id?.startsWith('handoff:'));
}

/** The business's default hand-off line, whatever the time of day makes of {expectation}. */
export const HANDOFF_LINE =
  /^Thanks for your patience\. I've passed this to our team, and someone from our team will reply (?:shortly|first thing|once we open|tomorrow once|on \w+ once)/;

export function draftsOf(conversationId: string) {
  return rows<{
    id: string;
    kind: string;
    status: string;
    via: string | null;
    reason: string | null;
    client_id: string;
    run_id: string | null;
    preview: {
      message: { channel: string; body: string; inReplyToMessageId: string | null } | null;
      actions: { kind: string; startsAt?: string; summary: string }[];
    };
  }>(
    admin(),
    sql`select id, kind, status::text as status, via, reason, client_id, run_id, preview
        from app.ai_teammate_drafts where conversation_id = ${conversationId} order by created_at, id`,
  );
}

export async function conversationOf(conversationId: string) {
  const [c] = await rows<{
    handled_by: string;
    ai_teammate_id: string | null;
    ai_epoch: number;
    handoff_reason: string | null;
    handoff_note: string | null;
    needs_person_since: Date | null;
    taken_over_by: string | null;
    ai_answered_through: Date | null;
    ai_disclosed_at: Date | null;
  }>(
    admin(),
    sql`select handled_by::text as handled_by, ai_teammate_id, ai_epoch, handoff_reason, handoff_note,
          needs_person_since, taken_over_by, ai_answered_through, ai_disclosed_at
        from app.conversations where id = ${conversationId}`,
  );
  return c!;
}

/** A customer's booked visits, soonest first. */
export function appointmentsOf(personId: string) {
  return rows<{ id: string; starts_at: Date | string }>(
    admin(),
    sql`select a.id, a.starts_at from app.appointment_attendees t
        join app.appointments a on a.id = t.appointment_id
        where t.person_id = ${personId} and t.status = 'booked' order by a.starts_at`,
  );
}

/** The last open time on the world's calendar `daysAhead` days from today (the teammate books the first). */
export async function openSlot(w: TeammateWorld, daysAhead: number): Promise<number> {
  const out = await executeQuery(
    api(),
    calendarAvailability,
    {
      workspaceId: w.workspaceId,
      calendarId: w.calendar!.id,
      from: iso(at(daysAhead, '00:00')),
      to: iso(at(daysAhead + 1, '00:00')),
    },
    ownerOf(w),
    meta(),
  );
  const slot = out.slots.at(-1);
  if (!slot) throw new Error(`no open time ${daysAhead} days from today`);
  return Date.parse(slot.startsAt);
}

/** A published fact in the knowledge base. */
export async function addFact(w: World, title: string, body: string): Promise<string> {
  const out = await run(w, knowledgeItemCreate, {
    workspaceId: w.workspaceId,
    content: { kind: 'fact', title, body, tags: [] },
    status: 'published',
  });
  return out.itemId;
}

/** The business profile's "the AI may quote prices" switch, on. */
export async function allowPrices(w: World): Promise<void> {
  await run(w, knowledgeProfileUpdate, {
    workspaceId: w.workspaceId,
    profile: { allowPrices: true },
  });
}
