import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TryOnboarding } from '@/components/practice/try-onboarding';
import { apiServer, getPlatformMe, unwrap } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Try onboarding' };

/**
 * Admin → Try onboarding (20261027027400): go through an onboarding as a brand-new customer would, in a practice
 * business that's deleted after. The founder and staff admins only; anyone else in support gets the 404 page, as for
 * any page that isn't theirs.
 */
export default async function TryOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const platform = await getPlatformMe();
  if (!platform?.staff?.permissions.includes('platform.practice.use')) notFound();
  const { api } = await apiServer();
  const [{ businesses }, query] = await Promise.all([
    api.POST('/v1/queries/practice.list', { body: {} }).then(unwrap),
    searchParams,
  ]);
  return <TryOnboarding businesses={businesses} ended={query.ended === '1'} />;
}
