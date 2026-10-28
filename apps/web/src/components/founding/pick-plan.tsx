'use client';

/**
 * Picking a founding spot and paying for it, straight after signing up (20261027012700): $497 a year or $97 a month,
 * first come, first served.
 *
 * Nothing here decides whether there is a spot. The counts are shown; pressing Pay holds one in the database, under
 * the cap's lock, or comes back saying they're gone. The payment itself is the page every founding payment uses: it
 * waits for Stripe's page, sends them there, and waits for Stripe's word when they come back.
 *
 * A discount or trial code (20261027014300), typed or filled in from its link, shows what it takes off each plan
 * before Pay (`founding.code_preview`), and goes with the purchase, which checks it again.
 */
import {
  AFFILIATE_CODE_WORDS as C,
  FOUNDING_PICK_WORDS as W,
  affiliateCodeFirstCharge,
  affiliateCodePriceWords,
  foundingLongDay,
  foundingPrice,
  money,
  type FoundingPickOffer,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { forgetOthersSearches } from '@/components/search/search-provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { supabaseBrowser } from '@/lib/supabase/client';

type Preview = Ok<'/v1/queries/founding.code_preview'>;

export function PickPlan({
  workspaceId,
  business,
  offers,
  first,
  canPay,
  startCode,
}: {
  workspaceId: string;
  /** The business's name, as they typed it a moment ago. */
  business: string;
  /** The spots on sale (`foundingPickable`), in the order staff set. */
  offers: readonly FoundingPickOffer[];
  /** The one picked to start with: the website's choice, or the first with room. */
  first: string;
  /** Whether this person may pay for the business (`money.manage`). */
  canPay: boolean;
  /** A code from its link, to fill in and try at once. */
  startCode?: string | null;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState(startCode ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const chosen = offers.find((o) => o.offerId === picked && o.remaining > 0) ?? null;
  const noneLeft = offers.every((o) => o.remaining <= 0);
  /** What the code does to one plan, when it's for that plan. */
  const dealOf = (o: FoundingPickOffer) => {
    const d = preview?.offers.find((p) => p.offerId === o.offerId);
    return d?.applies ? { ...d, billing: o.billing } : null;
  };
  const deal = chosen ? dealOf(chosen) : null;

  const tryCode = async (code: string) => {
    if (!code.trim()) return;
    setChecking(true);
    setCodeError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/founding.code_preview', {
          body: { workspaceId, code },
        }),
      );
      setPreview(out);
      setTyped(out.code);
      // Start on a plan the code is for, with room, when the one picked isn't.
      const fits = offers.filter(
        (o) => o.remaining > 0 && out.offers.some((p) => p.offerId === o.offerId && p.applies),
      );
      if (fits.length && !fits.some((o) => o.offerId === picked)) setPicked(fits[0]!.offerId);
      if (!fits.length) setCodeError(C.notForAny(out.code));
    } catch (e) {
      setPreview(null);
      setCodeError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  // A code from its link is tried once, as the page opens.
  useEffect(() => {
    if (startCode && canPay) void tryCode(startCode);
  }, []);

  const pay = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/founding.buy', {
          body: {
            workspaceId,
            offerId: chosen.offerId,
            code: deal ? (preview?.code ?? null) : null,
          },
        }),
      );
      router.push(`/founding/checkout/${out.checkoutId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      // The counts may have moved: somebody took the last spot, or the other plan is the one left.
      router.refresh();
    }
  };

  return (
    <Card
      className="w-[560px] max-w-full rounded-dialog p-9 max-md:p-6"
      data-testid="founding-plan"
    >
      <h1 className="text-2xl font-semibold leading-tight tracking-tight">{W.title}</h1>
      <p className="mt-1.5 text-[13.5px] text-text-2">{W.sub(business)}</p>

      {!canPay ? (
        <p
          className="mt-6 rounded-menu bg-card-2 px-4 py-3.5 text-[13.5px] text-text-2"
          data-testid="founding-plan-not-yours"
        >
          {W.notYours(business)}
        </p>
      ) : noneLeft ? (
        <p
          className="mt-6 rounded-menu bg-warning-soft px-4 py-3.5 text-[13.5px] text-warning-text"
          data-testid="founding-plan-none-left"
        >
          {W.noneLeft}
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-2.5" role="radiogroup" aria-label={W.title}>
            {offers.map((o) => {
              const d = dealOf(o);
              return (
                <RadioCard
                  key={o.offerId}
                  selected={o.offerId === chosen?.offerId}
                  onSelect={() => {
                    if (o.remaining > 0) setPicked(o.offerId);
                  }}
                  className={o.remaining > 0 ? undefined : 'cursor-not-allowed opacity-60'}
                  testId={`founding-plan-${o.offerId}`}
                  title={
                    <>
                      {foundingPrice(o.priceCents)}{' '}
                      <span className="font-normal text-text-2">{W.per(o.billing)}</span>
                    </>
                  }
                  description={
                    <>
                      {o.name} · {o.remaining > 0 ? W.left(o.remaining, o.seatCap) : W.full}
                      <br />
                      {d ? (
                        <span
                          className="font-medium text-success-text"
                          data-testid="founding-plan-deal"
                        >
                          {affiliateCodePriceWords(d)}
                        </span>
                      ) : preview ? (
                        C.notForPlan
                      ) : (
                        W.renews(o.billing)
                      )}
                    </>
                  }
                />
              );
            })}
          </div>
          <CodeBox
            typed={typed}
            setTyped={(v) => {
              setTyped(v);
              setCodeError(null);
            }}
            applied={preview?.code ?? null}
            checking={checking}
            error={codeError}
            onApply={() => void tryCode(typed)}
            onRemove={() => {
              setPreview(null);
              setTyped('');
              setCodeError(null);
            }}
          />
          <FieldError>{error}</FieldError>
          <Button
            size="lg"
            className="mt-5 w-full"
            loading={busy}
            disabled={!chosen || checking}
            data-testid="founding-plan-pay"
            onClick={() => void pay()}
          >
            {busy
              ? W.paying
              : deal?.trialDays
                ? C.startTrial(deal.trialDays)
                : deal
                  ? `Pay ${money(affiliateCodeFirstCharge(deal))}`
                  : W.pay(chosen?.priceCents ?? 0)}
          </Button>
          <p className="mt-3.5 text-center text-xs text-text-3">
            {deal?.trialDays
              ? C.trialFine(
                  foundingLongDay(new Date(Date.now() + deal.trialDays * 86_400_000).toISOString()),
                )
              : W.fine}
          </p>
        </>
      )}
    </Card>
  );
}

/** "Have a code?": typed, tried, and taken off again. */
function CodeBox({
  typed,
  setTyped,
  applied,
  checking,
  error,
  onApply,
  onRemove,
}: {
  typed: string;
  setTyped: (v: string) => void;
  applied: string | null;
  checking: boolean;
  error: string | null;
  onApply: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(typed !== '');
  if (!open && !applied)
    return (
      <button
        type="button"
        className="mt-3 text-[13px] font-medium text-accent-text hover:underline"
        onClick={() => setOpen(true)}
        data-testid="founding-plan-have-code"
      >
        {C.have}
      </button>
    );
  return (
    <form
      className="mt-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onApply();
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label={C.label}
          placeholder={C.label}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          readOnly={applied !== null}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          className="flex-1"
          data-testid="founding-plan-code"
        />
        {applied ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onRemove}
            data-testid="founding-plan-code-remove"
          >
            {C.remove}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="secondary"
            disabled={checking || !typed.trim()}
            data-testid="founding-plan-code-apply"
          >
            {checking ? C.checking : C.apply}
          </Button>
        )}
      </div>
      <FieldError>{error}</FieldError>
    </form>
  );
}

/** The plan page's way out: there's nothing else to go to until a spot is paid for. */
export function PlanSignOut() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      data-testid="founding-plan-sign-out"
      onClick={async () => {
        forgetOthersSearches(null);
        await supabaseBrowser().auth.signOut();
        router.replace('/sign-in');
        router.refresh();
      }}
    >
      {W.signOut}
    </Button>
  );
}
