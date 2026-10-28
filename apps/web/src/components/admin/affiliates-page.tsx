'use client';

/**
 * Admin → Affiliates (20261027014000): the share everyone earns and the most a code takes off (20261027014300), the
 * house codes, the applications waiting, and every affiliate.
 *
 * Approving turns their link on and emails them it; turning down asks first, since it emails them too. Everything
 * else about one affiliate (their own share, pausing, ending, their link code and the businesses they sent) is on
 * their own page, a row's link away.
 */
import {
  AFFILIATE_ADMIN_WORDS,
  AFFILIATE_CODE_WORDS,
  AFFILIATE_STATUS_WORDS,
  affiliateLink,
  affiliatePercentToBp,
  affiliateRateWords,
  deskCountHeading,
} from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { whenWords } from '@/components/admin/ticket-bits';
import { AffiliateCodeList, MakeCodeForm } from '@/components/affiliate/affiliate-codes';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

const W = AFFILIATE_ADMIN_WORDS;

type Program = Ok<'/v1/queries/platform.affiliates'>;
type Affiliate = Program['affiliates'][number];

export const AFFILIATE_BADGE: Readonly<Record<Affiliate['status'], BadgeVariant>> = {
  applied: 'pending',
  approved: 'ok',
  turned_down: 'gray',
  paused: 'pending',
  ended: 'gray',
};

