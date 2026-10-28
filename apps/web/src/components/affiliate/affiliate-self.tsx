'use client';

/**
 * The person's own affiliate page (20261027014000). Somebody who hasn't applied, or may apply again, sees what the
 * program pays and the form. An application waiting can still be changed. Once approved, it's their link, their share,
 * their link's clicks, how many signed up, and what they've earned and from which businesses (20261027014200). A
 * paused or ended affiliate still sees what they earned.
 */
import {
  AFFILIATE_CLOSED_BUSINESS,
  AFFILIATE_MINE_WORDS,
  AFFILIATE_PAGE_WORDS as W,
  affiliateLink,
  affiliateRateWords,
  money,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { AffiliateEarningsTiles } from '@/components/affiliate/affiliate-earnings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyField } from '@/components/ui/copy-field';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Ok } from '@/lib/api/types';

type Mine = Ok<'/v1/queries/affiliate.mine'>;
type Affiliate = NonNullable<Mine['affiliate']>;

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export function AffiliateSelf({ mine, name }: { mine: Mine; name: string }) {
  const a = mine.affiliate;
  const rate = affiliateRateWords(a?.rateBp ?? mine.defaultRateBp);
  const mayApplyAgain =
    a?.status === 'turned_down' &&
    (a.applyAgainFrom === null || new Date(a.applyAgainFrom).getTime() <= Date.now());

  return (
    <div data-testid="affiliate-self">
      <h1 className="text-2xl font-semibold leading-tight tracking-tight">{W.title}</h1>
      {a ? (
        <p className="mt-2 leading-relaxed text-text-2" data-testid="affiliate-standing">
          {AFFILIATE_MINE_WORDS[a.status]}
          {a.status === 'turned_down' && a.applyAgainFrom && !mayApplyAgain
            ? ` ${W.applyAgainFrom(day(a.applyAgainFrom))}`
            : ''}
        </p>
      ) : (
        <p className="mt-2 leading-relaxed text-text-2">{W.intro(rate)}</p>
      )}

      {a?.status === 'approved' ? <Approved affiliate={a} /> : null}
      {a &&
      (a.status === 'approved' || a.earnings.earnedCents !== 0 || a.payingBusinesses.length) ? (
        <Earned affiliate={a} />
      ) : null}
      {!a || mayApplyAgain ? (
        <ApplyForm affiliate={null} name={a?.name ?? name} code={a?.code ?? ''} />
      ) : null}
      {a?.status === 'applied' ? (
        <>
          <h2 className="mt-7 text-base font-semibold">{W.yourApplication}</h2>
          <ApplyForm affiliate={a} name={a.name} code={a.code} />
        </>
      ) : null}
    </div>
  );
}

function Approved({ affiliate: a }: { affiliate: Affiliate }) {
  return (
    <div className="mt-6 flex flex-col gap-5">
      <div>
        <h2 className="text-sm font-semibold">{W.yourLink}</h2>
        <CopyField
          className="mt-2"
          value={affiliateLink(a.code)}
          label={W.copyLink}
          copied={W.copied}
        />
      </div>
      <div>
        <h2 className="text-sm font-semibold">{W.yourShare}</h2>
        <p className="mt-1 text-[14px] text-text-2" data-testid="affiliate-my-share">
          {W.yourShareLine(affiliateRateWords(a.rateBp))}
        </p>
      </div>
      <div>
        <h2 className="text-sm font-semibold">{W.clicks}</h2>
        <p className="mt-1 text-[14px] text-text-2">{W.clicksLine(a.clicks30, a.clicksAll)}</p>
      </div>
      <div>
        <h2 className="text-sm font-semibold">{W.signUps}</h2>
        <p className="mt-1 text-[14px] text-text-2" data-testid="affiliate-sign-ups">
          {W.signUpsLine(a.signUps, a.payingBusinesses.length)}
        </p>
      </div>
    </div>
  );
}

/** What they've earned, and the businesses that earned it, by name. */
function Earned({ affiliate: a }: { affiliate: Affiliate }) {
  return (
    <div className="mt-7 flex flex-col gap-5">
      <div>
        <h2 className="mb-2 text-sm font-semibold">{W.earnings}</h2>
        <AffiliateEarningsTiles earnings={a.earnings} />
      </div>
      <div>
        <h2 className="text-sm font-semibold">{W.payingBusinesses}</h2>
        {a.payingBusinesses.length === 0 ? (
          <p className="mt-1 text-[14px] text-text-2">{W.noPaying}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2 text-[14px]" data-testid="affiliate-paying">
            {a.payingBusinesses.map((b, i) => (
              <li
                key={`${b.name ?? ''}-${i}`}
                className="flex items-baseline justify-between gap-2"
              >
                <span className="min-w-0 truncate font-medium">
                  {b.name ?? AFFILIATE_CLOSED_BUSINESS}
                </span>
                <span className="flex-none text-text-3">
                  {W.payingLine(money(b.earnedCents), b.firstPaidAt ? day(b.firstPaidAt) : null)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Applying, or changing an application while it waits. */
function ApplyForm({
  affiliate,
  name: startName,
  code: startCode,
}: {
  affiliate: Affiliate | null;
  name: string;
  code: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(startName);
  const [code, setCode] = useState(startCode);
  const [pitch, setPitch] = useState(affiliate?.pitch ?? '');
  const [links, setLinks] = useState(affiliate?.links ?? '');
  // Somebody already applied said so then.
  const [livesInUs, setLivesInUs] = useState(affiliate !== null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typed = code.trim().toLowerCase();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/affiliate.apply', {
          body: { name, code, pitch, links, livesInUs },
        }),
      );
      toast.success(affiliate ? W.saved : W.sent);
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 flex flex-col gap-4" data-testid="affiliate-apply">
      <Field label={W.name} htmlFor="affiliate-name" error={errors.name}>
        <Input
          id="affiliate-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          invalid={Boolean(errors.name)}
          autoComplete="name"
          required
        />
      </Field>
      <Field
        label={W.code}
        htmlFor="affiliate-code"
        error={errors.code}
        hint={typed ? W.codeHelp(affiliateLink(typed)) : W.codeShape}
      >
        <Input
          id="affiliate-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          invalid={Boolean(errors.code)}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          required
          data-testid="affiliate-apply-code"
        />
      </Field>
      <Field label={W.pitch} htmlFor="affiliate-pitch" error={errors.pitch}>
        <Textarea
          id="affiliate-pitch"
          value={pitch}
          onChange={(e) => setPitch(e.target.value)}
          placeholder={W.pitchPlaceholder}
          maxLength={2000}
          rows={4}
        />
      </Field>
      <Field label={W.links} htmlFor="affiliate-links" error={errors.links}>
        <Textarea
          id="affiliate-links"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder={W.linksPlaceholder}
          maxLength={1000}
          rows={3}
        />
      </Field>
      <div>
        <Checkbox
          label={W.livesInUs}
          checked={livesInUs}
          onChange={(e) => setLivesInUs(e.target.checked)}
          data-testid="affiliate-apply-us"
        />
        <p className="mt-1.5 text-[12.5px] text-text-3">{W.usOnly}</p>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        size="lg"
        loading={busy}
        disabled={!livesInUs}
        data-testid="affiliate-apply-send"
      >
        {affiliate ? W.saveChanges : W.apply}
      </Button>
    </form>
  );
}
