'use client';
/**
 * Settings → Payments (design/m9 Settings.dc.html). Everything here saves the moment it is changed — switches as
 * they are flipped, boxes as they are left — through `money.save_settings`, which is also where the settings that
 * fight each other are caught. Those come back as issues with fixes, the way the calendar builder's do, and an
 * error keeps what is on screen so a fix can act on it.
 *
 * The one thing this page says that no customer ever sees: what a way of paying costs the business. Bank transfer
 * leads because it is about 1% and capped, and the owner is told exactly that. Nothing is ever added to what a
 * customer owes for paying by card.
 */
import {
  applyMoneyPatch,
  checkMoneySettings,
  hasBlockingMoneyIssues,
  money,
  numberPreview,
  PAYMENT_TERMS,
  readMoneySettings,
  reminderSchedule,
  TERMS_DAYS,
  type MoneyIssue,
  type MoneySettings,
  type PaymentTerms,
} from '@hfos/core';
import {
  AlertCircle,
  AlertTriangle,
  Banknote,
  CheckCircle2,
  CreditCard,
  Hash,
  Lock,
  MapPin,
  Plus,
  Receipt,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PaymentConnectionRow } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import type { TeamMember } from './payment-access-dialog';
import { connectPaymentAccount, PaymentConnectionCard } from './payment-connection-card';
import { SetRow } from './set-row';

/** What the redirect from Stripe or Square says when it lands back here. */
const RESULT: Readonly<Record<string, { tone: 'success' | 'error' | 'plain'; text: string }>> = {
  connected: { tone: 'success', text: 'Connected. Money from HandsFreeOS goes straight into it.' },
  cancelled: { tone: 'plain', text: 'Nothing was connected.' },
  missing_permissions: {
    tone: 'error',
    text: 'A permission was left unticked, so we couldn’t finish. Try again and leave them all on.',
  },
  failed: { tone: 'error', text: 'That account didn’t connect. Try again.' },
};

const TERM_WORDS: Readonly<Record<PaymentTerms, string>> = {
  due_on_receipt: 'When they get it',
  net_7: 'Net 7 days',
  net_14: 'Net 14 days',
  net_30: 'Net 30 days',
};

/** The ladder the canvas draws. A business that saved other days keeps them: they get their own rows. */
const BEFORE_STEPS = [3];
const AFTER_STEPS = [3, 7, 14];

/** The address box, so the "no address" warning's fix can put the cursor in it. */
const ADDRESS_ID = 'money-business-address';

const sectionTitle = 'text-lg font-semibold leading-[1.3] tracking-[-0.005em]';
const uniqueSorted = (list: readonly number[], dir: 1 | -1) =>
  [...new Set(list)].sort((a, b) => (a - b) * dir);

