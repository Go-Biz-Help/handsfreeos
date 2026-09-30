'use client';
import { ButtonLink } from '@/components/ui/button';
import type { AddonSettingsProps } from '../registry';
import { realestateHref } from './bits';

/**
 * On the Add-ons page: Real Estate Agent's settings have a page of their own (the duty list, alerts, business days,
 * client updates and support access), so its sheet points there.
 */
export default function RealestateSettingsLink({ workspaceId, settings }: AddonSettingsProps) {
  if (settings === null)
    return (
      <p className="text-[13px] text-text-2">
        Owners and admins change the duty list, alerts and business days in Deal settings.
      </p>
    );
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-text-2">
        The duty list and its versions, who hears about critical alerts, the days the office is
        closed, and which milestones get a drafted client update.
      </p>
      <ButtonLink href={realestateHref(workspaceId, 'settings')} variant="secondary">
        Open Deal settings
      </ButtonLink>
    </div>
  );
}
