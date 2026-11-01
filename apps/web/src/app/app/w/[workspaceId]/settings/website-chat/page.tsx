import type { Metadata } from 'next';
import { MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Callout } from '@/components/crm/chips';
import { WebsiteChatPage } from '@/components/settings/website-chat-page';
import { loadChatEditor, teammateFor } from '@/lib/chat/editor-data';

export const metadata: Metadata = { title: 'Website chat' };

/**
 * Settings → Website chat (channels.manage: owners and admins): the business's first chat, edited exactly as Forms →
 * Website chats edits it (the sites it shows on, the snippet with the install check, who answers, how it looks, where
 * its button sits on phones and computers, what it asks visitors for, pausing it and a new key). Every chat is listed
 * in Forms, which is where another one is added; this page says so, and keeps settings search's places to land.
 */
export default async function WebsiteChatSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const data = await loadChatEditor(workspaceId);
  if (!data.canManage) notFound();
  const widget = data.widgets[0] ?? null;
  const more = data.widgets.length - 1;
  return (
    <>
      <div className="mb-5" data-testid="chat-in-forms">
        <Callout tone="info" icon={MessageCircle}>
          {more > 0
            ? `Your business has ${data.widgets.length} website chats. This is the first one; `
            : 'Your website chats are listed in Forms too, beside your forms. '}
          <Link
            href={`/app/w/${workspaceId}/forms#website-chats`}
            className="font-medium underline underline-offset-2"
          >
            {more > 0 ? 'open Forms to see them all.' : 'Open Forms to add another one.'}
          </Link>
        </Callout>
      </div>
      <WebsiteChatPage
        workspaceId={workspaceId}
        widget={widget}
        teammate={teammateFor(data, widget)}
        brandedOrigin={data.brandedOrigin}
        website={data.website}
        brand={data.brand}
      />
    </>
  );
}
