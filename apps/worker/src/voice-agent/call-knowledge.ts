/**
 * What a phone call reads once, when it's picked up (voice-agent/brain.ts, and the test console's calls), so a
 * question takes one model step instead of a look-up and then an answer:
 *
 * - The FAQ's short answers and facts, whole (up to a limit). A turn's search then looks only for what they
 *   don't cover: longer articles and documents, and anything past the limit.
 * - Some open times over the next few days on each calendar it may book without asking where they are, spread
 *   across each day. They're offered and booked like find_times' (booking still checks the time is free); for
 *   another day, a service or a length it still looks.
 * - The call's lasting context (ai-team/prompt.ts `callLasting`): everything that stays the same all call, these
 *   two included. The provider caches it after the fixed rules, and the call warms that cache while the greeting
 *   plays, so each turn reads only the time and what the caller just said.
 * - Each turn's knowledge (`turnMatches`): what matches the caller's words, past the FAQ it already has.
 *
 * Nothing here can stop a call: whatever fails to load is left out, and the call goes on as it would have.
 */
import {
  addDays,
  calendarAvailability,
  executeQuery,
  KNOWLEDGE_SEARCH_MAX_RESULTS,
  localDateOf,
  quoteData,
  startOfLocalDay,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { atLabel } from '../assistant/calendar-format';
import {
  CALL_FAQ_MAX,
  CALL_TIMES_CALENDARS,
  CALL_TIMES_DAYS,
  CALL_TIMES_PER_DAY,
  FAQ_PROMPT_MAX_CHARS,
  KNOWLEDGE_MATCHES,
} from '../ai-team/constants';
import type { RunContext } from '../ai-team/context';
import { callLasting, type CallKnowledge } from '../ai-team/prompt';
import { timeKey, type OfferedTime, type RunState } from '../ai-team/tools';
import { anyOfWords, findKnowledge, shortKnowledge } from '../knowledge/find';
import { systemActor, type TenantScope } from '../services';

/** An FAQ answer longer than this is left to the search: the FAQ read up front is for short ones. */
const FAQ_ITEM_MAX_CHARS = 1_500;
/** What an item costs in the prompt beyond its words: its tag, id and kind. */
const FAQ_ITEM_OVERHEAD = 120;

export interface CallBrief {
  /** The call's lasting context: the same text every turn, so the provider finds it ready. */
  readonly lasting: string;
  /** The FAQ items in it, which a turn's knowledge leaves out. */
  readonly faqIds: ReadonlySet<string>;
  readonly openTimes: readonly OfferedTime[];
}

export interface CallBriefInput {
  readonly rc: RunContext;
  /** How to talk on this call (phoneChannelLines). */
  readonly channelLines: readonly string[];
  /** It may book on this call (the book tool is among its tools): only then are open times read. */
  readonly booking: boolean;
  readonly meta: RequestMeta;
}

/** Reads the FAQ and the open times, and writes the call's lasting context. */
export async function readCallBrief(
  deps: { readonly db: Db; readonly log: Logger },
  scope: TenantScope,
  input: CallBriefInput,
): Promise<CallBrief> {
  const [faq, openTimes] = await Promise.all([
    readFaq(deps, scope).catch((e: unknown) => {
      deps.log.warn({ err: e }, 'couldn’t read the FAQ for a call; it searches instead');
      return [];
    }),
    input.booking
      ? readOpenTimes(deps, scope, input.rc, input.meta).catch((e: unknown) => {
          deps.log.warn(
            { err: e },
            'couldn’t read open times for a call; it looks them up instead',
          );
          return [];
        })
      : Promise.resolve([]),
  ]);
  const known: CallKnowledge = { faq, openTimes };
  return {
    lasting: callLasting(input.rc, known, { channelLines: input.channelLines }),
    faqIds: new Set(faq.map((f) => f.id)),
    openTimes,
  };
}

/** The times read at pickup, offerable and bookable like find_times' for the rest of the call. */
export function offerOpenTimes(state: RunState, brief: CallBrief): void {
  for (const t of brief.openTimes) {
    const key = timeKey(t.calendarId, t.startsAt);
    if (!state.offered.has(key)) state.offered.set(key, t);
  }
}

async function readFaq(
  deps: { readonly db: Db },
  scope: TenantScope,
): Promise<CallKnowledge['faq']> {
  const items = await asWorker(deps.db, scope, (tx) =>
    shortKnowledge(tx, {
      workspaceId: scope.workspaceId,
      limit: CALL_FAQ_MAX,
      itemChars: FAQ_ITEM_MAX_CHARS,
    }),
  );
  // Only whole items: an answer cut short would be left out of the search and still not be there.
  const kept: CallKnowledge['faq'][number][] = [];
  let used = 0;
  for (const item of items) {
    const cost =
      quoteData(item.title).length +
      quoteData(item.body.trim()).length +
      (item.sourceUrl?.length ?? 0) +
      FAQ_ITEM_OVERHEAD;
    if (used + cost > FAQ_PROMPT_MAX_CHARS) continue;
    kept.push(item);
    used += cost;
  }
  return kept;
}

/**
 * Open times from now to the end of the next few days on the calendars it can book without asking where they
 * are (no ZIP or address needed, no deposit, no service-area check first), a few from each day, spread out.
 */
async function readOpenTimes(
  deps: { readonly db: Db },
  scope: TenantScope,
  rc: RunContext,
  meta: RequestMeta,
): Promise<OfferedTime[]> {
  if (!rc.config.book.enabled || rc.config.book.serviceArea) return [];
  const calendars = rc.calendars
    .filter((c) => !c.deposit && !c.byZip && !c.byAddress)
    .slice(0, CALL_TIMES_CALENDARS);
  const lists = await Promise.all(
    calendars.map(async (cal) => {
      const tz = cal.timeZone;
      const from = rc.now;
      const to = startOfLocalDay(addDays(localDateOf(from, tz), CALL_TIMES_DAYS), tz);
      const out = await executeQuery(
        deps.db,
        calendarAvailability,
        {
          workspaceId: scope.workspaceId,
          calendarId: cal.id,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          serviceId: null,
        },
        systemActor(scope),
        meta,
      );
      const byDay = new Map<string, typeof out.slots>();
      for (const s of out.slots) {
        const day = localDateOf(Date.parse(s.startsAt), tz);
        byDay.set(day, [...(byDay.get(day) ?? []), s]);
      }
      return [...byDay.values()].flatMap((slots) =>
        spread(slots, CALL_TIMES_PER_DAY).map((s): OfferedTime => {
          const at = Date.parse(s.startsAt);
          return {
            calendarId: cal.id,
            startsAt: new Date(at).toISOString(),
            sessionId: s.sessionId,
            serviceId: out.serviceId,
            durationMinutes: null,
            postalCode: null,
            point: null,
            label: atLabel(at, tz),
            preloaded: true,
          };
        }),
      );
    }),
  );
  return lists.flat();
}

/** Up to `n` of the list, spread from its first to its last (a morning and an afternoon, not four in a row). */
export function spread<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  if (n <= 1) return list.slice(0, n);
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.round((i * (list.length - 1)) / (n - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => list[i]!);
}

/**
 * The knowledge that matches what the caller just said, or the call's own when nothing does. The FAQ read at
 * pickup is in the call's context already, so the search reaches past it for what it doesn't cover.
 */
export async function turnMatches(
  deps: { readonly db: Db },
  scope: TenantScope,
  said: string,
  o: { readonly faqIds: ReadonlySet<string>; readonly otherwise: RunContext['matches'] },
): Promise<RunContext['matches']> {
  const otherwise = o.otherwise.filter((m) => !o.faqIds.has(m.id));
  const words = anyOfWords(said);
  if (!words) return otherwise;
  const found = await asWorker(deps.db, scope, (tx) =>
    findKnowledge(tx, {
      workspaceId: scope.workspaceId,
      queries: [words],
      limit: o.faqIds.size ? KNOWLEDGE_SEARCH_MAX_RESULTS : KNOWLEDGE_MATCHES,
    }),
  );
  const fresh = found.filter((m) => !o.faqIds.has(m.id)).slice(0, KNOWLEDGE_MATCHES);
  return fresh.length ? fresh : otherwise;
}
