import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AgencyShell } from '@/components/agency/agency-shell';
import { ThemeSync } from '@/components/shell/theme-sync';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, fetchMe } from '@/lib/api/server';
import { parseTheme } from '@/lib/theme';

/**
 * The agency area (templates, client businesses, knowledge packs), for its organization's owners and admins.
 * Anyone else gets a 404, as the API does. Reached from the workspace switcher's group headers.
 */
export default async function AgencyLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const orgs = agencyOrganizations(me);
  const org = orgs.find((o) => o.id === orgId);
  if (!org) notFound();
  return (
    <>
      <ThemeSync theme={parseTheme((me.user.settings as { theme?: unknown }).theme)} />
      <AgencyShell
        me={me}
        org={{ id: org.id, name: org.name }}
        others={orgs.filter((o) => o.id !== orgId).map((o) => ({ id: o.id, name: o.name }))}
        businesses={orgBusinesses(me, orgId).map((b) => ({ id: b.id, name: b.name }))}
      >
        {children}
      </AgencyShell>
    </>
  );
}
