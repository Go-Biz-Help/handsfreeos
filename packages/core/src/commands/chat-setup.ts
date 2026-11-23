/**
 * The guided website chat setup's last screen (the owner, 23 Nov 2026, picks W1 a to W4 b): Turn on website chat
 * carries out every answer together. A business with no chat gets one (chat_widget.create); one with a chat has it
 * changed (chat_widget.update), leaving what the setup doesn't ask as it was. Picking the AI teammate also turns on
 * its Website chat for this chat (W1), through ai_teammate.save_config, so the teammate's own rules and history apply;
 * someone who can't change the teammate still gets their chat, and is told. Each part runs as its own command, with
 * all its own rules, so nothing here goes around them. Answers that are wrong are refused before anything changes, in
 * the setup's own words.
 */
import { and, eq } from 'drizzle-orm';
import { chatWidgets, guidedSetupDrafts } from '@hfos/db/schema';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import { HfosError } from '../errors';
import {
  CHAT_SETUP_QUESTIONS,
  chatSetupProblems,
  chatSetupTeammateChange,
  chatSetupWidgetFields,
  ChatSetupSaveInput,
  ChatSetupSaveOutput,
  type ChatSetupSaveOutput as SaveOutput,
} from '../guided-setup/chat';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { aiTeammateSaveConfig } from './ai-team';
import { chatWidgetCreate, chatWidgetUpdate } from './chat-widget';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const chatSetupSave = defineCommand({
  name: 'chat_setup.save',
  description:
    'Carry out the guided website chat setup’s answers, as its Turn on website chat (or, for a chat already set up, Save my answers) does: makes the chat when widgetId is null, or changes that chat, with the sites it shows on, who answers, what happens while nobody is answering, what it asks visitors for, how it looks and where its button sits. Picking the AI teammate also turns on its Website chat for this chat. Nothing changes when an answer is wrong.',
  risk: 2,
  input: ChatSetupSaveInput,
  output: ChatSetupSaveOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const a = input.answers;
    const row = a.who === 'ai' ? await loadTeammate(ctx.tx, ws, { forUpdate: true }) : null;
    const config = row ? teammateConfigOf(row) : null;
    const teammate =
      row && config
        ? {
            id: row.id,
            name: row.name,
            status: row.status as 'off' | 'training' | 'automatic',
            chatOn: config.channels.chat,
            widgetId: config.channels.widgetId,
          }
        : null;

    const problems = CHAT_SETUP_QUESTIONS.flatMap((q) => chatSetupProblems(q, a, { teammate }));
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({ path: `answers.${p.path}`, message: p.message })),
        problems[0]!.message,
      );

    const fields = chatSetupWidgetFields(a, teammate?.id ?? null);
    let widgetId: string;
    let publicKey: string;
    const created = !input.widgetId;
    if (input.widgetId) {
      const done = await executeCommandWithin(ctx, chatWidgetUpdate, {
        workspaceId: ws,
        widgetId: input.widgetId,
        ...fields,
      });
      widgetId = done.output.widgetId;
      const [w] = await ctx.tx
        .select({ publicKey: chatWidgets.publicKey })
        .from(chatWidgets)
        .where(and(eq(chatWidgets.id, widgetId), eq(chatWidgets.workspaceId, ws)));
      publicKey = w?.publicKey ?? '';
    } else {
      const made = await executeCommandWithin(ctx, chatWidgetCreate, {
        workspaceId: ws,
        ...fields,
      });
      widgetId = made.output.widgetId;
      publicKey = made.output.publicKey;
    }

    // W1: picking the teammate turns on its Website chat for this chat.
    let teammateChat: SaveOutput['teammateChat'] = 'none';
    const change = chatSetupTeammateChange(a, {
      teammate,
      widget: input.widgetId ? { id: input.widgetId } : null,
    });
    if (change === 'on') teammateChat = 'on';
    else if (row && config && (change === 'turn_on' || change === 'move'))
      try {
        await executeCommandWithin(ctx, aiTeammateSaveConfig, {
          workspaceId: ws,
          teammateId: row.id,
          baseRevision: row.revision,
          config: { ...config, channels: { ...config.channels, chat: true, widgetId } },
        });
        teammateChat = 'turned_on';
      } catch (e) {
        if (!(e instanceof HfosError) || e.code !== 'forbidden') throw e;
        teammateChat = 'not_allowed';
      }

    // The answers are spent: coming back starts from the chat as it now is.
    await ctx.tx
      .delete(guidedSetupDrafts)
      .where(and(eq(guidedSetupDrafts.workspaceId, ws), eq(guidedSetupDrafts.setup, 'chat')));

    return { widgetId, publicKey, created, teammateChat };
  },
});
