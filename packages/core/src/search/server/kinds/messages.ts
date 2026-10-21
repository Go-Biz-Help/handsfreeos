/**
 * Messages and Spam (inbox.use): one row per conversation, from four reads merged in core
 * (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "The searchers"):
 *
 *   (i)   a thread whose counterpart is the phone or email typed, exactly;
 *   (ii)  threads, in a window, by who they're with (the customer's, a chat visitor's or a Meta name and @handle),
 *         the digits of their number, or their last preview;
 *   (iii) messages, in a window, by the words of their subject and plain text (never their HTML), grouped by
 *         conversation, the best message as the snippet, one-to-one before campaign and automated sends;
 *   (iv)  calls, in a window, by their transcript, through their thread when they have one.
 *
 * Row security never asks for Use the inbox (gap 1): `SEARCH_KINDS` does. On top of it: Spam only in its own kind,
 * Other mail badged, a person's own mail badged "My mail"; never a thread on a turned-off add-on's record
 * (`RECORD_READS`), never a cancelled held text or an unanswered bridge call; archived threads only by name, to go
 * under Archived. Timeline copies of texts, emails and calls are never read here (decision 5).
 */
import { sql, type SQL } from 'drizzle-orm';
import { formatPhone } from '../../../crm/phone';
import { CANCELLED_TEXT } from '../../../messaging/quiet-hours';
import type { SearchHit } from '../../../schemas/search';
import { searchHref } from '../../href';
import { callTitle, messageTitle, SEARCH_WORDS, threadTitle } from '../../words';
import {
  digitsIn,
  fieldHolding,
  fieldSnippet,
  hitOf,
  holdsAll,
  isoOf,
  stretchSnippet,
  wordsLeft,
} from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import {
  archivedRule,
  digitsOf,
  folded,
  isoMicros,
  LIVE_PERSON,
  likeAll,
  reachOf,
  reachOfAll,
  RECORD_READS,
  stretchOf,
  textArray,
  uuidArray,
  windowed,
  windowOf,
  type WindowRow,
} from '../sql';

type Key = 'messages' | 'spam';

/** What every read says about the thread a row is in. */
interface ThreadRow extends Record<string, unknown> {
  conversation_id: string | null;
  channel: string;
  counterpart: string;
  folder: 'inbox' | 'other' | 'spam';
  private_to: string | null;
  archived_at: Date | null;
  last_message_at: Date | null;
  person_id: string | null;
  person_name: string | null;
  visitor_name: string | null;
  meta_name: string | null;
  meta_username: string | null;
  last_preview: string | null;
}

interface MessageRow extends ThreadRow, WindowRow {
  matches: number;
  best_id: string;
  /** The best message's time, to the microsecond: the thread opens up to it. */
  best_at: string;
  automated: boolean;
  direction: 'inbound' | 'outbound';
  snip: string | null;
  snip_cut_before: boolean;
  snip_cut_after: boolean;
}

interface CallRow extends Partial<ThreadRow>, WindowRow {
  call_id: string;
  call_person_id: string | null;
  is_voicemail: boolean;
  started_at: string;
  snip: string | null;
  snip_cut_before: boolean;
  snip_cut_after: boolean;
}

/** The thread's columns, from `c` and the names joined to it. */
const THREAD_COLUMNS = sql`c.id as conversation_id, c.channel::text as channel, c.counterpart,
  c.folder::text as folder, c.private_to, c.archived_at, c.last_message_at, c.last_preview, c.person_id,
  nullif(concat_ws(' ', p.first_name, p.last_name), '') as person_name, v.name as visitor_name,
  mc.name as meta_name, mc.username as meta_username`;

/**
 * Who a thread is with, joined as `inbox.list` joins them: a chat visitor and a Meta contact point at their
 * conversation, not the other way round. Customers in the bin, erased names and merged shells lend no name.
 *
 * Each is a lateral read by its key, and only for a thread of its channel (`offset 0` keeps the planner from turning
 * it into a join), so a window of threads costs a lookup a thread rather than a scan of every customer.
 */
