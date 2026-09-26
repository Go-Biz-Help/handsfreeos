/**
 * The AI teammate's thinking on a live phone call (M18 step 5): the same tools, holds, checks and hand-off as a
 * text reply (ai-team/run.ts), one caller turn at a time.
 *
 * - `prepareCall`: the call's record and conversation (call.record, as the webhook loop would), the run (one per
 *   call, however many turns), the conversation picked up for the teammate when nobody has it, and the call
 *   marked answered by it. A conversation a person looks after is answered too, with questions only: anything
 *   else is theirs, so it connects the caller to the team.
 * - `thinkTurn`: what the caller said goes through the same immediate hand-offs as a text (an emergency, a
 *   sensitive topic, asking for a person, frustration), then the tool loop, then the safety check (one rewrite).
 *   The knowledge that matches their words is in the context before the model is asked, so a question the
 *   business answers takes one model call, not a search and then another. A reply on a turn that changes nothing
 *   starts being said while it's written, a checked sentence at a time (early-speech.ts); the rest follows once
 *   it's done. Held changes run before the words are said (automatic), or wait in a draft for the team
 *   (training); money waits for an OK in every mode, and the caller hears the team will text it.
 * - `finishCall`: the words of the call on the call's record (the timeline and the inbox show them, and the next
 *   text reply reads them), and the run closed.
 */
