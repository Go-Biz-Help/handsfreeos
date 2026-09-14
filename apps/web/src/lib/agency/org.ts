import { hasOrgPermission } from '@hfos/core';
import type { Me } from '@/lib/api/types';

export type AgencySection = 'templates' | 'businesses' | 'packs';

/** Organizations whose agency area this person runs: their owners and admins (org.templates.manage). */
export function agencyOrganizations(me: Me): Me['organizations'] {
  return me.organizations.filter((o) => hasOrgPermission(o.role, 'org.templates.manage'));
}

export const agencyHref = (organizationId: string, section: AgencySection = 'templates') =>
  `/app/org/${organizationId}/${section}`;

/** The organization's client businesses, by name. */
export function orgBusinesses(me: Me, organizationId: string): Me['workspaces'] {
  return me.workspaces
    .filter((w) => w.organizationId === organizationId)
    .sort((a, b) => a.name.localeCompare(b.name));
}
