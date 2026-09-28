/**
 * The Assistant's inbox-crm tools (packages/core/src/assistant/tools-inbox-crm.ts): what each does when it runs on its own
 * ("auto"), and the card it shows and the command it runs once the person presses Confirm ("confirm").
 *
 * Everything here reads through the person's own queries and writes through the commands behind the buttons, so a
 * member on a narrowed inbox finds only the threads they're on, and every rule the screen keeps is kept here too:
 * a customer with open work is held back before it's archived, a text that can't go says why before anyone agrees,
 * and a yes to texts is left to the customer, who is the only one who can give it.
 *
 * A card is drafted from what is there now, and commit runs the command with what the model asked for; the command
 * checks everything again, so a card that has gone stale fails in the command's own words rather than doing
 * something nobody saw.
 */
import {
  checkCustomValue,
  customValueText,
  formatClock,
  formatPhone,
  HfosError,
  normalizePhone,
  registry,
  type CustomFieldShape,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, paths, query, quoted, when as at } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };
type Warning = { kind: string; text: string };
type Ref = { id: string; fullName: string } | null;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const idOf = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const action = (args: Args) => String(args['action'] ?? '');
const clip = (s: string | null | undefined, max = 140) =>
  !s ? '' : s.length > max ? `${s.slice(0, max - 1)}…` : s;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nothing = (why = 'Nothing would change.') => HfosError.validation([], why);
const missing = (path: string, message: string) =>
  HfosError.validation([{ path, message }], message);
const recordHref = (ws: string, id: string) => `/app/w/${ws}/customers/records/${id}`;

/**
 * A command's own input check, run while the card is drafted: a phone or an email it would refuse is said now,
 * in its words, instead of after Confirm.
 */
function checkInput(ctx: ToolContext, name: string, input: Args): void {
  const parsed = registry
    .command(name)
    ?.input.safeParse({ ...input, workspaceId: ctx.workspaceId });
  if (!parsed || parsed.success) return;
  const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw HfosError.validation(issues, issues[0]?.message ?? 'Some fields need attention.');
}

const card = (
  toolCallId: string,
  tool: string,
  title: string,
  fields: Field[],
  confirmLabel: string,
  warnings: Warning[] = [],
  result: Args = {},
): PreparedAction => ({
  card: settingsCard(toolCallId, tool, { title, fields, confirmLabel, warnings }),
  result: { waiting: true, ...result },
});

/** A card that can't be confirmed, saying why, the way the screen would refuse it; `next` tells the model what to do. */
const blocked = (
  toolCallId: string,
  tool: string,
  title: string,
  fields: Field[],
  why: string,
  next?: string,
): PreparedAction => ({
  card: settingsCard(toolCallId, tool, {
    title,
    fields,
    confirmLabel: '',
    warnings: [{ kind: 'blocked', text: why }],
  }),
  result: { blocked: true, why, ...(next ? { next } : {}) },
});

interface Members {
  members: { userId: string; fullName: string; email: string }[];
  organizationAdmins?: { userId: string; fullName: string; email: string }[];
}
/** A teammate's name, or null when they aren't in this business. */
async function teammateName(db: Db, ctx: ToolContext, userId: string): Promise<string | null> {
  const team = await query<Members>(db, ctx, 'workspace.members').catch((): Members => ({
    members: [],
  }));
  const found = [...team.members, ...(team.organizationAdmins ?? [])].find(
    (m) => m.userId === userId,
  );
  return found ? found.fullName || found.email : null;
}

// ---------- conversations ----------

interface Conv {
  id: string;
  channel: 'sms' | 'email' | 'chat';
  counterpart: string;
  counterpartDisplay: string;
  status: 'open' | 'snoozed' | 'closed';
  person: { id: string; fullName: string } | null;
  assignee: Ref;
  unreadCount: number;
  lastPreview: string | null;
  lastDirection: 'inbound' | 'outbound' | null;
  awaitingReplySince: string | null;
  snoozedUntil: string | null;
  archived: boolean;
  handledBy: 'none' | 'ai' | 'person';
  teammate: { id: string; name: string } | null;
  needsPersonSince: string | null;
  takenOverBy: Ref;
  sameAs: { id: string; fullName: string } | null;
}
interface ConvGet {
  conversation: Conv;
  person: { smsConsent: 'unknown' | 'opted_in' | 'opted_out' } | null;
  canText: { ok: boolean; reason: string | null };
  quiet: { quiet: boolean; localTime: string; endsAt: string | null };
}
interface ThreadItem {
  type: 'message' | 'call';
  id: string;
  occurredAt: string;
  direction: 'inbound' | 'outbound';
  status: string;
  channel: 'sms' | 'email' | 'chat' | null;
  body: string | null;
  subject: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  scheduledFor: string | null;
}

const CHANNEL: Record<string, string> = { sms: 'Texts', email: 'Email', chat: 'Website chat' };
const STATUS: Record<string, string> = { open: 'Open', snoozed: 'Snoozed', closed: 'Closed' };
const DAY_MS = 86_400_000;

const conversationOf = (db: Db, ctx: ToolContext, conversationId: unknown) =>
  query<ConvGet>(db, ctx, 'conversation.get', { conversationId });
const withWhom = (c: Conv) => c.person?.fullName ?? c.counterpartDisplay;
const answeredBy = (c: Conv) =>
  c.handledBy === 'ai'
    ? `${c.teammate?.name ?? 'The AI teammate'} (AI)`
    : c.needsPersonSince
      ? 'Waiting for a person'
      : c.handledBy === 'person'
        ? (c.takenOverBy?.fullName ?? 'A person')
        : 'Nobody in particular';
const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
/** A message that didn't go out: failed or undelivered (a cancelled text never shows in the thread). */
const didNotGo = (m: ThreadItem) =>
  m.type === 'message' &&
  m.direction === 'outbound' &&
  (m.status === 'failed' || m.status === 'undelivered');
/** Why a text can't go from this conversation, as the composer says it; null when it can. */
const cannotText = (reason: string | null): string | null =>
  reason === 'no_number'
    ? 'There’s no business number to text from yet.'
    : reason === 'not_ready'
      ? 'Texting turns on when the carriers approve your registration.'
      : reason === 'opted_out'
        ? 'They asked not to be texted. They can text START to get texts again.'
        : null;

async function findConversations(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const { items } = await query<{ items: Conv[] }>(
    db,
    ctx,
    'inbox.list',
    defined({
      box: args['box'] ?? 'all',
      status: args['status'] ?? 'open',
      q: str(args['query']),
      personId: idOf(args['personId']),
      channel: str(args['channel']),
      limit: Number(args['limit'] ?? 10) || 10,
    }),
  );
  const p = paths(ctx.workspaceId);
  return {
    result: {
      conversations: items.map((c) => ({
        id: c.id,
        with: withWhom(c),
        personId: c.person?.id ?? null,
        ...(c.person
          ? {}
          : {
              looksLike: c.sameAs ? { personId: c.sameAs.id, name: c.sameAs.fullName } : null,
            }),
        channel: c.channel,
        status: c.status,
        ...(c.status === 'snoozed' && c.snoozedUntil
          ? { snoozedUntil: at(c.snoozedUntil, ctx.timezone) }
          : {}),
        archived: c.archived,
        assignee: c.assignee?.fullName ?? null,
        answeredBy: answeredBy(c),
        unread: c.unreadCount,
        waitingMinutes: c.awaitingReplySince ? minutesSince(c.awaitingReplySince) : null,
        lastMessage: c.lastDirection === 'inbound' ? quoted(c.lastPreview) : c.lastPreview,
      })),
      ...(items.length ? {} : { note: 'No conversations match.' }),
    },
    card: items.length
      ? {
          type: 'list',
          title: count(items.length, 'conversation'),
          items: items.slice(0, 12).map((c) => ({
            title: withWhom(c),
            detail: [
              CHANNEL[c.channel],
              c.archived ? 'Archived' : STATUS[c.status],
              clip(c.lastPreview, 80),
            ]
              .filter(Boolean)
              .join(' · '),
            tone: c.unreadCount > 0 ? 'accent' : 'muted',
            href: p.conversation(c.id),
          })),
        }
      : null,
  };
}

async function unsentMessages(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const conversationId = String(args['conversationId']);
  const [{ conversation: c }, thread] = await Promise.all([
    conversationOf(db, ctx, conversationId),
    query<{ items: ThreadItem[] }>(db, ctx, 'conversation.thread', { conversationId, limit: 100 }),
  ]);
  const held = thread.items.filter((m) => m.type === 'message' && m.scheduledFor);
  const failed = thread.items.filter(didNotGo);
  return {
    result: {
      conversationId,
      with: withWhom(c),
      waitingForQuietHours: held.map((m) => ({
        messageId: m.id,
        goesAt: at(m.scheduledFor, ctx.timezone),
        text: clip(m.body, 300),
      })),
      didNotGo: failed.map((m) => ({
        messageId: m.id,
        at: at(m.occurredAt, ctx.timezone),
        channel: m.channel,
        ...(m.subject ? { subject: m.subject } : {}),
        text: clip(m.body, 300),
        why: m.errorMessage ?? 'It wasn’t delivered, and nothing said why.',
      })),
      ...(held.length || failed.length
        ? {}
        : { note: 'Nothing is waiting for quiet hours, and everything lately went out.' }),
    },
  };
}

