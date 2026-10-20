'use client';
import {
  BALANCE_WORDS,
  balanceHeadline,
  cardLine,
  money,
  topUpCapLine,
  usageQuantityWords,
  type SettingKey,
} from '@hfos/core';
import { CreditCard, Download, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { walletCard } from '@/lib/api/worker';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { settingAttrs } from './setting-anchor';

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
  setting,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
  /** Its key in settings search. */
  setting?: SettingKey;
}) {
  return (
    <Card className="px-[22px] py-5" data-testid={testId} {...settingAttrs(setting)}>
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
        <span className="block truncate">{entry.subject || BALANCE_WORDS.usage}</span>
        <span className="block text-xs text-text-3">
          {when.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
          {entry.quantity !== null && entry.unit
            ? ` · ${usageQuantityWords(entry.quantity, entry.unit)}`
            : ''}
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
  const words = balanceHeadline(wallet);

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

  const forgetCard = () =>
    startSaving(async () => {
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/wallet.forget_card', { body: { workspaceId } }),
        );
        toast.success(BALANCE_WORDS.cardRemoved);
        setAutoTopup(false);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  /**
   * Phase one: ask the worker for the provider's own card page and go there. The worker builds the address it
   * sends them back to, so nothing here can point it anywhere else.
   */
  const addCard = () =>
    startSaving(async () => {
      try {
        const started = await walletCard({ workspaceId });
        if (started.stage !== 'started') return;
        window.location.assign(started.hostedUrl);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  const topUpNow = () =>
    startSaving(async () => {
      try {
        unwrap(await apiBrowser().POST('/v1/commands/wallet.top_up', { body: { workspaceId } }));
        toast.success(BALANCE_WORDS.toppingUp);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  /**
   * Phase two: back from the card page. The session on the address is only a name for what happened — the
   * worker reads the card off the provider itself — and it is taken off the address either way, so a refresh
   * never saves anything twice.
   */
  const returned = useRef(false);
  useEffect(() => {
    // Read off the address itself rather than through `useSearchParams`, which would put this page behind a
    // Suspense boundary for one query parameter it reads once, on the way back from the provider.
    const mark = new URLSearchParams(window.location.search).get('card');
    if (!mark || returned.current) return;
    returned.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (mark === 'cancelled') {
      toast.info(BALANCE_WORDS.cardNotSaved);
      return;
    }
    startSaving(async () => {
      try {
        const answer = await walletCard({ workspaceId, sessionRef: mark });
        if (answer.stage === 'saved' && answer.card.cardLast4)
          toast.success(
            BALANCE_WORDS.cardSaved(
              cardLine({
                brand: answer.card.cardBrand,
                last4: answer.card.cardLast4,
                expiryMonth: answer.card.cardExpiryMonth,
                expiryYear: answer.card.cardExpiryYear,
              }),
            ),
          );
        else toast.info(BALANCE_WORDS.cardNotSaved);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });
  }, [router, workspaceId]);

  /** The statement as a spreadsheet. Built in the browser: it is already on the page. */
  const download = () => {
    const head = 'When,What,Amount,Balance after\n';
    const body = statement.items
      .map((e: Entry) =>
        [
          new Date(e.occurredAt).toISOString(),
          `"${(e.subject || BALANCE_WORDS.usage).replaceAll('"', '""')}"`,
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
        title={BALANCE_WORDS.balance}
        description={BALANCE_WORDS.balanceDetail}
        testId="usage-balance"
        setting="usage.balance"
        action={
          <Button onClick={topUpNow} disabled={saving || !wallet.card} data-testid="usage-top-up">
            {BALANCE_WORDS.topUp}
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
            <div>{BALANCE_WORDS.thisMonth(wallet.spentThisMonthCents)}</div>
            <div className="text-text-3">{BALANCE_WORDS.last30(wallet.spent30dCents)}</div>
          </div>
          {wallet.pendingTopUpCents !== null ? (
            <Badge variant="accent">{BALANCE_WORDS.onItsWay(wallet.pendingTopUpCents)}</Badge>
          ) : null}
        </div>
        {wallet.suspended ? (
          <p className="mt-4 rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
            {wallet.suspended.reason ?? BALANCE_WORDS.suspendedFallback}{' '}
            {BALANCE_WORDS.suspendedTail}
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
        title={BALANCE_WORDS.autoTitle}
        description={BALANCE_WORDS.autoDetail}
        testId="usage-auto-topup"
        setting="usage.auto_top_up"
        action={
          <Switch
            checked={autoTopup}
            disabled={saving || !wallet.card}
            label={BALANCE_WORDS.autoSwitch}
            onChange={(next) => {
              setAutoTopup(next);
              save({ autoTopup: next }, next ? BALANCE_WORDS.autoOn : BALANCE_WORDS.autoOff);
            }}
          />
        }
      >
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-text-2">{BALANCE_WORDS.floorLabel}</span>
            <Input
              value={floor}
              inputMode="decimal"
              className="w-[120px]"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFloor(e.target.value)}
              onBlur={() => {
                const cents = Math.round(Number(floor) * 100);
                if (Number.isFinite(cents) && cents !== wallet.floorCents)
                  save({ floorCents: Math.max(0, cents) }, BALANCE_WORDS.saved);
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-text-2">{BALANCE_WORDS.amountLabel}</span>
            <Input
              value={topup}
              inputMode="decimal"
              className="w-[120px]"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTopup(e.target.value)}
              onBlur={() => {
                const cents = Math.round(Number(topup) * 100);
                if (Number.isFinite(cents) && cents !== wallet.topupCents)
                  save({ topupCents: Math.max(500, cents) }, BALANCE_WORDS.saved);
              }}
            />
          </label>
        </div>
        {/* The cap the terms promise is shown. It is the one that actually applies, not the headline. */}
        <p className="mt-3 text-[13px] text-text-3" data-testid="usage-topup-cap">
          {topUpCapLine(wallet.maxTopupCents)}
        </p>
        {!wallet.card ? (
          <p className="mt-3 text-[13px] text-text-3">{BALANCE_WORDS.autoNeedsCard}</p>
        ) : null}
      </Section>

      <Section
        title={BALANCE_WORDS.cardTitle}
        description={BALANCE_WORDS.cardDetail}
        testId="usage-card"
        setting="usage.card"
        action={
          <div className="flex gap-2">
            <Button onClick={addCard} disabled={saving} data-testid="usage-add-card">
              {wallet.card ? BALANCE_WORDS.changeCard : BALANCE_WORDS.addCard}
            </Button>
            {wallet.card ? (
              <Button
                variant="secondary"
                onClick={forgetCard}
                disabled={saving}
                data-testid="usage-forget-card"
              >
                {BALANCE_WORDS.removeCard}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="mt-4 flex items-center gap-3 text-[13px]">
          {wallet.card ? (
            <>
              <CreditCard className="h-4 w-4 text-text-3" strokeWidth={1.8} />
              <span>{cardLine(wallet.card)}</span>
            </>
          ) : (
            <>
              <Wallet className="h-4 w-4 text-text-3" strokeWidth={1.8} />
              <span className="text-text-2">
                {wallet.cardRequested ? BALANCE_WORDS.cardWaiting : BALANCE_WORDS.cardNone}
              </span>
            </>
          )}
        </div>
        <p className="mt-3 text-[13px] text-text-3">{BALANCE_WORDS.cardOnProvider}</p>
      </Section>

      <Section
        title={BALANCE_WORDS.pricesTitle}
        description={BALANCE_WORDS.pricesDetail}
        testId="usage-prices"
        setting="usage.prices"
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
        title={BALANCE_WORDS.statementTitle}
        description={BALANCE_WORDS.statementDetail}
        testId="usage-statement"
        setting="usage.statement"
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
              <span>{BALANCE_WORDS.columnWhat}</span>
              <span className="text-right">{BALANCE_WORDS.columnAmount}</span>
              <span className="text-right">{BALANCE_WORDS.columnBalance}</span>
            </div>
            {statement.items.map((e: Entry) => (
              <Row key={e.id} entry={e} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-[13px] text-text-3">{BALANCE_WORDS.statementEmpty}</p>
        )}
      </Section>
    </div>
  );
}
