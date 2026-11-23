'use client';
import {
  MAX_ORDER_NOTES,
  money,
  nextOrderStatus,
  orderLineCents,
  orderNumberWords,
  orderStepLabel,
  orderStatusWords,
  orderTotalCents,
  ORDER_STEPS,
  INVOICE_WORDS,
  dayLabel,
  stockChoiceOf,
  stockWords,
  type InvoiceState,
  type OrderFulfilment,
  type OrderStatus as Status,
} from '@hfos/core';
import { ArrowRight, Check, FileText, Pencil, RotateCcw, Undo2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ResponseAnswers } from '@/components/forms/responses';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FormResponseGetOut, OrderSummary, ProductRow } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import {
  draftLine,
  linesInput,
  linesProblem,
  OrderLinesEditor,
  OrderWhenFields,
  type OrderLineDraft,
} from './order-editor';
import { OrderStatus } from './orders-list';
import { MoneyCrumbs } from './subnav';

/** The step before this one, for Back. */
function previousStep(status: Status): Status | null {
  const at = ORDER_STEPS.indexOf(status);
  return at > 0 ? ORDER_STEPS[at - 1]! : null;
}

/** One order: where it is and the buttons that move it, what's on it, when, notes, the invoice, and the form. */
export function OrderPage({
  workspaceId,
  order,
  products,
  response,
  canWrite,
  canBill,
  timeZone,
}: {
  workspaceId: string;
  order: OrderSummary;
  products: readonly ProductRow[];
  /** What they answered on the form that made it, when it came from one this person may see. */
  response: FormResponseGetOut | null;
  canWrite: boolean;
  canBill: boolean;
  /** The business's, for the day it was taken. */
  timeZone: string;
}) {
  const router = useRouter();
  useLiveRefresh(['order', 'invoice']);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const name = orderNumberWords(order.number);
  const refresh = () => startTransition(() => router.refresh());

  /** Runs one change; true once it went through. */
  async function act(key: string, run: () => Promise<unknown>, done?: string): Promise<boolean> {
    setBusy(key);
    try {
      await run();
      if (done) toast.success(done);
      refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const setStatus = (status: Status) =>
    act(
      `status-${status}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/order.set_status', {
            body: { workspaceId, orderId: order.id, status },
          }),
        ),
      `${name}: ${orderStatusWords(status, order.fulfilment)}.`,
    );

  const update = (key: string, body: Record<string, unknown>, done?: string) =>
    act(
      key,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/order.update', {
            body: { workspaceId, orderId: order.id, ...body },
          }),
        ),
      done,
    );

  const next = nextOrderStatus(order.status);
  const back = previousStep(order.status);

  return (
    <div className="mx-auto max-w-[920px]" data-testid="order-page">
      <MoneyCrumbs workspaceId={workspaceId} tab="orders" current={name} />
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-[22px] font-semibold tracking-tight" data-testid="order-title">
          Order {name}
        </h1>
        <OrderStatus order={order} testId="order-page-status" />
        <span className="w-full text-[13.5px] text-text-2">
          For{' '}
          <Link
            href={`/app/w/${workspaceId}/customers/${order.person.id}`}
            className="font-medium text-accent-text hover:underline"
          >
            {order.person.name}
          </Link>
          {' · '}
          {/* The business's day, so the server and the browser say the same one. */}
          {dayLabel(Date.parse(order.createdAt), timeZone)}
          {order.form ? (
            <>
              {' · from '}
              <Link
                href={`/app/w/${workspaceId}/forms/${order.form.id}${order.formResponseId ? `?response=${order.formResponseId}` : ''}`}
                className="hover:underline"
              >
                {order.form.name}
              </Link>
            </>
          ) : null}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Steps order={order} />
          {canWrite ? (
            <Card
              className="flex flex-wrap items-center gap-2 px-5 py-4"
              data-testid="order-actions"
            >
              {next ? (
                <Button
                  onClick={() => setStatus(next)}
                  loading={busy === `status-${next}`}
                  disabled={!!busy}
                  data-testid="order-next"
                >
                  {next === 'done' ? (
                    <Check className="h-4 w-4" strokeWidth={1.75} />
                  ) : (
                    <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
                  )}
                  {orderStepLabel(next, order.fulfilment)}
                </Button>
              ) : null}
              {back ? (
                <Button
                  variant="secondary"
                  onClick={() => setStatus(back)}
                  loading={busy === `status-${back}`}
                  disabled={!!busy}
                  data-testid="order-back"
                >
                  <Undo2 className="h-4 w-4" strokeWidth={1.75} />
                  Back to {orderStatusWords(back, order.fulfilment).toLowerCase()}
                </Button>
              ) : null}
              <span className="flex-1" />
              {order.status === 'cancelled' ? (
                <Button
                  variant="secondary"
                  onClick={() => setStatus('new')}
                  loading={busy === 'status-new'}
                  disabled={!!busy}
                  data-testid="order-reopen"
                >
                  <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                  Reopen it
                </Button>
              ) : order.open ? (
                <Button
                  variant="ghost"
                  className="text-danger-text"
                  onClick={() => setStatus('cancelled')}
                  loading={busy === 'status-cancelled'}
                  disabled={!!busy}
                  data-testid="order-cancel"
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                  {orderStepLabel('cancelled', order.fulfilment)}
                </Button>
              ) : null}
            </Card>
          ) : null}

          <Lines
            order={order}
            products={products}
            editable={canWrite && order.open}
            busy={busy === 'lines'}
            onSave={(lines) => update('lines', { lines: linesInput(lines) }, 'Order saved.')}
          />

          {response ? (
            <Card className="px-5 pb-5 pt-4" data-testid="order-answers">
              <h2 className="mb-3 text-base font-semibold tracking-tight">
                What they answered on {order.form?.name ?? 'the form'}
              </h2>
              <ResponseAnswers response={response} />
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card className="px-5 pb-5 pt-4" data-testid="order-when">
            <h2 className="mb-3 text-base font-semibold tracking-tight">When</h2>
            <OrderWhenFields
              fulfilment={order.fulfilment}
              dueOn={order.dueOn ?? ''}
              disabled={!canWrite || !!busy}
              onFulfilment={(f: OrderFulfilment | null) => update('when', { fulfilment: f })}
              onDueOn={(day) => update('when', { dueOn: day || null })}
            />
          </Card>

          <InvoiceCard
            workspaceId={workspaceId}
            order={order}
            canBill={canBill}
            busy={busy === 'invoice'}
            onMake={() =>
              act('invoice', async () => {
                const out = unwrap(
                  await apiBrowser().POST('/v1/commands/order.make_invoice', {
                    body: { workspaceId, orderId: order.id },
                  }),
                );
                toast.success('Invoice made. Check it over, then send it.');
                router.push(`/app/w/${workspaceId}/money/invoices/${out.invoiceId}`);
              })
            }
          />

          <Notes
            order={order}
            editable={canWrite}
            busy={busy === 'notes'}
            onSave={(notes) => update('notes', { notes: notes.trim() || null }, 'Notes saved.')}
          />
        </div>
      </div>
    </div>
  );
}

/** New → Making it → Ready → Picked up, with where it is lit. */
function Steps({ order }: { order: OrderSummary }) {
  if (order.status === 'cancelled')
    return (
      <Card className="px-5 py-4 text-[13.5px] text-text-2" data-testid="order-steps">
        This order was cancelled. Reopen it if it’s going ahead after all.
      </Card>
    );
  const at = ORDER_STEPS.indexOf(order.status);
  return (
    <Card className="px-5 py-4" data-testid="order-steps">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {ORDER_STEPS.map((step, i) => (
          <li key={step} className="flex items-center gap-2">
            <span
              data-current={i === at || undefined}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium',
                i < at && 'bg-success-soft text-success-text',
                i === at && 'bg-accent-soft text-accent-text',
                i > at && 'bg-card-2 text-text-3',
              )}
            >
              {i < at ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : null}
              {orderStatusWords(step, order.fulfilment)}
            </span>
            {i < ORDER_STEPS.length - 1 ? (
              <ArrowRight className="h-3.5 w-3.5 text-text-3" strokeWidth={1.75} aria-hidden />
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Lines({
  order,
  products,
  editable,
  busy,
  onSave,
}: {
  order: OrderSummary;
  products: readonly ProductRow[];
  editable: boolean;
  busy: boolean;
  onSave: (lines: OrderLineDraft[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<OrderLineDraft[] | null>(null);
  const [badPrice, setBadPrice] = useState(false);
  const problem = editing ? linesProblem(editing, badPrice) : null;

  // What each line did to stock: taken off when it was done ("Took 5 off stock · 3 left"), or, before then, what's
  // on hand for a product that's counted ("Comes off stock when it’s picked up · 8 on hand").
  const stockNotes = lineStockNotes(order, products);

  return (
    <Card className="px-5 pb-5 pt-4" data-testid="order-what">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-base font-semibold tracking-tight">What they ordered</h2>
        {editable && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(order.lines.map((l) => draftLine(l)))}
            data-testid="order-lines-edit"
          >
            <Pencil className="h-4 w-4" strokeWidth={1.75} />
            Change
          </Button>
        ) : null}
      </div>
      {editing ? (
        <>
          <OrderLinesEditor
            lines={editing}
            onChange={setEditing}
            products={products}
            onBadPrice={setBadPrice}
          />
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {problem ? <span className="text-[13px] text-text-3">{problem}</span> : null}
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={busy}
              disabled={!!problem}
              onClick={async () => {
                if (await onSave(editing)) setEditing(null);
              }}
              data-testid="order-lines-save"
            >
              Save
            </Button>
          </div>
        </>
      ) : (
        <>
          <ul className="divide-y divide-border" data-testid="order-lines-view">
            {order.lines.map((l, i) => (
              <li key={i} className="flex items-baseline gap-3 py-2.5 text-[14px]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{l.name}</span>
                  <span className="text-[12.5px] text-text-3">
                    {l.quantity.toLocaleString('en-US')} ×{' '}
                    {l.unitPriceCents > 0 ? money(l.unitPriceCents) : 'no price yet'}
                  </span>
                  {stockNotes[i] ? (
                    <span
                      className="block text-[12.5px] text-text-3"
                      data-testid="order-line-stock"
                    >
                      {stockNotes[i]}
                    </span>
                  ) : null}
                </span>
                <span className="whitespace-nowrap tabular-nums">
                  {l.unitPriceCents > 0 ? money(orderLineCents(l)) : '—'}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-3 text-[14px]">
            <span className="text-text-2">
              {order.itemCount.toLocaleString('en-US')} {order.itemCount === 1 ? 'item' : 'items'}
            </span>
            <span className="text-[16px] font-semibold tabular-nums" data-testid="order-total">
              {money(order.totalCents)}
            </span>
          </div>
          {editable && order.lines.some((l) => l.unitPriceCents === 0) ? (
            <p className="mt-2 text-[12.5px] text-text-3">
              Lines with no price yet count as $0. Change the order to price them before making the
              invoice.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Each line's stock note, or null. The order keeps what it took in line order, one entry per counted line. */
function lineStockNotes(order: OrderSummary, products: readonly ProductRow[]): (string | null)[] {
  const taken = [...order.stockTaken];
  const doneWord =
    order.fulfilment === 'pickup'
      ? 'picked up'
      : order.fulfilment === 'delivery'
        ? 'delivered'
        : 'done';
  return order.lines.map((l) => {
    if (order.stockTaken.length || order.status === 'done') {
      const at = taken.findIndex(
        (t) =>
          t.productId === l.productId && (t.choiceId === '' || l.choiceIds.includes(t.choiceId)),
      );
      if (at === -1) return null;
      const [t] = taken.splice(at, 1);
      return `Took ${t!.quantity.toLocaleString('en-US')} off stock · ${t!.left.toLocaleString('en-US')} left`;
    }
    if (order.status === 'cancelled' || !l.productId) return null;
    const product = products.find((p) => p.id === l.productId);
    if (!product?.stock) return null;
    const choice = stockChoiceOf(product, l.choiceIds);
    if (choice === null) return 'Not counted: no choice of what its stock is counted by';
    return `Comes off stock when it’s ${doneWord} · ${stockWords(product.stock.counts[choice] ?? 0, product.stock.lowAt)}`;
  });
}

function InvoiceCard({
  workspaceId,
  order,
  canBill,
  busy,
  onMake,
}: {
  workspaceId: string;
  order: OrderSummary;
  canBill: boolean;
  busy: boolean;
  onMake: () => void;
}) {
  const inv = order.invoice;
  const voided = inv?.status === 'void';
  const unpriced = orderTotalCents(order.lines) === 0;
  return (
    <Card className="px-5 pb-5 pt-4" data-testid="order-invoice">
      <h2 className="mb-2 text-base font-semibold tracking-tight">Invoice</h2>
      {inv ? (
        <Link
          href={`/app/w/${workspaceId}/money/invoices/${inv.id}`}
          className="flex items-center gap-2 rounded-control border border-border px-3 py-2.5 text-[13.5px] transition-colors hover:bg-card-2"
          data-testid="order-invoice-link"
        >
          <FileText className="h-4 w-4 shrink-0 text-text-2" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate font-medium">
            {inv.number ?? 'Draft invoice'}
          </span>
          <span className="text-text-3">
            {INVOICE_WORDS[inv.status as InvoiceState] ?? inv.status} · {money(inv.totalCents)}
          </span>
        </Link>
      ) : order.invoiceId ? (
        <p className="text-[13.5px] text-text-2">An invoice was made for this order.</p>
      ) : (
        <p className="text-[13.5px] text-text-2">No invoice yet.</p>
      )}
      {inv && !voided && inv.totalCents !== order.totalCents ? (
        <p className="mt-2 text-[12.5px] text-text-3">
          The order is {money(order.totalCents)} now. Change the invoice to match if it hasn’t gone
          out yet.
        </p>
      ) : null}
      {canBill && (!order.invoiceId || voided) && order.status !== 'cancelled' ? (
        <>
          <Button
            className="mt-3 w-full"
            variant={inv ? 'secondary' : 'primary'}
            onClick={onMake}
            loading={busy}
            disabled={unpriced}
            data-testid="order-make-invoice"
          >
            {voided ? 'Make a new invoice' : 'Make the invoice'}
          </Button>
          {unpriced ? (
            <p className="mt-2 text-[12.5px] text-text-3">
              Nothing on the order has a price yet. Set prices first.
            </p>
          ) : (
            <p className="mt-2 text-[12.5px] text-text-3">
              It starts as a draft with each line at its price, for you to send.
            </p>
          )}
        </>
      ) : null}
      {!canBill && !order.invoiceId ? (
        <p className="mt-2 text-[12.5px] text-text-3">Someone who bills can make it.</p>
      ) : null}
      {inv && !voided ? (
        <ButtonLink
          href={`/app/w/${workspaceId}/money/invoices/${inv.id}`}
          variant="ghost"
          size="sm"
          className="mt-2"
        >
          Open the invoice
        </ButtonLink>
      ) : null}
    </Card>
  );
}

function Notes({
  order,
  editable,
  busy,
  onSave,
}: {
  order: OrderSummary;
  editable: boolean;
  busy: boolean;
  onSave: (notes: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(order.notes ?? '');
  const [was, setWas] = useState(order.notes ?? '');
  if ((order.notes ?? '') !== was) {
    setWas(order.notes ?? '');
    setText(order.notes ?? '');
  }
  const dirty = text.trim() !== (order.notes ?? '').trim();
  return (
    <Card className="px-5 pb-5 pt-4" data-testid="order-notes-card">
      <h2 className="mb-2 text-base font-semibold tracking-tight">Notes</h2>
      {editable ? (
        <>
          <Textarea
            rows={4}
            value={text}
            maxLength={MAX_ORDER_NOTES}
            placeholder="Only your team sees these."
            onChange={(e) => setText(e.target.value)}
            data-testid="order-notes"
          />
          {dirty ? (
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setText(order.notes ?? '')}>
                Cancel
              </Button>
              <Button
                size="sm"
                loading={busy}
                onClick={() => void onSave(text)}
                data-testid="order-notes-save"
              >
                Save notes
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="whitespace-pre-wrap text-[13.5px] text-text-2">{order.notes || 'None.'}</p>
      )}
    </Card>
  );
}
