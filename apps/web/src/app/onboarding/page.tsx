import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CreateBusiness } from '@/components/onboarding-setup/create-business';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { apiServer, getMe } from '@/lib/api/server';
import { wantedPlan } from '@/lib/founding-plan';

export const metadata: Metadata = { title: 'Set up your business' };

/**
 * Straight after signing up (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): the guided setup's first
 * screen, which makes the business, then the rest on the business's own setup page. Someone already in a business
 * goes to it. `?plan=` is the founding spot the website's button was for (20261027012700), carried to the plan page.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { email } = await apiServer();
  const me = await getMe();
  if (me.workspaces.length > 0) redirect(`/app/w/${me.workspaces[0]!.id}`);
  const { plan } = await searchParams;
  return (
    <SetupPage business={null} email={email}>
      <CreateBusiness plan={wantedPlan(plan)} />
    </SetupPage>
  );
}
