import type { WorkflowTemplateInstall } from '@/lib/api/types';

/**
 * Versions an install is behind the newest (0 when current, not installed, or never published). A plain
 * module, not a client one: the businesses page works it out on the server.
 */
export function behindBy(i: WorkflowTemplateInstall, latest: number | null): number {
  return i.status === 'installed' && latest ? Math.max(0, latest - (i.installedVersion ?? 0)) : 0;
}
