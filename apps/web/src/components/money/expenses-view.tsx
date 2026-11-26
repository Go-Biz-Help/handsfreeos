'use client';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_PAID_WITH,
  EXPENSES_EMPTY,
  expensePaidWithLabel,
  inOutFigures,
  leftOf,
  money,
  monthLabel,
  RECEIPT_MAX_BYTES,
  RECEIPT_TYPES,
  signedDollars,
} from '@hfos/core';
import { Paperclip, Plus, Receipt, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ExpenseListOut, ExpenseRow, MoneyInAndOutOut } from '@/lib/api/types';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { ListNote, ShowMore, Td, Th, useMore } from './list-bits';
import { MoneyInput } from './money-input';

interface Filters {
  readonly month: string;
  readonly query: string;
  readonly category: string;
}

const HEIC: Record<string, string> = { heic: 'image/heic', heif: 'image/heif' };

/** "Nov 24". */
const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function hrefFor(workspaceId: string, f: Filters, change: Partial<Filters>) {
  const next = { ...f, ...change };
  const sp = new URLSearchParams();
  if (next.month) sp.set('month', next.month);
  if (next.query) sp.set('q', next.query);
  if (next.category) sp.set('category', next.category);
  const qs = sp.toString();
  return `/app/w/${workspaceId}/money/expenses${qs ? `?${qs}` : ''}`;
}

/** Opens a receipt in a new tab, through a link that works for five minutes. */
async function openReceipt(receipt: NonNullable<ExpenseRow['receipt']>) {
  const { data, error } = await supabaseBrowser()
    .storage.from(receipt.bucket)
    .createSignedUrl(receipt.objectPath, 300);
  if (error || !data) {
    toast.error('That receipt couldn’t be opened. Refresh the page and try again.');
    return;
  }
  window.open(data.signedUrl, '_blank', 'noopener');
}

/** Puts a receipt on an expense: its place is reserved, the file goes straight to Storage, then it's confirmed. */
async function uploadReceipt(workspaceId: string, expenseId: string, file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = file.type || HEIC[ext] || '';
  if (!(RECEIPT_TYPES as readonly string[]).includes(mimeType))
    throw new Error(
      `${file.name} isn’t a photo or a PDF. Pick a JPEG, PNG, HEIC or PDF of the receipt.`,
    );
  if (file.size > RECEIPT_MAX_BYTES)
    throw new Error(`${file.name} is over 25 MB. Take the photo again a little smaller.`);
  const begun = unwrap(
    await apiBrowser().POST('/v1/commands/expense.begin_receipt_upload', {
      body: {
        workspaceId,
        expenseId,
        name: file.name,
        mimeType: mimeType as (typeof RECEIPT_TYPES)[number],
        sizeBytes: file.size,
      },
    }),
  );
  const { error } = await supabaseBrowser()
    .storage.from(begun.bucket)
    .upload(begun.objectPath, file, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`${file.name} didn’t upload (${error.message}). Try again.`);
  unwrap(
    await apiBrowser().POST('/v1/commands/file.confirm', {
      body: { workspaceId, fileId: begun.fileId },
    }),
  );
}

function Figures({ inOut }: { inOut: MoneyInAndOutOut }) {
  const m = inOut.months.find((x) => x.month === inOut.breakdown.month) ?? {
    month: inOut.breakdown.month,
    inCents: inOut.breakdown.inCents,
    outCents: inOut.breakdown.outCents,
    expenseCount: 0,
  };
  return (
    <div
      className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3"
      data-testid="expenses-figures"
    >
      {inOutFigures(m, inOut.thisMonth).map((f) => (
        <div
          key={f.key}
          className="flex flex-col gap-0.5 bg-card px-[18px] py-3.5"
          data-testid={`expenses-${f.key}`}
        >
          <span
            className={cn(
              'text-2xl font-semibold leading-[1.15] tracking-[-0.015em] tabular-nums',
              f.tone === 'bad' && 'text-danger-text',
              f.tone === 'good' && 'text-success-text',
            )}
          >
            {f.value}
          </span>
          <span className="text-[12.5px] text-text-2">{f.label}</span>
          <span className="text-xs text-text-3">{f.sub}</span>
        </div>
      ))}
    </div>
  );
}