const THREAD_NAMES = sql`left join lateral (
    select p.first_name, p.last_name from app.people p
    where p.id = c.person_id and ${LIVE_PERSON('p')} offset 0) p on true
  left join lateral (
    select v.name from app.chat_visitors v
    where c.channel = 'chat' and v.conversation_id = c.id offset 0) v on true
  left join lateral (
    select mc.name, mc.username from app.meta_contacts mc
    where c.channel in ('messenger', 'instagram') and mc.conversation_id = c.id offset 0) mc on true`;

/** Every name a thread goes by, together. */
const NAMES = sql`concat_ws(' ', p.first_name, p.last_name, v.name, mc.name, mc.username)`;

/**
 * A thread's counterpart when it's something a person types: a text's phone or an email's address. A chat's, the
 * portal's and Meta's are keys of ours ("portal:<id>"), whose letters and digits would match by chance.
 */
const TYPED_COUNTERPART = sql`case when c.channel in ('sms', 'email') then c.counterpart end`;

/** Whether a thread's counterpart is a phone or an email a person would type. */
const typedCounterpart = (r: Partial<ThreadRow>): boolean =>
  r.channel === 'sms' || r.channel === 'email';

/**
 * The rules every read keeps to: the record reads, the folder, archived, and Only mine. Archived threads come back
 * only by who they're with (`byName`), to go under Archived; with Include archived, any way.
 */
function threadRules(plan: SearchPlan, key: Key, byName: SQL = sql`false`): SQL {
  const folder = key === 'spam' ? sql`c.folder = 'spam'` : sql`c.folder <> 'spam'`;
  const archived = archivedRule(plan, sql`c.archived_at`, byName);
  const mine =
    plan.onlyMine && plan.me
      ? sql`and (c.assignee_user_id = ${plan.me} or c.private_to = ${plan.me})`
      : sql``;
  return sql`${RECORD_READS(sql`c.custom_record_id`)} and ${folder} and ${archived} ${mine}`;
}

/** Who a thread is with, as a title names them. */
function whoOf(r: Partial<ThreadRow>): string {
  const name =
    r.person_name?.trim() ||
    r.visitor_name?.trim() ||
    r.meta_name?.trim() ||
    (r.meta_username ? `@${r.meta_username}` : null);
  if (name) return name;
  const counterpart = r.counterpart ?? '';
  if (counterpart.startsWith('+')) return formatPhone(counterpart);
  if (r.channel === 'email' && counterpart.includes('@')) return counterpart;
  return SEARCH_WORDS.noName;
}

/** The badges a thread lends its row. */
function threadBadges(r: Partial<ThreadRow>, key: Key, me: string | null): string[] {
  return [
    ...(r.archived_at ? ['archived'] : []),
    ...(key === 'spam' ? ['spam'] : r.folder === 'other' ? ['other_mail'] : []),
    ...(me && r.private_to === me ? ['my_mail'] : []),
  ];
}

const why = (field: string, snippet: SearchHit['why']['snippet'] = null): SearchHit['why'] => ({
  field,
  label: null,
  snippet,
  page: null,
});

/** A thread found as a whole: by its counterpart, who it's with, its number's digits or its last preview. */
function threadHit(r: ThreadRow, plan: SearchPlan, key: Key, exact: boolean): SearchHit {
  const p = plan.p;
  const names = [r.person_name, r.visitor_name, r.meta_name, r.meta_username];
  let explained: Pick<SearchHit, 'tier' | 'exact' | 'why'>;
  if (exact)
    explained = {
      tier: 0,
      exact: true,
      why: why(r.counterpart.includes('@') ? 'email' : 'phone'),
    };
  else if (holdsAll(names, p)) explained = { tier: 3, exact: false, why: why('name') };
  else if (p.digits && r.channel === 'sms' && digitsIn(r.counterpart).includes(p.digits))
    explained = { tier: 3, exact: false, why: why('phone') };
  else {
    const field = fieldHolding(wordsLeft(names, p), [
      ...(typedCounterpart(r)
        ? [{ field: r.channel === 'email' ? 'email' : 'phone', text: r.counterpart }]
        : []),
      { field: 'message', text: r.last_preview },
    ]);
    explained =
      field === 'message'
        ? { tier: 4, exact: false, why: why('message', fieldSnippet(r.last_preview, p)) }
        : { tier: 3, exact: false, why: why(field ?? 'name') };
  }
  return hitOf({
    kind: key,
    id: r.conversation_id!,
    title: threadTitle(r.channel, whoOf(r)),
    href: searchHref(plan.workspaceId, { type: 'conversation', id: r.conversation_id! }),
    ...explained,
    badges: threadBadges(r, key, plan.me),
    at: isoOf(r.last_message_at),
    contact: r.person_id
      ? {
          personId: r.person_id,
          phoneE164: r.counterpart.startsWith('+') ? r.counterpart : null,
          email: null,
        }
      : null,
    facts: {
      channel: r.channel,
      who: whoOf(r),
      ...(r.archived_at ? { archivedAt: isoOf(r.archived_at)! } : {}),
    },
  });
}

