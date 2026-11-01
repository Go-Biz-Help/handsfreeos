'use client';
/** Forms → New website chat: the set-up card, then the new chat's own page in Forms. */
import { useRouter } from 'next/navigation';
import { WebsiteChatPage, type ChatTeammate } from '@/components/settings/website-chat-page';

export function NewWebsiteChat({
  workspaceId,
  teammate,
  brandedOrigin,
  website,
  naming,
}: {
  workspaceId: string;
  teammate: ChatTeammate | null;
  brandedOrigin: string | null;
  website: string | null;
  naming: boolean;
}) {
  const router = useRouter();
  return (
    <WebsiteChatPage
      workspaceId={workspaceId}
      widget={null}
      teammate={teammate}
      brandedOrigin={brandedOrigin}
      website={website}
      naming={naming}
      onCreated={(id) => router.push(`/app/w/${workspaceId}/forms/chats/${id}`)}
    />
  );
}
