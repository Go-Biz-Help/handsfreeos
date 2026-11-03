/**
 * What a website chat's editor needs, loaded on the server for Forms → Website chats and Settings → Website chat
 * alike, so every chat is edited the same way wherever it's opened (the texting registration's chat included): the
 * business's chats, its AI teammate and which chat that answers, its own domain for the snippet, its website to start
 * a new chat from, and its logo for the top of the chat.
 */
import { can, lookOf } from '@hfos/core';
import type { ChatBrand, ChatTeammate } from '@/components/settings/website-chat-page';
import type { ChatWidget } from '@/lib/api/types';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';
import { logoSrc } from '@/lib/look';

export interface ChatEditorData {
  readonly widgets: readonly ChatWidget[];
  /** May set chats up and change them (channels.manage). */
  readonly canManage: boolean;
  /** The AI teammate, and which chat its Website chat channel answers (null: any it's named on). */
  readonly teammate:
    | (Omit<ChatTeammate, 'answersChat'> & {
        readonly chatOn: boolean;
        readonly widgetId: string | null;
      })
    | null;
  readonly brandedOrigin: string | null;
  readonly website: string | null;
  readonly brand: ChatBrand;
}

export async function loadChatEditor(workspaceId: string): Promise<ChatEditorData> {
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const permissions = got.workspace.permissions;
  const [widgets, team, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/chat_widget.list', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    brandedOriginFor(api, workspaceId),
  ]);
  const t = unwrapPage(team).teammate;
  const channels = (t?.config as { channels?: { chat?: unknown; widgetId?: unknown } } | undefined)
    ?.channels;
  const settings = (got.workspace.settings ?? {}) as Record<string, unknown>;
  // Settings → Workspace's website, which setup's quick questions fill in too: the first site a chat may show on.
  const website = typeof settings['website'] === 'string' ? settings['website'] || null : null;
  const look = lookOf(settings);
  return {
    widgets: unwrapPage(widgets).items,
    canManage: can(permissions, 'channels.manage'),
    teammate: t
      ? {
          id: t.id,
          name: t.name,
          status: t.status,
          chatOn: channels?.chat === true,
          widgetId: typeof channels?.widgetId === 'string' ? channels.widgetId : null,
        }
      : null,
    brandedOrigin,
    website,
    brand: {
      look,
      logo: look.logo
        ? { url: logoSrc(look.logo.path), width: look.logo.width, height: look.logo.height }
        : null,
      businessName: got.workspace.name,
      website,
      canChange: can(permissions, 'workspace.update'),
    },
  };
}

/** The teammate as one chat's editor shows it: whether its Website chat channel answers this chat. */
export function teammateFor(data: ChatEditorData, widget: ChatWidget | null): ChatTeammate | null {
  const t = data.teammate;
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    answersChat: t.chatOn && !!widget && (t.widgetId === null || t.widgetId === widget.id),
  };
}
