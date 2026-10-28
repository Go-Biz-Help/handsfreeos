import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocumentPage } from '@/components/documents/document-page';
import { apiServer } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Document' };

/** One sent document: who has signed, its proof trail, and its pages as they stand. */
export default async function SentDocumentPage({
  params,
}: {
  params: Promise<{ workspaceId: string; documentId: string }>;
}) {
  const { workspaceId, documentId } = await params;
  const { api } = await apiServer();
  const res = await api.POST('/v1/queries/document.get', { body: { workspaceId, documentId } });
  if (!res.data) notFound();
  return <DocumentPage workspaceId={workspaceId} doc={res.data} />;
}
