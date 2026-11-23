import {
  chatSetupAnswersFromWidget,
  chatSetupContextFrom,
  chatSetupLines,
  chatSetupTeammateOf,
} from '@hfos/core';
import type { Metadata } from 'next';
import { MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Callout } from '@/components/crm/chips';
import { WebsiteChatOverview } from '@/components/settings/website-chat-overview';
import { WebsiteChatPage } from '@/components/settings/website-chat-page';
import { apiServer } from '@/lib/api/server';
import { loadChatEditor, teammateFor } from '@/lib/chat/editor-data';

export const metadata: Metadata = { title: 'Website chat' };

/**
 * Settings → Website chat (channels.manage: owners and admins): one simple card (the owner, 23 Nov 2026, W3 a) with
 * the chat on or paused, its install check, Copy the code, Try it and Put it on your site, and the guided setup's six
 * answers, each with Change; with no chat yet, Set up website chat starts the guided setup. Under All settings, as
 * before, the business's first chat edited exactly as Forms → Website chats edits it (the sites it shows on, the
 * snippet with the install check, who answers, how it looks, where its button sits on phones and computers, what it
 * asks visitors for, pausing it and a new key). Every chat is listed in Forms, which is where another one is added;
 * this page says so, and keeps settings search's places to land (`?all=1` opens All settings).
 */
export default async function WebsiteChatSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { all } = await searchParams;
  const { api } = await apiServer();
  const [data, draft] = await Promise.all([
    loadChatEditor(workspaceId),
    // The web ships a little before the API: a draft it can't read yet is no draft.
    api
      .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'chat' } })
      .then((r) => r.data?.answers ?? null)
      .catch(() => null),
  ]);
  if (!data.canManage) notFound();
  const widget = data.widgets[0] ?? null;
  const more = data.widgets.length - 1;
  const ctx = chatSetupContextFrom({
    widget,
    teammate: chatSetupTeammateOf(data.teammate),
    website: data.website,
    brandColor: data.brand.look.color?.hex ?? null,
    hasLogo: !!data.brand.logo,
  });
  return (
    <>
      <div className="mb-5" data-testid="chat-in-forms">
        <Callout tone="info" icon={MessageCircle}>
          {more > 0
            ? `Your business has ${data.widgets.length} website chats, and this is the first. `
            : 'Website chats are listed in Forms too, beside your forms. '}
          <Link
            href={`/app/w/${workspaceId}/forms#website-chats`}
            className="font-medium underline underline-offset-2"
          >
            {more > 0
              ? 'See them all in Forms.'
              : widget
                ? 'Add another one there.'
                : 'Open Forms.'}
          </Link>
        </Callout>
      </div>
      <WebsiteChatOverview
        workspaceId={workspaceId}
        widget={widget}
        lines={widget ? chatSetupLines(chatSetupAnswersFromWidget(widget), ctx) : []}
        started={draft !== null}
        openAll={all === '1'}
        brandedOrigin={data.brandedOrigin}
      >
        <WebsiteChatPage
          workspaceId={workspaceId}
          widget={widget}
          teammate={teammateFor(data, widget)}
          brandedOrigin={data.brandedOrigin}
          website={data.website}
          brand={data.brand}
        />
      </WebsiteChatOverview>
    </>
  );
}
