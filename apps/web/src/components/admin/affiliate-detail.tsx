'use client';

/**
 * One affiliate on Admin → Affiliates (20261027014000): where they stand, their share, their link, the businesses
 * they sent and their link's clicks a day. Pausing and ending ask first, since each changes what their link does.
 */
import {
  AFFILIATE_ADMIN_WORDS,
  AFFILIATE_HOW_WORDS,
  AFFILIATE_STATUS_WORDS,
  affiliateLink,
  affiliatePercentToBp,
  affiliateRateWords,
} from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AFFILIATE_BADGE } from '@/components/admin/affiliates-page';
import { whenWords } from '@/components/admin/ticket-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

const W = AFFILIATE_ADMIN_WORDS;

type Page = Ok<'/v1/queries/platform.affiliate'>;

export function AffiliateDetail({ page }: { page: Page }) {
  const router = useRouter();
  const a = page.affiliate;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<'paused' | 'ended' | null>(null);
  const [rate, setRate] = useState(a.ownRateBp === null ? '' : String(a.ownRateBp / 100));
  const [code, setCode] = useState(a.code);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      router.refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (status: 'approved' | 'paused' | 'ended') =>
    run('status', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/affiliate.set_status', {
          body: { affiliateId: a.affiliateId, status },
        }),
      ),
    );

  const saveRate = (rateBp: number | null) =>
    run('rate', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/affiliate.set_rate', {
          body: { affiliateId: a.affiliateId, rateBp },
        }),
      ),
    );

  const decided = a.status !== 'applied' && a.status !== 'turned_down';

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="admin-affiliate">
      <Link href="/admin/affiliates" className="text-[13px] text-text-3 hover:text-text">
        ← {W.allAffiliates}
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">{a.name}</h1>
          <p className="mt-1 text-[13px] text-text-3">
            {a.email} · {W.applied(whenWords(a.appliedAt))}
            {a.decidedAt ? ` · ${W.decided(whenWords(a.decidedAt), a.decidedByName)}` : ''}
          </p>
        </div>
        <Badge variant={AFFILIATE_BADGE[a.status]} data-testid="affiliate-status">
          {AFFILIATE_STATUS_WORDS[a.status]}
        </Badge>
      </div>
      {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

      <div className="mt-5 grid items-start gap-5 md:grid-cols-2">
        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{W.link}</h2>
          <CopyField
            className="mt-2"
            value={affiliateLink(a.code)}
            label="Copy link"
            copied="Copied their link"
          />
          <p className="mt-3 text-[13px] text-text-2">{W.clicks(a.clicks30, a.clicksAll)}</p>
          <div className="mt-4 flex items-end gap-2">
            <Field label={W.code} htmlFor="affiliate-code" hint={W.codeHelp} className="flex-1">
              <Input
                id="affiliate-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                data-testid="affiliate-code"
              />
            </Field>
            <Button
              variant="secondary"
              className="mb-6"
              disabled={busy !== null || code.trim().toLowerCase() === a.code}
              onClick={() =>
                void run('code', async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/affiliate.set_code', {
                      body: { affiliateId: a.affiliateId, code },
                    }),
                  ),
                )
              }
            >
              {W.save}
            </Button>
          </div>
        </section>

        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{W.share}</h2>
          <p className="mt-1 text-[13px] text-text-2" data-testid="affiliate-share">
            {a.ownRateBp === null
              ? W.everyones(affiliateRateWords(a.rateBp))
              : `${W.ownShare}: ${affiliateRateWords(a.ownRateBp)}`}
          </p>
          <div className="mt-3 flex items-end gap-2">
            <Field label={W.setOwn} htmlFor="affiliate-own-rate" className="w-36">
              <Input
                id="affiliate-own-rate"
                inputMode="decimal"
                placeholder={String(a.rateBp / 100)}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                data-testid="affiliate-own-rate"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                const rateBp = affiliatePercentToBp(rate);
                if (rateBp === null) return setError(W.percentProblem);
                void saveRate(rateBp);
              }}
            >
              {W.save}
            </Button>
            {a.ownRateBp !== null ? (
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void saveRate(null).then((ok) => ok && setRate(''))}
              >
                {W.useEveryones}
              </Button>
            ) : null}
          </div>

          {decided && a.status !== 'ended' ? (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
              {a.status === 'paused' ? (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void setStatus('approved')}
                  data-testid="affiliate-resume"
                >
                  {W.resume}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => setAsking('paused')}
                  data-testid="affiliate-pause"
                >
                  {W.pause}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setAsking('ended')}
                data-testid="affiliate-end"
              >
                {W.end}
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      {a.pitch || a.links ? (
        <section className="mt-5 rounded-card border border-border bg-card p-4">
          {a.pitch ? (
            <>
              <h2 className="text-sm font-semibold">{W.pitch}</h2>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-2">{a.pitch}</p>
            </>
          ) : null}
          {a.links ? (
            <>
              <h2 className="mt-3 text-sm font-semibold">{W.links}</h2>
              <p className="mt-1 whitespace-pre-wrap break-all text-[13px] text-text-2">
                {a.links}
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      <div className="mt-5 grid items-start gap-5 md:grid-cols-2">
        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{W.theirBusinesses}</h2>
          {page.businesses.length === 0 ? (
            <p className="mt-2 text-[13px] text-text-3">{W.noBusinesses}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2 text-[13px]" data-testid="affiliate-businesses">
              {page.businesses.map((b) => (
                <li key={b.organizationId} className="flex items-baseline justify-between gap-2">
                  {b.workspaceId ? (
                    <Link
                      href={`/admin/businesses/${b.workspaceId}`}
                      className="min-w-0 truncate font-medium hover:underline"
                    >
                      {b.name}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate font-medium">{b.name}</span>
                  )}
                  <span className="flex-none text-text-3">
                    {W.credited(AFFILIATE_HOW_WORDS[b.how], whenWords(b.referredAt))}
                    {b.markedByName ? `, ${W.markedBy(b.markedByName)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{W.clicksByDay}</h2>
          {page.clicks.length === 0 ? (
            <p className="mt-2 text-[13px] text-text-3">{W.noClicks}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-[13px]">
              {page.clicks.map((c) => (
                <li key={c.day} className="flex justify-between gap-2">
                  <span className="text-text-2">
                    {new Date(`${c.day}T12:00:00Z`).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <span>{c.clicks}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog open={asking !== null} onOpenChange={(o) => (o ? null : setAsking(null))}>
        <DialogContent
          title={asking === 'ended' ? W.endTitle(a.name) : W.pauseTitle(a.name)}
          description={asking === 'ended' ? W.endBody : W.pauseBody}
        >
          <div className="mt-4 flex gap-2">
            <Button
              variant={asking === 'ended' ? 'danger' : 'primary'}
              disabled={busy !== null}
              onClick={() => asking && void setStatus(asking).then((ok) => ok && setAsking(null))}
              data-testid="affiliate-status-confirm"
            >
              {asking === 'ended' ? W.end : W.pause}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {W.cancel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
