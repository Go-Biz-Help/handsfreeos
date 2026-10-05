'use client';
/**
 * A buyer deal's financing (board 22, design/realestate/Financing.dc.html): the loan's steps from preapproval to
 * funding, each marked done with its proof (the lender's letter or email, or a document), the Closing Disclosure's
 * deadline, and the lender. A step's proof counts for the duties that ask for it; marking it done never finishes a
 * duty on its own.
 */
import { fmtMonthDay, money } from '@hfos/core';
import {
  LOAN_TYPE_KEYS,
  LOAN_TYPES,
  type LoanType,
} from '@hfos/core/addons/realestate/offer-words';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { parseMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CardHead, Line } from './bits';
import { DealCrumb, street } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { DealDocument, Financing, FinancingStep } from './types';
import { useAct } from './use-act';

export interface ProofFile {
  readonly id: string;
  readonly name: string;
}

const thisYear = () => new Date().getFullYear();

/** Which steps keep an amount, a rate and an end date. */
const HAS_AMOUNT = new Set(['preapproval', 'appraisal']);
const HAS_RATE = new Set(['rate_lock']);
const HAS_EXPIRY = new Set(['preapproval', 'rate_lock']);

export function FinancingPage({
  workspaceId,
  dealId,
  dealName,
  address,
  financing: f,
  documents,
  files,
  live,
  side = 'buyer',
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  address: string | null;
  financing: Financing;
  documents: readonly DealDocument[];
  files: readonly ProofFile[];
  live: boolean;
  side?: 'buyer' | 'listing';
}) {
  useLiveRefresh(['custom_record']);
  // On a listing it's the buyers' loan the deal waits on (round three).
  const title = side === 'listing' ? 'The buyer’s loan' : 'Financing';
  const [step, setStep] = useState<{ s: FinancingStep; done: boolean } | null>(null);
  const [reopening, setReopening] = useState<FinancingStep | null>(null);
  const [lender, setLender] = useState(false);
  const l = f.lender;
  return (
    <div data-testid="realestate-financing">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here={title} />
      <PageHeader
        title={title}
        description={[
          dealName,
          address ? street(address) : null,
          f.closing ? `closing ${fmtMonthDay(f.closing, thisYear())}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
        <Card className="p-0" data-testid="financing-steps">
          <ul>
            {f.steps.map((s) => (
              <li
                key={s.step}
                className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3.5 last:border-b-0 md:px-5"
                data-testid={`financing-${s.step}`}
              >
                <span
                  className={cn(
                    'mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full border',
                    s.status === 'done' && 'border-success bg-success text-on-solid',
                    s.status === 'in_progress' && 'border-warning bg-warning-soft',
                    s.status === 'not_started' && 'border-border-strong',
                  )}
                >
                  {s.status === 'done' ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold">{s.label}</div>
                  <div className="text-[12.5px] text-text-2">{s.line}</div>
                  {s.warning ? (
                    <div className="text-[12.5px] text-warning-text">{s.warning}</div>
                  ) : null}
                </div>
                <div className="flex flex-none items-center gap-2 text-[12.5px] text-text-2">
                  {s.proof ? <span className="max-w-[200px] truncate">{s.proof.label}</span> : null}
                  {s.step === 'closing_disclosure' && f.cdDeadline && s.status !== 'done' ? (
                    <span>3 business days before closing</span>
                  ) : null}
                  {live ? (
                    s.status === 'done' ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setStep({ s, done: false })}
                        >
                          Change
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setReopening(s)}>
                          Not done
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setStep({ s, done: false })}
                        >
                          Dates
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setStep({ s, done: true })}
                          data-testid={`financing-done-${s.step}`}
                        >
                          Mark done
                        </Button>
                      </>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-4">
          <Card className="p-4 md:p-5" data-testid="financing-lender">
            <CardHead
              title="Lender"
              action={
                live ? (
                  <Button size="sm" variant="ghost" onClick={() => setLender(true)}>
                    {l.lenderName ? 'Change' : 'Add'}
                  </Button>
                ) : null
              }
            />
            {l.lenderName || l.officerName ? (
              <>
                <Line label={l.lenderName ?? 'Lender'}>{l.officerName ?? '—'}</Line>
                {l.officerEmail || l.officerPhone ? (
                  <Line label="Reach them">
                    {[l.officerEmail, l.officerPhone].filter(Boolean).join(' · ')}
                  </Line>
                ) : null}
                {l.loanType || l.loanAmountCents ? (
                  <Line label="Loan">
                    {[
                      l.loanType ? LOAN_TYPES[l.loanType] : null,
                      l.loanAmountCents ? money(l.loanAmountCents) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Line>
                ) : null}
              </>
            ) : (
              <p className="text-[13.5px] text-text-2">No lender yet.</p>
            )}
          </Card>
          <Card className="p-4 md:p-5">
            <CardHead title="Marking a step done" />
            <p className="text-[13px] text-text-2">
              Each step needs its proof: the lender’s letter or email, or a document. It then counts
              for the matching duties, like the rate-lock deadline.
            </p>
          </Card>
        </div>
      </div>
      {step ? (
        <StepDialog
          step={step.s}
          done={step.done}
          onClose={() => setStep(null)}
          workspaceId={workspaceId}
          dealId={dealId}
          documents={documents}
          files={files}
        />
      ) : null}
      {lender ? (
        <LenderDialog
          financing={f}
          onClose={() => setLender(false)}
          workspaceId={workspaceId}
          dealId={dealId}
        />
      ) : null}
      <ReasonDialog
        open={!!reopening}
        onOpenChange={(o) => !o && setReopening(null)}
        title={`${reopening?.label ?? 'This step'} isn’t done?`}
        description="It goes back to under way. Its proof is kept in the history."
        submit="Mark it not done"
        done="Marked not done."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.financing.reopen_step', {
              body: { workspaceId, dealId, step: reopening!.step, reason },
            }),
          )
        }
      />
    </div>
  );
}

const orNull = (s: string) => (s.trim() ? s : null);

function StepDialog({
  step: s,
  done,
  onClose,
  workspaceId,
  dealId,
  documents,
  files,
}: {
  step: FinancingStep;
  done: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  documents: readonly DealDocument[];
  files: readonly ProofFile[];
}) {
  const [started, setStarted] = useState(s.startedOn ?? '');
  const [expected, setExpected] = useState(s.expectedOn ?? '');
  const [doneOn, setDoneOn] = useState(s.doneOn ?? '');
  const [amount, setAmount] = useState(s.amountCents ? String(s.amountCents / 100) : '');
  const [rate, setRate] = useState(s.rate?.toString() ?? '');
  const [expires, setExpires] = useState(s.expiresOn ?? '');
  const [note, setNote] = useState(s.note ?? '');
  const usable = documents.filter((d) => d.status !== 'void' && d.status !== 'superseded');
  const [proof, setProof] = useState(
    s.proof && s.proof.kind !== 'message'
      ? `${s.proof.kind}:${s.proof.id}`
      : usable[0]
        ? `document:${usable[0].documentId}`
        : files[0]
          ? `file:${files[0].id}`
          : '',
  );
  const { busy, errors, act } = useAct(onClose);
  const fields = {
    startedOn: orNull(started),
    expectedOn: orNull(expected),
    amountCents: HAS_AMOUNT.has(s.step) && amount.trim() ? parseMoney(amount) : null,
    rate: HAS_RATE.has(s.step) && rate.trim() ? Number(rate) : null,
    expiresOn: HAS_EXPIRY.has(s.step) ? orNull(expires) : null,
    note: orNull(note),
  };
  const marking = done || s.status === 'done';
  const save = () =>
    act(
      'save',
      async () => {
        if (marking) {
          const [kind, id] = proof.split(':') as ['document' | 'file', string];
          return unwrap(
            await apiBrowser().POST('/v1/commands/realestate.financing.mark_done', {
              body: {
                workspaceId,
                dealId,
                step: s.step,
                doneOn: doneOn || undefined,
                proof: { kind, id },
                ...fields,
              },
            }),
          );
        }
        return unwrap(
          await apiBrowser().POST('/v1/commands/realestate.financing.update_step', {
            body: { workspaceId, dealId, step: s.step, ...fields },
          }),
        );
      },
      marking ? `${s.label} marked done.` : 'Saved.',
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={done ? `${s.label} is done` : s.label}
        description={
          marking
            ? 'Pick its proof: the lender’s letter or email, or one of the deal’s documents.'
            : undefined
        }
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {marking ? (
            <Field
              label="Proof"
              htmlFor="step-proof"
              error={errors.proof ?? errors['proof.id']}
              hint={
                usable.length || files.length
                  ? undefined
                  : 'Nothing on the deal yet. Upload the lender’s letter under Documents first.'
              }
              className="sm:col-span-2"
            >
              <Select id="step-proof" value={proof} onChange={(e) => setProof(e.target.value)}>
                {usable.length ? (
                  <optgroup label="Documents">
                    {usable.map((d) => (
                      <option key={d.documentId} value={`document:${d.documentId}`}>
                        {d.title}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {files.length ? (
                  <optgroup label="Files on the deal">
                    {files.map((x) => (
                      <option key={x.id} value={`file:${x.id}`}>
                        {x.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </Select>
            </Field>
          ) : null}
          {marking ? (
            <Field label="Done on" htmlFor="step-done" error={errors.doneOn}>
              <Input
                id="step-done"
                type="date"
                value={doneOn}
                onChange={(e) => setDoneOn(e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field label="Started" htmlFor="step-start" error={errors.startedOn}>
                <Input
                  id="step-start"
                  type="date"
                  value={started}
                  onChange={(e) => setStarted(e.target.value)}
                />
              </Field>
              <Field label="Expected by" htmlFor="step-exp" error={errors.expectedOn}>
                <Input
                  id="step-exp"
                  type="date"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              </Field>
            </>
          )}
          {HAS_AMOUNT.has(s.step) ? (
            <Field
              label={s.step === 'appraisal' ? 'Appraised at' : 'Preapproved up to'}
              htmlFor="step-amount"
              error={errors.amountCents}
            >
              <Input
                id="step-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="$"
              />
            </Field>
          ) : null}
          {HAS_RATE.has(s.step) ? (
            <Field label="Rate (%)" htmlFor="step-rate" error={errors.rate}>
              <Input
                id="step-rate"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </Field>
          ) : null}
          {HAS_EXPIRY.has(s.step) ? (
            <Field
              label={s.step === 'rate_lock' ? 'Lock ends' : 'Letter ends'}
              htmlFor="step-ends"
              error={errors.expiresOn}
            >
              <Input
                id="step-ends"
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Note" htmlFor="step-note" className="sm:col-span-2">
            <Input id="step-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'save'}
              disabled={marking && !proof}
              data-testid="step-save"
            >
              {done ? 'Mark done' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LenderDialog({
  financing: f,
  onClose,
  workspaceId,
  dealId,
}: {
  financing: Financing;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
}) {
  const l = f.lender;
  const [name, setName] = useState(l.lenderName ?? '');
  const [officer, setOfficer] = useState(l.officerName ?? '');
  const [email, setEmail] = useState(l.officerEmail ?? '');
  const [phone, setPhone] = useState(l.officerPhone ?? '');
  const [loanType, setLoanType] = useState<LoanType | ''>(l.loanType ?? '');
  const [amount, setAmount] = useState(l.loanAmountCents ? String(l.loanAmountCents / 100) : '');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Lender" className="w-[min(560px,calc(100vw-32px))]">
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'save',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.financing.set_lender', {
                    body: {
                      workspaceId,
                      dealId,
                      lenderName: orNull(name),
                      officerName: orNull(officer),
                      officerEmail: orNull(email),
                      officerPhone: orNull(phone),
                      loanType: loanType || null,
                      loanAmountCents: amount.trim() ? parseMoney(amount) : null,
                    },
                  }),
                ),
              'Saved.',
            );
          }}
        >
          <Field label="Lender" htmlFor="l-name">
            <Input id="l-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Loan officer" htmlFor="l-officer">
            <Input id="l-officer" value={officer} onChange={(e) => setOfficer(e.target.value)} />
          </Field>
          <Field label="Their email" htmlFor="l-email" error={errors.officerEmail}>
            <Input
              id="l-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Their phone" htmlFor="l-phone">
            <Input id="l-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Loan" htmlFor="l-type">
            <Select
              id="l-type"
              value={loanType}
              onChange={(e) => setLoanType(e.target.value as LoanType | '')}
            >
              <option value="">Not known</option>
              {LOAN_TYPE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {LOAN_TYPES[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Loan amount" htmlFor="l-amount" error={errors.loanAmountCents}>
            <Input
              id="l-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="$"
            />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'save'}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
