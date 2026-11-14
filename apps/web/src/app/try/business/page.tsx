import type { Metadata } from 'next';
import { CreateBusiness } from '@/components/onboarding-setup/create-business';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { apiServer } from '@/lib/api/server';
import { practiceLinkOf } from '@/lib/practice-link';

export const metadata: Metadata = { title: 'Set up your business · Practice' };

/**
 * The setup's first screen in the practice sign-up (Admin → Try onboarding, 20261027027400): the same screen a new
 * customer fills in straight after signing up, except that it makes a practice business (`practice.start`), owned by
 * the person practicing and deleted after. From there it's the real pages: the founding spot, then the guided setup.
 * From an offer link (20261027027500), the website's plan and business start it off as the real one's do, and the
 * code goes on to the plan page.
 */
export default async function PracticeBusinessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ email }, link] = await Promise.all([apiServer(), searchParams.then(practiceLinkOf)]);
  return (
    <SetupPage business={null} email={email}>
      <CreateBusiness practice plan={link.plan} start={link.business} code={link.code} />
    </SetupPage>
  );
}
