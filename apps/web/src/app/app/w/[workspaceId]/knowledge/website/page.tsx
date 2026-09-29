import type { Metadata } from 'next';
import { WebsiteScan } from '@/components/knowledge/website-scan';
import { apiServer } from '@/lib/api/server';
import { loadWebsiteScan } from '@/lib/knowledge';

export const metadata: Metadata = { title: 'Website scan' };

/** The business's website, its newest scan (live while it reads), and that scan's suggestions page by page. */
export default async function KnowledgeWebsitePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  return <WebsiteScan {...await loadWebsiteScan(api, workspaceId)} />;
}
