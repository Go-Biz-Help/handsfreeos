'use client';
/**
 * Settings → Partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stages 2d and 3): how partners are paid, the terms
 * they accept on their page, paying them through HandsFreeOS (payouts-section.tsx), and the partners with what each
 * has earned.
 *
 * The share, the smallest payout and the calendar save the moment they're changed (`partners.save_settings`), as
 * Settings → Payments does. The terms wait for Save the terms: saving new terms asks every partner to accept them
 * again, so a half-typed sentence never goes out.
 */
import { earningsTotals, money, PARTNERS_WORDS as W, rateWords, type SettingKey } from '@hfos/core';
import { ChevronRight, FileText, Handshake, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { MoneyInput, PercentInput } from '@/components/money/money-input';
import { SetRow } from '@/components/settings/set-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { PayoutsSection } from '@/components/partners/payouts-section';
import type {
  PartnerPayoutsOut,
  PartnerRow,
  PartnerSettingsValue,
  PartnersSettingsOut,
} from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { settingAttrs } from '@/components/settings/setting-anchor';

type Change = Partial<
  Pick<PartnerSettingsValue, 'rateBp' | 'smallestPayoutCents' | 'calendarId' | 'terms'>
>;

export function Section({
  title,
  description,
  icon: Icon,
  children,
  testId,
  setting,
}: {
  title: string;
  description?: ReactNode;
  icon: typeof Wallet;
  children?: ReactNode;
  testId?: string;
  /** Its key in settings search. */
  setting?: SettingKey;
}) {
  return (
    <Card className="px-[22px] py-5" data-testid={testId} {...settingAttrs(setting)}>
      <div className="flex min-w-0 gap-2.5">
        <Icon className="mt-0.5 h-[18px] w-[18px] flex-none text-text-3" strokeWidth={1.75} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-[520px] text-[13px] text-text-2">{description}</p>
          ) : null}
        </div>
      </div>
      {children}
    </Card>
  );
}

export function PartnersSettings({
  workspaceId,
  initial,
  partners,
  payouts,
  canManageMoney,
  calendars,
}: {
  workspaceId: string;
  initial: PartnersSettingsOut;
  partners: readonly PartnerRow[];
  payouts: PartnerPayoutsOut;
  /** `money.manage`: putting on or taking off the card partner payouts are charged to. */
  canManageMoney: boolean;
  /** The calendars that take bookings on the booking page: the ones a partner's link can book. */
  calendars: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  useLiveRefresh(['partner']);
  const [saved, setSaved] = useState<PartnerSettingsValue>(initial.settings);
  const [rateBp, setRateBp] = useState(saved.rateBp);
  const [payout, setPayout] = useState(saved.smallestPayoutCents);
  const [payoutBad, setPayoutBad] = useState(false);
  const [terms, setTerms] = useState(saved.terms);
  const [busy, setBusy] = useState<'settings' | 'terms' | null>(null);
  // One save at a time, each from what the last one kept: leaving the share for the payout box straight away never
  // sends the old share back.
  const kept = useRef(initial.settings);
  const queue = useRef<Promise<void>>(Promise.resolve());

  function save(change: Change, which: 'settings' | 'terms'): void {
    queue.current = queue.current.then(async () => {
      const next = {
        rateBp: kept.current.rateBp,
        smallestPayoutCents: kept.current.smallestPayoutCents,
        calendarId: kept.current.calendarId,
        terms: kept.current.terms,
        ...change,
      };
      setBusy(which);
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/partners.save_settings', {
            body: { workspaceId, settings: next },
          }),
        );
        kept.current = out.settings;
        setSaved(out.settings);
        if (which === 'terms') {
          setTerms(out.settings.terms);
          toast.success(out.settings.terms ? W.terms.saved : W.terms.cleared);
        } else toast.success(W.settings.saved);
        router.refresh();
      } catch (e) {
        // What's on screen goes back to what's kept, so it never shows a share that isn't the one paid.
        if (change.rateBp !== undefined) setRateBp(kept.current.rateBp);
        if (change.smallestPayoutCents !== undefined) setPayout(kept.current.smallestPayoutCents);
        toast.error(errorMessage(e));
      } finally {
        setBusy(null);
      }
    });
  }

  const termsChanged = terms.trim() !== saved.terms;
  const linkCalendar = initial.linkCalendar;
  return (
    <div className="flex flex-col gap-4" data-testid="partners-settings">
      <p className="max-w-[640px] text-[13.5px] text-text-2">{W.about}</p>

      <Section title={W.settings.title} icon={Wallet} testId="partners-pay" setting="partners.pay">
        <div className="mt-3">
          <SetRow first center title={W.settings.share} description={W.settings.shareHint}>
            <div className="flex items-center gap-1.5">
              <PercentInput
                valueBp={rateBp}
                onChange={setRateBp}
                onBlur={() => {
                  if (rateBp !== saved.rateBp) save({ rateBp }, 'settings');
                }}
                aria-label={W.settings.share}
                className="w-20"
                data-testid="partners-rate"
              />
              <span className="text-[13px] text-text-2">%</span>
            </div>
          </SetRow>
          <SetRow
            center
            title={W.settings.smallestPayout}
            description={W.settings.smallestPayoutHint}
          >
            <MoneyInput
              valueCents={payout}
              onChange={setPayout}
              onInvalid={(v: boolean | SyntheticEvent<HTMLInputElement>) =>
                setPayoutBad(v === true)
              }
              onBlur={() => {
                if (!payoutBad && payout !== saved.smallestPayoutCents)
                  save({ smallestPayoutCents: payout }, 'settings');
              }}
              aria-label={W.settings.smallestPayout}
              className="w-28"
              data-testid="partners-smallest-payout"
            />
          </SetRow>
          <SetRow
            center
            title={W.settings.calendar}
            description={
              calendars.length ? (
                W.settings.calendarHint
              ) : (
                <span className="text-warning-text">{W.settings.noCalendar}</span>
              )
            }
          >
            <Select
              value={saved.calendarId ?? ''}
              disabled={!calendars.length}
              onChange={(e) => save({ calendarId: e.target.value || null }, 'settings')}
              aria-label={W.settings.calendar}
              className="w-60"
              data-testid="partners-calendar"
            >
              <option value="">
                {linkCalendar && !saved.calendarId
                  ? `${W.settings.calendarFirst} (${linkCalendar.name})`
                  : W.settings.calendarFirst}
              </option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </SetRow>
        </div>
      </Section>

      <Section
        title={W.terms.title}
        description={W.terms.hint}
        icon={FileText}
        testId="partners-terms"
        setting="partners.terms"
      >
        <Textarea
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          placeholder={W.terms.placeholder}
          rows={8}
          maxLength={20_000}
          className="mt-4"
          aria-label={W.terms.title}
          data-testid="partners-terms-text"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12.5px] text-text-3" data-testid="partners-terms-state">
            {termsChanged
              ? W.terms.unsaved
              : saved.terms
                ? W.terms.version(saved.termsVersion)
                : W.terms.none}
          </span>
          <Button
            disabled={!termsChanged}
            loading={busy === 'terms'}
            onClick={() => save({ terms: terms.trim() }, 'terms')}
            data-testid="partners-terms-save"
          >
            {W.terms.save}
          </Button>
        </div>
      </Section>

      <PayoutsSection workspaceId={workspaceId} payouts={payouts} canManageMoney={canManageMoney} />

      <PartnersList workspaceId={workspaceId} partners={partners} />
    </div>
  );
}