const manageConversation: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const got = await conversationOf(db, ctx, args['conversationId']);
    const c = got.conversation;
    const who = withWhom(c);
    const line: Field = { label: 'Conversation', value: `${who} · ${CHANNEL[c.channel]}` };
    const draft = (title: string, fields: Field[], confirmLabel: string, warnings?: Warning[]) =>
      card(toolCallId, 'manage_conversation', title, [line, ...fields], confirmLabel, warnings, {
        action: act,
        with: who,
      });
    const stop = (title: string, why: string, next?: string) =>
      blocked(toolCallId, 'manage_conversation', title, [line], why, next);
    switch (act) {
      case 'assign': {
        if (args['assigneeUserId'] === undefined)
          throw missing(
            'assigneeUserId',
            'Say who to give it to (a teammate from list_team), or null for nobody.',
          );
        const to = idOf(args['assigneeUserId']) ?? null;
        const name = to ? await teammateName(db, ctx, to) : null;
        if (to && !name)
          throw missing('assigneeUserId', 'Pick someone on the team: list_team has them.');
        if ((c.assignee?.id ?? null) === to)
          throw nothing(name ? `It’s assigned to ${name} already.` : 'It’s unassigned already.');
        return draft(
          name
            ? `Give the conversation with ${who} to ${name}?`
            : `Unassign the conversation with ${who}?`,
          [
            { label: 'Assigned to', value: name ?? 'Nobody, for anyone to pick up' },
            { label: 'Was', value: c.assignee?.fullName ?? 'Nobody' },
          ],
          name ? 'Assign it' : 'Unassign it',
        );
      }
      case 'close':
        if (c.status === 'closed') throw nothing('It’s closed already.');
        return draft(
          `Close the conversation with ${who}?`,
          [{ label: 'Was', value: STATUS[c.status] ?? c.status }],
          'Close it',
          [
            ...(c.awaitingReplySince
              ? [
                  {
                    kind: 'caution',
                    text: 'They’re waiting on a reply, and closing it doesn’t send one.',
                  },
                ]
              : []),
            { kind: 'note', text: 'It opens again if they write.' },
          ],
        );
      case 'reopen':
        if (c.status === 'open') throw nothing('It’s open already.');
        return draft(
          `Reopen the conversation with ${who}?`,
          [
            {
              label: 'Was',
              value:
                c.status === 'snoozed' && c.snoozedUntil
                  ? `Snoozed until ${at(c.snoozedUntil, ctx.timezone)}`
                  : (STATUS[c.status] ?? c.status),
            },
          ],
          'Reopen it',
        );
      case 'snooze': {
        const until = str(args['until']);
        if (!until) throw missing('until', 'Say when it should come back.');
        const t = Date.parse(until);
        if (!(t > Date.now() + 60_000)) throw missing('until', 'Pick a time in the future.');
        if (t > Date.now() + 90 * DAY_MS) throw missing('until', 'Snooze for 90 days at most.');
        return draft(
          `Snooze the conversation with ${who}?`,
          [
            { label: 'Comes back', value: at(until, ctx.timezone) },
            { label: 'Was', value: STATUS[c.status] ?? c.status },
          ],
          'Snooze it',
          [{ kind: 'note', text: 'It comes back then, or sooner if they write.' }],
        );
      }
      case 'mark_read':
        if (c.unreadCount === 0) throw nothing('Nothing in it is unread.');
        return draft(
          `Mark the conversation with ${who} read?`,
          [{ label: 'Unread now', value: count(c.unreadCount, 'message') }],
          'Mark it read',
          [{ kind: 'note', text: 'It’s marked read for the whole team.' }],
        );
      case 'mark_unread':
        if (c.unreadCount > 0) throw nothing('It’s unread already.');
        return draft(`Mark the conversation with ${who} unread?`, [], 'Mark it unread', [
          { kind: 'note', text: 'It stands out in the inbox again, for the whole team.' },
        ]);
      case 'hand_to_ai': {
        const { teammate } = await query<{
          teammate: {
            id: string;
            name: string;
            status: 'off' | 'training' | 'automatic';
            config: { channels?: Partial<Record<string, boolean>> };
          } | null;
        }>(db, ctx, 'ai_teammate.get');
        const title = `Hand the conversation with ${who} to your AI teammate?`;
        // The same refusals the command makes, said before anyone agrees.
        if (!teammate)
          return stop(title, 'There’s no AI teammate yet. Set one up in Settings → AI teammate.');
        if (teammate.status === 'off')
          return stop(title, `Turn ${teammate.name} on first, in Settings → AI teammate.`);
        const on = teammate.config.channels?.[c.channel] ?? (c.channel === 'chat' ? false : true);
        if (!on)
          return stop(
            title,
            `${teammate.name} doesn’t answer ${CHANNEL[c.channel]?.toLowerCase()}. Turn that on in its settings first.`,
          );
        if (c.handledBy === 'ai' && c.teammate?.id === teammate.id)
          throw nothing(`${teammate.name} has it already.`);
        return draft(
          `Hand the conversation with ${who} to ${teammate.name}?`,
          [
            { label: 'Answered by', value: `${teammate.name} (AI)` },
            { label: 'Was', value: answeredBy(c) },
          ],
          'Hand it over',
          [
            teammate.status === 'automatic'
              ? {
                  kind: 'caution',
                  text: `${teammate.name} answers ${who} on its own, starting with anything waiting.`,
                }
              : {
                  kind: 'note',
                  text: `${teammate.name} is still in training, so its replies wait for your OK before they go.`,
                },
          ],
        );
      }
      case 'take_over': {
        if (
          c.handledBy === 'person' &&
          c.takenOverBy?.id === ctx.actor.userId &&
          !c.needsPersonSince
        )
          throw nothing('You have it already.');
        return draft(
          `Take the conversation with ${who}?`,
          [
            { label: 'Answered by', value: 'You' },
            { label: 'Was', value: answeredBy(c) },
          ],
          'Take it',
          [
            {
              kind: 'note',
              text: c.teammate
                ? `${c.teammate.name} stays quiet here until someone hands it back, and any reply it had waiting is dropped.`
                : 'The AI teammate leaves it to you until someone hands it back.',
            },
          ],
        );
      }
      case 'link_customer': {
        const personId = idOf(args['personId']);
        if (!personId) throw missing('personId', 'Say which customer it is (search_customers).');
        const { person } = await query<{
          person: {
            fullName: string;
            phoneE164: string | null;
            email: string | null;
            otherPhones: { phoneE164: string }[];
            otherEmails: { email: string }[];
            archivedAt: string | null;
          };
        }>(db, ctx, 'person.get', { personId });
        const title = `Link ${c.counterpartDisplay} to ${person.fullName}?`;
        const fields: Field[] = [
          { label: 'Conversation', value: `${c.counterpartDisplay} · ${CHANNEL[c.channel]}` },
          { label: 'Customer', value: person.fullName },
        ];
        if (person.archivedAt)
          return blocked(
            toolCallId,
            'manage_conversation',
            title,
            fields,
            `${person.fullName} is archived. Bring them back first (archive_or_restore).`,
          );
        if (c.person?.id === personId) throw nothing(`It’s linked to ${person.fullName} already.`);
        // What linking adds to their record: this number or address, as their main one or beside it.
        const e164 = c.channel === 'sms' ? normalizePhone(c.counterpart) : null;
        const addr = c.channel === 'email' ? c.counterpart.toLowerCase() : null;
        const added =
          c.channel === 'sms'
            ? !person.phoneE164
              ? `${c.counterpartDisplay} becomes their phone number.`
              : e164 &&
                  e164 !== person.phoneE164 &&
                  !person.otherPhones.some((o) => o.phoneE164 === e164)
                ? `${c.counterpartDisplay} is added to their other numbers.`
                : null
            : c.channel === 'email'
              ? !person.email
                ? `${c.counterpartDisplay} becomes their email.`
                : addr &&
                    addr !== person.email.toLowerCase() &&
                    !person.otherEmails.some((o) => o.email.toLowerCase() === addr)
                  ? `${c.counterpartDisplay} is added to their other emails.`
                  : null
              : null;
        return card(
          toolCallId,
          'manage_conversation',
          title,
          [...fields, ...(c.person ? [{ label: 'Was', value: c.person.fullName }] : [])],
          'Link them',
          [
            { kind: 'note', text: 'Earlier messages and calls join their timeline.' },
            ...(added ? [{ kind: 'note', text: added }] : []),
          ],
          { action: act, with: c.counterpartDisplay, customer: person.fullName },
        );
      }
      case 'cancel_held_text':
      case 'send_again': {
        const messageId = idOf(args['messageId']);
        if (!messageId)
          throw missing(
            'messageId',
            'Say which message: unsent_messages lists them with their ids.',
          );
        const {
          message: m,
          conversationId,
          triedAgain,
        } = await query<{
          message: ThreadItem;
          conversationId: string;
          triedAgain: boolean;
        }>(db, ctx, 'message.get', { messageId });
        if (conversationId !== c.id)
          throw missing('messageId', 'That message isn’t in this conversation.');
        if (act === 'cancel_held_text') {
          if (m.errorCode === 'cancelled') throw nothing('That text is cancelled already.');
          if (didNotGo(m))
            throw nothing(
              'That text isn’t waiting to go. It didn’t go, and goes only if sent again.',
            );
          if (!m.scheduledFor)
            throw HfosError.rule(
              'not_scheduled',
              409,
              'That text isn’t waiting any more: it already went, so it can’t be cancelled.',
            );
          return draft(
            `Cancel the text to ${who}?`,
            [
              { label: 'Was going at', value: at(m.scheduledFor, ctx.timezone) },
              { label: 'Text', value: clip(m.body) },
            ],
            'Don’t send it',
            [
              {
                kind: 'note',
                // A failed text sent again goes back to how it was; a new one never went at all.
                text: triedAgain
                  ? 'It doesn’t go. It stays in the conversation as not delivered, and you can send it again later.'
                  : 'It never goes, and leaves the conversation.',
              },
            ],
          );
        }
        if (!didNotGo(m))
          throw HfosError.rule(
            'message_not_failed',
            409,
            'Only a message that didn’t go out can be sent again.',
          );
        const email = m.channel === 'email';
        const fields: Field[] = [
          ...(email && m.subject ? [{ label: 'Subject', value: m.subject }] : []),
          { label: email ? 'Email' : 'Text', value: clip(m.body) },
          { label: 'Didn’t go because', value: m.errorMessage ?? 'Nothing said why' },
        ];
        const title = `Send this ${email ? 'email' : 'text'} to ${who} again?`;
        const cant = email ? null : cannotText(got.canText.reason);
        if (cant) return stop(title, cant);
        // In quiet hours a text tried again waits for them to end (message.retry), like any held text.
        return draft(title, fields, 'Send it again', [
          !email && got.quiet.quiet && got.quiet.endsAt
            ? {
                kind: 'quiet_hours',
                text: `It’s ${formatClock(got.quiet.localTime)} where the business is, in quiet hours. It goes to ${who} when they end, at ${formatClock(got.quiet.endsAt)}, and you can cancel it until then.`,
              }
            : { kind: 'caution', text: `It goes to ${who} now.` },
        ]);
      }
      default:
        throw missing('action', 'Pick what to do with the conversation.');
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const conversationId = String(args['conversationId']);
    const href = paths(ctx.workspaceId).conversation(conversationId);
    const run = <T = { notApplied?: string[] }>(name: string, input: Args = {}) =>
      command<T>(db, ctx, name, { conversationId, ...input });
    // A close or snooze someone overtook (they wrote in since) leaves it open, and says so.
    const kept = (out: { notApplied?: string[] }) => !!out.notApplied?.includes('status');
    switch (act) {
      case 'assign': {
        const to = idOf(args['assigneeUserId']) ?? null;
        await run('conversation.assign', { assigneeUserId: to });
        return {
          outcome: to ? 'Assigned' : 'Unassigned',
          href,
          command: 'conversation.assign',
        };
      }
      case 'close': {
        const out = await run('conversation.close');
        return {
          outcome: kept(out) ? 'Left open: they wrote again since' : 'Closed',
          href,
          command: 'conversation.close',
        };
      }
      case 'reopen':
        await run('conversation.reopen');
        return { outcome: 'Reopened', href, command: 'conversation.reopen' };
      case 'snooze': {
        const out = await run('conversation.snooze', { until: args['until'] });
        return {
          outcome: kept(out)
            ? 'Left open: they wrote again since'
            : `Snoozed until ${at(String(args['until']), ctx.timezone)}`,
          href,
          command: 'conversation.snooze',
        };
      }
      case 'mark_read':
        await run('conversation.mark_read');
        return { outcome: 'Marked read', href, command: 'conversation.mark_read' };
      case 'mark_unread':
        await run('conversation.mark_unread');
        return { outcome: 'Marked unread', href, command: 'conversation.mark_unread' };
      case 'hand_to_ai':
        await run('conversation.hand_to_ai');
        return { outcome: 'Handed to your AI teammate', href, command: 'conversation.hand_to_ai' };
      case 'take_over':
        await run('conversation.take_over');
        return { outcome: 'It’s yours', href, command: 'conversation.take_over' };
      case 'link_customer': {
        const personId = String(args['personId']);
        await run('conversation.link_person', { personId });
        return {
          outcome: 'Linked',
          href: paths(ctx.workspaceId).person(personId),
          command: 'conversation.link_person',
        };
      }
      case 'cancel_held_text':
      case 'send_again': {
        // Only ever a message in the conversation the card was about.
        const { conversationId: on } = await query<{ conversationId: string }>(
          db,
          ctx,
          'message.get',
          { messageId: args['messageId'] },
        );
        if (on !== conversationId)
          throw missing('messageId', 'That message isn’t in this conversation.');
        const name = act === 'send_again' ? 'message.retry' : 'message.cancel_scheduled';
        const out = await command<{ scheduledFor?: string; stays?: boolean }>(db, ctx, name, {
          messageId: args['messageId'],
        });
        return {
          outcome:
            act !== 'send_again'
              ? out.stays
                ? 'It won’t go. It’s back as not delivered.'
                : 'It won’t go'
              : out.scheduledFor
                ? `It goes when quiet hours end: ${at(out.scheduledFor, ctx.timezone)}`
                : 'Sending it again',
          href,
          command: name,
        };
      }
      default:
        throw missing('action', 'Pick what to do with the conversation.');
    }
  },
};