/** A conversation found by its messages' words: its best message, with how many matched. */
function messageHit(r: MessageRow, plan: SearchPlan, key: Key): SearchHit {
  const at = r.best_at;
  return hitOf({
    kind: key,
    id: r.conversation_id!,
    title: messageTitle(r.channel, r.direction, whoOf(r)),
    href: searchHref(plan.workspaceId, {
      type: 'conversation',
      id: r.conversation_id!,
      messageId: r.best_id,
      at,
    }),
    tier: 4,
    why: why(
      'message',
      stretchSnippet(r.snip, { before: r.snip_cut_before, after: r.snip_cut_after }, plan.p),
    ),
    badges: [...threadBadges(r, key, plan.me), ...(r.automated ? ['automated'] : [])],
    at,
    facts: {
      channel: r.channel,
      direction: r.direction,
      who: whoOf(r),
      matches: Number(r.matches),
    },
  });
}

/** A call found by what was said on it: in its thread, or on its customer's timeline when it has none. */
function callHit(r: CallRow, plan: SearchPlan, key: Key): SearchHit | null {
  const at = r.started_at;
  const href = r.conversation_id
    ? searchHref(plan.workspaceId, {
        type: 'conversation',
        id: r.conversation_id,
        messageId: r.call_id,
        at,
      })
    : r.call_person_id
      ? searchHref(plan.workspaceId, { type: 'person', id: r.call_person_id })
      : null;
  // With neither a thread nor a customer, there's nowhere to open it.
  if (!href) return null;
  return hitOf({
    kind: key,
    id: r.conversation_id ?? r.call_id,
    title: callTitle(whoOf(r)),
    href,
    tier: 4,
    why: why(
      r.is_voicemail ? 'voicemail' : 'call',
      stretchSnippet(r.snip, { before: r.snip_cut_before, after: r.snip_cut_after }, plan.p),
    ),
    badges: [...threadBadges(r, key, plan.me), ...(r.is_voicemail ? ['voicemail'] : [])],
    at,
    facts: { who: whoOf(r), matches: 1 },
  });
}

/**
 * One row per conversation: the best of what found it (the lowest tier; among words, a one-to-one message before an
 * automated one, then the newest), with every message and call that matched counted.
 */
function merged(hits: readonly SearchHit[]): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  const better = (a: SearchHit, b: SearchHit) =>
    a.tier !== b.tier
      ? a.tier < b.tier
      : a.badges.includes('automated') !== b.badges.includes('automated')
        ? !a.badges.includes('automated')
        : Date.parse(a.at ?? '') > Date.parse(b.at ?? '');
  for (const h of hits) {
    const was = byId.get(h.id);
    if (!was) {
      byId.set(h.id, h);
      continue;
    }
    const matches = (was.facts.matches ?? 0) + (h.facts.matches ?? 0);
    const best = better(h, was) ? h : was;
    byId.set(h.id, {
      ...best,
      // A whole thread found by who it's with never says how many messages matched; its count of messages does.
      facts: matches && best.tier === 4 ? { ...best.facts, matches } : best.facts,
    });
  }
  return [...byId.values()];
}

