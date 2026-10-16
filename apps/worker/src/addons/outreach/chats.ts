/**
 * The AI's read of the chats brought in from Facebook's download (docs/outreach.md, decision 3).
 *
 * - The download's last part (`outreach.download.saved`), and chats the extension read in Messenger
 *   (`outreach.chats.collected`), queue a read of the business's waiting chats, one job per business, so chats
 *   brought in together are read once.
 * - Each read takes a batch, the latest chats first, and asks the model for a summary, the playbooks' tags that fit,
 *   whether they look like a prospect and a next step. Core checks the answer (checkedChatRead) and saves it
 *   (`outreach.chat.read`), which puts them in Contacts when the business's setting says to.
 * - A long list is read a batch at a time. At the day's AI limit it waits a few hours; an answer it can't use marks
 *   that chat as failed rather than trying it forever.
 */
import {
  CHAT_READ_SCHEMA,
  chatReadSystem,
  ChatReadAnswer,
  chatReadPlaybook,
  chatReadPrompt,
  checkedChatRead,
} from '@hfos/core/addons/outreach/chat-read';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import { chatRead } from '@hfos/core/addons/outreach/ops/chats';
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { executeCommand } from '@hfos/core/server';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const READ_CHATS_JOB = 'outreach.read_chats';
/** How many chats one read takes. */
export const READ_CHATS_BATCH = 20;
const HOUR = 3_600_000;

/** `outreach.download.saved` and `outreach.chats.collected`: the chats waiting are read now. */
export async function downloadSaved(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: READ_CHATS_JOB,
        dedupeKey: `${READ_CHATS_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `outreach.read_chats`: reads a batch of the business's waiting chats, and comes back for the rest. */
export async function readChatsJob(ctx: AddonJobContext): Promise<JobResult> {
  const { chats, playbooks } = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    chats: await rows<{
      id: string;
      last_at: Date | string;
      recent: DownloadMessage[];
      platform: Platform;
    }>(
      tx,
      sql`select id, last_at, recent, platform from addon_outreach.file_chats
          where workspace_id = ${ctx.scope.workspaceId} and read_state = 'waiting'
          order by last_at desc limit ${READ_CHATS_BATCH + 1}`,
    ),
    playbooks: await rows<{ name: string; details: unknown }>(
      tx,
      sql`select name, details from addon_outreach.playbooks
          where workspace_id = ${ctx.scope.workspaceId} and archived_at is null order by created_at`,
    ),
  }));
  if (!chats.length) return;
  const looking = playbooks.flatMap((p) => {
    const details = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return details.success ? [chatReadPlaybook(p.name, details.data)] : [];
  });
  const tags = [
    ...new Map(looking.flatMap((p) => p.tags).map((t) => [t.toLowerCase(), t])).values(),
  ];

  for (const chat of chats.slice(0, READ_CHATS_BATCH)) {
    let read: ReturnType<typeof checkedChatRead> | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: chatReadSystem(chat.platform),
        messages: [
          { role: 'user', content: chatReadPrompt(chat.recent, tags, looking, chat.platform) },
        ],
        schema: CHAT_READ_SCHEMA,
        zod: ChatReadAnswer,
        maxTokens: 600,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      read = checkedChatRead(value, tags, chat.recent);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: the rest wait a few hours. Not set up: they wait for the next file.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      // A busy model is worth another try; one still busy waits an hour.
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      read = null;
    }
    await executeCommand(
      ctx.db,
      chatRead,
      {
        workspaceId: ctx.scope.workspaceId,
        chatId: chat.id,
        lastAt: new Date(chat.last_at).toISOString(),
        read,
      },
      ctx.actor,
      ctx.meta,
    );
  }
  if (chats.length > READ_CHATS_BATCH) return { rescheduleAt: new Date(ctx.now) };
}
