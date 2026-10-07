'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';

export function AcceptInvite({
  token,
  email,
  expiresAt,
}: {
  token: string;
  email: string;
  expiresAt: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="mt-6 flex flex-col gap-2.5">
        <span className="text-xs font-medium text-text-3">Joining as</span>
        <div className="flex items-center gap-2.5 rounded-menu border border-border bg-card-2 px-3 py-2.5 text-[13.5px]">
          <span className="font-medium">{email}</span>
        </div>
      </div>
      <Button
        size="lg"
        className="mt-5 w-full"
        loading={busy}
        data-testid="accept-invite"
        onClick={async () => {
          setBusy(true);
          try {
            const out = unwrap(
              await apiBrowser().POST('/v1/commands/invitation.accept', { body: { token } }),
            );
            document.cookie = `${WORKSPACE_COOKIE}=${out.workspaceId}; path=/; max-age=31536000; samesite=lax`;
            toast.success('You are in.');
            // What an agency set up for them, to check and finish; else Home, with the tour of the menu the first
            // time (components/onboarding/tour.tsx).
            router.replace(
              out.setup ? `/onboarding/${out.workspaceId}` : `/app/w/${out.workspaceId}?tour=1`,
            );
            router.refresh();
          } catch (e) {
            setBusy(false);
            toast.error(errorMessage(e));
            router.refresh();
          }
        }}
      >
        Accept invitation
      </Button>
      <p className="mt-3.5 text-center text-xs text-text-3">
        This link works once and expires{' '}
        {new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.
      </p>
    </>
  );
}

export function SwitchAccount({ token }: { token: string }) {
  const router = useRouter();
  return (
    <Button
      size="lg"
      className="mt-5 w-full"
      data-testid="switch-account"
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.replace(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
        router.refresh();
      }}
    >
      Sign out and switch account
    </Button>
  );
}