/** The searcher for Messages, or for Spam, which reads the same way, only in the Spam folder. */
function threadsSearcher(key: Key): KindSearcher {
  return {
    key,
    async find(db, plan) {
      const { p } = plan;
      const byName = sql`(${likeAll(folded(NAMES), p.folds)})`;
      const found: SearchHit[] = [];

      // (i) Exact: the counterpart is the phone or the email typed, read through the one-per-line index. A thread a
      // line, so a handful at most: core orders them, and leaves out one that never had a message (as the inbox
      // does), since asking for that here would send the planner down the recency index instead.
      const exacts = [p.phoneE164, p.email].filter((x): x is string => !!x);
      if (exacts.length && !plan.archivedOnly) {
        const rows = await db.rows<ThreadRow>(
          sql`select ${THREAD_COLUMNS} from app.conversations c ${THREAD_NAMES}
              where c.workspace_id = ${plan.workspaceId} and c.counterpart = any(${textArray(exacts)})
                and ${threadRules(plan, key)}
              limit ${plan.limit}`,
        );
        found.push(
          ...rows.filter((r) => r.last_message_at).map((r) => threadHit(r, plan, key, true)),
        );
      }

      // (ii) Who the thread is with, its number's digits, or its last preview, in a window of the newest threads.
      const threads = windowOf(plan, 'threads');
      // A text's number only: the digits inside our own keys (a portal thread's id) mean nothing.
      const digitsArm = p.digits
        ? sql`(c.channel = 'sms' and ${digitsOf(sql`c.counterpart`)} like ${`%${p.digits}%`})`
        : sql`false`;
      const threadRows = await db.rows<ThreadRow & WindowRow>(
        windowed(
          threads,
          sql`select c.last_message_at as at from app.conversations c
              where c.workspace_id = ${plan.workspaceId} and c.last_message_at is not null
                ${threads.before ? sql`and c.last_message_at <= ${threads.before}::timestamptz` : sql``}
              order by c.last_message_at desc nulls last, c.id desc`,
          (inWindow) =>
            sql`select ${THREAD_COLUMNS} from app.conversations c ${THREAD_NAMES}
                where c.workspace_id = ${plan.workspaceId} and ${inWindow(sql`c.last_message_at`)}
                  and (${byName}
                    or ${likeAll(sql`lower(concat_ws(' ', ${NAMES}, ${TYPED_COUNTERPART}, c.last_preview))`, p.likes)}
                    or ${digitsArm})
                  and ${threadRules(plan, key, byName)}
                order by c.last_message_at desc nulls last, c.id desc
                limit ${plan.limit}`,
        ),
      );
      found.push(
        ...threadRows.filter((r) => r.conversation_id).map((r) => threadHit(r, plan, key, false)),
      );
      const reaches = [reachOf(threadRows)];

      // Archived threads are found by who they're with alone; the words inside them stay out of a search.
      if (!plan.archivedOnly && p.likes.length) {
        // (iii) Words in messages, in a window of the newest, grouped by conversation.
        const messages = windowOf(plan, 'messages');
        const messageRows = await db.rows<MessageRow>(
          windowed(
            messages,
            sql`select m.occurred_at as at from app.messages m
                where m.workspace_id = ${plan.workspaceId}
                  ${messages.before ? sql`and m.occurred_at <= ${messages.before}::timestamptz` : sql``}
                order by m.occurred_at desc`,
            (inWindow) =>
              sql`select g.matches, g.best_id, ${isoMicros(sql`bm.occurred_at`)} as best_at, g.automated,
                    bm.direction::text as direction,
                    ${stretchOf(sql`concat_ws(' · ', nullif(bm.subject, ''), bm.body_text)`, p.words[0] ?? null, 'snip')},
                    ${THREAD_COLUMNS}
                  from (
                    select m.conversation_id, count(*)::int as matches,
                      (array_agg(m.id order by (m.campaign_recipient_id is null or m.sent_by is not null) desc,
                        m.occurred_at desc))[1] as best_id,
                      max(m.occurred_at) as at,
                      bool_and(m.campaign_recipient_id is not null and m.sent_by is null) as automated
                    from app.messages m
                    join app.conversations c on c.id = m.conversation_id
                    where m.workspace_id = ${plan.workspaceId} and ${inWindow(sql`m.occurred_at`)}
                      and m.error_code is distinct from ${CANCELLED_TEXT} and m.unsent_at is null
                      and ${likeAll(sql`lower(coalesce(m.subject, '') || ' ' || coalesce(m.body_text, ''))`, p.likes)}
                      and ${threadRules(plan, key)}
                    group by m.conversation_id
                    order by automated, at desc
                    limit ${plan.limit}
                  ) g
                  join app.messages bm on bm.id = g.best_id
                  join app.conversations c on c.id = g.conversation_id
                  ${THREAD_NAMES}`,
          ),
        );
        found.push(
          ...messageRows.filter((r) => r.conversation_id).map((r) => messageHit(r, plan, key)),
        );
        reaches.push(reachOf(messageRows));

        // (iv) Call transcripts, in a window of the newest calls, through their thread when they have one, so the
        // folder, archived, Only mine and record rules apply to calls as to messages.
        const calls = windowOf(plan, 'calls');
        const callMine =
          plan.onlyMine && plan.me
            ? sql`and (c.assignee_user_id = ${plan.me} or c.private_to = ${plan.me}
                or (k.conversation_id is null and (k.placed_by = ${plan.me} or k.answered_by_user_id = ${plan.me})))`
            : sql``;
        const callRows = await db.rows<CallRow>(
          windowed(
            calls,
            sql`select k.started_at as at from app.calls k
                where k.workspace_id = ${plan.workspaceId}
                  ${calls.before ? sql`and k.started_at <= ${calls.before}::timestamptz` : sql``}
                order by k.started_at desc`,
            (inWindow) =>
              sql`select k.id as call_id, k.person_id as call_person_id, k.is_voicemail,
                    ${isoMicros(sql`k.started_at`)} as started_at,
                    ${stretchOf(sql`k.transcript`, p.words[0] ?? null, 'snip')},
                    c.id as conversation_id, c.channel::text as channel,
                    coalesce(c.counterpart, case when k.direction = 'inbound' then k.from_e164 else k.to_e164 end)
                      as counterpart,
                    c.folder::text as folder, c.private_to, c.archived_at, c.last_message_at,
                    nullif(concat_ws(' ', p.first_name, p.last_name), '') as person_name
                  from app.calls k
                  left join app.conversations c on c.id = k.conversation_id
                  left join app.people p on p.id = coalesce(c.person_id, k.person_id) and ${LIVE_PERSON('p')}
                  where k.workspace_id = ${plan.workspaceId} and ${inWindow(sql`k.started_at`)}
                    and k.transcript is not null
                    and ${likeAll(sql`lower(k.transcript)`, p.likes)}
                    -- A call through someone's own cell counts once the customer's phone was answered.
                    and (k.answered_via is distinct from 'bridge' or k.answered_by_user_id is not null)
                    -- A call with a thread follows it; one with none is the Inbox's, never archived or Spam.
                    and ${
                      key === 'spam'
                        ? sql`c.id is not null and ${threadRules(plan, key)}`
                        : sql`(k.conversation_id is null or (c.id is not null and ${threadRules(plan, key)}))`
                    }
                    ${callMine}
                  order by k.started_at desc
                  limit ${plan.limit}`,
          ),
        );
        found.push(
          ...callRows
            .filter((r) => r.call_id)
            .map((r) => callHit(r, plan, key))
            .filter((h): h is SearchHit => !!h),
        );
        reaches.push(reachOf(callRows));
      }

      return [{ kind: key, label: null, icon: null, hits: merged(found), ...reachOfAll(reaches) }];
    },

    async facts(db, _plan, hits) {
      // A whole thread's row says how many messages it holds: "Last one 2 days ago · 14 messages".
      const threads = hits.filter(
        (h) => h.facts.matches === undefined && h.href.includes('/inbox/'),
      );
      if (!threads.length) return [...hits];
      const counts = await db.rows<{ conversation_id: string; n: number }>(
        sql`select m.conversation_id, count(*)::int as n from app.messages m
            where m.conversation_id = any(${uuidArray(threads.map((h) => h.id))})
              and m.error_code is distinct from ${CANCELLED_TEXT}
            group by m.conversation_id`,
      );
      const byId = new Map(counts.map((c) => [c.conversation_id, Number(c.n)]));
      return hits.map((h) =>
        threads.includes(h) ? { ...h, facts: { ...h.facts, messages: byId.get(h.id) ?? 0 } } : h,
      );
    },
  };
}

export const messagesSearcher = threadsSearcher('messages');
export const spamSearcher = threadsSearcher('spam');