function PartnersList({
  workspaceId,
  partners,
}: {
  workspaceId: string;
  partners: readonly PartnerRow[];
}) {
  const sum = (pick: (p: PartnerRow) => number) => partners.reduce((t, p) => t + pick(p), 0);
  const totals = earningsTotals({
    earnedCents: sum((p) => p.earnings.earnedCents),
    waitingCents: sum((p) => p.earnings.waitingCents),
    payableCents: sum((p) => p.earnings.payableCents),
    heldCents: sum((p) => p.earnings.heldCents),
    payingCents: sum((p) => p.earnings.payingCents),
    paidCents: sum((p) => p.earnings.paidCents),
  });
  return (
    <Section title={W.list.title} icon={Handshake} testId="partners-list">
      {partners.length ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="partners-totals">
            {totals.map(([label, cents]) => (
              <div key={label} className="rounded-menu bg-card-2 px-3 py-2.5">
                <dt className="text-[12px] text-text-2">{label}</dt>
                <dd className="text-[17px] font-semibold tabular-nums">{money(cents)}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-4 divide-y divide-border border-t border-border">
            {partners.map((p) => (
              <li key={p.partnerId}>
                <Link
                  href={`/app/w/${workspaceId}/settings/partners/${p.partnerId}`}
                  className="flex items-center gap-3 py-3 hover:bg-card-2"
                  data-testid="partners-row"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14px] font-medium">{p.name}</span>
                      {p.status === 'active' ? null : (
                        <Badge variant={p.status === 'paused' ? 'pending' : 'gray'}>
                          {W.status[p.status]}
                        </Badge>
                      )}
                    </div>
                    <p className="text-[12.5px] text-text-2">
                      {p.ownRate ? W.list.ownShare(rateWords(p.rateBp)) : rateWords(p.rateBp)} ·{' '}
                      {W.list.clients(p.clients)}
                      {!p.termsAccepted && p.status !== 'ended' ? (
                        <span className="text-warning-text"> · {W.list.termsWaiting}</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-[14px] font-semibold tabular-nums">
                      {money(p.earnings.earnedCents)}
                    </div>
                    <div className="text-[12px] text-text-2 tabular-nums">
                      {W.earnings.payable} {money(p.earnings.payableCents)}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12.5px] text-text-3">{W.earnings.about}</p>
        </>
      ) : (
        <p className="mt-3 text-[13.5px] text-text-2" data-testid="partners-empty">
          {W.list.empty}
        </p>
      )}
    </Section>
  );
}
