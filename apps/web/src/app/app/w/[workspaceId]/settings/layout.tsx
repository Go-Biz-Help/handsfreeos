import type { ReactNode } from 'react';
import { SettingsFrame } from '@/components/settings/settings-nav';

/** Every settings page sits beside the settings menu, so a page only draws what is on it. */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <SettingsFrame workspaceId={workspaceId}>{children}</SettingsFrame>;
}
