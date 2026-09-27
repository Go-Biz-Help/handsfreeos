'use client';
import { money } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type Wallet = Ok<'/v1/queries/platform.wallet.get'>;
type Stage = Wallet['stage'];

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
const STAGE_WORDS: Readonly<Record<Stage, { label: string; what: string }>> = {
  off: {
    label: 'Silent',
    what: 'They do not know the balance exists. Nothing is shown to them and nothing stops.',
  },
  warn: {
    label: 'Warned',
    what: 'They see their balance and statement and are told when it runs low or out. Nothing stops.',
  },
  enforce: {
    label: 'Stopped at zero',
    what: 'The same, and outgoing texts and calls stop once the balance runs out. No overdraft applies.',
  },
  agency: {
    label: 'Paid by the agency',
    what: 'The agency pays for everything they use. They never see a balance, are never asked for a card, and nothing stops. Usage is still recorded here; moving them off writes off what they ran up.',
  },
};

const STAGE_TONE: Readonly<Record<Stage, BadgeVariant>> = {
  off: 'member',
  warn: 'accent',
  enforce: 'pending',
  agency: 'ok',
};

/** Charged over cost, as a multiple. Null where nothing cost us anything, which is not a margin of infinity. */
function realised(w: Wallet): number | null {
  return w.cost30dCents > 0 ? w.spent30dCents / w.cost30dCents : null;
}

function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-text-3">{label}</span>
      <span className={cn('font-mono', tone)}>{value}</span>
    </div>
  );
}

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
  const [amount, setAmount] = useState('25');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMoving(null);
    setCrediting(false);
    setReason('');
    setError(null);
  };

  const run = async (fn: () => Promise<unknown>) => {
    if (reason.trim().length < 3) return setError('Say why, in a few words.');
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
      const cents = Math.round(Number(amount) * 100);
      if (!Number.isFinite(cents) || cents === 0) throw new Error('Put in an amount.');
      unwrap(
        await apiBrowser().POST('/v1/commands/wallet.adjust', {
          body: {
            workspaceId,
            amountCents: cents,
            reason: reason.trim(),
            // One reference per decision: sending the same one twice is the same credit, not a second.
            reference: `admin:${workspaceId}:${Date.now()}`,
          },
        }),
      );
    });

  const margin = realised(wallet);
  const stage = STAGE_WORDS[wallet.stage];

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-wallet"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Their balance</h2>
          <p className="mt-1 text-[13px] text-text-3">
            What they pay us for texts, calls, numbers and AI — not money their own customers owe
            them.
          </p>
        </div>
        <Badge variant={STAGE_TONE[wallet.stage]} data-testid="admin-wallet-stage">
          {stage.label}
        </Badge>
      </div>

      {!wallet.opened ? (
        <p className="mt-4 text-[13px] text-text-3">
          Nothing yet. They have never spent anything and have never been moved along.
        </p>
      ) : (
        <div className="mt-4 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
          {/* Under the agency the balance only runs down: it is what the agency is covering, not a debt. */}
          <Line
            label={wallet.stage === 'agency' ? 'Balance, the agency covers it' : 'Balance'}
            value={money(wallet.balanceCents)}
            tone={
              wallet.balanceCents <= 0 && wallet.stage !== 'agency' ? 'text-danger-text' : undefined
            }
          />
          <Line
            label="Card"
            value={
              wallet.hasCard
                ? `${wallet.cardBrand ?? 'Card'} ····${wallet.cardLast4 ?? '????'}`
                : 'None'
            }
          />
          <Line
            label="Automatic top-up"
            value={
              wallet.autoTopup
                ? `${money(wallet.topupCents)} below ${money(wallet.floorCents)}`
                : 'Off'
            }
          />
          <Line label="Topped up, 30 days" value={money(wallet.toppedUp30dCents)} />
          <Line label="Charged them, 30 days" value={money(wallet.spent30dCents)} />
          {/* The only place in the product this number appears. Under 1.2x means the rate card is wrong. */}
          <Line
            label="Cost us, 30 days"
            value={`${money(wallet.cost30dCents)}${margin === null ? '' : ` · ${margin.toFixed(2)}×`}`}
            tone={margin !== null && margin < 1.2 ? 'text-danger-text' : undefined}
          />
          {wallet.declinesInRow > 0 ? (
            <Line
              label="Declines in a row"
              value={String(wallet.declinesInRow)}
              tone="text-danger-text"
            />
          ) : null}
          {wallet.escalationStep > 0 ? (
            <Line label="Top-up escalation" value={`step ${wallet.escalationStep}`} />
          ) : null}
        </div>
      )}

      {wallet.suspendedAt ? (
        <p className="mt-4 rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
          Suspended {new Date(wallet.suspendedAt).toLocaleDateString()} ·{' '}
          {wallet.suspendedReason ?? 'the card was declined'}
        </p>
      ) : null}

      <p className="mt-4 text-[13px] text-text-3">{stage.what}</p>

      {canChange ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(STAGE_WORDS) as Stage[])
            .filter((s) => s !== wallet.stage)
            .map((s) => (
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
                Move to {STAGE_WORDS[s].label.toLowerCase()}
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
            Put a credit on
          </Button>
        </div>
      ) : null}

      <Dialog open={moving !== null} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent
          title={moving ? `Move ${businessName} to ${STAGE_WORDS[moving].label.toLowerCase()}` : ''}
          description={moving ? STAGE_WORDS[moving].what : ''}
        >
          <div className="mt-4 flex flex-col gap-4">
            {wallet.stage === 'agency' && wallet.balanceCents < 0 ? (
              <p className="rounded-[10px] bg-card-2 px-3.5 py-3 text-[13px] text-text-2">
                The {money(-wallet.balanceCents)} they ran up while the agency paid is written off
                with a credit, so they start from zero.
              </p>
            ) : null}
            {moving === 'enforce' ? (
              <p className="rounded-[10px] bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text">
                From now on their outgoing texts and calls stop when the balance runs out. Calls
                coming in still reach them. Check they have a card on file first.
              </p>
            ) : null}
            <Field label="Why?" htmlFor="wallet-stage-reason">
              <Input
                id="wallet-stage-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="First cohort, they have a card and have been warned a week"
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
                Move them
              </Button>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={crediting} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent
          title={`Put a credit on ${businessName}`}
          description="It shows on their statement like everything else, with your reason. A negative amount takes one back."
        >
          <div className="mt-4 flex flex-col gap-4">
            <Field label="How much, in dollars?" htmlFor="wallet-credit-amount">
              <Input
                id="wallet-credit-amount"
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
                data-testid="admin-wallet-amount"
              />
            </Field>
            <Field label="Why?" htmlFor="wallet-credit-reason">
              <Input
                id="wallet-credit-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Sorry about the outage on the 14th"
                data-testid="admin-wallet-credit-reason"
              />
            </Field>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
            <div className="flex gap-2">
              <Button onClick={credit} disabled={busy} data-testid="admin-wallet-credit-confirm">
                Put it on
              </Button>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
