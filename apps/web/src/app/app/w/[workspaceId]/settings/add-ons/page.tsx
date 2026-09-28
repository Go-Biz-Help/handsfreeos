import { redirect } from 'next/navigation';

/**
 * Where Add-ons used to be, as a Settings tab: it is a place of its own now (../../add-ons), and links and emails
 * sent before still land there, with the add-on they name.
 */
export default async function OldAddonsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ addon?: string | string[] }>;
}) {
  const { workspaceId } = await params;
  const { addon } = await searchParams;
  const which = typeof addon === 'string' ? `?addon=${encodeURIComponent(addon)}` : '';
  redirect(`/app/w/${workspaceId}/add-ons${which}`);
}
