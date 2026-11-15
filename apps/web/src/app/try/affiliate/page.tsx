import type { Metadata } from 'next';
import Link from 'next/link';
import { AFFILIATE_PAGE_WORDS } from '@hfos/core';
import { AffiliateSelf } from '@/components/affiliate/affiliate-self';
import { Brand } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import { apiServer, getMe, unwrap } from '@/lib/api/server';

export const metadata: Metadata = { title: `${AFFILIATE_PAGE_WORDS.title} · Practice` };

/**
 * The practice affiliate application (Admin → Try onboarding, 20261027027500): the page the website's affiliate link
 * leads to after making an account, as somebody who hasn't applied sees it, whatever the staff member's own standing.
 * Sending it checks it and shows what an applicant sees while they wait; nothing is sent or saved.
 */
export default async function PracticeAffiliatePage() {
  const { api } = await apiServer();
  const [me, mine] = await Promise.all([
    getMe(),
    api.POST('/v1/queries/affiliate.mine', { body: {} }).then(unwrap),
  ]);
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <Card className="w-[560px] max-w-full rounded-dialog p-9 max-md:p-6">
        <AffiliateSelf mine={{ ...mine, affiliate: null }} name={me.user.fullName} practice />
      </Card>
      <Link href="/admin/try" className="text-[13px] font-medium text-accent-text hover:underline">
        ← Back to Try onboarding
      </Link>
    </div>
  );
}
