import { and, asc, eq, isNull } from 'drizzle-orm';
import { aiTeammates, chatWidgets } from '@hfos/db/schema';
import { chatWidgetName, readableTextOn } from '../chat/origins';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import {
  chatAskForOf,
  ChatWidgetGetOutput,
  ChatWidgetListInput,
  ChatWidgetListOutput,
  ChatWidgetRefInput,
  type ChatWidgetOut,
} from '../schemas/chat';
import { scopeCan } from '../kernel/execute';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const iso = (v: Date | null) => (v ? v.toISOString() : null);

async function widgets(ctx: QueryContext, workspaceId: string, widgetId?: string) {
  const list = await ctx.tx
    .select({
      w: chatWidgets,
      teammateName: aiTeammates.name,
      teammateStatus: aiTeammates.status,
    })
    .from(chatWidgets)
    .leftJoin(
      aiTeammates,
      and(eq(aiTeammates.id, chatWidgets.teammateId), isNull(aiTeammates.archivedAt)),
    )
    .where(
      and(
        eq(chatWidgets.workspaceId, workspaceId),
        ...(widgetId ? [eq(chatWidgets.id, widgetId)] : []),
      ),
    )
    .orderBy(asc(chatWidgets.createdAt), asc(chatWidgets.id));
  return list.map(({ w, teammateName, teammateStatus }): ChatWidgetOut => ({
    id: w.id,
    name: chatWidgetName(w.allowedOrigins),
    publicKey: w.publicKey,
    allowedOrigins: w.allowedOrigins,
    teammate:
      w.teammateId && teammateName && teammateStatus
        ? { id: w.teammateId, name: teammateName, status: teammateStatus }
        : null,
    greeting: w.greeting,
    launcherLabel: w.launcherLabel,
    accentColor: w.accentColor,
    textColor: readableTextOn(w.accentColor),
    position: w.position === 'left' ? 'left' : 'right',
    awayMessage: w.awayMessage,
    askFor: chatAskForOf(w.askFor),
    smsConsent: w.smsConsent,
    dailyCap: w.dailyCap,
    paused: w.pausedAt !== null,
    pausedAt: iso(w.pausedAt),
    install: {
      seen: w.lastSeenAt !== null,
      lastSeenOrigin: w.lastSeenOrigin,
      lastSeenAt: iso(w.lastSeenAt),
    },
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  }));
}

export const chatWidgetList = defineQuery({
  name: 'chat_widget.list',
  description:
    'The business’s website chat widgets: their sites, look and settings, whether each has been seen installed, and the public key for the snippet.',
  input: ChatWidgetListInput,
  output: ChatWidgetListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    return {
      items: await widgets(ctx, input.workspaceId),
      canManage: scopeCan(ctx.scope, 'channels.manage'),
    };
  },
});

export const chatWidgetGet = defineQuery({
  name: 'chat_widget.get',
  description:
    'One website chat widget: its sites, look and settings, the install check, and the public key for the snippet. Nothing secret.',
  input: ChatWidgetRefInput,
  output: ChatWidgetGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  // The worker's chat routes read a widget's settings too.
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const [widget] = await widgets(ctx, input.workspaceId, input.widgetId);
    if (!widget) throw HfosError.notFound('Chat widget not found.');
    return {
      widget,
      canManage: scopeCan(ctx.scope, 'channels.manage'),
    };
  },
});
