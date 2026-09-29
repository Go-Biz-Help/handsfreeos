import type { AttentionKind } from '@hfos/core';
import { Plus } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { KindTile } from './attention-bits';

const KINDS: readonly (readonly [AttentionKind, string])[] = [
  ['hot_lead', 'Hot leads'],
  ['unanswered_lead', 'New leads nobody has answered'],
  ['customer_waiting', 'Customers waiting for a reply'],
  ['stale_opportunity', 'Leads that went quiet'],
  ['missing_next_action', 'Leads with no next step'],
  ['unconfirmed_appointment', 'Visits not confirmed'],
  ['ai_approval', 'Approvals'],
  ['overdue_task', 'Overdue tasks'],
];

/** A brand-new business's Home, under Getting started: what this page becomes once there are customers. */
export function ActionCenterIntro({
  workspaceId,
  canImport,
}: {
  workspaceId: string;
  canImport: boolean;
}) {
  return (
    <Card
      className="border-transparent bg-accent-soft px-[22px] py-5 shadow-none"
      data-testid="action-center-intro"
    >
      <div className="flex items-center gap-2.5">
        <BrandMark size={24} />
        <h3 className="text-[15px] font-semibold text-accent-text">
          This page becomes your Action Center
        </h3>
      </div>
      <p className="mt-1.5 text-[13px] text-text-2">
        Add your first customer, or import a spreadsheet, and HandsFreeOS lists what needs you here,
        most important first:
      </p>
      <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {KINDS.map(([kind, label]) => (
          <li key={kind} className="flex items-center gap-2 text-[13px]">
            <KindTile kind={kind} size="sm" />
            {label}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-text-3">
        It can also ask customers to confirm visits and follow up on quiet leads. You choose what it
        does in Settings, Automations.
      </p>
      <div className="mt-3.5 flex flex-wrap gap-2">
        <ButtonLink href={`/app/w/${workspaceId}/customers`} variant="primary" size="sm">
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Add a person
        </ButtonLink>
        {canImport ? (
          <ButtonLink href={`/app/w/${workspaceId}/imports/new`} variant="secondary" size="sm">
            Import a spreadsheet
          </ButtonLink>
        ) : null}
      </div>
    </Card>
  );
}