/** Each of the last months, in and out, and what went on what in the one shown. */
function Months({
  workspaceId,
  inOut,
  filters,
}: {
  workspaceId: string;
  inOut: MoneyInAndOutOut;
  filters: Filters;
}) {
  const year = Number(inOut.thisMonth.slice(0, 4));
  const biggest = Math.max(1, ...inOut.breakdown.categories.map((c) => c.cents));
  return (
    <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
      <section
        className="overflow-hidden rounded-card border border-border bg-card"
        data-testid="expenses-months"
      >
        <h2 className="px-4 pb-1 pt-3 text-[13px] font-semibold">Month by month</h2>
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <Th>Month</Th>
              <Th align="right">In</Th>
              <Th align="right">Out</Th>
              <Th align="right">Left</Th>
            </tr>
          </thead>
          <tbody>
            {inOut.months.map((m) => {
              const left = leftOf(m);
              const shown = m.month === inOut.breakdown.month;
              return (
                <tr key={m.month} className={cn(shown && 'bg-accent-soft')}>
                  <Td>
                    <Link
                      href={hrefFor(workspaceId, filters, { month: m.month })}
                      aria-current={shown ? 'true' : undefined}
                      className="font-medium hover:underline"
                    >
                      {monthLabel(m.month, year)}
                    </Link>
                  </Td>
                  <Td align="right">{signedDollars(m.inCents)}</Td>
                  <Td align="right">{signedDollars(m.outCents)}</Td>
                  <Td align="right" className={cn(left < 0 && 'text-danger-text')}>
                    {signedDollars(left)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section
        className="rounded-card border border-border bg-card px-4 py-3"
        data-testid="expenses-categories"
      >
        <h2 className="text-[13px] font-semibold">
          What it went on, {monthLabel(inOut.breakdown.month, year)}
        </h2>
        {inOut.breakdown.categories.length ? (
          <ul className="mt-2 flex flex-col gap-2.5">
            {inOut.breakdown.categories.map((c) => (
              <li key={c.category}>
                <Link
                  href={hrefFor(workspaceId, filters, {
                    category: filters.category === c.category ? '' : c.category,
                  })}
                  className="block"
                >
                  <span className="flex justify-between gap-3 text-[13px]">
                    <span className={cn(filters.category === c.category && 'font-semibold')}>
                      {c.label}
                    </span>
                    <span className="tabular-nums text-text-2">{money(c.cents)}</span>
                  </span>
                  <span className="mt-1 block h-1.5 rounded-full bg-card-2">
                    <span
                      className="block h-1.5 rounded-full bg-accent"
                      style={{ width: `${Math.max(3, Math.round((c.cents / biggest) * 100))}%` }}
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] text-text-3">Nothing spent yet.</p>
        )}
      </section>
    </div>
  );
}

const today = () => new Date().toLocaleDateString('en-CA');

/** Add an expense, or change one: the same boxes either way, with its receipt. */
function ExpenseDialog({
  workspaceId,
  open,
  onOpenChange,
  expense,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense: ExpenseRow | null;
}) {
  const router = useRouter();
  const [spentOn, setSpentOn] = useState(expense?.spentOn ?? today());
  const [amountCents, setAmountCents] = useState(expense?.amountCents ?? 0);
  const [amountBad, setAmountBad] = useState(false);
  const [taxCents, setTaxCents] = useState(expense?.taxCents ?? 0);
  const [vendor, setVendor] = useState(expense?.vendor ?? '');
  const [category, setCategory] = useState(expense?.category ?? 'materials');
  const [paidWith, setPaidWith] = useState(expense?.paidWith ?? '');
  const [note, setNote] = useState(expense?.note ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const taxTooBig = taxCents > amountCents;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const fields = {
        spentOn,
        amountCents,
        taxCents: taxCents > 0 ? taxCents : null,
        vendor: vendor.trim(),
        category: category as ExpenseRow['category'] & (typeof EXPENSE_CATEGORIES)[number]['id'],
        paidWith: (paidWith || null) as (typeof EXPENSE_PAID_WITH)[number]['id'] | null,
        note: note.trim() || null,
      };
      const { expenseId } = expense
        ? unwrap(
            await apiBrowser().POST('/v1/commands/expense.update', {
              body: { workspaceId, expenseId: expense.id, ...fields },
            }),
          )
        : unwrap(
            await apiBrowser().POST('/v1/commands/expense.create', {
              body: { workspaceId, ...fields },
            }),
          );
      if (file) {
        try {
          await uploadReceipt(workspaceId, expenseId, file);
        } catch (err) {
          toast.error(
            `${expense ? 'Saved' : 'Added'}, but the receipt didn’t go up. ${errorMessage(err)}`,
          );
          onOpenChange(false);
          router.refresh();
          return;
        }
      }
      toast.success(
        expense ? 'Expense saved.' : `Added ${money(amountCents)} at ${fields.vendor}.`,
      );
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!expense) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/expense.delete', {
          body: { workspaceId, expenseId: expense.id },
        }),
      );
      toast.success(`Removed ${money(expense.amountCents)} at ${expense.vendor}.`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={expense ? 'Change this expense' : 'Add an expense'}
        description="The whole amount paid, tax in it. Add the receipt so it’s kept with it."
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          onSubmit={(e) => void save(e)}
          className="mt-4 flex flex-col gap-3.5"
          data-testid="expense-form"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Paid to" htmlFor="expense-vendor" className="col-span-2">
              <Input
                id="expense-vendor"
                value={vendor}
                maxLength={120}
                required
                placeholder="Home Depot"
                onChange={(e) => setVendor(e.target.value)}
                data-testid="expense-vendor"
              />
            </Field>
            <Field
              label="Amount"
              htmlFor="expense-amount"
              error={amountBad ? 'Type an amount, like $42.50.' : undefined}
            >
              <MoneyInput
                id="expense-amount"
                valueCents={amountCents}
                onChange={setAmountCents}
                onInvalid={(v: boolean | SyntheticEvent<HTMLInputElement>) =>
                  setAmountBad(v === true)
                }
                invalid={amountBad}
                data-testid="expense-amount"
              />
            </Field>
            <Field
              label="Tax in it"
              htmlFor="expense-tax"
              hint="When the receipt shows it"
              error={taxTooBig ? 'The tax is more than the whole amount.' : undefined}
            >
              <MoneyInput
                id="expense-tax"
                valueCents={taxCents}
                onChange={setTaxCents}
                invalid={taxTooBig}
                data-testid="expense-tax"
              />
            </Field>
            <Field label="Day" htmlFor="expense-day">
              <Input
                id="expense-day"
                type="date"
                value={spentOn}
                required
                onChange={(e) => setSpentOn(e.target.value)}
                data-testid="expense-day"
              />
            </Field>
            <Field label="Category" htmlFor="expense-category">
              <Select
                id="expense-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                data-testid="expense-category"
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Paid with" htmlFor="expense-paid-with">
              <Select
                id="expense-paid-with"
                value={paidWith}
                onChange={(e) => setPaidWith(e.target.value)}
                data-testid="expense-paid-with"
              >
                <option value="">Not saying</option>
                {EXPENSE_PAID_WITH.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Note" htmlFor="expense-note">
              <Input
                id="expense-note"
                value={note}
                maxLength={1000}
                placeholder="What it was for"
                onChange={(e) => setNote(e.target.value)}
                data-testid="expense-note"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <input
              ref={picker}
              type="file"
              accept={[...RECEIPT_TYPES, '.heic', '.heif'].join(',')}
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="expense-receipt-input"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => picker.current?.click()}
            >
              <Paperclip className="h-4 w-4" />
              {file
                ? 'Pick another receipt'
                : expense?.receipt
                  ? 'Replace the receipt'
                  : 'Add the receipt'}
            </Button>
            {file ? (
              <span className="truncate text-text-2">{file.name}</span>
            ) : expense?.receipt ? (
              <button
                type="button"
                className="text-accent-text hover:underline"
                onClick={() => void openReceipt(expense.receipt!)}
              >
                See the receipt
              </button>
            ) : (
              <span className="text-text-3">A photo or a PDF</span>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            {expense ? (
              removing ? (
                <span className="flex items-center gap-2 text-[13px]">
                  Remove it and its receipt for good?
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    loading={busy}
                    onClick={() => void remove()}
                    data-testid="expense-remove-yes"
                  >
                    Remove
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoving(false)}
                  >
                    Keep it
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoving(true)}
                  data-testid="expense-remove"
                >
                  Remove
                </Button>
              )
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                loading={busy && !removing}
                disabled={amountBad || amountCents < 1 || taxTooBig || !vendor.trim() || !spentOn}
                data-testid="expense-save"
              >
                {expense ? 'Save' : 'Add it'}
              </Button>
            </span>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ExpensesView({
  workspaceId,
  inOut,
  initial,
  filters,
}: {
  workspaceId: string;
  inOut: MoneyInAndOutOut;
  initial: ExpenseListOut;
  filters: Filters;
}) {
  const router = useRouter();
  const key = `${filters.month}|${filters.query}|${filters.category}|${initial.expenses[0]?.id ?? ''}|${initial.count}`;
  const more = useMore<ExpenseRow>(key, initial.nextCursor);
  const rows = [...initial.expenses, ...more.items];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [words, setWords] = useState(filters.query);
  const year = Number(inOut.thisMonth.slice(0, 4));
  const filtered = Boolean(filters.query || filters.category);

  const edit = (row: ExpenseRow | null) => {
    setEditing(row);
    setOpen(true);
  };

  return (
    <>
      <Figures inOut={inOut} />
      <Months workspaceId={workspaceId} inOut={inOut} filters={filters} />
      <div className="mb-3 mt-5 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-[15px] font-semibold">
          Expenses, {monthLabel(filters.month, year)}
        </h2>
        <form
          role="search"
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(hrefFor(workspaceId, filters, { query: words.trim() }));
          }}
        >
          <span className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
            <Input
              aria-label="Search expenses"
              placeholder="Search expenses"
              value={words}
              onChange={(e) => setWords(e.target.value)}
              className="w-52 pl-8"
              data-testid="expenses-search"
            />
          </span>
        </form>
        <Select
          aria-label="Category"
          value={filters.category}
          onChange={(e) => router.push(hrefFor(workspaceId, filters, { category: e.target.value }))}
          className="w-52"
          data-testid="expenses-category"
        >
          <option value="">Every category</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Button onClick={() => edit(null)} data-testid="expense-add">
          <Plus className="h-4 w-4" />
          Add expense
        </Button>
      </div>
      <div
        className="overflow-hidden rounded-card border border-border bg-card"
        data-testid="expenses-list"
      >
        {rows.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Day</Th>
                <Th>Paid to</Th>
                <Th className="max-md:hidden">Category</Th>
                <Th className="max-md:hidden">Paid with</Th>
                <Th>
                  <span className="sr-only">Receipt</span>
                </Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer hover:bg-card-2"
                  onClick={() => edit(r)}
                  data-testid="expense-row"
                >
                  <Td className="whitespace-nowrap text-text-2">{shortDay(r.spentOn)}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        edit(r);
                      }}
                    >
                      {r.vendor}
                    </button>
                    {r.note ? (
                      <span className="block truncate text-xs text-text-3">{r.note}</span>
                    ) : null}
                  </Td>
                  <Td className="max-md:hidden text-text-2">{r.categoryLabel}</Td>
                  <Td className="max-md:hidden text-text-2">
                    {expensePaidWithLabel(r.paidWith) ?? ''}
                  </Td>
                  <Td>
                    {r.receipt ? (
                      <button
                        type="button"
                        aria-label={`See the receipt from ${r.vendor}`}
                        className="rounded-control p-1 text-text-2 hover:bg-card-2 hover:text-text"
                        onClick={(e) => {
                          e.stopPropagation();
                          void openReceipt(r.receipt!);
                        }}
                      >
                        <Receipt className="h-4 w-4" />
                      </button>
                    ) : null}
                  </Td>
                  <Td align="right">{money(r.amountCents)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title={filtered ? 'No expenses match' : 'No expenses yet'}>
            {filtered ? 'Try other words, or every category.' : EXPENSES_EMPTY}
          </EmptyState>
        )}
        {more.cursor ? (
          <ShowMore
            busy={more.busy}
            onClick={() =>
              void more.load(async (cursor) => {
                const page = unwrap(
                  await apiBrowser().POST('/v1/queries/expense.list', {
                    body: {
                      workspaceId,
                      month: filters.month,
                      query: filters.query || undefined,
                      category: (filters.category || undefined) as
                        ExpenseRow['category'] | undefined,
                      limit: 50,
                      cursor,
                    } as never,
                  }),
                ) as ExpenseListOut;
                return { items: page.expenses, nextCursor: page.nextCursor };
              })
            }
          />
        ) : null}
      </div>
      {initial.count ? (
        <ListNote>
          {initial.count === 1 ? '1 expense' : `${initial.count.toLocaleString('en-US')} expenses`},{' '}
          {money(initial.totalCents)} in all{filtered ? ' that match' : ''}. Ask the Assistant for a
          spreadsheet of them for your accountant.
        </ListNote>
      ) : null}
      {open ? (
        <ExpenseDialog
          key={editing?.id ?? 'new'}
          workspaceId={workspaceId}
          open={open}
          onOpenChange={setOpen}
          expense={editing}
        />
      ) : null}
    </>
  );
}
