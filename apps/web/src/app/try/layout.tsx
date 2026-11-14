import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ThemeSync } from '@/components/shell/theme-sync';
import { getMe, getPlatformMe } from '@/lib/api/server';
import { parseTheme } from '@/lib/theme';

/**
 * The practice sign-up's screens before the practice business exists (Admin → Try onboarding, 20261027027400): the
 * sign-up and the setup's first screen, as a new customer sees them. Only someone who may practice comes here; anyone
 * else gets the 404 page, with no sign there is anything to find. Once the business is made, it's the real pages.
 */
export default async function TryLayout({ children }: { children: ReactNode }) {
  const [me, platform] = await Promise.all([getMe(), getPlatformMe()]);
  if (!platform?.staff?.permissions.includes('platform.practice.use')) notFound();
  return (
    <>
      <ThemeSync theme={parseTheme((me.user.settings as { theme?: unknown }).theme)} />
      {children}
    </>
  );
}
