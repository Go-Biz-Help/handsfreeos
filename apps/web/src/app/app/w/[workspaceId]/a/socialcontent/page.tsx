import { redirect } from 'next/navigation';
import { addonPage } from '@/addons/gate';

/**
 * AI Social Media Content Creator's bare page opens Creators, its first page (docs/socialcontent.md), once the gate
 * lets it: "not available here" while the add-on is off, and not found for someone without `socialcontent.use`.
 */
export default async function SocialcontentPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', () =>
    redirect(`/app/w/${workspaceId}/a/socialcontent/creators`),
  );
}
