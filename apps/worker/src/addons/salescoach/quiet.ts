/**
 * A written conversation's write-up once it goes quiet (round two, docs/salescoach.md): the same as a call's, for a
 * text thread, a chat, Messenger, Instagram or an email exchange.
 *
 * When a customer writes, the add-on queues one `salescoach.conversation_quiet` job for the conversation, a quiet spell
 * later (`QUIET_MS`). When it runs, it reads what was said since the last write-up: if anyone wrote within the quiet
 * spell, it waits until the spell has passed after the newest message. Then, when someone on the team (not the AI
 * teammate) took part and may be coached, the AI writes it up and `salescoach.conversation.finish` puts the notes on
 * the customer's timeline, a task for each promise, and a score. Nothing for a person's own mail, nor outside the Inbox.
 */
import {
  AFTER_CALL_SCHEMA,
  AFTER_CALL_SYSTEM,
  AfterCallAnswer,
  afterCallPrompt,
  checkedAfterCall,
  keptLines,
  linesOfMessages,
  playbookText,
} from '@hfos/core/addons/salescoach/coach';
import { conversationFinish } from '@hfos/core/addons/salescoach/ops/calls';
import { PlaybookDetails } from '@hfos/core/addons/salescoach/playbooks';
import { SUGGEST_CHANNELS, type SuggestChannel } from '@hfos/core/addons/salescoach/suggest';
import { executeCommand, localDateOf } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobHandler } from '../types';

export const QUIET_JOB = 'salescoach.conversation_quiet';
/** How long nobody writes before a conversation counts as quiet. */
export const QUIET_MS = 3 * 60 * 60_000;
/** The most of a stretch the write-up reads. */
const STRETCH_MESSAGES = 300;

/** A customer wrote: its write-up once the conversation goes quiet. One job per conversation at a time. */
export async function queueQuietCheck(
  ctx: AddonEventContext,
  conversationId: string,
): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: QUIET_JOB,
        dedupeKey: `${QUIET_JOB}:${conversationId}`,
        runAt: new Date(Date.now() + QUIET_MS),
        payload: { conversationId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

interface Said extends Record<string, unknown> {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly channel: string;
  readonly sent_by: string | null;
  readonly text: string;
  readonly at: Date;
}

export const conversationQuiet: AddonJobHandler = async (ctx) => {
  const conversationId = (ctx.job.payload as { conversationId?: unknown }).conversationId;
  if (typeof conversationId !== 'string') return;
  const ws = ctx.scope.workspaceId;
  const read = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [thread] = await rows<{
      folder: string;
      private_to: string | null;
      timezone: string;
      language: string | null;
    }>(
      tx,
      // The language is the customer's, as the AI teammate last said (M18).
      sql`select c.folder::text as folder, c.private_to, w.timezone, c.language
          from app.conversations c join app.workspaces w on w.id = c.workspace_id
          where c.id = ${conversationId} and c.workspace_id = ${ws}`,
    );
    // Where the last write-up ended: only what came after it is new.
    const [last] = await rows<{ at: Date }>(
      tx,
      sql`select m.occurred_at as at from addon_salescoach.calls k
          join app.messages m on m.id = k.through_message_id
          where k.conversation_id = ${conversationId} order by m.occurred_at desc limit 1`,
    );
    const said = await rows<Said>(
      tx,
      sql`select id, direction::text as direction, channel::text as channel, sent_by,
                 coalesce(nullif(btrim(body_text), ''), subject, '') as text, occurred_at as at
          from app.messages
          where conversation_id = ${conversationId} and workspace_id = ${ws}
            and occurred_at > ${(last ? new Date(last.at) : new Date(0)).toISOString()}::timestamptz
          order by occurred_at desc, id desc limit ${STRETCH_MESSAGES}`,
    );
    return { thread, said: said.reverse() };
  });
  const { thread, said } = read;
  if (!thread || thread.folder !== 'inbox' || thread.private_to || said.length === 0) return;
  const newest = said.at(-1)!;
  const quietAt = new Date(newest.at).getTime() + QUIET_MS;
  // Still going: look again once it has been quiet long enough after the newest message.
  if (quietAt > ctx.now) return { rescheduleAt: new Date(quietAt) };
  // Someone on the team must have taken part (the AI teammate's replies have no person), and be coached.
  const rep = [...said].reverse().find((m) => m.direction === 'outbound' && m.sent_by)?.sent_by;
  if (!rep || !said.some((m) => m.direction === 'inbound')) return;
  const [may] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ ok: boolean }>(
      tx,
      sql`select private.user_has_permission(${rep}::uuid, ${ws}::uuid, 'salescoach.use') as ok`,
    ),
  );
  if (!may?.ok) return;
  const lines = keptLines(
    linesOfMessages(
      said.map((m) => ({ direction: m.direction, text: m.text, at: new Date(m.at) })),
    ),
  );
  const [pb] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ name: string; details: unknown }>(
      tx,
      sql`select name, details from addon_salescoach.playbooks
          where workspace_id = ${ws} and archived_at is null
          order by is_default desc, created_at limit 1`,
    ),
  );
  const parsed = PlaybookDetails.safeParse(pb?.details ?? {});
  const details = parsed.success ? parsed.data : { steps: [], objections: [], points: [] };
  let answer: AfterCallAnswer;
  try {
    const { value } = await askStructured(ctx, ctx.scope, {
      system: AFTER_CALL_SYSTEM,
      messages: [
        {
          role: 'user',
          content: afterCallPrompt({
            kind: 'conversation',
            playbook: playbookText(pb?.name ?? 'No playbook', details),
            lines,
            today: localDateOf(ctx.now, thread.timezone),
            language: thread.language,
          }),
        },
      ],
      schema: AFTER_CALL_SCHEMA,
      zod: AfterCallAnswer,
      maxTokens: 2000,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    answer = value;
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // Busy: the job tries again. Anything else: no write-up this time, and the conversation goes on as it was.
    if (e.retryable && ctx.attempt < 4) throw e;
    ctx.log.info({ code: e.code }, 'no write-up for a quiet conversation');
    return;
  }
  const channel = (SUGGEST_CHANNELS as readonly string[]).includes(newest.channel)
    ? (newest.channel as SuggestChannel)
    : 'sms';
  await executeCommand(
    ctx.db,
    conversationFinish,
    {
      workspaceId: ws,
      conversationId,
      throughMessageId: newest.id,
      channel,
      userId: rep,
      lines,
      result: checkedAfterCall(answer, details, lines, thread.language),
      startedAt: new Date(said[0]!.at).toISOString(),
      endedAt: new Date(newest.at).toISOString(),
    },
    ctx.actor,
    ctx.meta,
  );
};
