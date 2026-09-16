import { redirect } from 'next/navigation';

/** Invoices are the section's front door, so /money/invoices goes there rather than showing the list twice. */
export default async function InvoicesIndexPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/app/w/${workspaceId}/money`);
}
