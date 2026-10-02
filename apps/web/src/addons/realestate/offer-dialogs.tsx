'use client';
/**
 * Entering an offer's terms: a new offer on one of the deal's homes, a counter (ours or the seller's), and the
 * answer to it. The contract itself is filled in the agent's forms software and uploaded to the deal's documents;
 * here it's picked, and the terms are typed in.
 *
 * On a listing (round three) it's the other way round: an offer comes in from buyers (no home of ours to pick, their
 * names instead), "them" is the buyers and "us" the seller, and the terms a seller weighs are there too (down
 * payment, a home to sell first, an escalation clause, possession, and what their agent asks the seller to pay).
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
  // Round three: what a seller weighs.
  downPct: string;
  homeSale: 'yes' | 'no' | '';
  escCap: string;
  escStep: string;
  possession: string;
  feeKind: 'pct' | 'amount';
  fee: string;
}

export type DealSideKind = 'buyer' | 'listing';

const dollars = (c: number | null | undefined) =>
  c === null || c === undefined ? '' : String(c / 100);
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const int = (s: string) => (s.trim() ? Math.round(Number(s.replace(/,/g, ''))) : null);
const num = (s: string) => (s.trim() ? Number(s.replace(/[,%\s]/g, '')) : null);
const yesNo = (b: boolean | null | undefined): 'yes' | 'no' | '' =>
  b === null || b === undefined ? '' : b ? 'yes' : 'no';

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
    downPct: str(v?.downPaymentPct),
    homeSale: yesNo(v?.homeSaleContingency),
    escCap: dollars(v?.escalationCapCents),
    escStep: dollars(v?.escalationStepCents),
    possession: v?.possession ?? '',
    feeKind:
      v?.buyerAgentFeeCents !== null && v?.buyerAgentFeeCents !== undefined ? 'amount' : 'pct',
    fee:
      v?.buyerAgentFeeCents !== null && v?.buyerAgentFeeCents !== undefined
        ? dollars(v.buyerAgentFeeCents)
        : v?.buyerAgentFeeBp !== null && v?.buyerAgentFeeBp !== undefined
          ? String(v.buyerAgentFeeBp / 100)
          : '',
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
      downPaymentPct: t.loanType === 'cash' ? null : num(t.downPct),
      homeSaleContingency: t.homeSale === '' ? null : t.homeSale === 'yes',
      escalationCapCents: t.escCap.trim() ? parseMoney(t.escCap) : null,
      escalationStepCents: t.escStep.trim() ? parseMoney(t.escStep) : null,
      possession: t.possession.trim() || null,
      buyerAgentFeeBp:
        t.feeKind === 'pct' && t.fee.trim() ? Math.round((num(t.fee) ?? 0) * 100) : null,
      buyerAgentFeeCents: t.feeKind === 'amount' && t.fee.trim() ? parseMoney(t.fee) : null,
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
  side = 'buyer',
}: {
  t: Terms;
  set: (patch: Partial<Terms>) => void;
  errors: Record<string, string>;
  documents: readonly DealDocument[];
  side?: DealSideKind;
}) {
  const e = (k: string) => errors[`terms.${k}`] ?? errors[k];
  const listing = side === 'listing';
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
      {listing ? (
        <Field label="Down payment (%)" htmlFor="t-down" error={e('downPaymentPct')}>
          <Input
            id="t-down"
            inputMode="decimal"
            value={t.downPct}
            onChange={(x) => set({ downPct: x.target.value })}
            disabled={t.loanType === 'cash'}
            placeholder="20"
          />
        </Field>
      ) : null}
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
      {listing ? (
        <>
          <Field label="A home to sell first" htmlFor="t-homesale">
            <Select
              id="t-homesale"
              value={t.homeSale}
              onChange={(x) => set({ homeSale: x.target.value as Terms['homeSale'] })}
            >
              <option value="">Not said</option>
              <option value="yes">Yes, it depends on selling theirs</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <div>
            <Label htmlFor="t-fee">Their agent’s fee, asked of the seller</Label>
            <div className="flex gap-2">
              <Input
                id="t-fee"
                inputMode="decimal"
                value={t.fee}
                onChange={(x) => set({ fee: x.target.value })}
                className="min-w-0 flex-1"
                placeholder={t.feeKind === 'pct' ? '2.5' : '$'}
                data-testid="offer-fee"
              />
              <Select
                aria-label="Fee as"
                value={t.feeKind}
                onChange={(x) => set({ feeKind: x.target.value as Terms['feeKind'] })}
                className="w-[120px]"
              >
                <option value="pct">% of price</option>
                <option value="amount">Dollars</option>
              </Select>
            </div>
            {e('buyerAgentFeeCents') || e('buyerAgentFeeBp') ? (
              <p className="mt-1 text-[12.5px] text-danger-text">
                {e('buyerAgentFeeCents') ?? e('buyerAgentFeeBp')}
              </p>
            ) : null}
          </div>
          <Field label="Escalation, up to" htmlFor="t-esc-cap" error={e('escalationCapCents')}>
            <Input
              id="t-esc-cap"
              inputMode="decimal"
              value={t.escCap}
              onChange={(x) => set({ escCap: x.target.value })}
              placeholder="$"
            />
          </Field>
          <Field label="Escalation, by" htmlFor="t-esc-step" error={e('escalationStepCents')}>
            <Input
              id="t-esc-step"
              inputMode="decimal"
              value={t.escStep}
              onChange={(x) => set({ escStep: x.target.value })}
              placeholder="$"
            />
          </Field>
          <Field label="Possession" htmlFor="t-possession" error={e('possession')}>
            <Input
              id="t-possession"
              value={t.possession}
              onChange={(x) => set({ possession: x.target.value })}
              placeholder="At closing"
            />
          </Field>
        </>
      ) : null}
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
  side = 'buyer',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  homes: readonly Home[];
  documents: readonly DealDocument[];
  homeId?: string | null;
  side?: DealSideKind;
}) {
  const router = useRouter();
  const listing = side === 'listing';
  const [home, setHome] = useState(homeId ?? '');
  const [buyers, setBuyers] = useState('');
  const [agent, setAgent] = useState('');
  const [brokerage, setBrokerage] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [t, setT] = useState<Terms>(() => fromVersion(undefined));
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  if (open && seen !== homeId) {
    setSeen(homeId);
    setHome(homeId ?? '');
    setBuyers('');
    const price = homes.find((h) => h.id === homeId)?.facts.price_cents;
    setT({ ...fromVersion(undefined), price: dollars(price) });
  }
  const { busy, errors, act } = useAct();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={listing ? 'Add an offer' : 'Make an offer'}
        description={
          listing
            ? 'Type in the terms from the buyers’ contract. Every version is kept as it came in.'
            : 'Type in the terms from the contract. Every version is kept as it was sent.'
        }
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
                      homeId: listing ? undefined : home,
                      buyerNames: listing ? buyers.trim() : undefined,
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
              listing
                ? 'Offer added. Its clock is running.'
                : 'Offer recorded. Its clock is running.',
            );
          }}
        >
          {listing ? (
            <Field
              label="Buyers"
              htmlFor="o-buyers"
              error={errors.buyerNames}
              className="sm:col-span-2"
            >
              <Input
                id="o-buyers"
                value={buyers}
                onChange={(e) => setBuyers(e.target.value)}
                placeholder="Jordan and Priya Patel"
                data-testid="offer-buyers"
              />
            </Field>
          ) : (
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
          )}
          <Field label={listing ? 'Their agent' : 'Listing agent'} htmlFor="o-agent">
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
            side={side}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'start'}
              disabled={listing ? !buyers.trim() : !home}
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
  dealSide = 'buyer',
}: {
  offer: Offer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  timeZone: string;
  documents: readonly DealDocument[];
  dealSide?: DealSideKind;
}) {
  const listing = dealSide === 'listing';
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
        title={listing ? `Counter on offer ${offer.number}` : `Counter on ${street(offer.address)}`}
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
                { value: 'them', label: listing ? 'The buyers’ counter' : 'The seller’s counter' },
                { value: 'us', label: 'Our counter' },
              ]}
            />
          </div>
          <TermsFields
            t={t}
            set={(p) => setT({ ...t, ...p })}
            errors={errors}
            documents={documents}
            side={dealSide}
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
  dealSide = 'buyer',
}: {
  offer: Offer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  timeZone: string;
  dealSide?: DealSideKind;
}) {
  const listing = dealSide === 'listing';
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
        title={listing ? `Record our answer to offer ${offer.number}` : 'Record their answer'}
        description={
          outcome === 'accepted'
            ? listing
              ? 'Its terms go to Key dates for you to confirm, and the listing moves to under contract.'
              : 'Its terms go to Key dates for you to confirm, and the deal moves to under contract.'
            : listing
              ? 'The offer ends; the listing stays on the market, with the offer kept.'
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
            ariaLabel={listing ? 'Our answer' : 'Their answer'}
            options={[
              { value: 'accepted', label: 'Accepted' },
              { value: 'declined', label: 'Declined' },
              { value: 'expired', label: listing ? 'It passed' : 'No answer in time' },
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
                    {v.number} ·{' '}
                    {v.side === 'us' ? 'ours' : listing ? 'the buyers’' : 'the seller’s'}
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
