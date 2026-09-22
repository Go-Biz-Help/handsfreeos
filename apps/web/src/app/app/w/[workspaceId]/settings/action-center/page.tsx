import { redirect } from 'next/navigation';

/**
 * Settings → Action Center became part of Settings → Automations, where each thing the Action Center looks for
 * is its own row. Old links (emails, the phone app, bookmarks) land there.
 */
export default async function ActionCenterSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/app/w/${workspaceId}/settings/automations`);
}
