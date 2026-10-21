import { managesAnAgency } from '@hfos/core';
import type { ReactNode } from 'react';
import { SettingsFrame } from '@/components/settings/settings-nav';
import { getMe, getPlatformMe } from '@/lib/api/server';

/** Every settings page sits beside the settings menu, so a page only draws what is on it. */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  // Who has New support tickets and Daily agency digest, which settings search lists only to them, as Account does.
  const [me, platform] = await Promise.all([getMe(), getPlatformMe()]);
  return (
    <SettingsFrame
      workspaceId={workspaceId}
      staff={Boolean(platform?.staff)}
      agency={managesAnAgency({ organizations: me.organizations, businesses: me.workspaces })}
    >
      {children}
    </SettingsFrame>
  );
}
