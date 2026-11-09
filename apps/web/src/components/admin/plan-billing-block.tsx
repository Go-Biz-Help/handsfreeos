'use client';
import { BILLING_WORDS as W } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Billing = Ok<'/v1/queries/platform.billing.business'>;
type Request = Billing['requests'][number];

const noon = (day: string) => `${day}T12:00:00Z`;

/**
 * A business's plan payments, on its page under /admin/businesses (20261027023600): what's owed and since when, how
 * many cards it has, and its requests for more time, each with Give them until… (their day, or another) and Say no.
 * A yes lifts their failed-payment page and pauses the retries until that day.
 */
export function PlanBillingBlock({ billing }: { billing: Billing }) {
  const owed = billing.owed;
  return (
    <Card className="px-[22px] py-5" data-testid="admin-plan-billing">
      <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">{W.adminTitle}</h2>
      <p className="mt-1 text-[13px] text-text-2">
        {owed ? W.adminOwed(owed.amountCents, owed.failedAt, owed.problem) : W.adminNothingOwed}{' '}
        {W.adminCards(billing.cardCount)}
      </p>
      {owed?.moreTimeUntil ? (
        <p className="mt-1 text-[13px] text-text-2">{W.adminGranted(owed.moreTimeUntil)}</p>
      ) : null}
      {billing.requests.length > 0 ? (
        <ul className="mt-3 flex flex-col">
          {billing.requests.map((r) => (
            <RequestRow key={r.id} request={r} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function RequestRow({ request: r }: { request: Request }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [picking, setPicking] = useState(false);
  const [until, setUntil] = useState(r.payBy);
  const answer = (grant: boolean, day?: string) =>
    start(async () => {
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/billing.answer_more_time', {
            body: { requestId: r.id, grant, ...(grant && day ? { until: day } : {}) },
          }),
        );
        setPicking(false);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });
  return (
    <li className="border-t border-border py-3 text-[13px]" data-testid="admin-plan-time-request">
      <p>
        {W.adminAsked(noon(r.payBy), r.askedBy, r.askedAt)}
        {r.ticketNumber ? (
          <span className="text-text-3"> · {W.adminTicket(r.ticketNumber)}</span>
        ) : null}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-text-2">{r.note || W.adminNoNote}</p>
      {r.status === 'pending' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => answer(true)}
            disabled={busy}
            data-testid="admin-plan-time-grant"
          >
            {W.adminGrant(noon(r.payBy))}
          </Button>
          {picking ? (
            <>
              <Input
                type="date"
                inputSize="sm"
                aria-label={W.adminUntil}
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="w-[160px]"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => answer(true, until)}
                disabled={busy || !until}
              >
                {W.adminGrant(noon(until || r.payBy))}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setPicking(true)} disabled={busy}>
              {W.adminOtherDay}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => answer(false)}
            disabled={busy}
            data-testid="admin-plan-time-decline"
          >
            {W.adminDecline}
          </Button>
        </div>
      ) : (
        <p className="mt-1 text-text-3">
          {r.status === 'granted' && r.grantedUntil
            ? W.adminGranted(noon(r.grantedUntil))
            : W.adminDeclined}
        </p>
      )}
    </li>
  );
}
