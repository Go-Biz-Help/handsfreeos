import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TextingPage } from '@/components/settings/texting-page';
import { apiServer } from '@/lib/api/server';
import { loadTexting } from '@/lib/texting';

export const metadata: Metadata = { title: 'Texting & calls' };

/** Owners and admins set up the business number and the carrier registration here. */
export default async function TextingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const props = await loadTexting(api, workspaceId);
  if (!props) notFound();
  return <TextingPage {...props} />;
}
