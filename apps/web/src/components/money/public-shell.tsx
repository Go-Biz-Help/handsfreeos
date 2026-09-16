'use client';
/**
 * The frame and the pieces the customer's two money pages share (`/e/<token>` and `/i/<token>`), drawn from
 * `design/m9/Estimate.dc.html` and `Invoice.dc.html`.
 *
 * These are phone pages that happen to open on a desktop: one column, centred, 44 px controls, the one thing to
 * do next held in a bar at the bottom. There is no app chrome and no sign-in — the business's name on top and
 * "Billing by HandsFreeOS" at the foot are the whole of it.
 *
 * **Printing is the answer to "can I have a PDF".** Every browser prints to one, so the page is laid out to
 * print properly instead of us making a second document that could disagree with this one: the bar, the buttons
 * and the states that belong to a screen drop out, the column opens to the width of the paper, and the
 * business's name and the customer's own reference sit at the top of the sheet.
 */
import { money } from '@hfos/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Printer } from 'lucide-react';
import type { ReactNode } from 'react';
import { CallButton } from '@/components/booking/public-shell';
import { BrandMark } from '@/components/ui/brand';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { MoneyTotals, PublicBusiness, PublicMoneyLine } from '@/lib/api/public-money';
import { cn, initials } from '@/lib/utils';
import { unitWord } from './document-view';

export { CallButton, callPhrase, PublicState } from '@/components/booking/public-shell';

/**
 * What a browser needs to make a good PDF of this page. Scoped to `[data-money-page]` so it can only ever
 * change these two pages.
 */
const PRINT_CSS = `
@media print {
  @page { margin: 14mm 12mm; }
  html, body { background: #fff !important; }
  [data-money-page] { min-height: 0 !important; background: #fff !important; }
  [data-money-page] [data-print="hide"] { display: none !important; }
  [data-money-page] [data-print="open"] { max-width: none !important; padding: 0 !important; }
  [data-money-page] [data-print="card"] {
    border-color: #d2d6dd !important;
    box-shadow: none !important;
    break-inside: avoid;
  }
  [data-money-page] [data-print="line"] { break-inside: avoid; }
}
`;

export const PrintStyles = () => <style>{PRINT_CSS}</style>;

/** The business's initials in its accent square, as the canvas draws them. */
export function BizMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-accent text-[13px] font-bold tracking-[0.02em] text-white"
    >
      {initials(name)}
    </span>
  );
}

/** "Billing by HandsFreeOS" — the booking pages' byline, in money's words. */
export function BillingByline({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        'flex items-center justify-center gap-[5px] text-[11.5px] text-text-3',
        className,
      )}
      data-print="hide"
    >
      <BrandMark size={13} />
      Billing by HandsFreeOS
    </p>
  );
}

/**
 * The page: the business on top, one readable column, and the action of the moment in a bar that stays in
 * reach on a phone. `footer` is that bar; leave it out and the page is just something to read.
 */
export function MoneyFrame({
  business,
  children,
  footer,
  testId,
}: {
  business: PublicBusiness | null;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex min-h-dvh flex-col bg-bg text-text"
      data-money-page
      data-testid={testId ?? 'money-page'}
    >
      <PrintStyles />
      {business ? (
        <header className="flex-none border-b border-border bg-card" data-print="card">
          <div
            className="mx-auto flex w-full max-w-[560px] items-center gap-2.5 px-4 py-3"
            data-print="open"
          >
            <BizMark name={business.name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] font-medium" data-testid="business-name">
                {business.name}
              </span>
              {business.phoneDisplay ? (
                <a
                  href={`tel:${business.phone}`}
                  className="w-fit text-xs text-text-3 hover:text-text-2"
                >
                  {business.phoneDisplay}
                </a>
              ) : null}
            </span>
          </div>
        </header>
      ) : null}
      <div className="flex flex-1 flex-col">{children}</div>
      {footer ? (
        <div
          className="sticky bottom-0 z-10 flex-none border-t border-border bg-card px-4 pb-3 pt-2.5"
          data-print="hide"
        >
          <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2">{footer}</div>
        </div>
      ) : null}
      <footer className="flex-none px-4 pb-5 pt-3">
        <BillingByline />
      </footer>
    </div>
  );
}

