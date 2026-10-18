'use client';
import { deskReasonGiven, PAYOUT_WORDS } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PlatformPartnerPayoutsOut } from '@/lib/api/types';

const S = PAYOUT_WORDS.staff;

/**
 * Whether HandsFreeOS pays this business's partners (the partners plan's stage 3): staff open payouts one business at
 * a time, once the terms are checked, as the usage wallet is moved along one business at a time. Opening and closing
 * each take a reason, kept on the event (`partner.set_payouts_open`).
 */
export function PartnerPayoutsBlock({
  workspaceId,
  businessName,
  payouts,
  canChange,
}: {
  workspaceId: string;
  businessName: string;
  payouts: PlatformPartnerPayoutsOut;
  canChange: boolean;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opening = !payouts.open;

  const close = () => {
    setAsking(false);
    setReason('');
    setError(null);
  };

  const change = async () => {
    if (!deskReasonGiven(reason)) return setError(S.sayWhy);
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/partner.set_payouts_open', {
          body: { workspaceId, open: opening, reason: reason.trim() },
        }),
      );
      close();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-partner-payouts"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{S.title}</h2>
          <p className="mt-1 max-w-[560px] text-[13px] text-text-3">{S.explain}</p>
        </div>
        <Badge variant={payouts.open ? 'ok' : 'gray'} data-testid="admin-partner-payouts-state">
          {payouts.open ? S.open : S.closed}
        </Badge>
      </div>
      <p className="mt-3 text-[13px] text-text-2">
        {S.card(payouts.hasCard)} {S.payouts(payouts.payouts, payouts.latestStatus)}
      </p>
      {canChange ? (
        <Button
          className="mt-3"
          variant="secondary"
          onClick={() => setAsking(true)}
          data-testid="admin-partner-payouts-change"
        >
          {opening ? S.openIt : S.closeIt}
        </Button>
      ) : null}

      <Dialog open={asking} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent
          title={opening ? S.openTitle(businessName) : S.closeTitle(businessName)}
          description={opening ? S.openBody : S.closeBody}
        >
          <div className="mt-4 flex flex-col gap-4">
            <Field label={S.why} htmlFor="partner-payouts-reason">
              <Input
                id="partner-payouts-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={S.whyPlaceholder}
                data-testid="admin-partner-payouts-reason"
              />
            </Field>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
            <div className="flex gap-2">
              <Button
                onClick={() => void change()}
                disabled={busy}
                data-testid="admin-partner-payouts-confirm"
              >
                {S.confirm(opening)}
              </Button>
              <Button variant="ghost" onClick={close}>
                {S.cancel}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
