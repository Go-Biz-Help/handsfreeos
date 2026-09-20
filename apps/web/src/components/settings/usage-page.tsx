'use client';
import { money } from '@hfos/core';
import { CreditCard, Download, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ChangeEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type Wallet = Ok<'/v1/queries/wallet.get'>;
type Prices = Ok<'/v1/queries/usage.prices'>;
type Statement = Ok<'/v1/queries/usage.statement'>;
type Entry = Statement['items'][number];

const sectionTitle = 'text-lg font-semibold leading-[1.3] tracking-[-0.005em]';
const sectionDesc = 'mt-1 text-[13px] text-text-2';

function Section({
  title,
  description,
  action,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="px-[22px] py-5" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={sectionTitle}>{title}</h2>
          {description ? <p className={cn(sectionDesc, 'max-w-[460px]')}>{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/**
 * The balance, in words before numbers. A business glancing at this page wants to know whether it is fine, not
 * to do arithmetic — so the sentence says what the number means, and the number is underneath it.
 */
function balanceWords(w: Wallet): { headline: string; tone: 'ok' | 'warn' | 'bad' } {
  if (w.suspended) return { headline: 'Texts and calls have stopped', tone: 'bad' };
  if (!w.opened) return { headline: 'Nothing used yet', tone: 'ok' };
  if (w.balanceCents <= 0) return { headline: 'Your balance has run out', tone: 'bad' };
  if (w.balanceCents <= w.floorCents)
    return {
      headline: w.autoTopup && w.card ? 'Topping up shortly' : 'Running low',
      tone: w.autoTopup && w.card ? 'ok' : 'warn',
    };
  return { headline: 'You’re fine', tone: 'ok' };
}

const TONE: Readonly<Record<'ok' | 'warn' | 'bad', string>> = {
  ok: 'text-text',
  warn: 'text-warning-text',
  bad: 'text-danger-text',
};

/** A ledger row as a person reads it: what it was, when, and what it did to the balance. */
function Row({ entry }: { entry: Entry }) {
  const inward = entry.amountCents > 0;
  const when = new Date(entry.occurredAt);
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_90px_90px] items-center gap-3 border-t border-border py-2.5 text-[13px]"
      data-testid="usage-row"
    >
      <div className="min-w-0">
        <span className="block truncate">{entry.subject || 'Usage'}</span>
        <span className="block text-xs text-text-3">
          {when.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
          {entry.quantity !== null && entry.unit ? ` · ${entry.quantity} ${entry.unit}` : ''}
        </span>
      </div>
      <span className={cn('text-right font-mono', inward ? 'text-success-text' : 'text-text-2')}>
        {inward ? '+' : '−'}
        {money(Math.abs(entry.amountCents))}
      </span>
      <span className="text-right font-mono text-text-3">{money(entry.balanceAfterCents)}</span>
    </div>
  );
}

export function UsagePage({
  workspaceId,
  wallet,
  prices,
  statement,
}: {
  workspaceId: string;
  wallet: Wallet;
  prices: Prices;
  statement: Statement;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [autoTopup, setAutoTopup] = useState(wallet.autoTopup);
  const [floor, setFloor] = useState(String(wallet.floorCents / 100));
  const [topup, setTopup] = useState(String(wallet.topupCents / 100));
  const words = balanceWords(wallet);

  const save = (body: Record<string, unknown>, done: string) =>
    startSaving(async () => {
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/wallet.set_auto_topup', {
            body: { workspaceId, ...body },
          }),
        );
        toast.success(done);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
        setAutoTopup(wallet.autoTopup);
      }
    });

  const topUpNow = () =>
    startSaving(async () => {
      try {
        unwrap(await apiBrowser().POST('/v1/commands/wallet.top_up', { body: { workspaceId } }));
        toast.success('Topping up now.');
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  /** The statement as a spreadsheet. Built in the browser: it is already on the page. */
  const download = () => {
    const head = 'When,What,Amount,Balance after\n';
    const body = statement.items
      .map((e: Entry) =>
        [
          new Date(e.occurredAt).toISOString(),
          `"${(e.subject || 'Usage').replaceAll('"', '""')}"`,
          (e.amountCents / 100).toFixed(2),
          (e.balanceAfterCents / 100).toFixed(2),
        ].join(','),
      )
      .join('\n');
    const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'handsfreeos-usage.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-5" data-testid="usage-page">
      <Section
        title="Your balance"
        description="What texts, calls, phone numbers and AI replies come out of. Your plan is billed separately."
        testId="usage-balance"
        action={
          <Button onClick={topUpNow} disabled={saving || !wallet.card} data-testid="usage-top-up">
            Top up now
          </Button>
        }
      >
        <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <div className={cn('text-[28px] font-semibold leading-none', TONE[words.tone])}>
              {money(wallet.balanceCents)}
            </div>
            <div className={cn('mt-1.5 text-[13px]', TONE[words.tone])}>{words.headline}</div>
          </div>
          <div className="text-[13px] text-text-2">
            <div>{money(wallet.spentThisMonthCents)} this month</div>
            <div className="text-text-3">{money(wallet.spent30dCents)} in the last 30 days</div>
          </div>
          {wallet.pendingTopUpCents !== null ? (
            <Badge variant="accent">{money(wallet.pendingTopUpCents)} on its way</Badge>
          ) : null}
        </div>
        {wallet.suspended ? (
          <p className="mt-4 rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
            {wallet.suspended.reason ?? 'The card on this balance was declined.'} Add a working card
            and everything starts again.
          </p>
        ) : null}
        {/* Why the top-up is bigger than usual, and the one setting that fixes it — in the same breath. */}
        {wallet.escalation ? (
          <p
            className="mt-4 rounded-[10px] bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text"
            data-testid="usage-escalation"
          >
            {wallet.escalation}
          </p>
        ) : null}
      </Section>

      <Section
        title="Automatic top-up"
        description="When the balance gets low, we charge the card on file so nothing stops."
        testId="usage-auto-topup"
        action={
          <Switch
            checked={autoTopup}
            disabled={saving || !wallet.card}
            label="Top up automatically"
            onChange={(next) => {
              setAutoTopup(next);
              save(
                { autoTopup: next },
                next ? 'Automatic top-up is on.' : 'Automatic top-up is off.',
              );
            }}
          />
        }
      >
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-text-2">Top up when it drops below</span>
            <Input
              value={floor}
              inputMode="decimal"
              className="w-[120px]"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFloor(e.target.value)}
              onBlur={() => {
                const cents = Math.round(Number(floor) * 100);
                if (Number.isFinite(cents) && cents !== wallet.floorCents)
                  save({ floorCents: Math.max(0, cents) }, 'Saved.');
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-text-2">Add this much</span>
            <Input
              value={topup}
              inputMode="decimal"
              className="w-[120px]"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTopup(e.target.value)}
              onBlur={() => {
                const cents = Math.round(Number(topup) * 100);
                if (Number.isFinite(cents) && cents !== wallet.topupCents)
                  save({ topupCents: Math.max(500, cents) }, 'Saved.');
              }}
            />
          </label>
        </div>
        {!wallet.card ? (
          <p className="mt-3 text-[13px] text-text-3">
            Add a card below and automatic top-up will start working.
          </p>
        ) : null}
      </Section>

      <Section
        title="Card on file"
        description="Only ever used for your own balance — never for money your customers pay you."
        testId="usage-card"
      >
        <div className="mt-4 flex items-center gap-3 text-[13px]">
          {wallet.card ? (
            <>
              <CreditCard className="h-4 w-4 text-text-3" strokeWidth={1.8} />
              <span>
                {wallet.card.brand ?? 'Card'} ending {wallet.card.last4 ?? '••••'}
                {wallet.card.expiryMonth && wallet.card.expiryYear
                  ? ` · expires ${String(wallet.card.expiryMonth).padStart(2, '0')}/${String(wallet.card.expiryYear).slice(-2)}`
                  : ''}
              </span>
            </>
          ) : (
            <>
              <Wallet className="h-4 w-4 text-text-3" strokeWidth={1.8} />
              <span className="text-text-2">
                {wallet.cardRequested
                  ? 'Waiting for a card to be added.'
                  : 'No card on this balance yet.'}
              </span>
            </>
          )}
        </div>
      </Section>

      <Section
        title="What things cost"
        description="The prices on your account today."
        testId="usage-prices"
      >
        <div className="mt-3">
          {prices.items.map((p) => (
            <div
              key={p.key ?? p.what}
              className="flex items-center justify-between gap-3 border-t border-border py-2.5 text-[13px]"
            >
              <span className="text-text-2">{p.what}</span>
              <span className="font-mono">
                {p.unit === 'about' ? 'about ' : ''}
                {money(p.cents)}
                {p.unit !== 'about' && p.unit !== 'each' ? ` ${p.unit}` : ''}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Statement"
        description="Every text, call, number and AI reply you’ve been charged for."
        testId="usage-statement"
        action={
          statement.items.length ? (
            <Button variant="secondary" onClick={download} data-testid="usage-csv">
              <Download className="h-4 w-4" strokeWidth={1.8} />
              CSV
            </Button>
          ) : null
        }
      >
        {statement.items.length ? (
          <div className="mt-3">
            <div className="grid grid-cols-[minmax(0,1fr)_90px_90px] gap-3 pb-1.5 text-[12px] font-medium uppercase tracking-wide text-text-3">
              <span>What</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Balance</span>
            </div>
            {statement.items.map((e: Entry) => (
              <Row key={e.id} entry={e} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-[13px] text-text-3">
            Nothing yet. Texts, calls and AI replies show up here as they happen.
          </p>
        )}
      </Section>
    </div>
  );
}
