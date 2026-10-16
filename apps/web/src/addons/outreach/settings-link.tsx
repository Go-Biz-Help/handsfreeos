'use client';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { ButtonLink } from '@/components/ui/button';
import type { AddonSettingsProps } from '../registry';
import { outreachHref } from './address';

/**
 * On the Add-ons page: Social Outreach's business settings live in its own Settings tab, under For your team on
 * General (docs/outreach.md, decisions 37 and 73), beside the rules and the extension's link, so its sheet points
 * there.
 */
export default function OutreachSettingsLink({ workspaceId, settings }: AddonSettingsProps) {
  if (settings === null) return <p className="text-[13px] text-text-2">{W.addonsPage.notOwner}</p>;
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-text-2">{W.addonsPage.about}</p>
      <ButtonLink href={outreachHref(workspaceId, { view: 'settings' })} variant="secondary">
        {W.addonsPage.open}
      </ButtonLink>
    </div>
  );
}
