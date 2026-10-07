import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { OnboardingQuickSetup } from '@/components/onboarding-setup/quick-setup';
import { apiServer, getMe } from '@/lib/api/server';
import { loadOnboardingSetup } from '@/lib/onboarding-setup/load';

export const metadata: Metadata = { title: 'Set up your business' };

/**
 * The guided setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7), where a new owner lands once the
 * business is made, and where Getting started's Home card points until it's finished. `?at=` is the screen it's on,
 * kept as it moves on, so a page loaded again opens there; coming back from Stripe or Square adds `?payments=`, and
 * `?part=owner` is the owner finishing their part of what their agency set up. Only someone who sets the business up
 * comes here; anyone else goes to Home.
 */
export default async function OnboardingSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const home = `/app/w/${workspaceId}`;
  const { api, email } = await apiServer();
  const me = await getMe();
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  if (!ws) notFound();
  if (!can(ws.permissions, 'workspace.update')) redirect(home);
  const query = await searchParams;
  const one = (key: string) => (typeof query[key] === 'string' ? query[key] : null);
  const data = await loadOnboardingSetup(api, ws, one('at'), one('part'));
  return (
    <SetupPage business={{ name: data.got.state.businessName || ws.name, home }} email={email}>
      <OnboardingQuickSetup data={data} payments={one('payments')} />
    </SetupPage>
  );
}
