'use client';
/**
 * A partner, under Settings → Partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stages 2d and 3): their share
 * (their own, or the business's), pausing or ending them, their link, sending them their page in the portal, each
 * share they earned or had taken back, their bank at Stripe and their part of each payout, and the clients they sent.
 * Everything comes from `partner.get`; changes are `partner.update`, and sending their page is `portal_access.give`.
 */
import {
  earningsTotals,
  formatDate,
  money,
  PARTNERS_WORDS as W,
  PAYOUT_WORDS as P,
  rateWords,
  type PartnerStatus,
} from '@hfos/core';
import { ArrowLeft, Banknote, Link2, Mail, Receipt, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PercentInput } from '@/components/money/money-input';
import { Section } from '@/components/partners/settings-page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PartnerCommissionRow, PartnerGetOut } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';

export function PartnerDetail({
  workspaceId,
  got,
  businessRateBp,
  hasTerms,
  pageSent,
  canSendPage,
  brandedOrigin,
}: {
  workspaceId: string;
  got: PartnerGetOut;
  /** The business's share for partners, which they earn unless they have their own. */
  businessRateBp: number;
  /** Whether the business has terms for partners to accept. */
  hasTerms: boolean;
  /** Whether they've been let into the portal (Send it again, then). */
  pageSent: boolean;
  /** `records.write`, which letting someone into the portal needs. */
  canSendPage: boolean;
  brandedOrigin: string | null;
}) {
  const router = useRouter();
  useLiveRefresh(['partner', 'person']);
  const origin = usePublicOrigin(brandedOrigin);
  const p = got.partner;
  const [rateBp, setRateBp] = useState(p.rateBp);
  const [busy, setBusy] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const base = `/app/w/${workspaceId}`;

  async function act(key: string, run: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(key);
    try {
      await run();
      toast.success(done);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const update = (
    key: string,
    body: { rateBp?: number | null; status?: PartnerStatus },
    done: string,
  ) =>
    act(
      key,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/partner.update', {
            body: { workspaceId, partnerId: p.partnerId, ...body },
          }),
        ),
      done,
    );

  async function saveRate(next: number | null) {
    const ok = await update('rate', { rateBp: next }, W.partner.shareSaved);
    // A refusal puts back what's kept; going back to the business's share shows it.
    if (!ok) setRateBp(p.rateBp);
    else if (next === null) setRateBp(businessRateBp);
  }

  const link = p.linkPath && origin ? `${origin}${p.linkPath}` : null;
  const statusLine = W.partner.statusLine[p.status];
  const totals = earningsTotals(p.earnings);
  const account = got.payouts.account;

  return (
    <div className="flex flex-col gap-4" data-testid="partner-detail">
      <div>
        <Link
          href={`${base}/settings/partners`}
          className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          {W.partner.back}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight">{p.name}</h2>
          <Badge
            variant={p.status === 'active' ? 'ok' : p.status === 'paused' ? 'pending' : 'gray'}
            data-testid="partner-status"
          >
            {W.status[p.status]}
          </Badge>
        </div>
        <p className="mt-1 text-[13px] text-text-2">
          {W.partner.since(formatDate(p.addedAt))} ·{' '}
          <Link
            href={`${base}/customers/people/${p.personId}`}
            className="text-accent-text hover:underline"
          >
            {W.partner.openContact}
          </Link>
        </p>
        {statusLine ? (
          <p
            className="mt-2 max-w-[640px] text-[13px] text-text-2"
            data-testid="partner-status-line"
          >
            {statusLine(p.name)}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {p.status === 'active' ? (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'paused'}
              onClick={() =>
                void update('paused', { status: 'paused' }, W.partner.statusSaved.paused(p.name))
              }
              data-testid="partner-pause"
            >
              {W.partner.pause}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'active'}
              onClick={() =>
                void update('active', { status: 'active' }, W.partner.statusSaved.active(p.name))
              }
              data-testid="partner-resume"
            >
              {W.partner.resume}
            </Button>
          )}
          {p.status === 'ended' ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEnding(true)}
              data-testid="partner-end"
            >
              {W.partner.end}
            </Button>
          )}
        </div>
      </div>

      <Section
        title={W.partner.share}
        description={W.partner.shareHint(rateWords(businessRateBp))}
        icon={Wallet}
      >
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <PercentInput
              valueBp={rateBp}
              onChange={setRateBp}
              onBlur={() => {
                if (rateBp !== p.rateBp) void saveRate(rateBp);
              }}
              aria-label={W.partner.share}
              className="w-20"
              data-testid="partner-rate"
            />
            <span className="text-[13px] text-text-2">%</span>
          </div>
          {p.ownRate ? (
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'rate'}
              onClick={() => void saveRate(null)}
              data-testid="partner-rate-default"
            >
              {W.partner.useYours(rateWords(businessRateBp))}
            </Button>
          ) : null}
        </div>
      </Section>

      <Section
        title={W.partner.link}
        description={W.partner.linkHint}
        icon={Link2}
        testId="partner-link"
      >
        <div className="mt-3">
          {link && p.status !== 'ended' ? (
            <CopyField value={link} label={W.partner.copy} copied={W.partner.copied} />
          ) : (
            <p className="text-[13px] text-text-2">
              {p.status === 'ended' ? W.partner.statusLine.ended(p.name) : W.partner.noLink}
            </p>
          )}
          {hasTerms && p.status !== 'ended' ? (
            <p
              className={cn(
                'mt-2 text-[12.5px]',
                p.termsAccepted ? 'text-text-3' : 'text-warning-text',
              )}
              data-testid="partner-terms"
            >
              {p.termsAccepted ? W.partner.termsAccepted : W.partner.termsWaiting}
            </p>
          ) : null}
        </div>
      </Section>

      <Section
        title={W.partner.page}
        description={W.partner.pageHint}
        icon={Mail}
        testId="partner-page"
      >
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {p.email ? (
            <Button
              variant="secondary"
              disabled={!canSendPage}
              loading={busy === 'send'}
              onClick={() =>
                void act(
                  'send',
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/portal_access.give', {
                        body: { workspaceId, personId: p.personId },
                      }),
                    ),
                  W.partner.sent(p.email!),
                )
              }
              data-testid="partner-send-page"
            >
              {pageSent ? W.partner.sendAgain : W.partner.send}
            </Button>
          ) : (
            <p className="text-[13px] text-warning-text">{W.partner.noEmail(p.name)}</p>
          )}
        </div>
      </Section>

      <Section
        title={W.partner.commissions.title}
        description={W.earnings.about}
        icon={Receipt}
        testId="partner-earnings"
      >
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {totals.map(([label, cents]) => (
            <div key={label} className="rounded-menu bg-card-2 px-3 py-2.5">
              <dt className="text-[12px] text-text-2">{label}</dt>
              <dd className="text-[17px] font-semibold tabular-nums">{money(cents)}</dd>
            </div>
          ))}
        </dl>
        {got.commissions.length ? (
          <ul
            className="mt-4 divide-y divide-border border-t border-border"
            data-testid="partner-commissions"
          >
            {got.commissions.map((c) => (
              <CommissionRow key={c.commissionId} c={c} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[13px] text-text-2">{W.partner.commissions.empty}</p>
        )}
      </Section>

      <Section
        title={P.partner.title}
        description={
          account?.ready ? P.partner.ready : account ? P.partner.needsMore : P.partner.noAccount
        }
        icon={Banknote}
        testId="partner-payouts-of-partner"
      >
        {got.payouts.lines.length ? (
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {got.payouts.lines.map((l) => (
              <li
                key={l.lineId}
                className="flex items-start justify-between gap-3 py-2.5"
                data-testid="partner-payout-line"
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">
                    {P.history.month(l.month)}
                    {l.livemode ? null : (
                      <span className="font-normal text-text-3"> · {P.history.test}</span>
                    )}
                  </p>
                  <p
                    className={cn(
                      'text-[12.5px]',
                      l.status === 'held' ? 'text-warning-text' : 'text-text-2',
                    )}
                  >
                    {l.status === 'paid' && l.paidAt
                      ? P.line.paid(formatDate(l.paidAt))
                      : l.status === 'held'
                        ? P.line.held
                        : l.status === 'cancelled'
                          ? P.line.cancelled
                          : P.line.pending}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 text-[14px] font-semibold tabular-nums',
                    l.status === 'cancelled' && 'text-text-3 line-through',
                  )}
                >
                  {money(l.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[13px] text-text-2">{P.partner.empty}</p>
        )}
      </Section>

      <Section title={W.partner.clients.title} icon={Users} testId="partner-clients">
        {got.clients.length ? (
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {got.clients.map((c) => (
              <li key={c.referralId} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  {c.personId ? (
                    <Link
                      href={`${base}/customers/people/${c.personId}`}
                      className="truncate text-[14px] font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                  ) : (
                    <span className="truncate text-[14px] font-medium">{c.name}</span>
                  )}
                  <p className="text-[12.5px] text-text-2">
                    {c.how === 'link' ? W.partner.clients.viaLink : W.partner.clients.byHand} ·{' '}
                    {formatDate(c.referredAt)}
                  </p>
                  <p className="text-[12.5px] text-text-2">
                    {c.monthsEndAt
                      ? W.partner.clients.until(formatDate(c.monthsEndAt))
                      : W.partner.clients.notYet}
                  </p>
                </div>
                <span className="shrink-0 text-[14px] font-semibold tabular-nums">
                  {money(c.earnedCents)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[13px] text-text-2">{W.partner.clients.empty}</p>
        )}
      </Section>

      <Dialog open={ending} onOpenChange={(o) => !o && setEnding(false)}>
        <DialogContent title={W.partner.endTitle(p.name)} description={W.partner.endBody}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEnding(false)}>
              {W.partner.endKeep}
            </Button>
            <Button
              variant="danger"
              loading={busy === 'ended'}
              onClick={async () => {
                if (await update('ended', { status: 'ended' }, W.partner.statusSaved.ended(p.name)))
                  setEnding(false);
              }}
              data-testid="partner-end-confirm"
            >
              {W.partner.end}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CommissionRow({ c }: { c: PartnerCommissionRow }) {
  const C = W.partner.commissions;
  const rate = rateWords(c.rateBp);
  const what =
    c.kind === 'earned'
      ? C.earned(rate, money(c.baseCents))
      : C.takenBack(rate, money(c.baseCents));
  const when = c.test
    ? C.test
    : c.held
      ? C.held
      : new Date(c.payableAt).getTime() > Date.now()
        ? C.freeOn(formatDate(c.payableAt))
        : C.free;
  return (
    <li className="flex items-start justify-between gap-3 py-2.5" data-testid="partner-commission">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-medium">
          {c.clientName}
          {c.invoiceNumber ? (
            <span className="font-normal text-text-2"> · {C.invoice(c.invoiceNumber)}</span>
          ) : null}
        </p>
        <p className="text-[12.5px] text-text-2">
          {formatDate(c.earnedAt)} · {what}
        </p>
        <p className={cn('text-[12.5px]', c.test || c.held ? 'text-warning-text' : 'text-text-3')}>
          {when}
        </p>
      </div>
      <span
        className={cn(
          'shrink-0 text-[14px] font-semibold tabular-nums',
          c.amountCents < 0 && 'text-danger-text',
          c.test && 'text-text-3 line-through',
        )}
      >
        {money(c.amountCents)}
      </span>
    </li>
  );
}
