import type { Metadata } from 'next';
import Link from 'next/link';
import { SignUpForm } from '@/app/(auth)/sign-up/sign-up-form';
import { PRACTICE_WORDS } from '@hfos/core';
import { Brand } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import { practiceLinkOf } from '@/lib/practice-link';

export const metadata: Metadata = { title: 'Create your account · Practice' };

/**
 * The practice sign-up (Admin → Try onboarding, 20261027027400): the sign-up page a new customer sees, in the sign-in
 * pages' frame, except that no login is made and nothing is sent. Any 6-digit code works. Then the setup's first
 * screen, which makes the practice business, or, from the affiliate link (`?then=affiliate`, 20261027027500), the
 * practice affiliate application. What an offer link carries (`lib/practice-link.ts`) rides on in the address, and a
 * note says what it was.
 */
export default async function PracticeSignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const link = practiceLinkOf(query);
  const next = query.then === 'affiliate' ? '/try/affiliate' : `/try/business${link.onward}`;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      {link.words.length ? (
        <p
          className="w-[440px] max-w-full rounded-control bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-text"
          data-testid="practice-link-note"
        >
          {PRACTICE_WORDS.linkNote(link.words)}
        </p>
      ) : null}
      <Card className="w-[440px] max-w-full rounded-dialog p-9 max-md:p-6">
        <SignUpForm next={next} google={false} practice />
      </Card>
      <p className="text-[13px] text-text-2">
        <Link href="/admin/try" className="font-medium text-accent-text hover:underline">
          ← Back to Try onboarding
        </Link>
      </p>
    </div>
  );
}
