/**
 * How a problem report is sorted when it's sent (20261027023100): a **limit** or a **fix**. The support desk's
 * Problem reports page shows limits apart, on top, and what needs a fix grouped by problem.
 *
 * A limit is nothing in HandsFreeOS to fix. It waits out, or the business raises it:
 * - `ai_daily`: the business reached its daily AI limit (money/wallet-words.ts `aiLimitReached`, the words the API
 *   refuses with and the tool copies as its note);
 * - `ai_balance`: the business's balance ran out, so the AI paused (`WALLET_REFUSALS.ai`);
 * - `network`: the network refused the step or warned (the AI helper's verdict), or the tool's own words say it hit
 *   a network's daily, weekly or monthly limit.
 *
 * Everything else is a fix. Reports sent before this were sorted the same way by the migration.
 *
 * Browser-safe: words and plain values only.
 */
import type { ProblemKind, ProblemLimit } from '../schemas/problem-report';

/** The start of `aiLimitReached`, with the amount or without: "This business reached the $10 daily AI limit, …". */
const AI_DAILY = /^This business reached (?:the \$[0-9.,]+ daily AI limit|today’s AI limit)/;
/** The start of `WALLET_REFUSALS.ai`. */
export const AI_BALANCE_NOTE = 'Your balance has run out, so the AI has paused';
/** A tool's own words about a network's limit: "reached the weekly invitation limit", "monthly connection limit". */
const NETWORK_LIMIT =
  /\b(?:daily|weekly|monthly) (?:connection |invitation |invite |request )?limit\b/i;
/** The AI helper's verdicts that mean the network said no (decision 142). */
const NETWORK_SAID_NO = new Set(['refused', 'warning']);

export interface ProblemSorted {
  readonly kind: ProblemKind;
  readonly limitKind: ProblemLimit | null;
}

/** Whether a report is a limit, and which, or a fix. */
export function problemKind(report: {
  readonly note: string | null;
  readonly helper: { readonly verdict: string } | null;
}): ProblemSorted {
  const note = report.note ?? '';
  if (AI_DAILY.test(note)) return { kind: 'limit', limitKind: 'ai_daily' };
  if (note.startsWith(AI_BALANCE_NOTE)) return { kind: 'limit', limitKind: 'ai_balance' };
  if ((report.helper && NETWORK_SAID_NO.has(report.helper.verdict)) || NETWORK_LIMIT.test(note))
    return { kind: 'limit', limitKind: 'network' };
  return { kind: 'fix', limitKind: null };
}
