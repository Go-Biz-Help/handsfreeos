import type { Members } from './types';

/** Everyone who can be assigned work in a workspace: direct members plus the organization's owners and admins. */
export function assigneeOptions(members: Members): { id: string; fullName: string }[] {
  const seen = new Set<string>();
  const out: { id: string; fullName: string }[] = [];
  for (const m of [...members.members, ...members.organizationAdmins]) {
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    out.push({ id: m.userId, fullName: m.fullName || m.email });
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
