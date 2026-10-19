'use client';
import {
  FOUNDING_BUSINESS_WORDS,
  FOUNDING_WORDS,
  foundingBusinessGivable,
  foundingBusinessHolds,
  foundingBusinessSeatLine,
  foundingOfferPriceLine,
  foundingSeatProblem,
} from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Founding = Ok<'/v1/queries/platform.founding.business'>;

/**
 * One business's founding seat, on its page under /admin/businesses: any business on the list can be given one from
 * here, whether or not it applied, and a seat it holds can be taken back. The same commands as /admin/founding, so the
 * cap and the open/closed switch still decide; a refusal comes back as a sentence and is shown as one.
 */
export function FoundingSeatBlock({
  workspaceId,
  businessName,
  founding,
}: {
  workspaceId: string;
  businessName: string;
  founding: Founding;
}) {
  const router = useRouter();
  const { seat } = founding;
  const holds = foundingBusinessHolds(seat);
  const givable = foundingBusinessGivable(founding.offers);
  const [giving, setGiving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [offerId, setOfferId] = useState(givable.first);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setGiving(false);
    setRevoking(false);
    setNote('');
    setError(null);
  };

  const run = async (path: string, body: object) => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
          body,
        }),
      );
      close();
      router.refresh();
    } catch (e) {
      // The database's refusals arrive here as sentences: "Every seat in this offer is taken", and so on.
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const line = foundingBusinessSeatLine(seat, workspaceId);
  const problem = seat ? foundingSeatProblem(seat) : null;

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-founding-seat"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{FOUNDING_BUSINESS_WORDS.title}</h2>
          <p className="mt-1 text-[13px] text-text-3">{FOUNDING_BUSINESS_WORDS.explain}</p>
        </div>
        <Link href="/admin/founding" className="text-[13px] text-text-3 hover:text-text">
          {FOUNDING_BUSINESS_WORDS.allSeats}
        </Link>
      </div>

      <p className="mt-3 text-[13px]" data-testid="admin-founding-seat-line">
        {line ?? FOUNDING_BUSINESS_WORDS.none}
      </p>
      {problem ? <p className="mt-1 text-[13px] text-danger-text">{problem}</p> : null}
      {error && !giving && !revoking ? (
        <p className="mt-2 text-[13px] text-danger-text">{error}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {holds ? (
          <Button
            variant="secondary"
            onClick={() => setRevoking(true)}
            data-testid="admin-founding-revoke"
          >
            {FOUNDING_BUSINESS_WORDS.revoke}
          </Button>
        ) : (
          <Button
            onClick={() => {
              setOfferId(givable.first);
              setGiving(true);
            }}
            data-testid="admin-founding-give"
          >
            {FOUNDING_BUSINESS_WORDS.give}
          </Button>
        )}
        {seat?.status === 'revoked' && seat.graceEndsAt ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => run('/v1/commands/founding.restore', { grantId: seat.grantId })}
          >
            {FOUNDING_BUSINESS_WORDS.undo}
          </Button>
        ) : null}
      </div>

      <Dialog open={giving} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent
          title={FOUNDING_BUSINESS_WORDS.giveTitle(businessName)}
          description={FOUNDING_BUSINESS_WORDS.giveDescription}
        >
          <div className="mt-4 flex flex-col gap-3">
            {givable.offers.length === 0 ? (
              <p className="text-[13px] text-text-3">{FOUNDING_BUSINESS_WORDS.noneOpen}</p>
            ) : (
              <Field label={FOUNDING_BUSINESS_WORDS.offer} htmlFor="founding-seat-offer">
                <select
                  id="founding-seat-offer"
                  value={offerId}
                  onChange={(e) => setOfferId(e.target.value)}
                  className="h-10 rounded-control border border-border bg-card px-2.5 text-sm"
                  data-testid="admin-founding-offer"
                >
                  {givable.offers.map((o) => (
                    <option key={o.offerId} value={o.offerId}>
                      {o.name} · {foundingOfferPriceLine(o)} · {o.remaining}
                      {FOUNDING_WORDS.ofLeft(o.seatCap)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field
              label={FOUNDING_BUSINESS_WORDS.whyThem}
              htmlFor="founding-seat-note"
              hint={FOUNDING_BUSINESS_WORDS.whyThemHint}
            >
              <Textarea
                id="founding-seat-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
              />
            </Field>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {FOUNDING_BUSINESS_WORDS.cancel}
            </Button>
            <Button
              disabled={busy || !offerId}
              onClick={() =>
                run('/v1/commands/founding.give', {
                  offerId,
                  organizationId: founding.organizationId,
                  workspaceId,
                  note: note.trim(),
                })
              }
              data-testid="admin-founding-give-confirm"
            >
              {busy ? FOUNDING_BUSINESS_WORDS.giving : FOUNDING_BUSINESS_WORDS.giveSeat}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={revoking} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent
          title={FOUNDING_WORDS.revokeTitle(businessName)}
          description={FOUNDING_WORDS.revokeDescription}
        >
          <div className="mt-4">
            <Field
              label={FOUNDING_WORDS.why}
              htmlFor="founding-seat-reason"
              hint={FOUNDING_WORDS.whyHint}
            >
              <Textarea
                id="founding-seat-reason"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
              />
            </Field>
            {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {FOUNDING_WORDS.cancel}
            </Button>
            <Button
              disabled={busy || note.trim() === '' || !seat}
              onClick={() =>
                seat &&
                run('/v1/commands/founding.revoke', { grantId: seat.grantId, reason: note.trim() })
              }
            >
              {busy ? FOUNDING_WORDS.revoking : FOUNDING_WORDS.revokeSeat}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
