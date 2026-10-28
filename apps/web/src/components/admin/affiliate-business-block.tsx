'use client';

/**
 * Which affiliate sold one business, on its page under /admin/businesses (20261027014000). Staff who run the program
 * can credit it to an approved affiliate by hand (somebody who signed up without the link) or take the credit off.
 */
import { AFFILIATE_ADMIN_WORDS, AFFILIATE_HOW_WORDS } from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { whenWords } from '@/components/admin/ticket-bits';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

const W = AFFILIATE_ADMIN_WORDS.block;

type OfBusiness = Ok<'/v1/queries/platform.affiliate_of_business'>;

export function AffiliateBusinessBlock({
  workspaceId,
  credit,
}: {
  workspaceId: string;
  credit: OfBusiness;
}) {
  const router = useRouter();
  const a = credit.affiliate;
  const [changing, setChanging] = useState(false);
  const [picked, setPicked] = useState(a?.affiliateId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/affiliate.set_business', {
          body: { workspaceId, affiliateId: picked || null },
        }),
      );
      setChanging(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-affiliate-block"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{W.title}</h2>
          <p className="mt-1 text-[13px] text-text-3">{W.explain}</p>
        </div>
        {!changing ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setPicked(a?.affiliateId ?? '');
              setChanging(true);
            }}
            data-testid="admin-affiliate-change"
          >
            {W.change}
          </Button>
        ) : null}
      </div>

      <p className="mt-3 text-[13px]" data-testid="admin-affiliate-line">
        {a ? (
          <>
            <Link href={`/admin/affiliates/${a.affiliateId}`} className="hover:underline">
              {W.creditedTo(a.name, a.code)}
            </Link>
            <span className="text-text-3">
              {' '}
              ·{' '}
              {AFFILIATE_ADMIN_WORDS.credited(AFFILIATE_HOW_WORDS[a.how], whenWords(a.referredAt))}
            </span>
          </>
        ) : (
          W.none
        )}
      </p>

      {changing ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {credit.choices.length === 0 && !a ? (
            <p className="text-[13px] text-text-3">{W.noChoices}</p>
          ) : (
            <Field label={W.pick} htmlFor="affiliate-of-business" className="min-w-56">
              <select
                id="affiliate-of-business"
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
                className="h-10 w-full rounded-control border border-border bg-card px-2.5 text-sm"
                data-testid="admin-affiliate-pick"
              >
                <option value="">{W.nobody}</option>
                {/* Somebody it's credited to who's since paused stays pickable, so Save without a change keeps them. */}
                {a && !credit.choices.some((c) => c.affiliateId === a.affiliateId) ? (
                  <option value={a.affiliateId}>
                    {a.name} ({a.code})
                  </option>
                ) : null}
                {credit.choices.map((c) => (
                  <option key={c.affiliateId} value={c.affiliateId}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button
            disabled={busy || picked === (a?.affiliateId ?? '')}
            onClick={() => void save()}
            data-testid="admin-affiliate-save"
          >
            {W.save}
          </Button>
          <Button variant="ghost" onClick={() => setChanging(false)}>
            {AFFILIATE_ADMIN_WORDS.cancel}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
