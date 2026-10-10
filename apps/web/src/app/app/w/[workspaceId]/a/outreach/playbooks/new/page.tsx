import { PLAYBOOK_TEMPLATE_KEYS } from '@hfos/core/addons/outreach/playbooks';
import { outreachSetupPath } from '@hfos/core/addons/outreach/setup';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { PlaybookBuilder } from '@/addons/outreach/playbook-builder';
import { builderData } from '../load';

export const metadata: Metadata = { title: 'New playbook' };

/**
 * A new playbook, asked a step at a time: from a template (`?template=crm_demos`), or blank. Owners and admins
 * (`outreach.manage`) write them; for anyone else it's not found. Started from Social Outreach's setup
 * (`?from=setup`), saving goes back there.
 */
export default async function NewPlaybookPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ template?: string | string[]; from?: string | string[] }>;
}) {
  const { workspaceId } = await params;
  const { template, from: came } = await searchParams;
  const from = PLAYBOOK_TEMPLATE_KEYS.find((k) => k === template) ?? null;
  return addonPage(workspaceId, 'outreach', 'outreach.manage', async () => (
    <PlaybookBuilder
      key={from ?? 'blank'}
      workspaceId={workspaceId}
      playbook={null}
      template={from}
      doneHref={
        came === 'setup' ? outreachSetupPath(workspaceId, { step: 'playbooks' }) : undefined
      }
      {...await builderData(workspaceId)}
    />
  ));
}
