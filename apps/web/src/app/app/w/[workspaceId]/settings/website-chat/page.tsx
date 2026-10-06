import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WebsiteChatPage } from '@/components/settings/website-chat-page';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: 'Website chat' };

/**
 * Settings → Website chat (channels.manage: owners and admins): the sites it shows on, the snippet with the
 * install check, who answers, how it looks, what it asks visitors for, pausing it and a new key.
 */
export default async function WebsiteChatSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'channels.manage')) notFound();
  const [widgets, team, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/chat_widget.list', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    brandedOriginFor(api, workspaceId),
  ]);
  // One widget per business for now (the first); more come with more sites to separate.
  const widget = unwrapPage(widgets).items[0] ?? null;
  const t = unwrapPage(team).teammate;
  const channels = (t?.config as { channels?: { chat?: unknown; widgetId?: unknown } } | undefined)
    ?.channels;
  // Settings → Workspace's website, which setup's quick questions fill in too: the first site the chat may show on.
  const website = (got.workspace.settings as Record<string, unknown> | null)?.['website'];
  return (
    <>
      <WebsiteChatPage
        workspaceId={workspaceId}
        widget={widget}
        teammate={
          t
            ? {
                id: t.id,
                name: t.name,
                status: t.status,
                answersChat: channels?.chat === true && channels.widgetId === widget?.id,
              }
            : null
        }
        brandedOrigin={brandedOrigin}
        website={typeof website === 'string' && website ? website : null}
      />
    </>
  );
}