// ---------- archiving anything, and bringing it back ----------

type Archivable = 'customer' | 'company' | 'lead' | 'conversation' | 'record';

interface PersonGet {
  person: {
    id: string;
    fullName: string;
    phone: string | null;
    archivedAt: string | null;
    openLeads: number;
    owner: Ref;
    team: { id: string; fullName: string }[];
    callConsent: { consent: 'unknown' | 'opted_in' | 'opted_out'; source: string | null };
  };
}
interface CompanyGet {
  company: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    phoneE164: string | null;
    website: string | null;
    address: Record<string, string | null>;
    notes: string | null;
    source: string | null;
    archivedAt: string | null;
    openLeads: number;
    owner: Ref;
    team: { id: string; fullName: string }[];
  };
}
interface LeadGet {
  lead: {
    title: string;
    stageName: string;
    archivedAt: string | null;
    person: { fullName: string } | null;
    company: { name: string } | null;
  };
}
interface RecordType {
  id: string;
  singular: string;
  plural: string;
  archived: boolean;
}
interface RecordGet {
  record: {
    id: string;
    name: string;
    notes: string | null;
    custom: Record<string, unknown>;
    type: RecordType;
    archivedAt: string | null;
  };
}

/** What is being archived or brought back, as the card names it. */
interface Subject {
  /** "Bob Smith", "the lead “Kitchen remodel”", "the conversation with Bob Smith". */
  readonly title: string;
  readonly fields: Field[];
  readonly archived: boolean;
  readonly openLeads: number;
  readonly openTasks: number;
  /** Where it goes, and where it comes back from, in the screen's words. */
  readonly away: string;
  readonly back: string;
  /** Why it can't come back yet (its kind is archived). */
  readonly cantRestore?: string;
  readonly href: string;
}

const openTasks = async (db: Db, ctx: ToolContext, filter: Args) =>
  (
    await query<{ items: unknown[] }>(db, ctx, 'task.list', {
      scope: 'all',
      status: 'open',
      limit: 100,
      ...filter,
    })
  ).items.length;