/** The reading column: everything between the header and the bar. */
export const MoneyBody = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <div
    className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-4 pb-6 pt-4"
    data-print="open"
    data-testid={testId}
  >
    {children}
  </div>
);

/** "ESTIMATE · $8,604.76 · New AC install, good until Wed, Sep 30". */
export function Hero({
  step,
  amount,
  sub,
  testId,
}: {
  step: string;
  amount: number;
  sub?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">{step}</span>
      <h1
        className="text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] tabular-nums sm:text-[34px]"
        data-testid="money-headline"
      >
        {money(amount)}
      </h1>
      {sub ? <p className="text-sm text-text-2">{sub}</p> : null}
    </div>
  );
}

/** The green band a page leads with once it's answered or paid. */
export function OkBox({
  children,
  icon,
  testId,
}: {
  children: ReactNode;
  icon: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-card bg-success-soft p-3.5 text-[13.5px] leading-[1.5] text-success-text"
      data-testid={testId}
      data-print="card"
    >
      <span aria-hidden className="mt-px flex-none">
        {icon}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-0.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
      {children}
    </div>
  );
}

/** One line of a totals block. `big` is the line someone actually reads: Total, Amount due, Paid. */
export function TotalRow({
  label,
  value,
  big,
  credit,
  testId,
}: {
  label: ReactNode;
  value: string;
  big?: boolean;
  /** Money coming off what's owed, in the success colour with a minus: a discount, a deposit, a refund. */
  credit?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 py-1.5 text-[13.5px]',
        big && 'mt-1 border-t border-border pt-2.5 text-base font-semibold',
      )}
      data-testid={testId}
    >
      <span className={big ? 'text-text' : 'text-text-2'}>{label}</span>
      <span
        className={cn('whitespace-nowrap tabular-nums', credit && 'text-success-text')}
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {credit ? `−${value}` : value}
      </span>
    </div>
  );
}

/** "1 each × $6,400 · taxed" — how a line's quantity, price and tax read under its name. */
function rateLine(line: PublicMoneyLine, taxed: boolean): string {
  // The same pluralisation the business sees, so a customer is never told "24 hour × $125".
  const rate = `${line.quantity} ${unitWord(line.quantity, line.unitLabel)} × ${money(line.unitPriceCents)}`;
  return taxed ? `${rate} · ${line.taxable ? 'taxed' : 'no tax'}` : rate;
}

