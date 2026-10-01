'use client';
/**
 * Entering an offer's terms: a new offer on one of the deal's homes, a counter (ours or the seller's), and the
 * answer to it. The contract itself is filled in the agent's forms software and uploaded to the deal's documents;
 * here it's picked, and the terms are typed in.
 */
import { localInstant, minutesToClock, TIME_OPTIONS } from '@hfos/core';
import {
  LOAN_TYPE_KEYS,
  LOAN_TYPES,
  type LoanType,
} from '@hfos/core/addons/realestate/offer-words';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { dateOf, minutesOf } from '@/lib/calendar/time';
import { parseMoney } from '@/lib/format';
import { dealHref } from './bits';
import { street } from './buyer-bits';
import type { DealDocument, Home, Offer, OfferVersion } from './types';
import { useAct } from './use-act';

interface Terms {
  price: string;
  emd: string;
  emdDays: string;
  credit: string;
  inspectionDays: string;
  loanType: LoanType | '';
  financingDays: string;
  appraisal: 'yes' | 'no' | '';
  closingDate: string;
  other: string;
  respondDate: string;
  respondTime: number;
  documentId: string;
  note: string;
}

const dollars = (c: number | null | undefined) =>
  c === null || c === undefined ? '' : String(c / 100);
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const int = (s: string) => (s.trim() ? Math.round(Number(s.replace(/,/g, ''))) : null);

function fromVersion(v: OfferVersion | undefined): Terms {
  return {
    price: dollars(v?.priceCents),
    emd: dollars(v?.emdCents),
    emdDays: str(v?.emdDays),
    credit: v && v.sellerCreditCents ? dollars(v.sellerCreditCents) : '',
    inspectionDays: str(v?.inspectionDays),
    loanType: v?.loanType ?? '',
    financingDays: str(v?.financingDays),
    appraisal:
      v?.appraisalContingency === null || v === undefined
        ? ''
        : v.appraisalContingency
          ? 'yes'
          : 'no',
    closingDate: v?.closingDate ?? '',
    other: v?.otherTerms ?? '',
    respondDate: '',
    respondTime: 1080,
    documentId: '',
    note: '',
  };
}

function termsBody(t: Terms, timeZone: string) {
  return {
    terms: {
      priceCents: parseMoney(t.price) ?? 0,
      emdCents: t.emd.trim() ? parseMoney(t.emd) : null,
      emdDays: int(t.emdDays),
      sellerCreditCents: t.credit.trim() ? (parseMoney(t.credit) ?? 0) : 0,
      inspectionDays: int(t.inspectionDays),
      loanType: t.loanType || null,
      financingDays: t.loanType === 'cash' ? null : int(t.financingDays),
      appraisalContingency: t.appraisal === '' ? null : t.appraisal === 'yes',
      closingDate: t.closingDate || null,
      otherTerms: t.other.trim() || null,
    },
    respondBy: t.respondDate
      ? new Date(localInstant(t.respondDate, minutesToClock(t.respondTime), timeZone)).toISOString()
      : null,
    documentId: t.documentId || undefined,
    note: t.note.trim() || undefined,
  };
}

