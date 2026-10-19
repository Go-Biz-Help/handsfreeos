'use client';

/**
 * Taking a founding seat up from its link (0093): pick the workspace it goes on, then either take it (a free
 * seat) or go and pay for it (a paid one).
 *
 * Nothing here decides who may. The page only offers the workspaces this person runs in the business the seat
 * was approved for, because offering any other would only lead to a refusal — but the refusal is the
 * database's, and it is what actually stops somebody.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';

export interface ClaimWorkspace {
  readonly id: string;
  readonly name: string;
}

export function ClaimSeat({
  token,
  paid,
  yearly = false,
  priceLabel,
  workspaces,
  checkoutId,
}: {
  token: string;
  paid: boolean;
  /** Paid by the year: the card is charged again each year, until they stop it. */
  yearly?: boolean;
  priceLabel: string;
  workspaces: readonly ClaimWorkspace[];
  /** A payment already under way on this seat: carry on with it rather than start another. */
  checkoutId: string | null;
}) {
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  if (checkoutId)
    return (
      <ButtonLink
        href={`/founding/checkout/${checkoutId}`}
        variant="primary"
        size="lg"
        className="mt-6 w-full"
      >
        Carry on paying
      </ButtonLink>
    );

  const go = async () => {
    setBusy(true);
    try {
      if (paid) {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/founding.start_checkout', {
            body: { token, workspaceId },
          }),
        );
        router.push(`/founding/checkout/${out.checkoutId}`);
        return;
      }
      unwrap(
        await apiBrowser().POST('/v1/commands/founding.claim', { body: { token, workspaceId } }),
      );
      document.cookie = `${WORKSPACE_COOKIE}=${workspaceId}; path=/; max-age=31536000; samesite=lax`;
      toast.success('Your founding seat is yours.');
      router.replace(`/app/w/${workspaceId}`);
      router.refresh();
    } catch (e) {
      setBusy(false);
      toast.error(errorMessage(e));
      router.refresh();
    }
  };

  return (
    <>
      {workspaces.length > 1 ? (
        <div className="mt-6 flex flex-col gap-2" role="radiogroup" aria-label="Which workspace">
          <span className="text-xs font-medium text-text-3">Which workspace it goes on</span>
          {workspaces.map((w) => (
            <RadioCard
              key={w.id}
              selected={w.id === workspaceId}
              onSelect={() => setWorkspaceId(w.id)}
              title={w.name}
            />
          ))}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2.5">
          <span className="text-xs font-medium text-text-3">It goes on</span>
          <div className="rounded-menu border border-border bg-card-2 px-3 py-2.5 text-[13.5px] font-medium">
            {workspaces[0]?.name}
          </div>
        </div>
      )}
      <Button
        size="lg"
        className="mt-5 w-full"
        loading={busy}
        disabled={!workspaceId}
        data-testid="claim-seat"
        onClick={() => void go()}
      >
        {paid ? `Pay ${priceLabel}` : 'Take up my seat'}
      </Button>
      <p className="mt-3.5 text-center text-xs text-text-3">
        {paid && yearly
          ? 'You pay on Stripe’s secure page, and it renews each year on the same card. Stop it any time in Settings → Usage & balance.'
          : paid
            ? 'You pay on Stripe’s secure page. Your seat is held while you do.'
            : 'This link works once. The seat covers one workspace.'}
      </p>
    </>
  );
}

/** Nothing of theirs to put it on: most often, signed in with a different account from the one that applied. */
export function ClaimSwitchAccount({ token }: { token: string }) {
  const router = useRouter();
  return (
    <Button
      size="lg"
      className="mt-5 w-full"
      data-testid="claim-switch-account"
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.replace(`/sign-in?next=${encodeURIComponent(`/founding/${token}`)}`);
        router.refresh();
      }}
    >
      Sign out and use another account
    </Button>
  );
}
