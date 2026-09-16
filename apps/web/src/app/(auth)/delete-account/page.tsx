import { Check, Globe, Smartphone, UserRoundX } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DeleteAccount } from '@/components/account/delete-account';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiServer, unwrap } from '@/lib/api/server';
import { getServerSession } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Delete your account',
  description:
    'How to delete your HandsFreeOS account, and what the businesses you worked with keep.',
};

function Step({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-accent-soft text-accent-text">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-[14.5px] font-semibold">{title}</h3>
        <p className="mt-0.5 text-[13.5px] leading-[1.5] text-text-2">{children}</p>
      </div>
    </div>
  );
}

/**
 * The public page on deleting an account (M10): the stores link here. Anyone can read how to do it in the app or on
 * the web and what happens to what they worked on; someone signed in can do it right here, including an account that
 * belongs to no business (it has no business settings to open).
 */
export default async function DeleteAccountPage() {
  const session = await getServerSession();
  let signedIn: { email: string; check: Awaited<ReturnType<typeof loadCheck>> } | null = null;
  if (session) {
    try {
      signedIn = { email: session.email, check: await loadCheck() };
    } catch {
      signedIn = null;
    }
  }
  return (
    <>
      <Card className="w-[560px] max-w-full rounded-dialog p-9 max-md:p-6">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
          Delete your HandsFreeOS account
        </h1>
        <p className="mt-1.5 text-text-2">
          You can delete your account yourself, from the app or on the web. It takes a moment and
          can’t be undone.
        </p>
        <div className="mt-6 flex flex-col gap-4">
          <Step icon={<Smartphone className="h-4 w-4" strokeWidth={1.75} />} title="In the app">
            Open More, then Settings, and press Delete my account. Type your email address to
            confirm.
          </Step>
          <Step icon={<Globe className="h-4 w-4" strokeWidth={1.75} />} title="On the web">
            Sign in, open Settings → Account, and choose Delete my account. Or sign in and do it on
            this page.
          </Step>
          <Step
            icon={<UserRoundX className="h-4 w-4" strokeWidth={1.75} />}
            title="What is removed"
          >
            Your sign-in, your name and photo, your place in each business, your cell phone and the
            phones you get notifications on, and your chats with the Assistant. You are signed out
            everywhere.
          </Step>
          <Step
            icon={<Check className="h-4 w-4" strokeWidth={1.75} />}
            title="What each business keeps"
          >
            The customers, messages, calls, jobs and notes you worked on stay with the business,
            shown as from a former teammate. A business’s only owner makes someone else an owner
            first, so it isn’t left without one.
          </Step>
        </div>
        <div className="mt-7 border-t border-border pt-6">
          {signedIn ? (
            <DeleteAccount email={signedIn.email} check={signedIn.check} />
          ) : (
            <div className="flex flex-col gap-2.5">
              <ButtonLink
                href={`/sign-in?next=${encodeURIComponent('/delete-account')}`}
                variant="primary"
                size="lg"
                className="w-full"
              >
                Sign in to delete my account
              </ButtonLink>
              <p className="text-center text-[13px] text-text-3">
                Forgot your password? Choose Email me a code on the sign-in page: it only needs your
                email address.
              </p>
            </div>
          )}
        </div>
      </Card>
      <p className="text-[13px] text-text-2">
        <Link href="/sign-in" className="font-medium text-accent-text hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}

async function loadCheck() {
  const { api } = await apiServer();
  return unwrap(await api.POST('/v1/queries/account.deletion_check', { body: {} }));
}
