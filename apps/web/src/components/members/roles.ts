import { ROLE_DESCRIPTIONS, ROLE_LABELS, roleRank, type WorkspaceRole } from '@hfos/core';

export const ROLE_OPTIONS: { value: WorkspaceRole; label: string; description: string }[] = (
  ['owner', 'admin', 'member'] as const
).map((r) => ({
  value: r,
  label: ROLE_LABELS[r],
  description: ROLE_DESCRIPTIONS[r],
}));

export const grantable = (myRole: WorkspaceRole | null) =>
  ROLE_OPTIONS.filter((o) => roleRank(o.value) <= roleRank(myRole));
export { roleRank };
