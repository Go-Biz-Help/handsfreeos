import type { Metadata } from 'next';
import { CreateBusiness } from '@/components/onboarding-setup/create-business';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { apiServer } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Set up your business · Practice' };

/**
 * The setup's first screen in the practice sign-up (Admin → Try onboarding, 20261027027200): the same screen a new
 * customer fills in straight after signing up, except that it makes a practice business (`practice.start`), owned by
 * the person practicing and deleted after. From there it's the real pages: the founding spot, then the guided setup.
 */
export default async function PracticeBusinessPage() {
  const { email } = await apiServer();
  return (
    <SetupPage business={null} email={email}>
      <CreateBusiness practice />
    </SetupPage>
  );
}
