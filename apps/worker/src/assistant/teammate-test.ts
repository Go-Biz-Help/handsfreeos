/**
 * Trying the AI teammate as a customer, by asking (tm-8): what AI teammate → Test console does, through the same
 * worker code (ai-team/console.ts) with the saved settings. The customer's messages go to it by text, email or the
 * website chat, as someone in Contacts or a stranger, now or at a time picked; what it would reply, whether that waits
 * for an OK, what it looked up, what it would do and how its safety check went come back. Nothing is sent, booked or
 * changed and nobody is rung: the test's run is marked a test, as the console's are, and only its tokens count, toward
 * the teammate's share of the daily AI limit. A phone call is tried in the console itself, live.
 */
import { HfosError, type TestEvent } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { prepareTest, runTest, TestConsoleInput, type ConsoleDeps } from '../ai-team/console';
import { hasPermission, parseBody } from '../http/common';
import type { WorkerServices } from '../services';
import type { ToolContext, ToolOutcome } from './runtime';
import { query, when } from './tools-read';

type Args = Record<string, unknown>;

/** How long a test may take before it is stopped, as a person closing the console would. */
const TEST_MS = 120_000;

const BY: Readonly<Record<string, string>> = {
  sms: 'text',
  email: 'email',
  chat: 'the website chat',
};