import type { AiUsage } from '@hfos/ai';
import {
  callAttachTranscript,
  callRecord,
  callUpdateStatus,
  conversationPickUp,
  EMERGENCY_SAFETY_TEXT,
  executeCommand,
  executeCommandIn,
  HfosError,
  loadTeammate,
  runHeldAction,
  TEAMMATE_TURN_ENDERS,
  teammateTools,
  walletRoom,
  type AiEmployeeActor,
  type ConversationHandoffReason,
  type RequestMeta,
  type TeammateConfig,
  type TeammateRow,
  type TeammateTool,
  type TeammateToolName,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import { callBrief } from '../ai-calls';
import { aiBudget, recordAndChargeAi } from '../ai/budget';
import { runToolLoop, type ToolLoopResult } from '../ai/tool-loop';
import { chatCodeSender } from '../ai-team/chat-code';
import { runtimeConfigOf } from '../ai-team/config';
import { KNOWLEDGE_MATCHES } from '../ai-team/constants';
import { loadRunContext, type BatchMessage, type RunContext } from '../ai-team/context';
import { handOffAsAi } from '../ai-team/handoff';
import { contextText, TEAMMATE_SYSTEM } from '../ai-team/prompt';
import {
  checkReply,
  checkRows,
  closeRun,
  closeStaleCallRuns,
  finalText,
  immediateHandOff,
  makeApprovals,
  makeDraft,
  withFeedback,
  type DraftRun,
} from '../ai-team/run';
import { createExecutor, newRunState, toolDefinition, type RunState } from '../ai-team/tools';
import { anyOfWords, findKnowledge } from '../knowledge/find';
import type { WorkerServices } from '../services';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { loadAccount } from '../telephony/accounts';
import type { ProviderAccount } from '../telephony/provider';
import { EarlySpeech, streamSpoken } from './early-speech';
import {
  alreadySaid,
  CANT_GO_ON,
  CONNECTING,
  phoneChannelLines,
  phoneTurn,
  PHONE_MAX_TOKENS,
  tongue,
  type CallLine,
} from './prompt';
import type { StreamTicket } from './ticket';

/** How long a call waits for a text reply that's running on the same conversation to finish. */
const RUN_WAIT_MS = 3_000;

/** Tools on a call a person looks after: questions only, and connecting them. */
const PERSON_HAS_IT_TOOLS: ReadonlySet<TeammateToolName> = new Set<TeammateToolName>([
  'search_knowledge',
  'reply',
  'end_call',
  'hand_off',
]);

export type BrainDeps = Pick<
  WorkerServices,
  | 'db'
  | 'log'
  | 'ai'
  | 'voiceAi'
  | 'wallet'
  | 'moneyLinks'
  | 'geocoder'
  | 'webUrl'
  | 'sealer'
  | 'mailer'
  | 'telephony'
  | 'publicUrl'
>;

export interface PreparedCall {
  readonly scope: TenantScope;
  readonly ticket: StreamTicket;
  readonly callId: string;
  readonly conversationId: string;
  readonly teammate: TeammateRow;
  readonly config: TeammateConfig;
  readonly runId: string;
  readonly training: boolean;
  /** Someone on the team looks after this customer: it answers questions and connects the rest. */
  readonly personHasIt: boolean;
  readonly account: ProviderAccount;
  readonly rc: RunContext;
  readonly ai: AiEmployeeActor;
  readonly meta: RequestMeta;
  /** What stays true across the call's turns: the times it offered, what it found. */
  readonly state: RunState;
  /** Changes held for the team's OK in training, across the call: each turn's draft carries all of them. */
  readonly trainingHeld: RunState['held'];
  /** AI outbound calls: the call it placed itself, and why; null when it's answering one. */
  readonly outbound: OutboundCall | null;
}

/** A call the teammate placed (app.ai_calls). */
export interface OutboundCall {
  readonly aiCallId: string;
  readonly purpose: 'confirm_visit' | 'missed_call' | 'quote' | 'campaign';
  /** What it says it's calling about: it finishes "I'm calling …". */
  readonly goal: string;
  readonly personId: string;
  readonly attendeeId: string | null;
  readonly firstName: string | null;
  /** A quote's or a campaign's facts, for the AI (data); null for the other reasons. */
  readonly brief: string | null;
}

export type Prepared =
  { readonly ok: true; readonly call: PreparedCall } | { readonly ok: false; readonly why: string };

/**
 * What the call does after a turn. `spoken` is how much of `text` it already said while the reply was written
 * (the session says the rest); none when it said nothing early.
 */
export type TurnOutcome =
  | {
      readonly kind: 'say';
      readonly text: string;
      readonly language: string | null;
      readonly spoken?: number;
    }
  | {
      readonly kind: 'end';
      readonly text: string;
      readonly language: string | null;
      readonly spoken?: number;
    }
  | {
      readonly kind: 'transfer';
      readonly text: string;
      readonly language: string | null;
      readonly reason: ConversationHandoffReason;
      readonly note: string;
    };

const TRANSFER_NOTE_MAX = 500;

type Attempt = { readonly call: PreparedCall } | { readonly why: string } | { readonly busy: true };

/** How the tools ended the turn so far (read through a call: the loop's tools change it). */
const endOf = (state: RunState): RunState['end'] => state.end;

/** Sets the call up for the teammate, or says why it can't answer (the call then goes to voicemail). */
export async function prepareCall(deps: BrainDeps, ticket: StreamTicket): Promise<Prepared> {
  const scope: TenantScope = {
    workspaceId: ticket.workspaceId,
    organizationId: ticket.organizationId,
  };
  const provider = deps.voiceAi ?? deps.ai.provider;
  if (!provider) return { ok: false, why: 'no AI provider' };
  const meta = workerMeta(null, null);
  // A call it placed already has its record (the place job made it): this finds it by the call's sid.
  const placed = !!ticket.aiCallId;
  const recorded = await executeCommand(
    deps.db,
    callRecord,
    {
      workspaceId: scope.workspaceId,
      providerSid: ticket.callSid,
      direction: placed ? 'outbound' : 'inbound',
      from: placed ? ticket.line : ticket.from,
      to: placed ? ticket.from : ticket.line,
      status: 'ringing',
    },
    systemActor(scope),
    meta,
  );
  const callId = recorded.output.callId;
  const conversationId = recorded.output.conversationId;
  if (!conversationId) return { ok: false, why: 'no conversation' };

  const started = Date.now();
  for (;;) {
    const r = await asWorker(deps.db, scope, async (tx): Promise<Attempt> => {
      const teammate = await loadTeammate(tx, scope.workspaceId);
      if (!teammate || teammate.status === 'off') return { why: 'teammate off' };
      const config = runtimeConfigOf(teammate.config);
      if (!config.phone.enabled) return { why: 'phone answering off' };
      const money = await walletRoom(tx, scope.workspaceId, 'ai', (m, e) =>
        deps.log.error({ err: e }, m),
      );
      if (!money.allowed) return { why: 'balance ran out' };
      const account = await loadAccount(tx, scope.workspaceId, deps.sealer);
      if (!account) return { why: 'no telephony account' };
      let outbound: OutboundCall | null = null;
      if (ticket.aiCallId) {
        const [o] = await rows<{
          id: string;
          purpose: OutboundCall['purpose'];
          goal: string;
          person_id: string;
          attendee_id: string | null;
          status: string;
          first_name: string | null;
        }>(
          tx,
          sql`select c.id, c.purpose, c.goal, c.person_id, c.attendee_id, c.status, p.first_name
              from app.ai_calls c join app.people p on p.id = c.person_id
              where c.id = ${ticket.aiCallId} and c.workspace_id = ${scope.workspaceId}`,
        );
        if (!o || o.status !== 'calling') return { why: 'not a call it placed' };
        outbound = {
          aiCallId: o.id,
          purpose: o.purpose,
          goal: o.goal,
          personId: o.person_id,
          attendeeId: o.attendee_id,
          firstName: o.first_name?.trim() || null,
          brief: await callBrief(tx, o.id),
        };
      }
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update');
      if (!conv) return { why: 'no conversation' };
      const mine = conv.handledBy === 'ai' && conv.aiTeammateId === teammate.id;
      const free = conv.handledBy === 'none' && !conv.assigneeUserId;
      const epoch = free ? conv.aiEpoch + 1 : conv.aiEpoch;
      await closeStaleCallRuns(tx, conv.id);
      const [made] = await rows<{ id: string }>(
        tx,
        sql`insert into app.ai_teammate_runs
              (workspace_id, teammate_id, conversation_id, person_id, triggered_by, ai_epoch, message_ids, model, call_id)
            values (${scope.workspaceId}, ${teammate.id}, ${conv.id}, ${conv.personId},
              ${outbound ? 'call.placed' : 'call.answered'},
              ${epoch}, '{}'::uuid[], ${provider.model.slice(0, 100)}, ${callId})
            on conflict (conversation_id) where status = 'running' do nothing
            returning id`,
      );
      // A text reply is being written for them this moment: the call waits for it, briefly.
      if (!made) return { busy: true };
      const ai: AiEmployeeActor = {
        type: 'ai_employee',
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
        teammateId: teammate.id,
        teammateName: teammate.name,
        runId: made.id,
        conversationId: conv.id,
        approvedBy: null,
        origin: null,
        test: false,
      };
      const runMeta: RequestMeta = {
        correlationId: made.id,
        causationId: null,
        channel: 'ai_employee',
      };
      if (free) {
        const picked = await executeCommandIn(
          tx,
          conversationPickUp,
          { workspaceId: scope.workspaceId, conversationId: conv.id },
          ai,
          runMeta,
        );
        if (picked.output.aiEpoch !== epoch)
          await tx.execute(
            sql`update app.ai_teammate_runs set ai_epoch = ${picked.output.aiEpoch} where id = ${made.id}`,
          );
      }
      await executeCommandIn(
        tx,
        callUpdateStatus,
        { workspaceId: scope.workspaceId, callId, status: 'in_progress', answeredVia: 'ai' },
        systemActor(scope),
        runMeta,
      );
      const rc = await loadRunContext(tx, {
        scope,
        teammate,
        config,
        conversationId: conv.id,
        batch: [],
        webUrl: deps.webUrl,
        now: Date.now(),
      });
      return {
        call: {
          scope,
          ticket,
          callId,
          conversationId: conv.id,
          teammate,
          config,
          runId: made.id,
          training: teammate.status === 'training',
          personHasIt: !mine && !free,
          account,
          // The greeting said who it is, so no reply on the call is its first.
          rc: { ...rc, discloseNow: false, firstAiMessage: false },
          ai,
          meta: runMeta,
          state: newRunState(),
          trainingHeld: [],
          outbound,
        } satisfies PreparedCall,
      };
    });
    if ('call' in r) return { ok: true, call: r.call };
    if ('why' in r) return { ok: false, why: r.why };
    if (Date.now() - started > RUN_WAIT_MS) return { ok: false, why: 'a reply was running' };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The caller's words as one of a text reply's customer messages: the same checks read them. */
function asBatch(said: string): BatchMessage {
  return { id: 'call', channel: 'sms', text: said, subject: null, at: Date.now(), photos: [] };
}

function toolsFor(call: PreparedCall): TeammateTool[] {
  const all = teammateTools(call.config, {
    phone: true,
    outbound: call.outbound?.purpose ?? null,
  });
  return call.personHasIt
    ? all.filter((t) => PERSON_HAS_IT_TOOLS.has(t.name as TeammateToolName))
    : all;
}

const transfer = (
  language: string | null,
  reason: ConversationHandoffReason,
  note: string,
  text = CONNECTING[tongue(language)],
): TurnOutcome => ({
  kind: 'transfer',
  text,
  language,
  reason,
  note: note.slice(0, TRANSFER_NOTE_MAX),
});

/** The knowledge that matches what the caller just said, or the call's own when nothing does. */
async function turnMatches(
  deps: BrainDeps,
  call: PreparedCall,
  said: string,
): Promise<RunContext['matches']> {
  const words = anyOfWords(said);
  if (!words) return call.rc.matches;
  const found = await asWorker(deps.db, call.scope, (tx) =>
    findKnowledge(tx, {
      workspaceId: call.scope.workspaceId,
      queries: [words],
      limit: KNOWLEDGE_MATCHES,
    }),
  );
  return found.length ? found : call.rc.matches;
}

/** One turn: what the caller said, answered. */
export async function thinkTurn(
  deps: BrainDeps,
  call: PreparedCall,
  input: {
    readonly turn: number;
    readonly lines: readonly CallLine[];
    readonly said: string;
    readonly language: string | null;
    /** Says a checked sentence of the reply while the rest is still being written; `ending` for a goodbye. */
    readonly speak?: (sentence: string, ending: boolean) => void;
  },
): Promise<TurnOutcome> {
  const { scope, state } = call;
  const language = input.language;
  const batch = [asBatch(input.said)];

  const immediate = immediateHandOff({ ...call.rc, batch });
  if (immediate)
    return transfer(
      language,
      immediate.reason,
      `On a call: ${immediate.note}`,
      immediate.emergency
        ? `${EMERGENCY_SAFETY_TEXT[immediate.emergency]} ${CONNECTING[tongue(language)]}`
        : CONNECTING[tongue(language)],
    );

  const provider = deps.voiceAi ?? deps.ai.provider;
  if (!provider)
    return transfer(language, 'error', 'The AI isn’t set up, so it couldn’t answer the call.');
  const rc: RunContext = {
    ...call.rc,
    batch,
    matches: await turnMatches(deps, call, input.said),
    now: Date.now(),
  };
  // The loop checks the budget before every model call, its first one included.
  const hasRoom = () =>
    aiBudget.teammateHasRoom(deps.db, scope, {
      teammateId: call.teammate.id,
      dailyTokens: deps.ai.dailyTokens,
      sharePercent: call.config.limits.dailySharePercent,
      timeZone: rc.workspace.timeZone,
    });

  // What one turn did starts over; what it offered and found stays for the rest of the call.
  state.held.length = 0;
  state.end = null;
  state.discount = null;
  state.moneyAsk = null;
  const tools = toolsFor(call);
  const enders = tools.filter((t) => TEAMMATE_TURN_ENDERS.has(t.name as TeammateToolName));
  const execute = createExecutor({
    db: deps.db,
    scope,
    runId: call.runId,
    ai: call.ai,
    meta: call.meta,
    rc,
    state,
    tools,
    training: call.training,
    moneyLinks: deps.moneyLinks,
    chatCodes: chatCodeSender(deps),
    geocoder: deps.geocoder,
    // Each turn is its own request, so its calls get their own ids.
    callPrefix: `t${input.turn}:`,
    phone: true,
    outboundCall: call.outbound
      ? {
          aiCallId: call.outbound.aiCallId,
          personId: call.outbound.personId,
          attendeeId: call.outbound.attendeeId,
        }
      : null,
    log: deps.log,
  });
  const onTurnUsage = (usage: AiUsage) =>
    recordAndChargeAi(deps, scope, {
      source: 'teammate',
      teammateId: call.teammate.id,
      teammateRunId: call.runId,
      model: provider.model,
      usage,
    });
  const base = {
    provider,
    system: TEAMMATE_SYSTEM,
    context: contextText(rc, {
      channelLines: phoneChannelLines({
        training: call.training,
        personHasIt: call.personHasIt,
        outbound: call.outbound,
      }),
    }),
    maxTokens: PHONE_MAX_TOKENS,
    execute,
    onTurnUsage,
    checkBudget: hasRoom,
  };
  const failed = (res: ToolLoopResult): TurnOutcome | null => {
    if (res.stoppedBy === 'error' || res.stoppedBy === 'aborted') {
      deps.log.warn(
        { err: res.error, runId: call.runId },
        'the AI teammate couldn’t answer a call turn',
      );
      return transfer(
        language,
        'error',
        'The AI couldn’t answer on the call just now.',
        CANT_GO_ON[tongue(language)],
      );
    }
    if (res.stoppedBy === 'budget')
      return transfer(
        language,
        'budget',
        'It reached its share of today’s AI limit during a call.',
        CANT_GO_ON[tongue(language)],
      );
    if (res.stoppedBy === 'max_rounds')
      return transfer(
        language,
        'limit',
        `It needed more than ${call.config.limits.toolRounds} tool steps to answer on the call.`,
        CANT_GO_ON[tongue(language)],
      );
    return null;
  };

  // Training: nothing it holds has happened yet, so it may not say it has.
  const checked = (text: string) =>
    checkReply(rc, call.training ? { ...state, held: [] } : state, text);
  const speak = input.speak;
  const early = speak
    ? new EarlySpeech({
        passes: (words) => checked(words).ok,
        mayStart: () => !state.held.length && !state.moneyAsk,
        say: speak,
      })
    : null;

  const loop = await runToolLoop({
    ...base,
    messages: [
      {
        role: 'user',
        content: phoneTurn(
          rc,
          { lines: input.lines, offered: [...state.offered.values()] },
          input.said,
        ),
      },
    ],
    tools: tools.map((t) => streamSpoken(toolDefinition(t))),
    maxRounds: call.config.limits.toolRounds,
    ...(early ? { onToolInput: early.onToolInput } : {}),
  });
  const stop = failed(loop);
  if (stop) return stop;
  const ended = endOf(state);
  if (ended?.kind === 'hand_off')
    return transfer(language, ended.reason, `On a call: ${ended.note}`);

  // What it already said while writing: the reply carries on from there.
  const said = early?.said ?? '';
  const heard = (text: string): { text: string; spoken: number } => {
    if (!said) return { text, spoken: 0 };
    const whole = text.trim();
    return { text: whole.startsWith(said) ? whole : `${said} ${whole}`, spoken: said.length };
  };
  const spoken = (): { text: string; ending: boolean } => {
    const e = endOf(state);
    return e?.kind === 'reply' || e?.kind === 'end_call'
      ? { text: e.message, ending: e.kind === 'end_call' }
      : { text: finalText(loop.messages), ending: false };
  };
  let { text, ending } = spoken();
  if (!text.trim())
    return transfer(language, 'cant_answer', 'It didn’t come up with anything to say on the call.');
  const checks: unknown[] = [];
  let verdict = checked(text);
  if (!verdict.ok) {
    checks.push(...checkRows(1, verdict, false));
    state.end = null;
    const redo = await runToolLoop({
      ...base,
      messages: withFeedback(loop.messages, verdict, said ? alreadySaid(said) : undefined),
      tools: enders.map(toolDefinition),
      maxRounds: 1,
    });
    const again = failed(redo);
    if (again) return again;
    if (endOf(state)?.kind === 'hand_off')
      return transfer(
        language,
        'cant_answer',
        'Its reply on the call didn’t pass the safety check.',
      );
    ({ text, ending } = (() => {
      const e = endOf(state);
      return e?.kind === 'reply' || e?.kind === 'end_call'
        ? { text: e.message, ending: e.kind === 'end_call' }
        : { text: finalText(redo.messages), ending: false };
    })());
    verdict = checked(text);
    checks.push(...checkRows(2, verdict, true));
    if (!verdict.ok)
      return transfer(
        language,
        'cant_answer',
        `Its reply on the call didn’t pass the safety check: ${verdict.problems.map((p) => p.message).join('; ')}.`,
        CANT_GO_ON[tongue(language)],
      );
  }

  // What it held, before it says so: done (automatic), or waiting for the team (training). Money waits either way.
  const draftRun: DraftRun = {
    id: call.runId,
    scope,
    teammate: call.teammate,
    target: null,
  };
  const causation = `call:${call.callId}`;
  try {
    await asWorker(deps.db, scope, async (tx) => {
      if (state.held.length) {
        if (call.training) {
          call.trainingHeld.push(...state.held);
          await makeDraft(
            tx,
            causation,
            draftRun,
            rc,
            { ...state, held: call.trainingHeld },
            null,
            null,
          );
        } else
          await tx.transaction(async (sp) => {
            for (const [i, a] of state.held.entries())
              await runHeldAction(
                sp,
                call.ai,
                call.meta,
                a,
                `ai:${call.runId}:t${input.turn}:${i + 1}`,
              );
          });
      }
      await makeApprovals(tx, causation, draftRun, rc, state, `:t${input.turn}`);
    });
  } catch (e) {
    if (!(e instanceof HfosError)) throw e;
    if (e.rule === 'not_handled_by_ai')
      return transfer(language, 'other', 'A person took the conversation over during the call.');
    // The time was taken meanwhile, or the like: it says so plainly, and the call goes on.
    return {
      kind: 'say',
      text:
        tongue(language) === 'es'
          ? 'Disculpe, eso no se pudo completar. ¿Probamos otra opción?'
          : `Sorry, that didn’t go through. ${e.message} Should we try something else?`,
      language,
    };
  }
  const out = heard(text);
  return { kind: ending ? 'end' : 'say', text: out.text, language, spoken: out.spoken };
}

/** The call's words, one line each, newest kept when they run long. */
export function transcriptOf(lines: readonly CallLine[], name: string): string | null {
  if (!lines.length) return null;
  const text = lines.map((l) => `${l.who === 'caller' ? 'Caller' : name}: ${l.text}`).join('\n');
  return text.length <= 10_000 ? text : text.slice(text.length - 10_000);
}

/** How a call went, for the run. */
export interface CallEnding {
  readonly outcome: 'replied' | 'handed_off' | 'no_reply';
  readonly summary: string;
  readonly turns: number;
  readonly lastSaid: string | null;
  readonly error?: string | null;
  /** Hand the conversation to a person as the call is handed on (the transfer). */
  readonly handOff?: { readonly reason: ConversationHandoffReason; readonly note: string } | null;
}

/** Hands the conversation to the team as the caller is connected (their phones ring; the note says why). */
export async function handOffForTransfer(
  deps: BrainDeps,
  call: PreparedCall,
  reason: ConversationHandoffReason,
  note: string,
): Promise<void> {
  if (call.personHasIt) return;
  await asWorker(deps.db, call.scope, (tx) =>
    handOffAsAi(tx, call.ai, call.meta, reason, note, { line: 'none' }),
  );
}

export async function finishCall(
  deps: BrainDeps,
  call: PreparedCall,
  lines: readonly CallLine[],
  ending: CallEnding,
): Promise<void> {
  const transcript = transcriptOf(lines, call.config.identity.name);
  if (transcript)
    await executeCommand(
      deps.db,
      callAttachTranscript,
      { workspaceId: call.scope.workspaceId, callId: call.callId, transcript, status: 'completed' },
      systemActor(call.scope),
      call.meta,
    ).catch((e: unknown) =>
      deps.log.warn({ err: e, callId: call.callId }, 'couldn’t save a call’s words'),
    );
  // A call it placed: how it went, on its own row too (the person's timeline and the approval card read it).
  if (call.outbound)
    await asWorker(deps.db, call.scope, (tx) =>
      tx.execute(
        // The carrier's "it ended" may have got here first (onAiCallEnded): the summary is still the call's.
        sql`update app.ai_calls set status = 'done', outcome = 'talked',
              summary = ${ending.summary.slice(0, 1000)}, finished_at = coalesce(finished_at, now())
            where id = ${call.outbound!.aiCallId}
              and (status = 'calling' or (status = 'done' and outcome = 'talked'))`,
      ),
    ).catch((e: unknown) =>
      deps.log.warn({ err: e, callId: call.callId }, 'couldn’t record how a placed call went'),
    );
  await asWorker(deps.db, call.scope, (tx) =>
    closeRun(tx, call.runId, {
      status: ending.error ? 'failed' : 'done',
      outcome: ending.outcome,
      summary: ending.summary,
      replyText: ending.lastSaid,
      toolSteps: ending.turns,
      leadId: call.rc.lead?.id ?? null,
      ...(ending.error ? { error: ending.error } : {}),
    }),
  );
}