export function AffiliatesPage({ program }: { program: Program }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rate, setRate] = useState(String(program.settings.rateBp / 100));
  const [limit, setLimit] = useState(String(program.settings.maxDiscountBp / 100));
  const [turningDown, setTurningDown] = useState<Affiliate | null>(null);

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

  const decide = (a: Affiliate, decision: 'approve' | 'turn_down') =>
    run(`decide:${a.affiliateId}`, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/affiliate.decide', {
          body: { affiliateId: a.affiliateId, decision },
        }),
      ),
    );

  const saveSettings = () => {
    const rateBp = affiliatePercentToBp(rate);
    if (rateBp === null) return setError(W.percentProblem);
    const maxDiscountBp = affiliatePercentToBp(limit);
    if (maxDiscountBp === null || maxDiscountBp < 100 || maxDiscountBp > 9000)
      return setError(AFFILIATE_CODE_WORDS.limitProblem);
    void run('rate', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/affiliates.save_settings', {
          body: { rateBp, maxDiscountBp },
        }),
      ),
    );
  };

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="admin-affiliates">
      <h1 className="text-xl font-semibold md:text-2xl">{W.title}</h1>
      <p className="mt-1 max-w-[640px] text-[13px] text-text-3">{W.intro}</p>
      {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

      <section className="mt-5 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{W.everyone}</h2>
        <p className="mt-1 max-w-[560px] text-[13px] text-text-3">{W.everyoneHelp}</p>
        <div className="mt-3 flex items-end gap-2">
          <Field label={W.percent} htmlFor="affiliate-rate" className="w-28">
            <Input
              id="affiliate-rate"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              data-testid="affiliate-rate"
            />
          </Field>
          <Field label={AFFILIATE_CODE_WORDS.limit} htmlFor="affiliate-limit" className="w-44">
            <Input
              id="affiliate-limit"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              data-testid="affiliate-limit"
            />
          </Field>
          <Button
            variant="secondary"
            onClick={saveSettings}
            disabled={
              busy === 'rate' ||
              (affiliatePercentToBp(rate) === program.settings.rateBp &&
                affiliatePercentToBp(limit) === program.settings.maxDiscountBp)
            }
            data-testid="affiliate-rate-save"
          >
            {W.save}
          </Button>
        </div>
        <p className="mt-2 max-w-[560px] text-[12.5px] text-text-3">
          {AFFILIATE_CODE_WORDS.limitHelp}
        </p>
      </section>

      <section
        className="mt-5 rounded-card border border-border bg-card p-4"
        data-testid="house-codes"
      >
        <h2 className="text-sm font-semibold">{AFFILIATE_CODE_WORDS.houseCodes}</h2>
        <p className="mt-1 max-w-[560px] text-[13px] text-text-3">
          {AFFILIATE_CODE_WORDS.houseHelp}
        </p>
        <AffiliateCodeList
          codes={program.houseCodes}
          plans={program.plans}
          busy={busy !== null}
          asStaff
          onTurn={(c, on) =>
            void run(`code:${c.codeId}`, async () =>
              unwrap(
                await apiBrowser().POST('/v1/commands/affiliates.turn_code', {
                  body: { codeId: c.codeId, on },
                }),
              ),
            )
          }
        />
        <details className="mt-4 rounded-menu border border-border p-3">
          <summary className="cursor-pointer text-[14px] font-medium">
            {AFFILIATE_CODE_WORDS.make}
          </summary>
          <MakeCodeForm
            plans={program.plans}
            maxDiscountBp={9000}
            onMake={async (code) => {
              unwrap(
                await apiBrowser().POST('/v1/commands/affiliates.make_code', {
                  body: { affiliateId: null, ...code },
                }),
              );
              router.refresh();
            }}
          />
        </details>
      </section>

      <h2 className="mt-8 text-base font-semibold">
        {deskCountHeading(W.waiting, program.applications.length)}
      </h2>
      {program.applications.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{W.noneWaiting}</p>
      ) : (
        <ul
          className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card"
          data-testid="affiliate-applications"
        >
          {program.applications.map((a) => (
            <li key={a.affiliateId} className="px-4 py-3.5">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {a.name} <span className="font-normal text-text-3">· {a.email}</span>
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-text-3">
                    {W.applied(whenWords(a.appliedAt))} · {W.wantsCode(a.code)}
                  </p>
                  {a.pitch ? (
                    <p className="mt-2 whitespace-pre-wrap text-[13px] text-text-2">{a.pitch}</p>
                  ) : null}
                  {a.links ? (
                    <p className="mt-1 whitespace-pre-wrap break-all text-[12.5px] text-text-3">
                      {a.links}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-none gap-2">
                  <Button
                    size="sm"
                    onClick={() => void decide(a, 'approve')}
                    disabled={busy !== null}
                    data-testid={`affiliate-approve-${a.code}`}
                  >
                    {W.approve}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setTurningDown(a)}
                    disabled={busy !== null}
                  >
                    {W.turnDown}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-base font-semibold">
        {deskCountHeading(W.affiliates, program.affiliates.length)}
      </h2>
      {program.affiliates.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{W.noneYet}</p>
      ) : (
        <ul
          className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card"
          data-testid="affiliate-list"
        >
          {program.affiliates.map((a) => (
            <li key={a.affiliateId}>
              <Link
                href={`/admin/affiliates/${a.affiliateId}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-card-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  <span className="block truncate text-[12.5px] text-text-3">
                    {affiliateLink(a.code)}
                  </span>
                </span>
                <span className="text-[12.5px] text-text-2">
                  {affiliateRateWords(a.rateBp)}
                  {a.ownRateBp !== null ? ` (${W.ownShare.toLowerCase()})` : ''}
                </span>
                <span className="text-[12.5px] text-text-2">
                  {W.clicks(a.clicks30, a.clicksAll)}
                </span>
                <span className="text-[12.5px] text-text-2">{W.businessCount(a.businesses)}</span>
                <Badge variant={AFFILIATE_BADGE[a.status]}>
                  {AFFILIATE_STATUS_WORDS[a.status]}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={turningDown !== null} onOpenChange={(o) => (o ? null : setTurningDown(null))}>
        <DialogContent
          title={turningDown ? W.turnDownTitle(turningDown.name) : ''}
          description={W.turnDownBody}
        >
          <div className="mt-4 flex gap-2">
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() =>
                turningDown &&
                void decide(turningDown, 'turn_down').then((ok) => ok && setTurningDown(null))
              }
              data-testid="affiliate-turn-down-confirm"
            >
              {W.turnDown}
            </Button>
            <Button variant="ghost" onClick={() => setTurningDown(null)}>
              {W.cancel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
