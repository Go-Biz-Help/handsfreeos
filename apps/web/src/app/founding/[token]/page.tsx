import type { Metadata } from 'next';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { ClaimSeat, ClaimSwitchAccount } from '@/components/founding/claim-seat';
import { Brand } from '@/components/ui/brand';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, apiServer, getMe, unwrap } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Your founding seat' };

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

/**
 * Where a founding claim link opens (0093). Signed in only — the proxy sends anybody else to sign in and back.
 *
 * The seat was approved for a **business**, so the page offers the workspaces this person runs in that business
 * and nothing else. Somebody signed in with a different account sees why nothing is offered and how to switch,
 * rather than a list of workspaces the database would refuse.
 */
export default async function FoundingClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { api, email } = await apiServer();
  let seat: Awaited<ReturnType<typeof load>> | null = null;
  async function load() {
    return unwrap(await api.POST('/v1/queries/founding.claim_preview', { body: { token } }));
  }
  try {
    seat = await load();
  } catch (e) {
    if (!(e instanceof ApiError && (e.status === 404 || e.status === 400))) throw e;
  }
  const me = seat ? await getMe() : null;
  // Owners and admins run a workspace; a member cannot put a seat on one, so it is not offered.
  const workspaces = (me?.workspaces ?? [])
    .filter((w) => w.organizationId === seat?.organizationId)
    .filter((w) => w.role === 'owner' || w.role === 'admin')
    .map((w) => ({ id: w.id, name: w.name }));
  const paid = (seat?.priceCents ?? 0) > 0;
  const priceLabel = seat ? money(seat.priceCents) : '';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <Card className="w-[480px] max-w-full rounded-dialog p-9">
        {!seat ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">That link doesn’t work</h1>
            <p className="mt-2 leading-relaxed text-text-2">
              It may have been mistyped, or cut short by your email. Ask us for a new one.
            </p>
            <ButtonLink href="/app" variant="primary" size="lg" className="mt-6 w-full">
              Go to your workspaces
            </ButtonLink>
          </>
        ) : (
          <>
            <span className="text-[13px] text-text-2">{seat.businessName}</span>
            <h1 className="mt-1 text-2xl font-semibold leading-tight tracking-tight">
              {seat.offerName}
            </h1>
            <p className="mt-2 leading-relaxed text-text-2">
              {paid && seat.billing === 'yearly'
                ? `HandsFreeOS for one business: ${priceLabel} a year, renewed on its own until you stop it. Texts, calls and AI are billed for what you use.`
                : paid
                  ? `HandsFreeOS for as long as it exists, for one business: ${priceLabel}, paid once. Texts, calls and AI are billed for what you use.`
                  : 'HandsFreeOS free for as long as it exists, for one business. Texts, calls and AI are billed for what you use.'}
            </p>

            {seat.state === 'ready' && workspaces.length > 0 ? (
              <ClaimSeat
                token={token}
                paid={paid}
                yearly={seat.billing === 'yearly'}
                priceLabel={priceLabel}
                workspaces={workspaces}
                checkoutId={seat.checkoutId}
              />
            ) : seat.state === 'ready' ? (
              <>
                <div
                  className="mt-6 flex gap-3 rounded-menu bg-danger-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-danger-text"
                  data-testid="claim-no-workspace"
                >
                  <AlertCircle className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
                  <span>
                    This seat is for {seat.businessName}, but you are signed in as{' '}
                    <strong className="font-semibold">{email}</strong>, who doesn’t run a workspace
                    there. Sign in with the account that applied.
                  </span>
                </div>
                <ClaimSwitchAccount token={token} />
              </>
            ) : seat.state === 'claimed' ? (
              <>
                <div
                  className="mt-6 flex gap-3 rounded-menu bg-warning-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-warning-text"
                  data-testid="claim-used"
                >
                  <CheckCircle2 className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
                  <span>This seat is already taken up. Each link works once.</span>
                </div>
                <ButtonLink href="/app" variant="primary" size="lg" className="mt-5 w-full">
                  Open your workspaces
                </ButtonLink>
              </>
            ) : (
              <div
                className="mt-6 flex gap-3 rounded-menu bg-warning-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-warning-text"
                data-testid={`claim-${seat.state}`}
              >
                <Clock className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
                <span>
                  {seat.state === 'expired' && seat.expiresAt
                    ? `This link ran out on ${day(seat.expiresAt)}. Ask us for a new one — if the seat is still yours, we will send it.`
                    : 'This seat is no longer held for you. If you think that’s a mistake, ask us.'}
                </span>
              </div>
            )}
          </>
        )}
      </Card>
      <p className="text-[13px] text-text-3">
        Not ready yet? Close this page. Nothing changes until you press the button.
      </p>
    </div>
  );
}
