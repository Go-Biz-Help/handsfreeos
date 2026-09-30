'use client';
import {
  DESK_WALLET_STAGES,
  DESK_WALLET_STAGE_TONES,
  DESK_WALLET_WORDS,
  deskCreditCents,
  deskCreditReference,
  deskReasonGiven,
  deskWalletLines,
  deskWalletMoves,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type Wallet = Ok<'/v1/queries/platform.wallet.get'>;
type Stage = Wallet['stage'];

function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-text-3">{label}</span>
      <span className={cn('font-mono', tone)}>{value}</span>
    </div>
  );
}

/**
 * One business's usage balance, for the support desk (M16).
 *
 * Two things happen here that happen nowhere else in the product. **Cost is shown beside price** — a business
 * is shown what it was charged, because that is the number it decides on, and staff are shown both, because
 * the question they get asked is why. And **the rollout switch lives here**: moving a business from silent to
 * warned to stopped is the only control in HandsFreeOS that can stop somebody's phone working, so it is one
 * business at a time, behind a confirmation, with a reason. One stage sits beside the rollout rather than on
 * it: **paid by the agency**, for a business the agency runs for itself. Its usage is still recorded at cost and
 * price, but the business never sees a balance and nothing stops; moving it off settles what it ran up.
 */
export function WalletBlock({
  workspaceId,
  businessName,
  wallet,
  canChange,
}: {
  workspaceId: string;
  businessName: string;
  wallet: Wallet;
  canChange: boolean;
}) {
  const router = useRouter();
  const [moving, setMoving] = useState<Stage | null>(null);
  const [crediting, setCrediting] = useState(false);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState<string>(DESK_WALLET_WORDS.defaultAmount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMoving(null);
    setCrediting(false);
    setReason('');
    setError(null);
  };

  const run = async (fn: () => Promise<unknown>) => {
    if (!deskReasonGiven(reason)) return setError(DESK_WALLET_WORDS.sayWhy);
    setBusy(true);
    setError(null);
    try {
      await fn();
      close();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const moveTo = (stage: Stage) =>
    run(async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/wallet.set_stage', {
          body: { workspaceId, stage, reason: reason.trim() },
        }),
      ),
    );

  const credit = () =>
    run(async () => {
      const cents = deskCreditCents(amount);
      if (cents === null) throw new Error(DESK_WALLET_WORDS.putInAmount);
      unwrap(
        await apiBrowser().POST('/v1/commands/wallet.adjust', {
          body: {
            workspaceId,
            amountCents: cents,
            reason: reason.trim(),
            // One reference per decision: sending the same one twice is the same credit, not a second.
            reference: deskCreditReference(workspaceId),
          },
        }),
      );
    });

  const stage = DESK_WALLET_STAGES[wallet.stage];

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-wallet"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{DESK_WALLET_WORDS.title}</h2>
          <p className="mt-1 text-[13px] text-text-3">{DESK_WALLET_WORDS.explain}</p>
        </div>
        <Badge variant={DESK_WALLET_STAGE_TONES[wallet.stage]} data-testid="admin-wallet-stage">
          {stage.label}
        </Badge>
      </div>

      {!wallet.opened ? (
        <p className="mt-4 text-[13px] text-text-3">{DESK_WALLET_WORDS.notOpened}</p>
      ) : (
        <div className="mt-4 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
          {/* Cost beside price, the one place in the product it shows; under 1.2x the rate card is wrong. */}
          {deskWalletLines(wallet).map((l) => (
            <Line
              key={l.label}
              label={l.label}
              value={l.value}
              tone={l.tone === 'danger' ? 'text-danger-text' : undefined}
            />
          ))}
        </div>
      )}

      {wallet.suspendedAt ? (
        <p className="mt-4 rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
          {DESK_WALLET_WORDS.suspended(
            new Date(wallet.suspendedAt).toLocaleDateString(),
            wallet.suspendedReason,
          )}
        </p>
      ) : null}

      <p className="mt-4 text-[13px] text-text-3">{stage.what}</p>

      {canChange ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {deskWalletMoves(wallet.stage).map((s) => (
            <Button
              key={s}
              variant="secondary"
              onClick={() => {
                setMoving(s);
                setReason('');
                setError(null);
              }}
              data-testid={`admin-wallet-to-${s}`}
            >
              {DESK_WALLET_WORDS.moveTo(s)}
            </Button>
          ))}
          <Button
            variant="ghost"
            onClick={() => {
              setCrediting(true);
              setReason('');
              setError(null);
            }}
            data-testid="admin-wallet-credit"
          >
            {DESK_WALLET_WORDS.credit}
          </Button>
        </div>
      ) : null}

      <Dialog open={moving !== null} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent
          title={moving ? DESK_WALLET_WORDS.moveTitle(businessName, moving) : ''}
          description={moving ? DESK_WALLET_STAGES[moving].what : ''}
        >
          <div className="mt-4 flex flex-col gap-4">
            {wallet.stage === 'agency' && wallet.balanceCents < 0 ? (
              <p className="rounded-[10px] bg-card-2 px-3.5 py-3 text-[13px] text-text-2">
                {DESK_WALLET_WORDS.writtenOff(-wallet.balanceCents)}
              </p>
            ) : null}
            {moving === 'enforce' ? (
              <p className="rounded-[10px] bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text">
                {DESK_WALLET_WORDS.enforceWarning}
              </p>
            ) : null}
            <Field label={DESK_WALLET_WORDS.why} htmlFor="wallet-stage-reason">
              <Input
                id="wallet-stage-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={DESK_WALLET_WORDS.movePlaceholder}
                data-testid="admin-wallet-reason"
              />
            </Field>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
            <div className="flex gap-2">
              <Button
                onClick={() => moving && moveTo(moving)}
                disabled={busy}
                data-testid="admin-wallet-confirm"
              >
                {DESK_WALLET_WORDS.moveThem}
              </Button>
              <Button variant="ghost" onClick={close}>
                {DESK_WALLET_WORDS.cancel}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={crediting} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent
          title={DESK_WALLET_WORDS.creditTitle(businessName)}
          description={DESK_WALLET_WORDS.creditExplain}
        >
          <div className="mt-4 flex flex-col gap-4">
            <Field label={DESK_WALLET_WORDS.howMuch} htmlFor="wallet-credit-amount">
              <Input
                id="wallet-credit-amount"
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
                data-testid="admin-wallet-amount"
              />
            </Field>
            <Field label={DESK_WALLET_WORDS.why} htmlFor="wallet-credit-reason">
              <Input
                id="wallet-credit-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={DESK_WALLET_WORDS.creditPlaceholder}
                data-testid="admin-wallet-credit-reason"
              />
            </Field>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
            <div className="flex gap-2">
              <Button onClick={credit} disabled={busy} data-testid="admin-wallet-credit-confirm">
                {DESK_WALLET_WORDS.putItOn}
              </Button>
              <Button variant="ghost" onClick={close}>
                {DESK_WALLET_WORDS.cancel}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
