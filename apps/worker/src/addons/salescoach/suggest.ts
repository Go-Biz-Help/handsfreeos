/**
 * Replies to suggest in a written conversation (round two, docs/salescoach.md).
 *
 * A customer wrote (`message.received`, any channel): the add-on queues one `salescoach.suggest` job for the
 * conversation, a moment later, so a burst of messages gets one set. The job reads the conversation as it is then:
 * nothing while the AI teammate answers it (it drafts its own), nor for a person's own mail or what isn't in the
 * Inbox. Otherwise the fast model reads the business's playbook, brief and short knowledge answers and the latest
 * messages, and suggests two or three replies, which `salescoach.suggestions.put` keeps for the customer's newest
 * message. The web shows them above the message box (`composer.suggestions`).
 */
import { PlaybookDetails } from '@hfos/core/addons/salescoach/playbooks';
import { playbookText } from '@hfos/core/addons/salescoach/coach';
import { suggestionsPut } from '@hfos/core/addons/salescoach/ops/suggestions';
import {
  checkedSuggestions,
  SUGGEST_AFTER_MS,
  SUGGEST_CHANNELS,
  SUGGEST_MESSAGES,
  SUGGEST_SCHEMA,
  SUGGEST_SYSTEM,
  SuggestAnswer,
  suggestPrompt,
  type SuggestChannel,
} from '@hfos/core/addons/salescoach/suggest';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonJobHandler, AddonScopeContext, AddonSubscriber } from '../types';
import { businessText } from './business';
import { queueQuietCheck } from './quiet';

export const SUGGEST_JOB = 'salescoach.suggest';

/** A customer wrote: one set of suggestions for the conversation, after the burst settles. */
export const onCustomerWrote: AddonSubscriber = async (ctx) => {
  const conversationId = (ctx.event.payload as { conversationId?: unknown }).conversationId;
  if (typeof conversationId !== 'string') return;
  // And its write-up once it goes quiet (./quiet.ts).
  await queueQuietCheck(ctx, conversationId);
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: SUGGEST_JOB,
        dedupeKey: `${SUGGEST_JOB}:${conversationId}`,
        runAt: new Date(Date.now() + SUGGEST_AFTER_MS),
        payload: { conversationId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
};

interface Thread extends Record<string, unknown> {
  readonly handled_by: string;
  readonly folder: string;
  readonly private_to: string | null;
  /** The customer's language, as the AI teammate last said (M18). */
  readonly language: string | null;
}

async function usualPlaybook(ctx: AddonScopeContext) {
  const [p] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ name: string; details: unknown }>(
      tx,
      sql`select name, details from addon_salescoach.playbooks
          where workspace_id = ${ctx.scope.workspaceId} and archived_at is null
          order by is_default desc, created_at limit 1`,
    ),
  );
  const parsed = PlaybookDetails.safeParse(p?.details ?? {});
  return {
    name: p?.name ?? 'No playbook yet',
    details: parsed.success ? parsed.data : { steps: [], objections: [], points: [] },
  };
}

export const suggestReplies: AddonJobHandler = async (ctx) => {
  const conversationId = (ctx.job.payload as { conversationId?: unknown }).conversationId;
  if (typeof conversationId !== 'string') return;
  const ws = ctx.scope.workspaceId;
  const read = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [thread] = await rows<Thread>(
      tx,
      sql`select handled_by::text as handled_by, folder::text as folder, private_to, language
          from app.conversations where id = ${conversationId} and workspace_id = ${ws}`,
    );
    const messages = await rows<{
      id: string;
      direction: 'inbound' | 'outbound';
      channel: string;
      text: string;
    }>(
      tx,
      sql`select id, direction::text as direction, channel::text as channel,
                 coalesce(nullif(btrim(body_text), ''), subject, '') as text
          from app.messages where conversation_id = ${conversationId} and workspace_id = ${ws}
          order by occurred_at desc, id desc limit ${SUGGEST_MESSAGES}`,
    );
    return { thread, messages: messages.reverse() };
  });
  const { thread, messages } = read;
  // The AI teammate answers it, or it isn't the team's to answer here.
  if (!thread || thread.handled_by === 'ai' || thread.folder !== 'inbox' || thread.private_to)
    return;
  const last = messages.at(-1);
  // Someone already answered the newest message, or there's nothing to answer.
  if (!last || last.direction !== 'inbound' || !last.text.trim()) return;
  const channel = (SUGGEST_CHANNELS as readonly string[]).includes(last.channel)
    ? (last.channel as SuggestChannel)
    : 'sms';
  const playbook = await usualPlaybook(ctx);
  let answer: SuggestAnswer;
  try {
    const { value } = await askStructured(
      { ...ctx, ai: { ...ctx.ai, provider: ctx.voiceAi ?? ctx.ai.provider } },
      ctx.scope,
      {
        system: SUGGEST_SYSTEM,
        context: [playbookText(playbook.name, playbook.details), await businessText(ctx)].join(
          '\n\n',
        ),
        messages: [
          {
            role: 'user',
            content: suggestPrompt({ channel, messages, language: thread.language }),
          },
        ],
        schema: SUGGEST_SCHEMA,
        zod: SuggestAnswer,
        maxTokens: 900,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      },
    );
    answer = value;
  } catch (e) {
    // No suggestions this time is a quiet box, never an error: the person writes their own.
    if (e instanceof AiAskError) {
      ctx.log.info({ code: e.code }, 'no reply suggestions this time');
      return;
    }
    throw e;
  }
  const checked = checkedSuggestions(answer, channel, playbook.details);
  if (!checked.replies.length) return;
  await executeCommand(
    ctx.db,
    suggestionsPut,
    {
      workspaceId: ws,
      conversationId,
      messageId: last.id,
      replies: checked.replies,
      objectionId: checked.objectionId,
    },
    ctx.actor,
    ctx.meta,
  );
};
