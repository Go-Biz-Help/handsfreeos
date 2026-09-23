'use client';
import { money, PAYMENT_METHOD_LABELS } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PaymentConnectionRow, PaymentRow } from '@/lib/api/types';
import { accountsFor, firstAccount } from './draft';
import { MoneyInput } from './money-input';

type Person = { fullName: string; email: string | null; phone: string | null };

/** Every dialog here does one thing and then reloads the page it sits on. */
function useAction(): [boolean, (run: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  return [
    busy,
    async (run) => {
      setBusy(true);
      try {
        await run();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
  ];
}

/**
 * Sending: which ways the customer is told, and a line to go with it. A document with no email and no phone
 * cannot be sent at all, and says so rather than failing at the worker.
 */
export function SendDialog({
  open,
  onOpenChange,
  kind,
  workspaceId,
  documentId,
  person,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: 'estimate' | 'invoice';
  workspaceId: string;
  documentId: string;
  person: Person;
  onSent?: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, act] = useAction();
  const canEmail = !!person.email;
  const canText = !!person.phone;
  const channels: ('sms' | 'email')[] = [
    ...(email && canEmail ? (['email'] as const) : []),
    ...(sms && canText ? (['sms'] as const) : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={kind === 'estimate' ? 'Send this estimate' : 'Send this invoice'}
        description={`${person.fullName} gets a link to their own page. The number is taken the moment you send, so numbers stay in order.`}
      >
        <div className="mt-4 flex flex-col gap-2.5" data-testid="send-dialog">
          <Checkbox
            label={canEmail ? `Email · ${person.email}` : 'Email · no address on file'}
            checked={email && canEmail}
            disabled={!canEmail}
            onChange={(e) => setEmail(e.target.checked)}
          />
          <Checkbox
            label={canText ? `Text · ${person.phone}` : 'Text · no mobile on file'}
            checked={sms && canText}
            disabled={!canText}
            onChange={(e) => setSms(e.target.checked)}
          />
          <Field label="A line to go with it" htmlFor="send-message" className="mt-1.5">
            <Textarea
              id="send-message"
              rows={3}
              maxLength={2_000}
              value={message}
              placeholder="Optional. Anything here goes out with the link."
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Not yet</Button>
          </DialogClose>
          <Button
            loading={busy}
            disabled={channels.length === 0}
            data-testid="send-confirm"
            onClick={() =>
              void act(async () => {
                const note = message.trim() || null;
                const out =
                  kind === 'estimate'
                    ? unwrap(
                        await apiBrowser().POST('/v1/commands/estimate.send', {
                          body: { workspaceId, estimateId: documentId, channels, message: note },
                        }),
                      )
                    : unwrap(
                        await apiBrowser().POST('/v1/commands/invoice.send', {
                          body: { workspaceId, invoiceId: documentId, channels, message: note },
                        }),
                      );
                toast.success(`${out.number ?? 'It'} is on its way to ${person.fullName}.`);
                onOpenChange(false);
                onSent?.();
                router.refresh();
              })
            }
          >
            Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Turning an approved estimate into the invoice that collects the money. */
export function ConvertDialog({
  open,
  onOpenChange,
  workspaceId,
  estimateId,
  depositCents,
  connections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  estimateId: string;
  depositCents: number;
  connections: readonly PaymentConnectionRow[];
}) {
  const router = useRouter();
  const [purpose, setPurpose] = useState<'standard' | 'deposit'>('standard');
  // Only the accounts this person may bill into (0105), theirs by default.
  const payable = accountsFor(connections);
  const [connectionId, setConnectionId] = useState(firstAccount(connections)?.id ?? '');
  const [busy, act] = useAction();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Turn this into an invoice"
        description="Every line comes across. The estimate keeps what the customer agreed to."
      >
        <div className="mt-4 flex flex-col gap-3.5" data-testid="convert-dialog">
          {depositCents > 0 ? (
            <Field label="What to bill" htmlFor="convert-purpose">
              <Select
                id="convert-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as 'standard' | 'deposit')}
              >
                <option value="standard">
                  The whole job · the {money(depositCents)} deposit is asked for first
                </option>
                <option value="deposit">Only the {money(depositCents)} deposit, on its own</option>
              </Select>
            </Field>
          ) : null}
          {payable.length > 0 ? (
            <Field label="Paid into" htmlFor="convert-connection">
              <Select
                id="convert-connection"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {payable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {connectionLabel(c)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={busy}
            data-testid="convert-confirm"
            onClick={() =>
              void act(async () => {
                const out = unwrap(
                  await apiBrowser().POST('/v1/commands/estimate.convert', {
                    body: {
                      workspaceId,
                      estimateId,
                      purpose,
                      connectionId: connectionId || null,
                    },
                  }),
                );
                toast.success('Invoice raised from this estimate.');
                onOpenChange(false);
                router.push(`/app/w/${workspaceId}/money/invoices/${out.invoiceId}`);
              })
            }
          >
            Make the invoice
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** They said yes on the phone: recorded in the name they gave, by the person who took the call. */
export function MarkAcceptedDialog({
  open,
  onOpenChange,
  workspaceId,
  estimateId,
  personName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  estimateId: string;
  personName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(personName);
  const [note, setNote] = useState('');
  const [busy, act] = useAction();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="They said yes"
        description="Recorded in your name, with the moment, so the estimate reads honestly later."
      >
        <div className="mt-4 flex flex-col gap-3.5" data-testid="accepted-dialog">
          <Field label="Who said yes" htmlFor="accepted-name">
            <Input
              id="accepted-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Anything worth noting" htmlFor="accepted-note">
            <Textarea
              id="accepted-note"
              rows={2}
              maxLength={500}
              value={note}
              placeholder="Optional."
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={busy}
            disabled={!name.trim()}
            data-testid="accepted-confirm"
            onClick={() =>
              void act(async () => {
                unwrap(
                  await apiBrowser().POST('/v1/commands/estimate.mark_accepted', {
                    body: {
                      workspaceId,
                      estimateId,
                      name: name.trim(),
                      note: note.trim() || null,
                    },
                  }),
                );
                toast.success('Marked approved.');
                onOpenChange(false);
                router.refresh();
              })
            }
          >
            Mark approved
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Cash, a cheque, or money taken some other way off the system. Never more than what is owed. */
export function CashPaymentDialog({
  open,
  onOpenChange,
  workspaceId,
  invoiceId,
  balanceCents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  invoiceId: string;
  balanceCents: number;
}) {
  const router = useRouter();
  const [amountCents, setAmountCents] = useState(balanceCents);
  const [method, setMethod] = useState<'cash' | 'check' | 'other'>('cash');
  const [reference, setReference] = useState('');
  const [busy, act] = useAction();
  const tooMuch = amountCents > balanceCents;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record a payment"
        description={`Money taken off the system. ${money(balanceCents)} is owed.`}
      >
        <div className="mt-4 flex flex-col gap-3.5" data-testid="cash-dialog">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="How much"
              htmlFor="cash-amount"
              error={tooMuch ? `That is more than the ${money(balanceCents)} owed.` : undefined}
            >
              <MoneyInput
                id="cash-amount"
                valueCents={amountCents}
                onChange={setAmountCents}
                invalid={tooMuch}
                data-testid="cash-amount"
              />
            </Field>
            <Field label="How it was paid" htmlFor="cash-method">
              <Select
                id="cash-method"
                value={method}
                onChange={(e) => setMethod(e.target.value as 'cash' | 'check' | 'other')}
              >
                <option value="cash">{PAYMENT_METHOD_LABELS.cash}</option>
                <option value="check">{PAYMENT_METHOD_LABELS.check}</option>
                <option value="other">{PAYMENT_METHOD_LABELS.other}</option>
              </Select>
            </Field>
          </div>
          <Field label="Reference" htmlFor="cash-reference" hint="A cheque number, say. Optional.">
            <Input
              id="cash-reference"
              value={reference}
              maxLength={120}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={busy}
            disabled={tooMuch || amountCents < 1}
            data-testid="cash-confirm"
            onClick={() =>
              void act(async () => {
                unwrap(
                  await apiBrowser().POST('/v1/commands/invoice.record_cash_payment', {
                    body: {
                      workspaceId,
                      invoiceId,
                      amountCents,
                      method,
                      reference: reference.trim() || null,
                    },
                  }),
                );
                toast.success(`${money(amountCents)} recorded.`);
                onOpenChange(false);
                router.refresh();
              })
            }
          >
            Record it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Giving money back. A refund needs the account it was taken into to be connected right now. */
export function RefundDialog({
  open,
  onOpenChange,
  workspaceId,
  payment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  payment: PaymentRow | null;
}) {
  const router = useRouter();
  const refundable = payment ? payment.amountCents - payment.refundedCents : 0;
  const [amountCents, setAmountCents] = useState(refundable);
  const [reason, setReason] = useState('');
  const [busy, act] = useAction();
  const tooMuch = amountCents > refundable;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Refund this payment"
        description={
          payment
            ? `${money(refundable)} of the ${money(payment.amountCents)} can still be given back.`
            : ''
        }
      >
        <div className="mt-4 flex flex-col gap-3.5" data-testid="refund-dialog">
          <Field
            label="How much"
            htmlFor="refund-amount"
            error={tooMuch ? `Only ${money(refundable)} is left to refund.` : undefined}
          >
            <MoneyInput
              id="refund-amount"
              valueCents={amountCents}
              onChange={setAmountCents}
              invalid={tooMuch}
              data-testid="refund-amount"
            />
          </Field>
          <Field label="Why" htmlFor="refund-reason" hint="Kept with the refund. Optional.">
            <Textarea
              id="refund-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            variant="danger"
            loading={busy}
            disabled={!payment || tooMuch || amountCents < 1}
            data-testid="refund-confirm"
            onClick={() =>
              void act(async () => {
                if (!payment) return;
                const out = unwrap(
                  await apiBrowser().POST('/v1/commands/payment.refund', {
                    body: {
                      workspaceId,
                      paymentId: payment.id,
                      amountCents,
                      reason: reason.trim() || null,
                    },
                  }),
                );
                toast.success(
                  out.manual
                    ? `${money(out.amountCents)} refunded.`
                    : `${money(out.amountCents)} is on its way back.`,
                );
                onOpenChange(false);
                router.refresh();
              })
            }
          >
            Refund
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Voiding. A number is never reused, so a voided document stays readable for ever. */
export function VoidDialog({
  open,
  onOpenChange,
  kind,
  workspaceId,
  documentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: 'estimate' | 'invoice';
  workspaceId: string;
  documentId: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, act] = useAction();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Void this ${kind}`}
        description={`It keeps its number and stays readable. Numbers are never reused, so make a new ${kind} to replace it.`}
      >
        <Field label="Why" htmlFor="void-reason" className="mt-4" hint="Optional.">
          <Textarea
            id="void-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Keep it</Button>
          </DialogClose>
          <Button
            variant="danger"
            loading={busy}
            data-testid="void-confirm"
            onClick={() =>
              void act(async () => {
                const why = reason.trim() || null;
                if (kind === 'estimate')
                  unwrap(
                    await apiBrowser().POST('/v1/commands/estimate.void', {
                      body: { workspaceId, estimateId: documentId, reason: why },
                    }),
                  );
                else
                  unwrap(
                    await apiBrowser().POST('/v1/commands/invoice.void', {
                      body: { workspaceId, invoiceId: documentId, reason: why },
                    }),
                  );
                toast.success('Voided.');
                onOpenChange(false);
                router.refresh();
              })
            }
          >
            Void it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Stripe · Lone Star HVAC" — what an account is called on screen. */
export function connectionLabel(c: PaymentConnectionRow): string {
  const provider =
    c.provider === 'stripe' ? 'Stripe' : c.provider === 'square' ? 'Square' : c.provider;
  const name = c.label ?? c.displayName;
  return name ? `${provider} · ${name}` : provider;
}