async function subjectOf(db: Db, ctx: ToolContext, what: Archivable, id: string): Promise<Subject> {
  const p = paths(ctx.workspaceId);
  switch (what) {
    case 'customer': {
      const { person } = await query<PersonGet>(db, ctx, 'person.get', { personId: id });
      return {
        title: person.fullName,
        fields: [{ label: 'Customer', value: person.fullName }],
        archived: !!person.archivedAt,
        openLeads: person.openLeads,
        openTasks: person.archivedAt ? 0 : await openTasks(db, ctx, { personId: id }),
        away: 'They leave Customers and searches but keep their history. Bring them back any time: Customers, Show archived.',
        back: 'They come back to Customers and searches, and can go on new leads again.',
        href: p.person(id),
      };
    }
    case 'company': {
      const { company } = await query<CompanyGet>(db, ctx, 'company.get', { companyId: id });
      return {
        title: company.name,
        fields: [{ label: 'Company', value: company.name }],
        archived: !!company.archivedAt,
        openLeads: company.openLeads,
        openTasks: company.archivedAt ? 0 : await openTasks(db, ctx, { companyId: id }),
        away: 'It leaves Customers and searches but keeps its history. Bring it back any time: Customers → Companies, Show archived.',
        back: 'It comes back to Customers and searches.',
        href: p.company(id),
      };
    }
    case 'lead': {
      const { lead } = await query<LeadGet>(db, ctx, 'lead.get', { leadId: id });
      return {
        title: `the lead “${lead.title}”`,
        fields: [
          { label: 'Lead', value: lead.title },
          { label: 'Customer', value: lead.person?.fullName ?? lead.company?.name ?? '' },
          { label: 'Stage', value: lead.stageName },
        ],
        archived: !!lead.archivedAt,
        openLeads: 0,
        openTasks: 0,
        away: 'It leaves the pipeline but keeps its history, and can be brought back.',
        back: `It goes back to ${lead.stageName}.`,
        href: p.lead(id),
      };
    }
    case 'conversation': {
      const { conversation: c } = await conversationOf(db, ctx, id);
      return {
        title: `the conversation with ${withWhom(c)}`,
        fields: [{ label: 'Conversation', value: `${withWhom(c)} · ${CHANNEL[c.channel]}` }],
        archived: c.archived,
        openLeads: 0,
        openTasks: 0,
        away: 'It leaves the inbox; its messages and calls stay. Bring it back any time: Inbox, Archived.',
        back: 'It comes back to the inbox as it was when it was put away.',
        href: p.conversation(id),
      };
    }
    case 'record': {
      const { record } = await query<RecordGet>(db, ctx, 'custom_record.get', {
        customRecordId: id,
      });
      return {
        title: record.name,
        fields: [
          { label: record.type.singular, value: record.name },
          { label: 'Kind', value: record.type.plural },
        ],
        archived: !!record.archivedAt,
        openLeads: 0,
        openTasks: 0,
        away: `It leaves ${record.type.plural} and searches; its history, tasks, files and relationships stay.`,
        back: `It comes back to ${record.type.plural}.`,
        ...(record.type.archived
          ? {
              cantRestore: `${record.type.plural} are archived. Restore them in Settings → Relationships first.`,
            }
          : {}),
        href: recordHref(ctx.workspaceId, id),
      };
    }
  }
}

const ARCHIVE_COMMANDS: Record<Archivable, { archive: string; restore: string; key: string }> = {
  customer: { archive: 'person.archive', restore: 'person.restore', key: 'personId' },
  company: { archive: 'company.archive', restore: 'company.restore', key: 'companyId' },
  lead: { archive: 'lead.archive', restore: 'lead.restore', key: 'leadId' },
  conversation: {
    archive: 'conversation.archive',
    restore: 'conversation.restore',
    key: 'conversationId',
  },
  record: {
    archive: 'custom_record.archive',
    restore: 'custom_record.restore',
    key: 'customRecordId',
  },
};

const archiveOrRestore: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const what = String(args['what']) as Archivable;
    const s = await subjectOf(db, ctx, what, String(args['id']));
    const tool = 'archive_or_restore';
    if (act === 'restore') {
      if (!s.archived) throw nothing(`${s.title} isn’t archived.`);
      const title = `Bring back ${s.title}?`;
      if (s.cantRestore) return blocked(toolCallId, tool, title, s.fields, s.cantRestore);
      return card(toolCallId, tool, title, s.fields, 'Bring it back', [
        { kind: 'note', text: s.back },
      ]);
    }
    if (s.archived) throw nothing(`${s.title} is archived already.`);
    const open = s.openLeads + s.openTasks;
    const work: Field[] = [
      ...(s.openLeads ? [{ label: 'Open leads', value: String(s.openLeads) }] : []),
      ...(s.openTasks ? [{ label: 'Open tasks', value: String(s.openTasks) }] : []),
    ];
    // The screen refuses the first try while there is open work and asks again; so does this.
    if (open && args['archiveOpenLeads'] !== true)
      return blocked(
        toolCallId,
        tool,
        `${s.title} still has open work`,
        [...s.fields, ...work],
        'Archiving anyway also archives the open leads. Open tasks stay on the list.',
        'Say what is open. If they still want it archived, call archive_or_restore again with archiveOpenLeads: true.',
      );
    return card(
      toolCallId,
      tool,
      open ? `Archive ${s.title} anyway?` : `Archive ${s.title}?`,
      [
        ...s.fields,
        ...(s.openLeads ? [{ label: 'Open leads', value: `${s.openLeads}, archived too` }] : []),
        ...(s.openTasks ? [{ label: 'Open tasks', value: `${s.openTasks}, stay open` }] : []),
      ],
      open ? 'Archive anyway' : 'Archive it',
      [
        ...(s.openLeads
          ? [
              {
                kind: 'caution',
                text:
                  s.openLeads === 1
                    ? 'The open lead is archived too.'
                    : `The ${s.openLeads} open leads are archived too.`,
              },
            ]
          : []),
        { kind: 'note', text: s.away },
      ],
    );
  },

  async commit(db, ctx, args) {
    const act = action(args) === 'restore' ? 'restore' : 'archive';
    const what = String(args['what']) as Archivable;
    const id = String(args['id']);
    const c = ARCHIVE_COMMANDS[what];
    const name = c[act];
    const force =
      act === 'archive' && (what === 'customer' || what === 'company')
        ? { force: args['archiveOpenLeads'] === true }
        : {};
    const out = await command<{ archivedLeads?: number }>(db, ctx, name, { [c.key]: id, ...force });
    const p = paths(ctx.workspaceId);
    const href =
      what === 'customer'
        ? p.person(id)
        : what === 'company'
          ? p.company(id)
          : what === 'lead'
            ? p.lead(id)
            : what === 'conversation'
              ? p.conversation(id)
              : recordHref(ctx.workspaceId, id);
    return {
      outcome:
        act === 'restore'
          ? 'Brought back'
          : out.archivedLeads
            ? `Archived, with ${count(out.archivedLeads, 'open lead')}`
            : 'Archived',
      href,
      command: name,
    };
  },
};

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
/** Up to three pages of a list, keeping the archived ones: the lists don't filter to archived only. */
async function archivedIn<T extends { archivedAt: string | null }>(
  db: Db,
  ctx: ToolContext,
  name: string,
  input: Args,
): Promise<{ items: T[]; more: boolean }> {
  const found: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 3; i++) {
    const page = await query<Page<T>>(db, ctx, name, {
      ...input,
      includeArchived: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.items.filter((x) => x.archivedAt));
    if (!page.nextCursor || found.length >= 20) return { items: found.slice(0, 20), more: false };
    cursor = page.nextCursor;
  }
  return { items: found.slice(0, 20), more: true };
}

async function findArchived(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const what = str(args['what']);
  const q = str(args['query']);
  const want = (k: string) => !what || what === k;
  const none = { items: [], more: false };
  const [people, companies, leads, records, kinds] = await Promise.all([
    want('customer')
      ? archivedIn<{ id: string; fullName: string; archivedAt: string | null }>(
          db,
          ctx,
          'person.list',
          defined({ q, sort: 'recent' }),
        )
      : none,
    want('company')
      ? archivedIn<{ id: string; name: string; archivedAt: string | null }>(
          db,
          ctx,
          'company.list',
          defined({ q }),
        )
      : none,
    want('lead')
      ? archivedIn<{
          id: string;
          title: string;
          archivedAt: string | null;
          person: { fullName: string } | null;
          company: { name: string } | null;
        }>(db, ctx, 'lead.list', defined({ q }))
      : none,
    want('record')
      ? archivedIn<{ id: string; name: string; typeId: string; archivedAt: string | null }>(
          db,
          ctx,
          'custom_record.list',
          defined({ q }),
        )
      : none,
    want('record')
      ? query<{ types: RecordType[] }>(db, ctx, 'custom_record_type.list')
      : { types: [] as RecordType[] },
  ]);
  const kindName = new Map(kinds.types.map((k) => [k.id, k.singular]));
  const on = (iso: string | null) => at(iso, ctx.timezone);
  const p = paths(ctx.workspaceId);
  const rows = [
    ...people.items.map((x) => ({ title: x.fullName, detail: 'Customer', href: p.person(x.id) })),
    ...companies.items.map((x) => ({ title: x.name, detail: 'Company', href: p.company(x.id) })),
    ...leads.items.map((x) => ({ title: x.title, detail: 'Lead', href: p.lead(x.id) })),
    ...records.items.map((x) => ({
      title: x.name,
      detail: kindName.get(x.typeId) ?? 'Record',
      href: recordHref(ctx.workspaceId, x.id),
    })),
  ];
  const more = people.more || companies.more || leads.more || records.more;
  return {
    result: {
      ...(want('customer')
        ? {
            customers: people.items.map((x) => ({
              id: x.id,
              name: x.fullName,
              archived: on(x.archivedAt),
            })),
          }
        : {}),
      ...(want('company')
        ? {
            companies: companies.items.map((x) => ({
              id: x.id,
              name: x.name,
              archived: on(x.archivedAt),
            })),
          }
        : {}),
      ...(want('lead')
        ? {
            leads: leads.items.map((x) => ({
              id: x.id,
              title: x.title,
              customer: x.person?.fullName ?? x.company?.name ?? null,
              archived: on(x.archivedAt),
            })),
          }
        : {}),
      ...(want('record')
        ? {
            records: records.items.map((x) => ({
              id: x.id,
              name: x.name,
              kind: kindName.get(x.typeId) ?? null,
              archived: on(x.archivedAt),
            })),
          }
        : {}),
      ...(rows.length ? {} : { note: 'Nothing archived matches.' }),
      ...(more
        ? { note: 'Only the first few hundred were looked through: search by name to find one.' }
        : {}),
    },
    card: rows.length
      ? {
          type: 'list',
          title: `Archived: ${count(rows.length, 'match', 'matches')}`,
          items: rows.slice(0, 12).map((r) => ({ ...r, tone: 'muted' as const })),
        }
      : null,
  };
}