const OUTCOME: Readonly<Record<string, string>> = {
  replied: 'It replied',
  drafted: 'It wrote a reply that waits for someone’s OK first (training wheels)',
  handed_off: 'It handed the conversation to a person',
  no_reply: 'It chose not to reply',
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The test, as the console's request sends it: this business, the saved settings, never a phone call. */
function consoleInput(ctx: ToolContext, args: Args): TestConsoleInput {
  const retry = args['retryWithFix'] as
    { reply?: string; better?: string; why?: string } | undefined;
  return parseBody(TestConsoleInput, {
    workspaceId: ctx.workspaceId,
    personId: str(args['personId']) ?? null,
    channel: str(args['channel']) ?? 'sms',
    call: null,
    at: str(args['at']) ?? null,
    config: null,
    messages: Array.isArray(args['messages']) ? args['messages'] : [],
    coaching: retry
      ? {
          reply: str(retry.reply) ?? null,
          better: str(retry.better) ?? null,
          why: str(retry.why) ?? null,
        }
      : null,
  });
}

/** What the console showed, gathered: each event the test streamed, in the order it came. */
function summed(events: readonly TestEvent[]) {
  const runId = events.find((e) => e.type === 'started')?.runId ?? null;
  const done = events.find((e) => e.type === 'done');
  const error = events.find((e) => e.type === 'error');
  const checks = events.filter((e) => e.type === 'check');
  const last = checks[checks.length - 1];
  return {
    runId,
    done: done ?? null,
    error: error?.message ?? null,
    lookedUp: events.flatMap((e) =>
      e.type === 'tool' ? [e.detail ? `${e.title}: ${e.detail}` : e.title] : [],
    ),
    knowledge: [
      ...new Set(
        events.flatMap((e) => (e.type === 'knowledge' ? e.items.map((i) => i.title) : [])),
      ),
    ],
    wouldDo: events.flatMap((e) => (e.type === 'would' ? [e.summary] : [])),
    notes: events.flatMap((e) =>
      e.type === 'context' || e.type === 'note'
        ? [e.detail ? `${e.title}: ${e.detail}` : e.title]
        : [],
    ),
    check: last
      ? {
          passed: last.ok,
          ...(last.problems.length ? { problems: last.problems.map((p) => p.message) } : {}),
          ...(last.rewritten ? { rewrittenOnce: true } : {}),
        }
      : null,
  };
}

export async function testAiTeammate(
  db: Db,
  ctx: ToolContext,
  args: Args,
  services: WorkerServices | null,
  webUrl: string,
): Promise<ToolOutcome> {
  if (!services) throw new Error('This worker can’t try the AI teammate for the Assistant');
  // The console's own check: it runs as the worker, so who may try it is checked here, as its route does.
  if (!(await hasPermission({ httpDb: db }, ctx.actor.userId, ctx.workspaceId, 'ai_team.manage')))
    throw HfosError.forbidden(
      'Only someone who manages the AI teammate can try it. Ask an owner or admin of this business.',
    );
  const input = consoleInput(ctx, args);
  const last = input.messages.length - 1;
  if (input.messages[last]?.from !== 'customer')
    throw HfosError.validation(
      [{ path: `messages.${last}`, message: 'End with the customer’s new message.' }],
      'The test answers the customer’s newest message, so end the conversation with what the customer says next.',
    );
  // Someone in Contacts is one this person can see, read as them, as the console's picker lists them.
  const person = input.personId
    ? (
        await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
          personId: input.personId,
        })
      ).person
    : null;
  const deps: ConsoleDeps = {
    db,
    ai: services.ai,
    voiceAi: services.voiceAi,
    aiFor: services.aiFor,
    webUrl: webUrl || services.webUrl,
    log: services.log,
    wallet: services.wallet,
    geocoder: services.geocoder,
  };
  const prepared = await prepareTest(deps, input);
  const events: TestEvent[] = [];
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TEST_MS);
  try {
    await runTest(deps, prepared, (e) => events.push(e), stop.signal);
  } catch (e) {
    if (e instanceof HfosError) throw e;
    services.log.error({ err: e }, 'the Assistant’s try of the AI teammate stopped');
    throw HfosError.rule(
      'teammate_test_failed',
      502,
      `${prepared.teammate.name}’s test stopped before it answered. Try again in a minute.`,
    );
  } finally {
    clearTimeout(timer);
  }
  const s = summed(events);
  const name = prepared.teammate.name;
  if (!s.done)
    throw HfosError.rule(
      'teammate_test_failed',
      502,
      s.error ?? `${name}’s test stopped before it answered. Try again in a minute.`,
    );
  const reply = s.done.reply;
  return {
    result: {
      tried: {
        teammate: name,
        as: person?.fullName ?? 'Someone not in Contacts yet',
        by: BY[input.channel] ?? input.channel,
        at: input.at ? when(input.at, ctx.timezone) : 'now',
      },
      outcome: OUTCOME[s.done.outcome] ?? s.done.outcome,
      ...(reply ? { reply: { ai_teammate_wrote: reply } } : {}),
      ...(s.done.draft ? { waitsForAnOk: true } : {}),
      ...(s.wouldDo.length ? { wouldDo: s.wouldDo } : {}),
      ...(s.lookedUp.length ? { lookedUp: s.lookedUp } : {}),
      ...(s.knowledge.length ? { usedKnowledge: s.knowledge } : {}),
      ...(s.notes.length ? { notes: s.notes } : {}),
      ...(s.check ? { safetyCheck: s.check } : {}),
      ...(s.runId ? { runId: s.runId } : {}),
      note: `Nothing was sent, booked or changed: this is how ${name} would answer with its saved settings. It counted toward ${name}’s share of the daily AI limit, as the Test console does. To rate the reply, pass this runId to do_ai_teammate_give_feedback; to try it again with a better reply in mind, call this again with retryWithFix.`,
    },
    card: {
      type: 'list',
      title: `How ${name} would answer`,
      items: [
        {
          title: OUTCOME[s.done.outcome] ?? s.done.outcome,
          detail: reply ? (reply.length > 300 ? `${reply.slice(0, 299)}…` : reply) : '',
          tone: s.done.outcome === 'handed_off' ? 'warning' : 'accent',
          href: `/app/w/${ctx.workspaceId}/ai-team`,
        },
        ...s.wouldDo.slice(0, 6).map((w) => ({
          title: 'Would',
          detail: w,
          tone: 'muted' as const,
          href: null,
        })),
      ],
    },
  };
}
