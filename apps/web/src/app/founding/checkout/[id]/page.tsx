import type { Metadata } from 'next';
import { CheckoutStatus } from '@/components/founding/checkout-status';
import { Brand } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Paying for your founding spot' };

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * One founding spot's payment (0093): the page that waits for Stripe's page to be made and sends them there, and
 * the page Stripe sends them back to. Only for whoever runs the workspace it is for — anybody else is shown the
 * same "not found" as a checkout that never existed. A spot bought from the plan page after signing up
 * (20261027012700) goes on to the setup from here.
 */
export default async function FoundingCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ back?: string }>;
}) {
  const [{ id }, { back }] = await Promise.all([params, searchParams]);
  const { api } = await apiServer();
  const status = unwrapPage(
    await api.POST('/v1/queries/founding.checkout_status', { body: { checkoutId: id } }),
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <Card className="w-[480px] max-w-full rounded-dialog p-9">
        <span className="text-[13px] text-text-2">
          {status.renewal
            ? `${money(status.amountCents)}, another ${status.billing === 'monthly' ? 'month' : 'year'}`
            : status.billing === 'yearly'
              ? `${money(status.amountCents)} a year`
              : status.billing === 'monthly'
                ? `${money(status.amountCents)} a month`
                : `${money(status.amountCents)}, paid once`}
        </span>
        <h1 className="mt-1 text-2xl font-semibold leading-tight tracking-tight">
          {status.offerName}
        </h1>
        <CheckoutStatus
          initial={status}
          back={back === 'paid' || back === 'cancel' ? back : null}
        />
      </Card>
    </div>
  );
}