/** The tax row's own words: "TX sales tax · 8.25% on $6,020.10". */
function taxLabelOf(totals: MoneyTotals): string {
  const name = totals.taxLabel?.trim() || 'Tax';
  const rate = (totals.taxRateBp / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${name} · ${rate}% on ${money(totals.taxableBaseCents)}`;
}

/**
 * The document itself: its number, what it was for, every line as it was written, and the totals adding up to
 * the figure at the top of the page. `extra` is what each page adds under the total — an estimate's deposit,
 * an invoice's payments and what's still due.
 */
export function DocumentCard({
  number,
  title,
  when,
  lines,
  totals,
  extra,
  className,
  testId = 'money-document',
}: {
  number: string | null;
  title: string | null;
  /** "Wed, Sep 16", or "Sent Fri, Sep 18". */
  when: string | null;
  lines: readonly PublicMoneyLine[];
  totals: MoneyTotals;
  extra?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const taxed = totals.taxRateBp > 0 && totals.taxCents > 0;
  return (
    <Card
      className={cn('px-4 py-4 sm:px-[18px]', className)}
      data-testid={testId}
      data-print="card"
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="font-medium" data-testid="money-number">
          {number ?? 'Not numbered yet'}
        </span>
        {when ? <span className="text-[13px] text-text-3">{when}</span> : null}
      </div>
      {title ? <div className="mb-2 text-[13px] text-text-2">{title}</div> : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 pb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        <span>What</span>
        <span className="text-right">Amount</span>
      </div>
      <ul>
        {lines.map((line) => (
          <li
            key={line.id}
            data-testid="money-line"
            data-print="line"
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-border py-[11px] text-[13.5px]"
          >
            <span className="min-w-0">
              <span className="block font-medium leading-[1.35]">{line.name}</span>
              {line.description ? (
                <span className="mt-px block text-xs leading-[1.4] text-text-3">
                  {line.description}
                </span>
              ) : null}
              <span className="mt-px block text-xs leading-[1.4] text-text-3">
                {rateLine(line, taxed)}
              </span>
              {line.discountCents > 0 ? (
                <span className="mt-px block text-xs leading-[1.4] text-success-text">
                  −{money(line.discountCents)} off this line
                </span>
              ) : null}
            </span>
            <span className="whitespace-nowrap text-right font-semibold tabular-nums">
              {money(line.amountCents)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3">
        {/* Core's `subtotalCents` is already net of the document discount, so the lines' own sum is put back
            here — otherwise Subtotal, Discount, tax and Total wouldn't add up on the page. */}
        <TotalRow
          label="Subtotal"
          value={money(totals.subtotalCents + totals.discountCents)}
          testId="money-subtotal"
        />
        {totals.discountCents > 0 ? (
          <TotalRow
            label="Discount"
            value={money(totals.discountCents)}
            credit
            testId="money-discount"
          />
        ) : null}
        {taxed ? (
          <TotalRow label={taxLabelOf(totals)} value={money(totals.taxCents)} testId="money-tax" />
        ) : null}
        <TotalRow label="Total" value={money(totals.totalCents)} big testId="money-total" />
        {extra}
      </div>
    </Card>
  );
}

/** "Print or save a PDF", and the business's number beside it. The canvas's quiet row under the document. */
export function PageActions({ business }: { business: PublicBusiness }) {
  return (
    <div className="flex flex-wrap justify-center gap-2" data-print="hide">
      <Button
        variant="secondary"
        size="sm"
        className="max-md:h-11"
        onClick={() => window.print()}
        data-testid="print"
      >
        <Printer size={15} aria-hidden />
        Print or save a PDF
      </Button>
      <CallButton business={business} variant="secondary" />
    </div>
  );
}

/** The note the business wrote, in its own card: "From Lone Star". */
export function NotesCard({ notes, business }: { notes: string; business: PublicBusiness }) {
  return (
    <Card className="px-4 py-3.5" data-testid="money-notes" data-print="card">
      <SectionLabel>From {business.name}</SectionLabel>
      <p className="whitespace-pre-line text-[13px] leading-[1.55] text-text-2">{notes}</p>
    </Card>
  );
}

/**
 * The canvas's bottom sheet: the page dims and one thing is asked. Radix gives it the focus trap and Escape
 * that a panel over a page needs; it stays a sheet at every width because this page is a phone page wherever
 * it's opened.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:animate-in data-[state=open]:fade-in" />
        <DialogPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[592px] flex-col overflow-y-auto rounded-t-2xl border-t border-border bg-card px-4 pb-6 pt-3.5 shadow-3 focus:outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom"
          data-testid={testId}
        >
          <span
            aria-hidden
            className="mx-auto mb-3.5 h-1 w-10 flex-none rounded-full bg-border-strong"
          />
          <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          <div className="mt-3 flex flex-col gap-3">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The honeypot every acting form carries, exactly as the booking form does: a field a person never sees and a
 * bot fills in. The worker refuses anything that arrives with it filled.
 */
export function Honeypot({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -left-[9999px] h-0 w-0 overflow-hidden"
    >
      <label htmlFor={id}>Website</label>
      <input
        id={id}
        name="website"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
