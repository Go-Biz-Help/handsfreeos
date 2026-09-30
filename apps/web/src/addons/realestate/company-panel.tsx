'use client';
import type { SlotProps } from '../registry';
import { DealsPanel } from './deals-panel';

/** A company's deals (a lender, a title company, a brokerage), on its page. */
export default function CompanyPanel({ workspaceId, companyId }: SlotProps<'company.panels'>) {
  return <DealsPanel workspaceId={workspaceId} of={{ companyId }} defaults={async () => ({})} />;
}