// ---------- companies ----------

const ADDRESS_PARTS = [
  ['line1', 'Street'],
  ['line2', 'Street, line 2'],
  ['city', 'City'],
  ['state', 'State'],
  ['postalCode', 'ZIP code'],
] as const;
type Address = Partial<Record<(typeof ADDRESS_PARTS)[number][0], string | null>>;

/** A company's details as the command takes them: only what was said, null to take one off. */
function companyInput(args: Args): Args {
  const address = (args['address'] ?? undefined) as Address | undefined;
  const text = (v: unknown) => (v === null ? null : str(v));
  return defined({
    name: str(args['name']),
    phone: text(args['phone']),
    email: text(args['email']),
    website: text(args['website']),
    notes: text(args['notes']),
    source: text(args['source']),
    ...(address && Object.values(address).some((v) => v !== undefined)
      ? {
          address: defined(Object.fromEntries(ADDRESS_PARTS.map(([k]) => [k, text(address[k])]))),
        }
      : {}),
  });
}

const manageCompany: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const input = companyInput(args);
    const address = (input['address'] ?? {}) as Address;
    const phone = typeof input['phone'] === 'string' ? normalizePhone(input['phone']) : null;
    if (act === 'create') {
      const name = str(args['name']);
      if (!name) throw missing('name', 'Give the company a name.');
      checkInput(ctx, 'company.create', input);
      const { matches } = await query<{ matches: { name: string; matchedOn: string }[] }>(
        db,
        ctx,
        'crm.find_matches',
        {
          kind: 'company',
          name,
          phone: str(args['phone']) ?? null,
          email: str(args['email']) ?? null,
        },
      );
      const where = ADDRESS_PARTS.map(([k]) => address[k])
        .filter(Boolean)
        .join(', ');
      return card(
        toolCallId,
        'manage_company',
        `Add ${name} as a company?`,
        [
          { label: 'Company', value: name },
          { label: 'Phone', value: phone ? formatPhone(phone) : '' },
          { label: 'Email', value: str(args['email']) ?? '' },
          { label: 'Website', value: str(args['website']) ?? '' },
          { label: 'Address', value: where },
          { label: 'Source', value: str(args['source']) ?? '' },
          { label: 'Notes', value: clip(str(args['notes'])) },
        ],
        matches.length ? 'Add anyway' : 'Add company',
        matches.slice(0, 3).map((m) => ({
          kind: 'duplicate',
          text: `${m.name} already has this ${m.matchedOn}. It may be the same company.`,
        })),
        { possibleDuplicates: matches.map((m) => m.name) },
      );
    }
    const companyId = idOf(args['companyId']);
    if (!companyId) throw missing('companyId', 'Say which company (search_customers).');
    checkInput(ctx, 'company.update', { companyId, ...input });
    const { company } = await query<CompanyGet>(db, ctx, 'company.get', { companyId });
    const changes: Field[] = [];
    const change = (label: string, next: unknown, was: string | null, same: boolean) => {
      if (next === undefined || same) return;
      const now = next === null ? 'Taken off' : String(next);
      changes.push({ label, value: was ? `${now} (was ${was})` : now });
    };
    const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
    change('Name', input['name'], company.name, input['name'] === company.name);
    change(
      'Phone',
      phone ? formatPhone(phone) : input['phone'],
      company.phone,
      input['phone'] === null ? !company.phoneE164 : phone === company.phoneE164,
    );
    change(
      'Email',
      input['email'],
      company.email,
      (lower(input['email']) ?? null) === (company.email?.toLowerCase() ?? null),
    );
    change(
      'Website',
      input['website'],
      company.website,
      (input['website'] ?? null) === company.website,
    );
    for (const [k, label] of ADDRESS_PARTS)
      change(
        label,
        address[k],
        company.address[k] ?? null,
        (address[k] ?? null) === (company.address[k] ?? null),
      );
    change('Source', input['source'], company.source, (input['source'] ?? null) === company.source);
    change(
      'Notes',
      input['notes'] === undefined || input['notes'] === null
        ? input['notes']
        : clip(String(input['notes'])),
      null,
      (input['notes'] ?? null) === company.notes,
    );
    if (!changes.length) throw nothing();
    return card(
      toolCallId,
      'manage_company',
      `Change ${company.name}?`,
      changes,
      'Save the change',
      [],
      { changes: changes.map((f) => f.label) },
    );
  },

  async commit(db, ctx, args) {
    const input = companyInput(args);
    if (action(args) === 'create') {
      const { companyId } = await command<{ companyId: string }>(db, ctx, 'company.create', {
        ...input,
        ignoreDuplicates: true,
      });
      return {
        outcome: `Added ${String(input['name'])} to Customers`,
        href: paths(ctx.workspaceId).company(companyId),
        command: 'company.create',
      };
    }
    const companyId = String(args['companyId']);
    await command(db, ctx, 'company.update', { companyId, ...input });
    return {
      outcome: 'Saved',
      href: paths(ctx.workspaceId).company(companyId),
      command: 'company.update',
    };
  },
};

// ---------- who looks after a customer ----------

const assignCustomer: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const recordType = args['recordType'] === 'company' ? 'company' : 'person';
    const recordId = String(args['recordId']);
    const userId = String(args['userId']);
    const [who, user] = await Promise.all([
      recordType === 'person'
        ? query<PersonGet>(db, ctx, 'person.get', { personId: recordId }).then((r) => ({
            name: r.person.fullName,
            owner: r.person.owner,
            team: r.person.team,
          }))
        : query<CompanyGet>(db, ctx, 'company.get', { companyId: recordId }).then((r) => ({
            name: r.company.name,
            owner: r.company.owner,
            team: r.company.team,
          })),
      teammateName(db, ctx, userId),
    ]);
    if (!user) throw missing('userId', 'Pick someone on the team: list_team has them.');
    const isMain = who.owner?.id === userId;
    const onIt = who.team.some((t) => t.id === userId);
    const others = (ids: { fullName: string }[]) =>
      ids.map((t) => t.fullName).join(', ') || 'Nobody';
    const why =
      recordType === 'person'
        ? 'Being on a customer lets a member see their conversations and bills.'
        : 'It marks who works with this company.';
    const draft = (title: string, main: string, team: string, label: string, notes: Warning[]) =>
      card(
        toolCallId,
        'assign_customer',
        title,
        [
          { label: recordType === 'person' ? 'Customer' : 'Company', value: who.name },
          { label: 'Main person', value: main },
          { label: 'Also on it', value: team },
        ],
        label,
        notes,
        { customer: who.name, teammate: user },
      );
    switch (act) {
      case 'add':
        if (isMain || onIt) throw nothing(`${user} is on ${who.name} already.`);
        return who.owner
          ? draft(
              `Put ${user} on ${who.name}?`,
              who.owner.fullName,
              others([...who.team, { fullName: user }]),
              'Assign them',
              [{ kind: 'note', text: why }],
            )
          : draft(
              `Make ${user} the main person on ${who.name}?`,
              user,
              others(who.team),
              'Assign them',
              [{ kind: 'note', text: why }],
            );
      case 'remove': {
        if (!isMain && !onIt) throw nothing(`${user} isn’t on ${who.name}.`);
        const [next, ...rest] = who.team;
        return isMain
          ? draft(
              `Take ${user} off ${who.name}?`,
              next?.fullName ?? 'Nobody',
              others(rest),
              'Take them off',
              next ? [{ kind: 'note', text: `${next.fullName} becomes the main person.` }] : [],
            )
          : draft(
              `Take ${user} off ${who.name}?`,
              who.owner?.fullName ?? 'Nobody',
              others(who.team.filter((t) => t.id !== userId)),
              'Take them off',
              [],
            );
      }
      case 'make_main':
        if (isMain) throw nothing(`${user} is the main person already.`);
        return draft(
          `Make ${user} the main person on ${who.name}?`,
          user,
          others([...(who.owner ? [who.owner] : []), ...who.team.filter((t) => t.id !== userId)]),
          'Make them main',
          who.owner ? [{ kind: 'note', text: `${who.owner.fullName} stays on it.` }] : [],
        );
      default:
        throw missing('action', 'Say whether to add, remove or make main.');
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const recordType = args['recordType'] === 'company' ? 'company' : 'person';
    const recordId = String(args['recordId']);
    const input = { recordType, recordId, userId: args['userId'] };
    const name = act === 'remove' ? 'record.unassign' : 'record.assign';
    await command(
      db,
      ctx,
      name,
      act === 'remove' ? input : { ...input, main: act === 'make_main' },
    );
    return {
      outcome: act === 'remove' ? 'Taken off' : act === 'make_main' ? 'Made main' : 'Assigned',
      href:
        recordType === 'person'
          ? paths(ctx.workspaceId).person(recordId)
          : paths(ctx.workspaceId).company(recordId),
      command: name,
    };
  },
};

