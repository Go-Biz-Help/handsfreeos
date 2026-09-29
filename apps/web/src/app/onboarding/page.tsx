import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Brand } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import { apiServer, getMe } from '@/lib/api/server';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: 'Set up your business' };

export default async function OnboardingPage() {
  const { email } = await apiServer();
  const me = await getMe();
  if (me.workspaces.length > 0) redirect(`/app/w/${me.workspaces[0]!.id}`);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <Card className="w-[520px] max-w-full rounded-dialog p-9">
        <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
          Step 1 of 2
        </div>
        <h1 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.015em]">
          Set up your business
        </h1>
        <p className="mt-1.5 text-text-2">
          This creates your first workspace. Everything HandsFreeOS does happens inside it.
        </p>
        <OnboardingForm />
      </Card>
      <p className="text-[13px] text-text-3">Signed in as {email}</p>
    </div>
  );
}