function Section({
  title,
  description,
  icon: Icon,
  action,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  icon: typeof Wallet;
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="px-[22px] py-5" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <Icon className="mt-0.5 h-[18px] w-[18px] flex-none text-text-3" strokeWidth={1.75} />
          <div className="min-w-0">
            <h2 className={sectionTitle}>{title}</h2>
            {description ? (
              <p className="mt-1 max-w-[460px] text-[13px] text-text-2">{description}</p>
            ) : null}
          </div>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** A quiet note under a section, in the canvas's grey box. */
function Note({
  children,
  icon: Icon = ShieldCheck,
  testId,
}: {
  children: ReactNode;
  icon?: typeof ShieldCheck;
  testId?: string;
}) {
  return (
    <div
      className="mt-2.5 flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2"
      data-testid={testId}
    >
      <Icon className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** A box that saves what is in it when it is left (or on Enter), and goes back when it can't be used. */
function TextBox({
  value,
  label,
  onCommit,
  problem,
  className,
  testId,
  ...rest
}: {
  value: string;
  label: string;
  onCommit: (next: string) => void;
  /** Why this value can't be used, in a sentence. */
  problem?: (next: string) => string | null;
  className?: string;
  testId?: string;
  placeholder?: string;
  maxLength?: number;
  inputMode?: 'text' | 'numeric' | 'decimal';
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  const commit = () => {
    const raw = text.trim();
    if (raw === value) return;
    const why = problem?.(raw) ?? null;
    if (why) {
      toast.error(why);
      setText(value);
      return;
    }
    onCommit(raw);
  };
  return (
    <Input
      inputSize="sm"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className={className}
      data-testid={testId}
      {...rest}
    />
  );
}

export function PaymentsSettings({
  workspaceId,
  initial,
  nextEstimateNumber,
  nextInvoiceNumber,
  connections,
  team,
  hasSentDocuments,
  result,
}: {
  workspaceId: string;
  initial: MoneySettings;
  /** From `app.document_counters`, which is what a Send actually reads. */
  nextEstimateNumber: string;
  nextInvoiceNumber: string;
  connections: readonly PaymentConnectionRow[];
  /** The business's people and whether each bills, for who may use each account (0102). */
  team: readonly TeamMember[];
  /** Whether an estimate or an invoice has ever gone out: the missing-address warning waits for it. */
  hasSentDocuments: boolean;
  /** `?payments=` from the provider's redirect. */
  result: string | null;
}) {
  const router = useRouter();
  useLiveRefresh(['payment_connection', 'workspace']);

  // The counter is the authority, not the settings document: a business that has sent invoices is further on
  // than its settings say, so the editable number starts where the counter actually is.
  const [start] = useState<MoneySettings>(() =>
    withCounters(initial, nextEstimateNumber, nextInvoiceNumber),
  );
  const [settings, setSettings] = useState<MoneySettings>(start);
  const latest = useRef(start);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [connecting, setConnecting] = useState<string | null>(null);

  const told = useRef(false);
  useEffect(() => {
    if (!result || told.current) return;
    told.current = true;
    const r = RESULT[result] ?? RESULT.failed!;
    if (r.tone === 'success') toast.success(r.text);
    else if (r.tone === 'error') toast.error(r.text);
    else toast(r.text);
    router.replace(`/app/w/${workspaceId}/settings/payments`, { scroll: false });
  }, [result, router, workspaceId]);

  const issues = checkMoneySettings(settings, { hasSentDocuments });
  const blocking = hasBlockingMoneyIssues(issues);
  const addressMissing = issues.some((i) => i.code === 'no_business_address');

  /**
   * Saves the whole document, one save at a time. What is on screen changes at once; a refused value keeps it
   * (so a fix can act on it) and anything else puts it back.
   */
  function save(change: (s: MoneySettings) => MoneySettings, done?: string): Promise<boolean> {
    const before = latest.current;
    const next = change(before);
    latest.current = next;
    setSettings(next);
    if (hasBlockingMoneyIssues(checkMoneySettings(next, { hasSentDocuments })))
      return Promise.resolve(false);
    const run = queue.current.then(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/money.save_settings', {
            body: { workspaceId, settings: next },
          }),
        );
        if (latest.current === next) {
          const saved = withCounters(
            readMoneySettings(out.settings),
            out.nextEstimateNumber,
            out.nextInvoiceNumber,
          );
          latest.current = saved;
          setSettings(saved);
        }
        if (done) toast.success(done);
        return true;
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'validation') && latest.current === next) {
          latest.current = before;
          setSettings(before);
        }
        toast.error(errorMessage(e));
        return false;
      }
    });
    queue.current = run;
    return run;
  }

  const applyFix = (fix: MoneyIssue['fixes'][number]) =>
    void save((s) => applyMoneyPatch(s, fix.patch), 'Fixed.');

  /** The address has no patch to apply: its fix is to put the cursor where the address goes. */
  const focusAddress = () => {
    const box = document.getElementById(ADDRESS_ID);
    box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box?.focus({ preventScroll: true });
  };

  const connect = (provider: 'stripe' | 'square') => {
    setConnecting(provider);
    connectPaymentAccount(workspaceId, provider).catch((e: unknown) => {
      toast.error(errorMessage(e));
      setConnecting(null);
    });
  };

  // A sign-in that was started and never finished isn't an account yet: it stays out of the list.
  const live = connections.filter((c) => c.status !== 'pending' && c.status !== 'disconnected');
  const { tax, numbering, deposit, reminders } = settings;
  const beforeDays = uniqueSorted([...BEFORE_STEPS, ...reminders.beforeDueDays], -1);
  const afterDays = uniqueSorted([...AFTER_STEPS, ...reminders.afterDueDays], 1);
  const schedule = reminderSchedule(settings);

  const setReminder = (when: 'before' | 'after', days: number, on: boolean) =>
    void save(
      (s) => {
        const from = when === 'before' ? s.reminders.beforeDueDays : s.reminders.afterDueDays;
        const kept = from.filter((d) => d !== days);
        const next = on ? uniqueSorted([...kept, days], 1) : kept;
        return {
          ...s,
          reminders:
            when === 'before'
              ? { ...s.reminders, beforeDueDays: next }
              : { ...s.reminders, afterDueDays: next },
        };
      },
      on
        ? `A reminder goes ${days} ${days === 1 ? 'day' : 'days'} ${when === 'before' ? 'before' : 'after'} the due date.`
        : `No reminder ${days} ${days === 1 ? 'day' : 'days'} ${when === 'before' ? 'before' : 'after'} the due date.`,
    );

  return (
    <div className="flex flex-col gap-5" data-testid="payments-settings">
      {issues.length ? (
        <div className="flex flex-col gap-2" data-testid="money-issues">
          {issues.map((issue) => {
            const error = issue.severity === 'error';
            return (
              <div
                key={`${issue.code}-${issue.message}`}
                data-testid={`issue-${issue.code}`}
                className={cn(
                  'flex items-start gap-2.5 rounded-menu border px-3.5 py-3',
                  error
                    ? 'border-[color-mix(in_oklab,var(--danger)_35%,var(--border))] bg-[color-mix(in_oklab,var(--danger-soft)_60%,var(--card))]'
                    : 'border-[color-mix(in_oklab,var(--warning)_35%,var(--border))] bg-[color-mix(in_oklab,var(--warning-soft)_60%,var(--card))]',
                )}
              >
                {error ? (
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 flex-none text-danger-text"
                    strokeWidth={1.75}
                  />
                ) : (
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 flex-none text-warning-text"
                    strokeWidth={1.75}
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-medium">{issue.message}</span>
                  <span
                    className={cn(
                      'mt-0.5 text-xs font-medium',
                      error ? 'text-danger-text' : 'text-warning-text',
                    )}
                  >
                    {error ? 'Nothing is saved until this is fixed' : 'Doesn’t stop it saving'}
                  </span>
                  {issue.fixes.length || issue.code === 'no_business_address' ? (
                    <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className="mr-0.5 text-xs font-semibold text-text-3">Fix:</span>
                      {issue.fixes.map((fix) => (
                        <Button
                          key={fix.id}
                          variant="secondary"
                          size="sm"
                          className="h-7 text-[12.5px]"
                          data-testid={`fix-${issue.code}-${fix.id}`}
                          onClick={() => applyFix(fix)}
                        >
                          {fix.label}
                        </Button>
                      ))}
                      {/* Nobody can patch in an address, so this one's fix is the box itself. */}
                      {issue.code === 'no_business_address' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 text-[12.5px]"
                          data-testid="fix-no_business_address-write_it"
                          onClick={focusAddress}
                        >
                          Write it in
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-5">
          <Section
            title="Accounts you get paid into"
            description="Money goes straight to your own account. HandsFreeOS never holds it."
            icon={Wallet}
            testId="pay-accounts"
          >
            {live.length ? (
              <div className="mt-3 flex flex-col gap-2">
                {live.map((c) => (
                  <PaymentConnectionCard
                    key={c.id}
                    workspaceId={workspaceId}
                    connection={c}
                    team={team}
                  />
                ))}
              </div>
            ) : (
              <div className="mt-3" data-testid="pay-no-accounts">
                <EmptyState title="No account connected yet" className="py-7" dashed>
                  Connect Stripe or Square and customers can pay an invoice from its own link.
                </EmptyState>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={connecting === 'stripe'}
                onClick={() => connect('stripe')}
                data-testid="connect-stripe"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                Connect Stripe
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={connecting === 'square'}
                onClick={() => connect('square')}
                data-testid="connect-square"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                Connect Square
              </Button>
            </div>
            <p className="mt-2 text-[12.5px] text-text-3">
              You can connect several, including two of the same kind, and keep each one to the
              people who use it.
            </p>
            <Note>
              Disconnecting asks about the plans billing through that account first. Refunds keep
              working if you reconnect the same account later.
            </Note>
          </Section>

          <Section
            title="Ways to pay"
            description="What the customer sees on their page, in this order."
            icon={CreditCard}
            testId="pay-methods"
          >
            <div className="mt-2">
              <SetRow
                first
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    Bank transfer
                    <Badge variant="ok">Cheapest</Badge>
                  </span>
                }
                description="About 1% of the payment, capped at $5, and it takes 1 to 3 business days. It shows first because it costs you the least."
              >
                <Switch
                  checked={settings.bankTransfer}
                  label="Offer bank transfer"
                  onChange={(on) =>
                    void save(
                      (s) => ({ ...s, bankTransfer: on }),
                      on
                        ? 'Bank transfer is on, and it shows first.'
                        : 'Bank transfer is off. Customers will see card only.',
                    )
                  }
                  testId="bank-transfer-switch"
                />
              </SetRow>
              <SetRow
                center
                title="Card"
                description="Visa, Mastercard, Amex, Apple Pay and Google Pay. The money is there at once."
              >
                <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-text-3">
                  <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                  Always on
                </span>
              </SetRow>
              <SetRow
                center
                className="pb-0"
                title="Cash and cheque"
                description="Not offered to customers. You record one by hand from the invoice."
              >
                <span className="whitespace-nowrap text-[11.5px] font-medium text-text-3">
                  By hand
                </span>
              </SetRow>
            </div>
            <Note>
              Nothing is ever added to what the customer owes for paying by card. Surcharging is
              banned in four states and needs 30 days’ notice to your bank, so HandsFreeOS doesn’t
              do it.
            </Note>
          </Section>

          <Section
            title="Sales tax"
            description="One rate for the business. Each line on a document is marked taxable or not."
            icon={Receipt}
            testId="pay-tax"
          >
            <div className="mt-2">
              <SetRow first center title="Rate" description="Up to 20%, to two decimal places.">
                <span className="flex items-center gap-1.5">
                  <TextBox
                    value={ratePercent(tax.rateBp)}
                    label="Sales tax rate"
                    inputMode="decimal"
                    className="w-20 px-2.5 text-right tabular-nums"
                    testId="tax-rate"
                    problem={(next) => (rateBpOf(next) === null ? 'Use a rate like 8.25.' : null)}
                    onCommit={(next) => {
                      const bp = rateBpOf(next);
                      if (bp === null) return;
                      void save(
                        (s) => ({ ...s, tax: { ...s.tax, rateBp: bp } }),
                        `${tax.name} is ${ratePercent(bp)}%.`,
                      );
                    }}
                  />
                  <span className="text-xs text-text-3">%</span>
                </span>
              </SetRow>
              <SetRow
                center
                title="What to call it on a document"
                description="“Sales tax”, “TX sales tax”, “GST”."
              >
                <TextBox
                  value={tax.name}
                  label="What to call the tax"
                  maxLength={40}
                  className="w-[170px] px-2.5"
                  testId="tax-name"
                  problem={(next) => (next ? null : 'Name the tax.')}
                  onCommit={(next) =>
                    void save(
                      (s) => ({ ...s, tax: { ...s.tax, name: next } }),
                      `It’s called ${next} on documents.`,
                    )
                  }
                />
              </SetRow>
              <SetRow
                center
                className="pb-0"
                title="New items start taxable"
                description="A new product or service is taxed unless you say otherwise."
              >
                <Switch
                  checked={tax.newProductsTaxable}
                  label="New items start taxable"
                  onChange={(on) =>
                    void save(
                      (s) => ({ ...s, tax: { ...s.tax, newProductsTaxable: on } }),
                      on
                        ? 'New items start taxable.'
                        : 'New items start with no tax. You can change each one.',
                    )
                  }
                  testId="tax-new-taxable"
                />
              </SetRow>
            </div>
            <Note icon={Lock}>
              A document keeps the rate it was sent with, for life. Changing it here only affects
              new ones.
            </Note>
          </Section>

          <Section
            title="Numbering"
            description="Numbers run in order, per business. A voided number is kept and never used again."
            icon={Hash}
            testId="pay-numbering"
          >
            <div className="mt-2">
              {(['invoice', 'estimate'] as const).map((kind, i) => (
                <div
                  key={kind}
                  className={cn(
                    'flex flex-wrap items-end justify-between gap-3 py-3.5',
                    i === 0 ? 'pt-1' : 'border-t border-border',
                  )}
                >
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-[12.5px] text-text-3">
                      {kind === 'invoice' ? 'Invoices start with' : 'Estimates start with'}
                      <TextBox
                        value={numbering[kind].prefix}
                        label={`${kind === 'invoice' ? 'Invoice' : 'Estimate'} prefix`}
                        maxLength={12}
                        className="w-24 px-2.5"
                        testId={`${kind}-prefix`}
                        problem={(next) =>
                          /^[A-Za-z0-9-]*$/.test(next)
                            ? null
                            : 'A prefix can have letters, numbers and hyphens.'
                        }
                        onCommit={(next) =>
                          void save(
                            (s) => withNumbering(s, kind, { prefix: next }),
                            'Numbering saved.',
                          )
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[12.5px] text-text-3">
                      Next number
                      <TextBox
                        value={String(numbering[kind].next)}
                        label={`Next ${kind} number`}
                        inputMode="numeric"
                        className="w-24 px-2.5 tabular-nums"
                        testId={`${kind}-next`}
                        problem={(next) => {
                          const n = Number(next);
                          if (!next || !Number.isInteger(n) || n < 1)
                            return 'Enter a whole number, 1 or more.';
                          if (n < numbering[kind].next)
                            return `The next number only moves forward (it’s at ${numbering[kind].next}).`;
                          return null;
                        }}
                        onCommit={(value) =>
                          void save(
                            (s) => withNumbering(s, kind, { next: Number(value) }),
                            'Numbering saved.',
                          )
                        }
                      />
                    </label>
                  </div>
                  <span className="flex flex-col gap-1 text-[12.5px] text-text-3">
                    The next one will be
                    <span
                      className="inline-flex h-[34px] items-center gap-1.5 rounded-control bg-card-2 px-3 font-mono text-[13px] font-medium text-text"
                      data-testid={`${kind}-preview`}
                    >
                      <Hash className="h-3.5 w-3.5 text-text-3" strokeWidth={1.75} aria-hidden />
                      {numberPreview(numbering[kind])}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <Note icon={Lock}>
              A document gets its number the moment you press Send, not while you are writing it.
            </Note>
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Section
            title="Your address"
            description="It shows at the top of every estimate and invoice the customer sees, exactly as you write it here."
            icon={MapPin}
            testId="pay-address"
          >
            <div className="mt-3">
              <NoteBox
                id={ADDRESS_ID}
                value={settings.businessAddress}
                label="Your business address"
                maxLength={300}
                invalid={addressMissing}
                placeholder={'Lone Star HVAC & Roofing\n2210 Oak St\nHouston, TX 77008'}
                testId="business-address"
                onCommit={(next) =>
                  void save(
                    (s) => ({ ...s, businessAddress: next }),
                    next ? 'Your address is on new documents.' : 'Your address is off documents.',
                  )
                }
              />
            </div>
            <p className="mt-1.5 text-[12.5px] text-text-3">
              Five lines at most. Without it a customer only sees your business name.
            </p>
          </Section>

          <Section
            title="Terms and notes"
            description="When an invoice is due, how long an estimate stays good, and what every document ends with."
            icon={Receipt}
            testId="pay-terms"
          >
            <div className="mt-2">
              <SetRow
                first
                center
                title="Invoices are due"
                description={
                  TERMS_DAYS[settings.terms] === 0
                    ? 'The day it is sent. Nothing goes out before the due date.'
                    : `${TERMS_DAYS[settings.terms]} days after it is sent.`
                }
              >
                <Select
                  selectSize="sm"
                  className="w-[170px]"
                  aria-label="Invoices are due"
                  value={settings.terms}
                  data-testid="terms"
                  onChange={(e) => {
                    const terms = e.target.value as PaymentTerms;
                    void save(
                      (s) => ({ ...s, terms }),
                      `Invoices are due ${TERM_WORDS[terms].toLowerCase()}.`,
                    );
                  }}
                >
                  {PAYMENT_TERMS.map((t) => (
                    <option key={t} value={t}>
                      {TERM_WORDS[t]}
                    </option>
                  ))}
                </Select>
              </SetRow>
              <SetRow
                center
                title="Estimates stay good for"
                description="After this it expires, and the customer’s page says so."
              >
                <span className="flex items-center gap-1.5">
                  <TextBox
                    value={String(settings.estimateGoodForDays)}
                    label="Estimates stay good for this many days"
                    inputMode="numeric"
                    className="w-16 px-2.5 tabular-nums"
                    testId="estimate-good-for"
                    problem={(next) => {
                      const n = Number(next);
                      return !next || !Number.isInteger(n) || n < 1 || n > 365
                        ? 'Use a whole number of days, 1 to 365.'
                        : null;
                    }}
                    onCommit={(next) =>
                      void save(
                        (s) => ({ ...s, estimateGoodForDays: Number(next) }),
                        `Estimates stay good for ${next} days.`,
                      )
                    }
                  />
                  <span className="text-xs text-text-3">days</span>
                </span>
              </SetRow>
            </div>
            <div className="mt-2 flex flex-col gap-3 border-t border-border pt-3.5">
              {(['invoice', 'estimate'] as const).map((kind) => (
                <label key={kind} className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">
                    {kind === 'invoice'
                      ? 'Note at the bottom of an invoice'
                      : 'Note on an estimate'}
                  </span>
                  <NoteBox
                    value={settings.notes[kind]}
                    label={kind === 'invoice' ? 'Note on an invoice' : 'Note on an estimate'}
                    testId={`note-${kind}`}
                    onCommit={(next) =>
                      void save(
                        (s) => ({
                          ...s,
                          notes:
                            kind === 'invoice'
                              ? { ...s.notes, invoice: next }
                              : { ...s.notes, estimate: next },
                        }),
                        'Note saved.',
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <p className="mt-2 text-[12.5px] text-text-3">
              You can change the note on a single document while you are writing it.
            </p>
          </Section>

          <Section
            title="Deposits"
            description="What an estimate asks for before the work starts."
            icon={Banknote}
            testId="pay-deposit"
            action={
              <Switch
                checked={deposit.kind !== 'none'}
                label="Ask for a deposit"
                onChange={(on) =>
                  void save(
                    (s) => ({
                      ...s,
                      deposit: { ...s.deposit, kind: on ? 'percent' : 'none' },
                    }),
                    on
                      ? `New estimates ask for ${ratePercent(deposit.percentBp)}% up front.`
                      : 'New estimates won’t ask for a deposit.',
                  )
                }
                testId="deposit-switch"
              />
            }
          >
            {deposit.kind === 'none' ? (
              <p className="mt-3 text-[13px] text-text-2">
                Estimates ask for nothing up front. You can still add a deposit to a single one
                while you write it.
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Segmented<'percent' | 'amount'>
                  ariaLabel="Ask for"
                  value={deposit.kind === 'amount' ? 'amount' : 'percent'}
                  onChange={(kind) =>
                    void save(
                      (s) => ({ ...s, deposit: { ...s.deposit, kind } }),
                      kind === 'percent'
                        ? `New estimates ask for ${ratePercent(deposit.percentBp)}% up front.`
                        : `New estimates ask for ${money(deposit.amountCents)} up front.`,
                    )
                  }
                  options={[
                    { value: 'percent', label: 'A share of the total', testId: 'deposit-percent' },
                    { value: 'amount', label: 'A set amount', testId: 'deposit-amount' },
                  ]}
                />
                {deposit.kind === 'percent' ? (
                  <span className="flex items-center gap-1.5">
                    <TextBox
                      value={ratePercent(deposit.percentBp)}
                      label="Deposit percentage"
                      inputMode="decimal"
                      className="w-20 px-2.5 text-right tabular-nums"
                      testId="deposit-percent-value"
                      problem={(next) => {
                        const bp = rateBpOf(next, 10_000);
                        return bp === null || bp === 0 ? 'Use a share like 25.' : null;
                      }}
                      onCommit={(next) => {
                        const bp = rateBpOf(next, 10_000);
                        if (bp === null) return;
                        void save(
                          (s) => ({ ...s, deposit: { ...s.deposit, percentBp: bp } }),
                          `New estimates ask for ${ratePercent(bp)}% up front.`,
                        );
                      }}
                    />
                    <span className="text-xs text-text-3">% of the total</span>
                  </span>
                ) : (
                  <TextBox
                    value={money(deposit.amountCents)}
                    label="Deposit amount"
                    inputMode="decimal"
                    className="w-28 px-2.5 text-right tabular-nums"
                    testId="deposit-amount-value"
                    problem={(next) => (centsOf(next) ? null : 'Use an amount like $500.')}
                    onCommit={(next) => {
                      const cents = centsOf(next);
                      if (!cents) return;
                      void save(
                        (s) => ({ ...s, deposit: { ...s.deposit, amountCents: cents } }),
                        `New estimates ask for ${money(cents)} up front.`,
                      );
                    }}
                  />
                )}
              </div>
            )}
            <p className="mt-2.5 text-[12.5px] text-text-3">
              A deposit to book a visit is set on the calendar itself.{' '}
              <Link
                href={`/app/w/${workspaceId}/settings/calendars`}
                className="text-accent-text hover:underline"
              >
                Settings → Calendars
              </Link>
            </p>
          </Section>

          <Section
            title="Invoice reminders"
            description="Set when the invoice is sent, on the schedule you agree here. They go by text if the customer agreed to texts, otherwise by email, and they follow quiet hours."
            icon={AlertTriangle}
            testId="pay-reminders"
          >
            <div className="mt-2.5" data-testid="reminder-rows">
              {beforeDays.map((days) => (
                <ReminderRow
                  key={`before-${days}`}
                  title={`${days} ${days === 1 ? 'day' : 'days'} before it’s due`}
                  what="A friendly heads-up with the amount and the link"
                  on={reminders.beforeDueDays.includes(days)}
                  testId={`reminder-before-${days}`}
                  onChange={(on) => setReminder('before', days, on)}
                />
              ))}
              <ReminderRow
                title="On the day it’s due"
                what="Due today, with the link"
                on={reminders.onDue}
                testId="reminder-on"
                onChange={(on) =>
                  void save(
                    (s) => ({ ...s, reminders: { ...s.reminders, onDue: on } }),
                    on ? 'A reminder goes on the due date.' : 'No reminder on the due date itself.',
                  )
                }
              />
              {afterDays.map((days) => (
                <ReminderRow
                  key={`after-${days}`}
                  title={`${days} ${days === 1 ? 'day' : 'days'} after`}
                  what={
                    days === 3
                      ? 'First nudge'
                      : days === 7
                        ? 'Second nudge'
                        : days === 14
                          ? 'Last one. After this it stops and Home raises a card instead.'
                          : 'Another nudge with the amount and the link'
                  }
                  on={reminders.afterDueDays.includes(days)}
                  testId={`reminder-after-${days}`}
                  onChange={(on) => setReminder('after', days, on)}
                />
              ))}
              <ReminderRow
                title="Nudge an estimate nobody answered"
                what={
                  reminders.estimateAfterDays === null
                    ? 'Nothing is sent about an estimate that goes quiet.'
                    : `${reminders.estimateAfterDays} days after it goes out, once.`
                }
                on={reminders.estimateAfterDays !== null}
                testId="reminder-estimate"
                onChange={(on) =>
                  void save(
                    (s) => ({
                      ...s,
                      reminders: { ...s.reminders, estimateAfterDays: on ? 3 : null },
                    }),
                    on
                      ? 'An estimate nobody answers gets one nudge after 3 days.'
                      : 'Estimates get no nudge.',
                  )
                }
                extra={
                  reminders.estimateAfterDays === null ? null : (
                    <TextBox
                      value={String(reminders.estimateAfterDays)}
                      label="Nudge an estimate after this many days"
                      inputMode="numeric"
                      className="w-14 px-2.5 tabular-nums"
                      testId="reminder-estimate-days"
                      problem={(next) => {
                        const n = Number(next);
                        return !next || !Number.isInteger(n) || n < 1 || n > 90
                          ? 'Use a whole number of days, 1 to 90.'
                          : null;
                      }}
                      onCommit={(next) =>
                        void save(
                          (s) => ({
                            ...s,
                            reminders: { ...s.reminders, estimateAfterDays: Number(next) },
                          }),
                          `An estimate nobody answers gets one nudge after ${next} days.`,
                        )
                      }
                    />
                  )
                }
              />
            </div>
            <p className="mt-2 text-[12.5px] text-text-3" data-testid="reminder-count">
              {schedule.length
                ? `${schedule.length} ${schedule.length === 1 ? 'reminder' : 'reminders'} per invoice.`
                : 'Nobody is reminded about an unpaid invoice.'}
            </p>
            <Note>
              These are the only money messages that go on their own, and only because you set them
              in advance. Home never chases money by itself — it asks you first.
            </Note>
          </Section>
        </div>
      </div>

      <p
        className="flex items-center gap-2 text-[12.5px] text-text-3"
        data-testid="money-settings-state"
        data-blocked={blocking ? 'yes' : 'no'}
      >
        {blocking ? (
          <>
            <AlertCircle className="h-4 w-4 text-danger-text" strokeWidth={1.75} aria-hidden />
            Fix the red item above — nothing is saved until it’s sorted.
          </>
        ) : (
          <>
            <CheckCircle2 className="h-4 w-4 text-success-text" strokeWidth={1.75} aria-hidden />
            Everything here saves as you change it.
          </>
        )}
      </p>
    </div>
  );
}

function ReminderRow({
  title,
  what,
  on,
  onChange,
  testId,
  extra,
}: {
  title: string;
  what: string;
  on: boolean;
  onChange: (next: boolean) => void;
  testId: string;
  extra?: ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-t border-border py-[11px] first:border-t-0 first:pt-1"
      data-testid={testId}
      data-on={on ? 'yes' : 'no'}
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-xs text-text-3">{what}</span>
      </span>
      <span className="flex flex-none items-center gap-2">
        {extra}
        <Switch checked={on} label={title} onChange={onChange} testId={`${testId}-switch`} />
      </span>
    </div>
  );
}

/** A note that saves when it is left. Longer than a box, so it gets its own component. */
function NoteBox({
  value,
  label,
  onCommit,
  testId,
  id,
  maxLength = 2_000,
  invalid,
  placeholder,
}: {
  value: string;
  label: string;
  onCommit: (next: string) => void;
  testId: string;
  id?: string;
  maxLength?: number;
  invalid?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  return (
    <Textarea
      id={id}
      aria-label={label}
      value={text}
      placeholder={placeholder}
      invalid={invalid}
      maxLength={maxLength}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text.trim();
        if (next !== value) onCommit(next);
      }}
      className="min-h-[68px] rounded-[10px] px-[11px] py-[9px] text-[13px] leading-[1.6]"
      data-testid={testId}
    />
  );
}

// ---- reading and writing the little numbers ----

/** 825 → "8.25", 800 → "8". */
function ratePercent(bp: number | undefined): string {
  const value = (bp ?? 0) / 100;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** "8.25" → 825, refusing anything that isn't a percentage. */
function rateBpOf(text: string, max = 2_000): number | null {
  const cleaned = text.replace(/[%\s,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const bp = Math.round(Number(cleaned) * 100);
  return bp > max ? null : bp;
}

/** "$500" → 50000, and 0 or nonsense → 0, so a caller can refuse both at once. */
function centsOf(text: string): number {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return 0;
  return Math.round(Number(cleaned) * 100);
}

/** One counter changed, written out longhand so the two kinds keep their own types. */
function withNumbering(
  settings: MoneySettings,
  kind: 'invoice' | 'estimate',
  change: { prefix?: string; next?: number },
): MoneySettings {
  const current = settings.numbering[kind];
  const updated = { ...current, ...change };
  return {
    ...settings,
    numbering:
      kind === 'invoice'
        ? { ...settings.numbering, invoice: updated }
        : { ...settings.numbering, estimate: updated },
  };
}

/**
 * The counter row is what a Send reads, and it runs ahead of the settings document as documents go out. The
 * editable number starts where the counter is, so the preview is honest and a save is never refused for going
 * backwards.
 */
function withCounters(
  settings: MoneySettings,
  estimatePreview: string,
  invoicePreview: string,
): MoneySettings {
  const at = (preview: string, fallback: number) =>
    Math.max(fallback, Number(/(\d+)$/.exec(preview)?.[1] ?? 0) || 0);
  return {
    ...settings,
    numbering: {
      estimate: {
        ...settings.numbering.estimate,
        next: at(estimatePreview, settings.numbering.estimate.next),
      },
      invoice: {
        ...settings.numbering.invoice,
        next: at(invoicePreview, settings.numbering.invoice.next),
      },
    },
  };
}
