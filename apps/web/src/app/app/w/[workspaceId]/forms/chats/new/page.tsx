import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NewWebsiteChat } from '@/components/forms/new-website-chat';
import { PageHeader } from '@/components/shell/page-header';
import { loadChatEditor, teammateFor } from '@/lib/chat/editor-data';

export const metadata: Metadata = { title: 'New website chat' };

/** Forms → New website chat (channels.manage): its name and sites, then its editor opens. */
export default async function NewWebsiteChatPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const data = await loadChatEditor(workspaceId);
  if (!data.canManage) notFound();
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
        title="New website chat"
        description={
          data.widgets.length
            ? 'Another chat button, with its own name, sites and look. Only one chat shows on a page, so give each its own sites.'
            : 'A chat button on your website. Every chat lands in your inbox.'
        }
      />
      <NewWebsiteChat
        workspaceId={workspaceId}
        teammate={teammateFor(data, null)}
        brandedOrigin={data.brandedOrigin}
        // A second chat is for another site, so it doesn't start from the business's main one.
        website={data.widgets.length ? null : data.website}
        naming={data.widgets.length > 0}
      />
    </>
  );
}
