import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/shell/page-header';
import { WebsiteChatPage } from '@/components/settings/website-chat-page';
import { loadChatEditor, teammateFor } from '@/lib/chat/editor-data';

export const metadata: Metadata = { title: 'Website chat' };

/**
 * Forms → Website chats → one chat (channels.manage): the same editor as Settings → Website chat, for whichever chat
 * this is, the texting registration's one included.
 */
export default async function WebsiteChatInFormsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; widgetId: string }>;
}) {
  const { workspaceId, widgetId } = await params;
  const data = await loadChatEditor(workspaceId);
  if (!data.canManage) notFound();
  const widget = data.widgets.find((w) => w.id === widgetId);
  if (!widget) notFound();
  return (
    <>
      <Link
        href={`/app/w/${workspaceId}/forms#website-chats`}
        className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Forms
      </Link>
      <PageHeader
        title={widget.name}
        description="A website chat: its sites, who answers, its look, where its button sits on phones and computers, and what it asks visitors for."
      />
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