// ---------- what a customer said about being contacted ----------

const CALL_WORDS: Record<string, string> = {
  unknown: 'Not asked',
  opted_in: 'Agreed in writing',
  opted_out: 'Doesn’t want calls',
};
/**
 * Why the Assistant never records a yes to texts. The screens don't either: a yes comes from the customer, by START or
 * a box they tick, which is also what puts them in texting campaigns, and it's the proof the carriers ask for.
 */
const TEXTS_YES =
  'A yes to texts has to come from them: they text START to your number, or tick the box on your booking page, a form or the website chat. That keeps the proof of their yes.';

const recordConsent: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const personId = String(args['personId']);
    const { person } = await query<PersonGet>(db, ctx, 'person.get', { personId });
    const name = person.fullName;
    const agreed = args['answer'] === 'agreed';
    const where = str(args['where']);
    if (args['what'] === 'texts') {
      const fields = [
        { label: 'Customer', value: name },
        { label: 'Number', value: person.phone ?? 'No number on file' },
      ];
      if (agreed)
        return blocked(
          toolCallId,
          'record_consent',
          `Turn texts on for ${name}?`,
          fields,
          TEXTS_YES,
        );
      // Their texting consent is on their text conversation, when they have one.
      const { items } = await query<{ items: { id: string }[] }>(db, ctx, 'inbox.list', {
        personId,
        channel: 'sms',
        limit: 1,
      });
      const thread = items[0] ? await conversationOf(db, ctx, items[0].id) : null;
      if (thread?.person?.smsConsent === 'opted_out')
        throw nothing(`${name} is already marked as not wanting texts.`);
      return card(
        toolCallId,
        'record_consent',
        `Record that ${name} doesn’t want texts?`,
        [...fields, { label: 'Texts', value: 'Doesn’t want texts' }],
        'Record it',
        [
          {
            kind: 'note',
            text: 'Nothing is texted to them from now on, by you, your workflows or your AI, until they text START.',
          },
        ],
      );
    }
    const was = person.callConsent;
    if (agreed && !where)
      throw missing(
        'where',
        'Say where they agreed in writing, like “Signed service agreement”. Ask if you don’t know.',
      );
    const consent = agreed ? 'opted_in' : 'opted_out';
    if (was.consent === consent && (!where || where === was.source))
      throw nothing(`${name} is already marked “${CALL_WORDS[consent]}”.`);
    return card(
      toolCallId,
      'record_consent',
      agreed ? `Record that ${name} agreed to calls?` : `Record that ${name} doesn’t want calls?`,
      [
        { label: 'Customer', value: name },
        { label: 'Calls from us', value: CALL_WORDS[consent] ?? consent },
        ...(where ? [{ label: agreed ? 'Where they agreed' : 'How they said', value: where }] : []),
        {
          label: 'Was',
          value: `${CALL_WORDS[was.consent] ?? was.consent}${was.consent === 'opted_in' && was.source ? ` (${was.source})` : ''}`,
        },
      ],
      'Record it',
      [
        agreed
          ? {
              kind: 'caution',
              text: 'Only if they agreed in writing: your AI’s campaign calls can go to them from now on.',
            }
          : { kind: 'note', text: 'Your AI won’t call them again, for anything.' },
      ],
    );
  },

  async commit(db, ctx, args) {
    const personId = String(args['personId']);
    const href = paths(ctx.workspaceId).person(personId);
    if (args['what'] === 'texts') {
      // Mirrors the blocked card: a yes is never recorded from here, whatever the card said.
      if (args['answer'] === 'agreed')
        throw HfosError.rule('texts_yes_from_customer', 409, TEXTS_YES);
      await command(db, ctx, 'person.set_sms_consent', { personId, consent: 'opted_out' });
      return { outcome: 'Recorded: no texts', href, command: 'person.set_sms_consent' };
    }
    const agreed = args['answer'] === 'agreed';
    await command(
      db,
      ctx,
      'person.set_call_consent',
      defined({ personId, consent: agreed ? 'opted_in' : 'opted_out', source: str(args['where']) }),
    );
    return {
      outcome: agreed ? 'Recorded: agreed to calls' : 'Recorded: no calls',
      href,
      command: 'person.set_call_consent',
    };
  },
};

// ---------- pets, vehicles, properties, and what's related to what ----------

type EndKind = 'person' | 'company' | 'custom_record';
interface RelEnd {
  end: EndKind;
  recordType: RecordType | null;
  label: string;
}
interface RelType {
  id: string;
  a: RelEnd;
  b: RelEnd;
  cardinality: string;
  mutual: boolean;
}
interface FieldOut extends CustomFieldShape {
  recordTypeId: string | null;
}
interface Pair {
  id: string;
  label: string;
  ownLabel: string;
  note: string | null;
  other: {
    kind: EndKind;
    id: string;
    name: string;
    archived: boolean;
    recordType: { singular: string } | null;
  };
}

/** What the model and the card call each end: "customer", "company", or the kind's own name. */
const endIs = (e: RelEnd) =>
  e.end === 'person'
    ? 'customer'
    : e.end === 'company'
      ? 'company'
      : (e.recordType?.singular ?? 'record');
const kindOf = (recordType: unknown): EndKind | 'lead' =>
  recordType === 'record' ? 'custom_record' : (recordType as EndKind | 'lead');

const fieldsOf = async (db: Db, ctx: ToolContext, typeId: string) =>
  (
    await query<{ fields: FieldOut[] }>(db, ctx, 'custom_field.list', {
      entity: 'custom_record',
      recordTypeId: typeId,
    })
  ).fields;

