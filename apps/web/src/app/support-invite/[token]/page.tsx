import type { Metadata } from 'next';
import { Brand } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import { AcceptSupportInvite } from '@/components/admin/accept-support-invite';

export const metadata: Metadata = { title: 'Support invitation' };

/**
 * Accepting a support invitation. It sits outside the admin area on purpose: the person is not staff yet,
 * and everything under /admin answers "not found" to anyone who isn't.
 */
export default async function SupportInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <Card className="w-[480px] max-w-full rounded-dialog p-9">
        <h1 className="text-2xl font-semibold tracking-tight">Answer HandsFreeOS support</h1>
        <p className="mt-2 leading-relaxed text-text-2">
          Accepting this gives you the support desk: the tickets customers send in, and a read-only
          look at a business when you need one to answer them.
        </p>
        <AcceptSupportInvite token={token} />
      </Card>
      <p className="text-[13px] text-text-3">
        The link works once, and only for the address it was sent to.
      </p>
    </div>
  );
}
