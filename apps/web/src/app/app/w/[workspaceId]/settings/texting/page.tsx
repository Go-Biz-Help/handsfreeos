import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TextingPage } from '@/components/settings/texting-page';
import { apiServer } from '@/lib/api/server';
import { loadTexting } from '@/lib/texting';

export const metadata: Metadata = { title: 'Texting & calls' };

/**
 * Owners and admins see what the business number does here, and change it. `?bring=` comes from the guided phone
 * setup's first question, when the number they have is staying with them: the page opens on moving it here.
 */
export default async function TextingSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const props = await loadTexting(api, workspaceId);
  if (!props) notFound();
  const bring = (await searchParams)['bring'];
  return (
    <TextingPage {...props} bring={bring === 'carrier' || bring === 'choose' ? bring : null} />
  );
}