function TermsFields({
  t,
  set,
  errors,
  documents,
}: {
  t: Terms;
  set: (patch: Partial<Terms>) => void;
  errors: Record<string, string>;
  documents: readonly DealDocument[];
}) {
  const e = (k: string) => errors[`terms.${k}`] ?? errors[k];
  return (
    <>
      <Field label="Price" htmlFor="t-price" error={e('priceCents')}>
        <Input
          id="t-price"
          inputMode="decimal"
          value={t.price}
          onChange={(x) => set({ price: x.target.value })}
          placeholder="$"
          data-testid="offer-price"
        />
      </Field>
      <Field label="Earnest money" htmlFor="t-emd" error={e('emdCents')}>
        <Input
          id="t-emd"
          inputMode="decimal"
          value={t.emd}
          onChange={(x) => set({ emd: x.target.value })}
          placeholder="$"
        />
      </Field>
      <Field label="Earnest money due in (days)" htmlFor="t-emd-days" error={e('emdDays')}>
        <Input
          id="t-emd-days"
          inputMode="numeric"
          value={t.emdDays}
          onChange={(x) => set({ emdDays: x.target.value })}
        />
      </Field>
      <Field label="Seller pays toward costs" htmlFor="t-credit" error={e('sellerCreditCents')}>
        <Input
          id="t-credit"
          inputMode="decimal"
          value={t.credit}
          onChange={(x) => set({ credit: x.target.value })}
          placeholder="$0"
        />
      </Field>
      <Field label="Inspection period (days)" htmlFor="t-insp" error={e('inspectionDays')}>
        <Input
          id="t-insp"
          inputMode="numeric"
          value={t.inspectionDays}
          onChange={(x) => set({ inspectionDays: x.target.value })}
        />
      </Field>
      <Field label="Loan" htmlFor="t-loan">
        <Select
          id="t-loan"
          value={t.loanType}
          onChange={(x) => set({ loanType: x.target.value as LoanType | '' })}
        >
          <option value="">Not said</option>
          {LOAN_TYPE_KEYS.map((k) => (
            <option key={k} value={k}>
              {LOAN_TYPES[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Financing period (days)" htmlFor="t-fin" error={e('financingDays')}>
        <Input
          id="t-fin"
          inputMode="numeric"
          value={t.financingDays}
          onChange={(x) => set({ financingDays: x.target.value })}
          disabled={t.loanType === 'cash'}
        />
      </Field>
      <Field label="Appraisal condition" htmlFor="t-appr">
        <Select
          id="t-appr"
          value={t.appraisal}
          onChange={(x) => set({ appraisal: x.target.value as Terms['appraisal'] })}
        >
          <option value="">Not said</option>
          <option value="yes">They can back out if it appraises low</option>
          <option value="no">None</option>
        </Select>
      </Field>
      <Field label="Closing" htmlFor="t-close" error={e('closingDate')}>
        <Input
          id="t-close"
          type="date"
          value={t.closingDate}
          onChange={(x) => set({ closingDate: x.target.value })}
        />
      </Field>
      <div>
        <Label htmlFor="t-respond">Answer due by</Label>
        <div className="flex gap-2">
          <Input
            id="t-respond"
            type="date"
            value={t.respondDate}
            onChange={(x) => set({ respondDate: x.target.value })}
            className="min-w-0 flex-1"
          />
          <Select
            aria-label="Time"
            value={t.respondTime}
            onChange={(x) => set({ respondTime: Number(x.target.value) })}
            className="w-[120px]"
            disabled={!t.respondDate}
          >
            {TIME_OPTIONS.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Field
        label="Other terms"
        htmlFor="t-other"
        className="sm:col-span-2"
        error={e('otherTerms')}
      >
        <Textarea
          id="t-other"
          rows={2}
          value={t.other}
          onChange={(x) => set({ other: x.target.value })}
          className="min-h-[60px]"
        />
      </Field>
      <Field
        label="The contract, uploaded"
        htmlFor="t-doc"
        hint="Fill it in your forms software, upload it under Documents, then pick it here."
        className="sm:col-span-2"
      >
        <Select
          id="t-doc"
          value={t.documentId}
          onChange={(x) => set({ documentId: x.target.value })}
        >
          <option value="">Not uploaded yet</option>
          {documents
            .filter((d) => d.status !== 'void' && d.status !== 'superseded')
            .map((d) => (
              <option key={d.documentId} value={d.documentId}>
                {d.title}
              </option>
            ))}
        </Select>
      </Field>
    </>
  );
}

export function StartOfferDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  timeZone,
  homes,
  documents,
  homeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  homes: readonly Home[];
  documents: readonly DealDocument[];
  homeId?: string | null;
}) {
  const router = useRouter();
  const [home, setHome] = useState(homeId ?? '');
  const [agent, setAgent] = useState('');
  const [brokerage, setBrokerage] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [t, setT] = useState<Terms>(() => fromVersion(undefined));
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  if (open && seen !== homeId) {
    setSeen(homeId);
    setHome(homeId ?? '');
    const price = homes.find((h) => h.id === homeId)?.facts.price_cents;
    setT({ ...fromVersion(undefined), price: dollars(price) });
  }
  const { busy, errors, act } = useAct();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Make an offer"
        description="Type in the terms from the contract. Every version is kept as it was sent."
        className="w-[min(720px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 grid max-h-[70vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'start',
              async () => {
                const out = unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.offer.start', {
                    body: {
                      workspaceId,
                      dealId,
                      homeId: home,
                      theirAgentName: agent.trim() || undefined,
                      theirBrokerage: brokerage.trim() || undefined,
                      theirEmail: email.trim() || undefined,
                      theirPhone: phone.trim() || undefined,
                      ...termsBody(t, timeZone),
                    },
                  }),
                );
                onOpenChange(false);
                router.push(dealHref(workspaceId, dealId, `offers/${out.offerId}`));
              },
              'Offer recorded. Its clock is running.',
            );
          }}
        >
          <Field label="Home" htmlFor="o-home" error={errors.homeId} className="sm:col-span-2">
            <Select
              id="o-home"
              value={home}
              onChange={(e) => setHome(e.target.value)}
              data-testid="offer-home"
            >
              <option value="">Pick one of the deal’s homes</option>
              {homes
                .filter((h) => h.status !== 'removed')
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.address}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Listing agent" htmlFor="o-agent">
            <Input id="o-agent" value={agent} onChange={(e) => setAgent(e.target.value)} />
          </Field>
          <Field label="Their brokerage" htmlFor="o-brokerage">
            <Input
              id="o-brokerage"
              value={brokerage}
              onChange={(e) => setBrokerage(e.target.value)}
            />
          </Field>
          <Field label="Their email" htmlFor="o-email" error={errors.theirEmail}>
            <Input
              id="o-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Their phone" htmlFor="o-phone">
            <Input id="o-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <TermsFields
            t={t}
            set={(p) => setT({ ...t, ...p })}
            errors={errors}
            documents={documents}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'start'}
              disabled={!home}
              data-testid="offer-start"
            >
              Record the offer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function VersionDialog({
  offer,
  open,
  onOpenChange,
  workspaceId,
  timeZone,
  documents,
}: {
  offer: Offer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  timeZone: string;
  documents: readonly DealDocument[];
}) {
  const newest = offer.versions.at(-1);
  const [side, setSide] = useState<'us' | 'them'>(newest?.side === 'us' ? 'them' : 'us');
  const [t, setT] = useState<Terms>(() => fromVersion(newest));
  const [seen, setSeen] = useState<string | null>(null);
  if (open && seen !== (newest?.id ?? '')) {
    setSeen(newest?.id ?? '');
    setSide(newest?.side === 'us' ? 'them' : 'us');
    setT(fromVersion(newest));
  }
  const { busy, errors, act } = useAct(() => onOpenChange(false));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Counter on ${street(offer.address)}`}
        description="Starts from the newest terms. Change what changed."
        className="w-[min(720px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 grid max-h-[70vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'version',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.offer.add_version', {
                    body: { workspaceId, offerId: offer.id, side, ...termsBody(t, timeZone) },
                  }),
                ),
              'Kept as a new version.',
            );
          }}
        >
          <div className="sm:col-span-2">
            <Segmented
              value={side}
              onChange={setSide}
              ariaLabel="Whose counter"
              options={[
                { value: 'them', label: 'The seller’s counter' },
                { value: 'us', label: 'Our counter' },
              ]}
            />
          </div>
          <TermsFields
            t={t}
            set={(p) => setT({ ...t, ...p })}
            errors={errors}
            documents={documents}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'version'}>
              Keep this version
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AnswerDialog({
  offer,
  open,
  onOpenChange,
  workspaceId,
  timeZone,
}: {
  offer: Offer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  timeZone: string;
}) {
  const newest = offer.versions.at(-1);
  const [outcome, setOutcome] = useState<'accepted' | 'declined' | 'expired'>('accepted');
  const [versionId, setVersionId] = useState(newest?.id ?? '');
  const [date, setDate] = useState('');
  const [time, setTime] = useState(720);
  const [note, setNote] = useState('');
  const [seen, setSeen] = useState(false);
  if (open && !seen) {
    setSeen(true);
    const now = new Date().toISOString();
    setDate(dateOf(now, timeZone));
    setTime(Math.floor(minutesOf(now, timeZone) / 15) * 15);
    setVersionId(newest?.id ?? '');
  }
  if (!open && seen) setSeen(false);
  const { busy, act } = useAct(() => onOpenChange(false));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record their answer"
        description={
          outcome === 'accepted'
            ? 'Its terms go to Key dates for you to confirm, and the deal moves to under contract.'
            : 'The offer ends, and the deal goes back to touring with its history kept.'
        }
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'answer',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.offer.record_response', {
                    body: {
                      workspaceId,
                      offerId: offer.id,
                      outcome,
                      versionId: outcome === 'accepted' ? versionId : undefined,
                      at: date
                        ? new Date(localInstant(date, minutesToClock(time), timeZone)).toISOString()
                        : undefined,
                      note: note.trim() || undefined,
                    },
                  }),
                ),
              outcome === 'accepted' ? 'Accepted. Confirm its dates under Key dates.' : 'Recorded.',
            );
          }}
        >
          <Segmented
            value={outcome}
            onChange={setOutcome}
            ariaLabel="Their answer"
            options={[
              { value: 'accepted', label: 'Accepted' },
              { value: 'declined', label: 'Declined' },
              { value: 'expired', label: 'No answer in time' },
            ]}
          />
          {outcome === 'accepted' && offer.versions.length > 1 ? (
            <Field label="The version accepted" htmlFor="ans-version">
              <Select
                id="ans-version"
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
              >
                {[...offer.versions].reverse().map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.number} · {v.side === 'us' ? 'ours' : 'the seller’s'}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {outcome === 'accepted' ? (
            <div>
              <Label htmlFor="ans-date">When</Label>
              <div className="flex gap-2">
                <Input
                  id="ans-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="min-w-0 flex-1"
                />
                <Select
                  aria-label="Time"
                  value={time}
                  onChange={(e) => setTime(Number(e.target.value))}
                  className="w-[120px]"
                >
                  {TIME_OPTIONS.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}
          <Field label="Note (optional)" htmlFor="ans-note">
            <Input id="ans-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'answer'} data-testid="offer-answer-save">
              Record it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
