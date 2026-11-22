import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { TextingApprovalFlow } from '@/components/texting-approval/texting-approval-flow';
import { apiServer, getSetupWorkspace } from '@/lib/api/server';
import { loadTexting } from '@/lib/texting';

export const metadata: Metadata = { title: 'Get approved to text' };

/**
 * Texting approval as a guided setup (the owner, 22 Nov 2026): the carriers' eight questions in four parts, one at a
 * time on a page of its own, where the guided phone setup leaves off and from Settings → Texting & calls. The answers
 * are saved as they are given (`registration.save_draft`), so this page opens on the question left.
 *
 * Only while there is something to fill in: a registration not sent yet, or one the carriers turned down and the
 * business is correcting (`?fix=1`). Otherwise Settings shows where it stands. Only someone who can change the
 * business's channels comes here; anyone else goes Home.
 */
export default async function TextingApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const { api, email } = await apiServer();
  const mine = await getSetupWorkspace(workspaceId);
  if (!mine) notFound();
  const props = await loadTexting(api, workspaceId);
  if (!props) redirect(`/app/w/${workspaceId}`);
  const settings = `/app/w/${workspaceId}/settings/texting`;
  const { status } = props;
  // The number it's for; without a working one, a local registration sent ahead of the number (it needs none).
  const working = status.number?.status === 'active' ? status.number : null;
  const arriving = status.numbers.find((n) => n.status === 'porting') ?? null;
  const step = working ? status.nextStep : status.localRegistrationStep;
  const fix = (await searchParams)['fix'] === '1' && step === 'rejected';
  if (step !== 'submit_registration' && !fix) redirect(`${settings}#approval`);
  if (!working && arriving?.numberType === 'toll_free') redirect(settings);
  return (
    <TextingApprovalFlow
      workspaceId={workspaceId}
      businessName={props.businessName}
      businessWebsite={props.businessWebsite ?? null}
      businessAddress={props.businessAddress ?? null}
      industry={props.industry ?? null}
      email={email}
      me={props.me}
      number={
        working
          ? { numberType: working.numberType, display: working.display }
          : arriving
            ? { numberType: 'local', display: arriving.display }
            : null
      }
      registrations={status.registrations}
      fix={fix}
      draft={props.registrationDraft ?? null}
      surfaces={props.surfaces}
      feesPaidFor={status.textingFees?.paidFor ?? null}
    />
  );
}