/** A record's name on one end, or null when that id isn't one of that end's kind. */
async function nameOn(db: Db, ctx: ToolContext, end: RelEnd, id: string): Promise<string | null> {
  try {
    if (end.end === 'person')
      return (await query<PersonGet>(db, ctx, 'person.get', { personId: id })).person.fullName;
    if (end.end === 'company')
      return (await query<CompanyGet>(db, ctx, 'company.get', { companyId: id })).company.name;
    const { record } = await query<RecordGet>(db, ctx, 'custom_record.get', { customRecordId: id });
    return record.type.id === end.recordType?.id ? record.name : null;
  } catch (e) {
    if (e instanceof HfosError && e.status === 404) return null;
    throw e;
  }
}
const articled = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word.toLowerCase()}`;
/** Each id's name on its end of a relationship type, or one refusal that says which don't fit. */
async function namesOn(
  db: Db,
  ctx: ToolContext,
  ends: { end: RelEnd; id: string; path: string }[],
): Promise<string[]> {
  const names = await Promise.all(ends.map((x) => nameOn(db, ctx, x.end, x.id)));
  const problems = ends
    .filter((_, i) => !names[i])
    .map((x) => ({
      path: x.path,
      message: `${x.path} isn’t ${articled(endIs(x.end))}: the ${x.end.label} end takes one.`,
    }));
  if (problems.length)
    throw HfosError.validation(problems, problems.map((p) => p.message).join(' '));
  return names as string[];
}

/** A record's name, whatever it is. */
async function nameOf(
  db: Db,
  ctx: ToolContext,
  kind: EndKind | 'lead',
  id: string,
): Promise<string> {
  if (kind === 'lead')
    return (await query<LeadGet>(db, ctx, 'lead.get', { leadId: id })).lead.title;
  if (kind === 'person')
    return (await query<PersonGet>(db, ctx, 'person.get', { personId: id })).person.fullName;
  if (kind === 'company')
    return (await query<CompanyGet>(db, ctx, 'company.get', { companyId: id })).company.name;
  return (await query<RecordGet>(db, ctx, 'custom_record.get', { customRecordId: id })).record.name;
}

const pageOf = (ws: string, kind: EndKind | 'lead', id: string) => {
  const p = paths(ws);
  return kind === 'person'
    ? p.person(id)
    : kind === 'company'
      ? p.company(id)
      : kind === 'lead'
        ? p.lead(id)
        : recordHref(ws, id);
};

async function findRecords(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const typeId = idOf(args['typeId']);
  const [{ types: kinds }, { types: relTypes }, { fields }, { items }] = await Promise.all([
    query<{ types: RecordType[] }>(db, ctx, 'custom_record_type.list'),
    query<{ types: RelType[] }>(db, ctx, 'relationship_type.list'),
    query<{ fields: FieldOut[] }>(db, ctx, 'custom_field.list', { entity: 'custom_record' }),
    query<{
      items: {
        id: string;
        typeId: string;
        name: string;
        detail: string | null;
        related: { id: string; name: string; label: string; kind: EndKind }[];
      }[];
    }>(
      db,
      ctx,
      'custom_record.list',
      defined({ q: str(args['query']), typeId, limit: Number(args['limit'] ?? 20) || 20 }),
    ),
  ]);
  const kindName = new Map(kinds.map((k) => [k.id, k.singular]));
  return {
    result: {
      kinds: kinds.map((k) => ({
        typeId: k.id,
        name: k.singular,
        plural: k.plural,
        fields: fields
          .filter((f) => f.recordTypeId === k.id)
          .map((f) => ({
            fieldId: f.id,
            label: f.label,
            type: f.type,
            ...(f.options.length
              ? { choices: f.options.map((o) => ({ value: o.value, label: o.label })) }
              : {}),
          })),
      })),
      relationshipTypes: relTypes.map((t) => ({
        relationshipTypeId: t.id,
        a: { label: t.a.label, is: endIs(t.a) },
        b: { label: t.b.label, is: endIs(t.b) },
        howMany: t.cardinality,
        ...(t.mutual ? { sameBothWays: true } : {}),
      })),
      records: items.map((r) => ({
        id: r.id,
        kind: kindName.get(r.typeId) ?? null,
        name: r.name,
        detail: r.detail,
        relatedTo: r.related.map((x) => ({ id: x.id, name: x.name, is: x.label })),
      })),
      ...(kinds.length
        ? {}
        : {
            note: 'This business has no kinds of records yet. An owner or admin makes them in Settings → Relationships.',
          }),
    },
    card: items.length
      ? {
          type: 'list',
          title: count(items.length, 'record'),
          items: items.slice(0, 12).map((r) => ({
            title: r.name,
            detail: [kindName.get(r.typeId), r.detail, r.related.map((x) => x.name).join(', ')]
              .filter(Boolean)
              .join(' · '),
            tone: 'muted' as const,
            href: recordHref(ctx.workspaceId, r.id),
          })),
        }
      : null,
  };
}

interface FileOut {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedBy: Ref;
  createdAt: string;
}
const filesOn = async (db: Db, ctx: ToolContext, kind: EndKind | 'lead', recordId: string) =>
  (await query<{ files: FileOut[] }>(db, ctx, 'file.list', { recordType: kind, recordId })).files;
const size = (bytes: number | null) =>
  bytes === null
    ? null
    : bytes >= 1_048_576
      ? `${(bytes / 1_048_576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

async function getRecordDetails(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const kind = kindOf(args['recordType']);
  const recordId = String(args['recordId']);
  const files = filesOn(db, ctx, kind, recordId);
  const pairs =
    kind === 'lead'
      ? Promise.resolve([] as Pair[])
      : query<{ items: Pair[] }>(db, ctx, 'relationship.list', { recordType: kind, recordId }).then(
          (r) => r.items,
        );
  const about = async (): Promise<Args> => {
    if (kind === 'person' || kind === 'company') {
      const c =
        kind === 'person'
          ? (await query<PersonGet>(db, ctx, 'person.get', { personId: recordId })).person
          : (await query<CompanyGet>(db, ctx, 'company.get', { companyId: recordId })).company;
      return {
        name: 'fullName' in c ? c.fullName : c.name,
        archived: !!c.archivedAt,
        lookedAfterBy: {
          main: c.owner ? { userId: c.owner.id, name: c.owner.fullName } : null,
          alsoOnIt: c.team.map((t) => ({ userId: t.id, name: t.fullName })),
        },
      };
    }
    if (kind === 'lead') {
      const { lead } = await query<LeadGet>(db, ctx, 'lead.get', { leadId: recordId });
      return { name: lead.title, archived: !!lead.archivedAt };
    }
    const { record } = await query<RecordGet>(db, ctx, 'custom_record.get', {
      customRecordId: recordId,
    });
    const fields = await fieldsOf(db, ctx, record.type.id);
    return {
      name: record.name,
      kind: record.type.singular,
      typeId: record.type.id,
      archived: !!record.archivedAt,
      notes: record.notes,
      fields: fields.map((f) => ({
        fieldId: f.id,
        label: f.label,
        type: f.type,
        value: customValueText(f, record.custom[f.id]),
      })),
    };
  };
  const [record, found, related] = await Promise.all([about(), files, pairs]);
  return {
    result: {
      recordType: args['recordType'],
      recordId,
      ...record,
      ...(kind === 'lead'
        ? {}
        : {
            relationships: related.map((r) => ({
              relationshipId: r.id,
              other: {
                kind: r.other.kind === 'custom_record' ? 'record' : r.other.kind,
                id: r.other.id,
                name: r.other.name,
              },
              is: r.label,
              ...(r.note ? { note: r.note } : {}),
              ...(r.other.archived ? { archived: true } : {}),
            })),
          }),
      files: found.map((f) => ({
        fileId: f.id,
        name: f.name,
        type: f.mimeType,
        size: size(f.sizeBytes),
        addedBy: f.uploadedBy?.fullName ?? null,
        added: at(f.createdAt, ctx.timezone),
      })),
    },
  };
}

/** Field values as the card shows them, each checked against its field the way the command will. */
function valueLines(fields: FieldOut[], values: Args, was?: Record<string, unknown>): Field[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const problems: { path: string; message: string }[] = [];
  const lines: Field[] = [];
  for (const [id, raw] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) {
      problems.push({ path: `values.${id}`, message: 'That field isn’t on this kind of record.' });
      continue;
    }
    const checked = checkCustomValue(field, raw);
    if (!checked.ok) {
      problems.push({ path: `values.${id}`, message: `${field.label}: ${checked.message}` });
      continue;
    }
    const now = customValueText(field, checked.value);
    const before = was ? customValueText(field, was[id]) : null;
    if (was && now === before) continue;
    lines.push({
      label: field.label,
      value:
        now === null
          ? `Cleared${before ? ` (was ${before})` : ''}`
          : before
            ? `${now} (was ${before})`
            : now,
    });
  }
  if (problems.length) throw HfosError.validation(problems, problems[0]!.message);
  return lines;
}

const relTypeOf = async (db: Db, ctx: ToolContext, relationshipTypeId: unknown) => {
  const { types } = await query<{ types: RelType[] }>(db, ctx, 'relationship_type.list');
  const t = types.find((x) => x.id === relationshipTypeId);
  if (!t)
    throw missing(
      'relationshipTypeId',
      'That relationship type isn’t set up: find_records lists them.',
    );
  return t;
};

/** The new record's end of a relationship type: the one that is its kind. */
function newRecordSide(t: RelType, kind: RecordType): 'a' | 'b' {
  const mine = (e: RelEnd) => e.end === 'custom_record' && e.recordType?.id === kind.id;
  if (mine(t.a) && mine(t.b))
    throw missing(
      'relationshipTypeId',
      `Both ends of that relationship are ${kind.plural.toLowerCase()}: add it first, then relate the two with relate.`,
    );
  if (mine(t.b)) return 'b';
  if (mine(t.a)) return 'a';
  throw missing(
    'relationshipTypeId',
    `That relationship has no ${kind.singular.toLowerCase()} on either end.`,
  );
}

/** One pair, as the record it was listed on sees it. */
async function pairOn(db: Db, ctx: ToolContext, args: Args) {
  const kind = kindOf(args['recordType']);
  const recordId = idOf(args['recordId']);
  const relationshipId = idOf(args['relationshipId']);
  if (!recordId || !relationshipId || kind === 'lead')
    throw missing(
      'relationshipId',
      'Say which pair: get_record_details lists them, with the recordType and recordId it was asked about.',
    );
  const [{ items }, name] = await Promise.all([
    query<{ items: Pair[] }>(db, ctx, 'relationship.list', { recordType: kind, recordId }),
    nameOf(db, ctx, kind, recordId),
  ]);
  const pair = items.find((r) => r.id === relationshipId);
  if (!pair)
    throw HfosError.notFound(
      'That relationship isn’t on this record: get_record_details lists the ones that are.',
    );
  return { pair, name, kind, recordId };
}

const manageRecord: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_record';
    const values = (args['values'] ?? {}) as Args;
    switch (act) {
      case 'create': {
        const typeId = idOf(args['typeId']);
        const name = str(args['name']);
        if (!typeId) throw missing('typeId', 'Say which kind of record: find_records lists them.');
        if (!name) throw missing('name', 'Give it a name.');
        const [{ types }, fields] = await Promise.all([
          query<{ types: RecordType[] }>(db, ctx, 'custom_record_type.list'),
          fieldsOf(db, ctx, typeId),
        ]);
        const kind = types.find((k) => k.id === typeId);
        if (!kind)
          throw missing('typeId', 'That kind of record isn’t set up: find_records lists them.');
        const lines = valueLines(fields, values);
        let related: Field[] = [];
        if (args['relationshipTypeId'] || args['relateToId']) {
          const relateToId = idOf(args['relateToId']);
          if (!relateToId) throw missing('relateToId', 'Say what it’s related to.');
          const t = await relTypeOf(db, ctx, args['relationshipTypeId']);
          const side = newRecordSide(t, kind);
          const other = side === 'a' ? t.b : t.a;
          const [on] = await namesOn(db, ctx, [{ end: other, id: relateToId, path: 'relateToId' }]);
          related = [{ label: other.label, value: on ?? '' }];
        }
        return card(
          toolCallId,
          tool,
          `Add ${name} as a new ${kind.singular.toLowerCase()}?`,
          [
            { label: kind.singular, value: name },
            ...related,
            ...lines,
            { label: 'Notes', value: clip(str(args['notes'])) },
          ],
          'Add it',
        );
      }
      case 'change': {
        const recordId = idOf(args['recordId']);
        if (!recordId) throw missing('recordId', 'Say which record: find_records lists them.');
        const { record } = await query<RecordGet>(db, ctx, 'custom_record.get', {
          customRecordId: recordId,
        });
        const fields = await fieldsOf(db, ctx, record.type.id);
        const name = str(args['name']);
        const notes = args['notes'] === null ? null : str(args['notes']);
        const lines: Field[] = [
          ...(name && name !== record.name
            ? [{ label: 'Name', value: `${name} (was ${record.name})` }]
            : []),
          ...(notes !== undefined && (notes ?? null) !== record.notes
            ? [{ label: 'Notes', value: notes === null ? 'Taken off' : clip(notes) }]
            : []),
          ...valueLines(fields, values, record.custom),
        ];
        if (!lines.length) throw nothing();
        return card(toolCallId, tool, `Change ${record.name}?`, lines, 'Save the change');
      }
      case 'relate': {
        const aId = idOf(args['aId']);
        const bId = idOf(args['bId']);
        if (!aId || !bId)
          throw missing('aId', 'Say which two records: aId on end A and bId on end B.');
        const t = await relTypeOf(db, ctx, args['relationshipTypeId']);
        const [a, b] = await namesOn(db, ctx, [
          { end: t.a, id: aId, path: 'aId' },
          { end: t.b, id: bId, path: 'bId' },
        ]);
        const note = str(args['note']);
        return card(
          toolCallId,
          tool,
          `Relate ${a} and ${b}?`,
          [
            { label: t.a.label, value: a ?? '' },
            { label: t.b.label, value: b ?? '' },
            { label: 'Note', value: note ?? '' },
          ],
          'Relate them',
        );
      }
      case 'change_note': {
        const { pair, name } = await pairOn(db, ctx, args);
        const note = str(args['note']) ?? null;
        if (note === (pair.note ?? null)) throw nothing();
        return card(
          toolCallId,
          tool,
          `Change the note on ${name} and ${pair.other.name}?`,
          [
            { label: pair.ownLabel, value: name },
            { label: pair.label, value: pair.other.name },
            { label: 'Note', value: note ?? 'No note' },
            { label: 'Was', value: pair.note ?? 'No note' },
          ],
          'Save the note',
        );
      }
      case 'unrelate': {
        const { pair, name } = await pairOn(db, ctx, args);
        return card(
          toolCallId,
          tool,
          `Remove the relationship between ${name} and ${pair.other.name}?`,
          [
            { label: pair.ownLabel, value: name },
            { label: pair.label, value: pair.other.name },
            { label: 'Note', value: pair.note ?? '' },
          ],
          'Remove it',
          [{ kind: 'note', text: 'Neither record is deleted, and both timelines say who did it.' }],
        );
      }
      default:
        throw missing('action', 'Pick what to do.');
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const values = (args['values'] ?? undefined) as Args | undefined;
    switch (act) {
      case 'create': {
        const typeId = String(args['typeId']);
        const relateToId = idOf(args['relateToId']);
        let relateTo: Args | undefined;
        if (relateToId) {
          const [t, { types }] = await Promise.all([
            relTypeOf(db, ctx, args['relationshipTypeId']),
            query<{ types: RecordType[] }>(db, ctx, 'custom_record_type.list'),
          ]);
          const kind = types.find((k) => k.id === typeId);
          if (!kind)
            throw missing('typeId', 'That kind of record isn’t set up: find_records lists them.');
          relateTo = {
            relationshipTypeId: t.id,
            recordId: relateToId,
            side: newRecordSide(t, kind),
            ...(str(args['note']) ? { note: str(args['note']) } : {}),
          };
        }
        const out = await command<{ customRecordId: string }>(
          db,
          ctx,
          'custom_record.create',
          defined({
            typeId,
            name: str(args['name']),
            notes: str(args['notes']),
            values: values && Object.keys(values).length ? values : undefined,
            relateTo,
          }),
        );
        return {
          outcome: `Added ${str(args['name'])}`,
          href: recordHref(ctx.workspaceId, out.customRecordId),
          command: 'custom_record.create',
        };
      }
      case 'change': {
        const customRecordId = String(args['recordId']);
        const edits = defined({
          name: str(args['name']),
          notes: args['notes'] === null ? null : str(args['notes']),
        });
        const ran: string[] = [];
        if (Object.keys(edits).length) {
          await command(db, ctx, 'custom_record.update', { customRecordId, ...edits });
          ran.push('custom_record.update');
        }
        if (values && Object.keys(values).length) {
          await command(db, ctx, 'record.set_fields', {
            recordType: 'custom_record',
            recordId: customRecordId,
            values,
          });
          ran.push('record.set_fields');
        }
        return {
          outcome: 'Saved',
          href: recordHref(ctx.workspaceId, customRecordId),
          command: ran[0] ?? 'custom_record.update',
        };
      }
      case 'relate': {
        await command(
          db,
          ctx,
          'relationship.create',
          defined({
            relationshipTypeId: args['relationshipTypeId'],
            aId: args['aId'],
            bId: args['bId'],
            note: str(args['note']),
          }),
        );
        const t = await relTypeOf(db, ctx, args['relationshipTypeId']);
        return {
          outcome: 'Related',
          href: pageOf(ctx.workspaceId, t.a.end, String(args['aId'])),
          command: 'relationship.create',
        };
      }
      case 'change_note':
      case 'unrelate': {
        const kind = kindOf(args['recordType']);
        const recordId = String(args['recordId']);
        const relationshipId = args['relationshipId'];
        const name = act === 'unrelate' ? 'relationship.delete' : 'relationship.update';
        await command(
          db,
          ctx,
          name,
          act === 'unrelate'
            ? { relationshipId }
            : { relationshipId, note: str(args['note']) ?? null },
        );
        return {
          outcome: act === 'unrelate' ? 'Removed' : 'Saved',
          href: pageOf(ctx.workspaceId, kind, recordId),
          command: name,
        };
      }
      default:
        throw missing('action', 'Pick what to do.');
    }
  },
};

