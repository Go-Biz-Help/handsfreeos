import type { Metadata } from 'next';
import Link from 'next/link';
import { AFFILIATE_PAGE_WORDS } from '@hfos/core';
import { AffiliateSelf } from '@/components/affiliate/affiliate-self';
import { Brand } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import { apiServer, getMe, unwrap } from '@/lib/api/server';

export const metadata: Metadata = { title: AFFILIATE_PAGE_WORDS.title };

/**
 * Selling HandsFreeOS (20261027014000): applying to be an affiliate, the application while it waits, and once
 * approved, the person's link and share. Signed in only, with or without a business of their own: an affiliate needn't
 * be a customer (decision 6). The proxy sends anybody signed out to sign in, or make an account, and back here.
 */
export default async function AffiliatePage() {
  const { api } = await apiServer();
  const [me, mine] = await Promise.all([
    getMe(),
    api.POST('/v1/queries/affiliate.mine', { body: {} }).then(unwrap),
  ]);

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <Card className="w-[560px] max-w-full rounded-dialog p-9 max-md:p-6">
        <AffiliateSelf mine={mine} name={me.user.fullName} />
      </Card>
      <Link href="/app" className="text-[13px] text-text-2 hover:text-text">
        {AFFILIATE_PAGE_WORDS.backToApp}
      </Link>
    </div>
  );
}
