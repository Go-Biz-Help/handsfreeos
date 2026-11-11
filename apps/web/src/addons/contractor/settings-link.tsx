'use client';
import { ButtonLink } from '@/components/ui/button';
import type { AddonSettingsProps } from '../registry';
import { contractorHref } from './bits';

/**
 * On the Add-ons page: Contractor Operations' settings (its trades and a new project's phases) have a page of their
 * own, so its sheet points there.
 */
export default function ContractorSettingsLink({ workspaceId, settings }: AddonSettingsProps) {
  if (settings === null)
    return (
      <p className="text-[13px] text-text-2">
        Owners and admins pick the trades and a new project’s phases in Contractor Operations →
        Settings.
      </p>
    );
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-text-2">
        The trades you do, and the phases a new project starts with.
      </p>
      <ButtonLink href={contractorHref(workspaceId, 'settings')} variant="secondary">
        Open Contractor settings
      </ButtonLink>
    </div>
  );
}