// ---------- a file on a record ----------

/** The file, found on the record it was listed on: only a customer's, company's, lead's or record's own. */
async function fileOn(db: Db, ctx: ToolContext, args: Args) {
  const kind = kindOf(args['recordType']);
  const recordId = String(args['recordId']);
  const [files, name] = await Promise.all([
    filesOn(db, ctx, kind, recordId),
    nameOf(db, ctx, kind, recordId),
  ]);
  const file = files.find((f) => f.id === args['fileId']);
  if (!file)
    throw HfosError.notFound(
      'That file isn’t on this record: get_record_details lists the ones that are.',
    );
  return { file, name, kind, recordId };
}

const deleteFile: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { file, name } = await fileOn(db, ctx, args);
    return card(
      toolCallId,
      'delete_file',
      `Delete ${file.name}?`,
      [
        { label: 'File', value: file.name },
        { label: 'On', value: name },
        {
          label: 'Added',
          value: `${at(file.createdAt, ctx.timezone)}${file.uploadedBy ? ` by ${file.uploadedBy.fullName}` : ''}`,
        },
        { label: 'Size', value: size(file.sizeBytes) ?? '' },
      ],
      'Delete it',
      [
        {
          kind: 'caution',
          text: 'It’s deleted for good: nobody can open it again, and it can’t be brought back.',
        },
      ],
    );
  },

  async commit(db, ctx, args) {
    // Found on the record again, so this only ever deletes a file that is on it.
    const { file, kind, recordId } = await fileOn(db, ctx, args);
    await command(db, ctx, 'file.delete', { fileId: file.id });
    return {
      outcome: 'Deleted',
      href: pageOf(ctx.workspaceId, kind, recordId),
      command: 'file.delete',
    };
  },
};

export const inboxCrmAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  find_conversations: findConversations,
  unsent_messages: unsentMessages,
  find_archived: findArchived,
  find_records: findRecords,
  get_record_details: getRecordDetails,
};

export const inboxCrmConfirmTools: Record<string, SettingsConfirmTool> = {
  manage_conversation: manageConversation,
  archive_or_restore: archiveOrRestore,
  manage_company: manageCompany,
  assign_customer: assignCustomer,
  record_consent: recordConsent,
  manage_record: manageRecord,
  delete_file: deleteFile,
};

/** What the panel says while each one runs. */
export const inboxCrmStepLabels: Record<string, string> = {
  find_conversations: 'Looking through the inbox',
  unsent_messages: 'Checking what didn’t go out',
  manage_conversation: 'Getting the conversation ready',
  archive_or_restore: 'Getting it ready for your OK',
  find_archived: 'Looking through what’s archived',
  manage_company: 'Getting the company ready',
  assign_customer: 'Choosing who looks after them',
  record_consent: 'Writing down what they said',
  find_records: 'Looking at your records',
  get_record_details: 'Looking at the record',
  manage_record: 'Getting the record ready',
  delete_file: 'Finding the file',
};
