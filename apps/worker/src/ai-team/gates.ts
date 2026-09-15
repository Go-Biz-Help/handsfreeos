/**
 * The checks that decide whether the AI teammate answers a message at all (plan M7, "What starts a run"): its
 * working hours, automatic emails, loops with other bots, and the daily reply cap. Email bodies lose their
 * quoted history here too, for the model and for these checks.
 */
import {
  localDateOf,
  localMinutes,
  parseClock,
  weekdayOf,
  type TeammateConfig,
  type WeeklyHours,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { LOOP_FLOOD, LOOP_REPEATS, LOOP_WINDOW_MS } from './constants';

// ---- Hours ----

/** Whether `now` falls inside these weekly hours, in the time zone (day 0 is Sunday; an end of 24:00 is midnight). */
export function withinHours(hours: WeeklyHours, timeZone: string, now: number): boolean {
  const day = weekdayOf(localDateOf(now, timeZone));
  const minute = localMinutes(new Date(now), timeZone);
  return hours.some(
    (h) => h.day === day && parseClock(h.start) <= minute && minute < parseClock(h.end),
  );
}

/** Whether the teammate is working now: always, only while the business is closed, or its own hours. */
export function workingNow(
  config: TeammateConfig,
  openHours: WeeklyHours,
  timeZone: string,
  now: number,
): boolean {
  switch (config.hours.mode) {
    case 'always':
      return true;
    case 'after_hours':
      return !withinHours(openHours, timeZone, now);
    case 'custom':
      return withinHours(config.hours.custom, timeZone, now);
  }
}

// ---- Emails ----

const AUTO_SENDER =
  /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|auto-?reply|autoresponder)(?:[+._-][^@]*)?@/i;
const AUTO_SUBJECT =
  /^\s*(?:(?:re|fwd?):\s*)?(?:auto(?:matic)?[ -]?(?:reply|response)|autoreply|out of (?:the )?office|ooo\b|away from (?:the|my) office|undeliverable|undelivered mail|delivery (?:status )?(?:notification|failure)|mail delivery (?:failed|subsystem)|returned mail|vacation (?:reply|response))/i;
const AUTO_BODY =
  /^\s*(?:this is an automat(?:ic|ed) (?:reply|response|message)|(?:i am|i'm|i’m) (?:currently )?(?:out of (?:the )?office|away from (?:the|my) (?:office|desk))|thank you for your (?:e-?mail|message)\.? (?:i am|i'm|i’m) (?:currently )?(?:away|out))/i;

/**
 * An email a machine sent: a no-reply sender, an out-of-office or delivery-failure subject, or an automatic
 * reply's opening line. Postmark and mailbox sync already drop mail whose headers say so (email/render.ts
 * isAutomatic); this catches what gets past the headers.
 */
export function isAutomaticEmail(m: {
  readonly from: string | null;
  readonly subject: string | null;
  readonly body: string | null;
}): boolean {
  return (
    AUTO_SENDER.test(m.from ?? '') ||
    AUTO_SUBJECT.test(m.subject ?? '') ||
    AUTO_BODY.test(m.body ?? '')
  );
}

/** An email body without the quoted history under it ("On Tue, Sam wrote:", "> …", "-----Original Message-----"). */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (
      /^\s*On\b.{0,300}\bwrote:\s*$/i.test(line) ||
      /^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line) ||
      /^_{5,}\s*$/.test(line) ||
      (out.some((l) => l.trim()) && /^\s*From:\s.+/i.test(line))
    )
      break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Loops and limits ----

const normal = (s: string | null) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Why this conversation looks like a loop with another bot or an auto-responder, or null: the same message
 * arriving again and again within minutes, a flood of messages, or the customer's side repeating the
 * teammate's own replies back.
 */
export async function loopReason(tx: Tx, conversationId: string): Promise<string | null> {
  const recent = await rows<{ body_text: string | null; direction: string; ai: boolean }>(
    tx,
    sql`select body_text, direction::text as direction, sent_by_teammate_id is not null as ai
        from app.messages
        where conversation_id = ${conversationId}
          and created_at > now() - make_interval(secs => ${LOOP_WINDOW_MS / 1000})
        order by created_at, id`,
  );
  const inbound = recent.filter((m) => m.direction === 'inbound');
  if (inbound.length >= LOOP_FLOOD)
    return `${inbound.length} messages came in within minutes, like an automated sender.`;
  const counts = new Map<string, number>();
  for (const m of inbound) {
    const key = normal(m.body_text);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const most = Math.max(0, ...counts.values());
  if (most >= LOOP_REPEATS)
    return `The same message came in ${most} times within minutes, like an automated sender.`;
  const lastAi = recent
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.ai)
    .pop();
  const said = normal(lastAi?.m.body_text ?? null);
  if (lastAi && said.length >= 20) {
    const echo = said.slice(0, 60);
    if (
      recent
        .slice(lastAi.i + 1)
        .some((m) => m.direction === 'inbound' && normal(m.body_text).includes(echo))
    )
      return 'The other side repeats its replies back, like another bot.';
  }
  return null;
}

/** Replies (sent or drafted) the teammate made in this conversation since midnight where the business is. */
export async function repliesToday(
  tx: Tx,
  conversationId: string,
  timeZone: string,
): Promise<number> {
  const [r] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from app.ai_teammate_runs
        where conversation_id = ${conversationId} and not is_test and outcome in ('replied', 'drafted')
          and started_at >= (date_trunc('day', now() at time zone ${timeZone}) at time zone ${timeZone})`,
  );
  return r?.n ?? 0;
}
