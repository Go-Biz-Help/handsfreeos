import {
  earningsTotals,
  formatDate,
  formatDateOnly,
  holds,
  money,
  PARTNERS_WORDS as W,
  payoutLineWords,
  PAYOUT_WORDS as P,
  payoutCountryIn,
  rateWords,
  type PartnerEarnings,
  type PartnerStatus,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Share, View } from 'react-native';

import { Share as ShareIcon } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useLiveAnswer } from '@/lib/live-answer';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';

import {
  partnerCalls,
  type PartnerCommissionRow,
  type PartnerGetOut,
  type PartnerPayoutsOut,
  type PartnerRow,
  type PartnersSettingsOut,
} from './calls';

/**
 * Settings → Partners on the phone (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stages 2d and 3), in the web's words:
 * how partners are paid and paying them through HandsFreeOS, to read (the share, the smallest payout, the calendar,
 * the terms and the payout card are set up on the web, as the business's other settings are), the partners with what
 * they've earned, and each one's page, where the owner pauses, ends or brings them back, gives them their own share,
 * shares their link and sends them their page, and sees their payouts. It all needs signal; nothing of it is kept on
 * the phone.
 */

const partnerHref = (workspaceId: string, partnerId: string) =>
  businessHref(workspaceId, `settings/partners/${partnerId}`) as Href;

const badgeOf = (status: PartnerStatus) =>
  status === 'active' ? 'ok' : status === 'paused' ? 'pending' : 'gray';

/** Earned, waiting and free to pay out, then what a dispute holds, what's on its way and what's paid while there's some. */
function Totals({ earnings, testID }: { earnings: PartnerEarnings; testID?: string }) {
  const totals = earningsTotals(earnings);
  return (
    <View className="flex-row flex-wrap gap-2" testID={testID}>
      {totals.map(([label, cents]) => (
        <View key={label} className="min-w-[46%] flex-1 rounded-menu bg-card-2 px-3 py-2.5">
          <Text className="text-[12px] text-text-2">{label}</Text>
          <Text className="text-[17px] font-semibold">{money(cents)}</Text>
        </View>
      ))}
    </View>
  );
}

function Missing({ words, testID }: { words: string | null; testID: string }) {
  return words ? (
    <Text className="py-10 text-center text-[13px] text-text-3" testID={testID}>
      {words}
    </Text>
  ) : null;
}

const sumOf = (partners: readonly PartnerRow[]): PartnerEarnings => ({
  earnedCents: partners.reduce((t, p) => t + p.earnings.earnedCents, 0),
  waitingCents: partners.reduce((t, p) => t + p.earnings.waitingCents, 0),
  payableCents: partners.reduce((t, p) => t + p.earnings.payableCents, 0),
  heldCents: partners.reduce((t, p) => t + p.earnings.heldCents, 0),
  payingCents: partners.reduce((t, p) => t + p.earnings.payingCents, 0),
  paidCents: partners.reduce((t, p) => t + p.earnings.paidCents, 0),
});

export function PartnersScreen() {
  const { business } = useBusiness();
  const load = React.useCallback(async () => {
    const calls = partnerCalls(business.id);
    const [settings, partners, payouts] = await Promise.all([
      calls.settings(),
      calls.list(),
      calls.payouts(),
    ]);
    return { settings, partners, payouts };
  }, [business.id]);
  const answer = useLiveAnswer(load, business.id, W.phone.needsSignal);
  const data = answer.data;
  return (
    <Screen
      title={W.menu}
      leading="back"
      back={businessHref(business.id, 'settings') as Href}
      testID="partners"
      contentClassName="gap-2"
    >
      {data ? (
        <PartnersBody
          workspaceId={business.id}
          settings={data.settings}
          partners={data.partners}
          payouts={data.payouts}
        />
      ) : (
        <Missing words={answer.loading ? null : answer.error} testID="partners-missing" />
      )}
    </Screen>
  );
}

export function PartnersBody({
  workspaceId,
  settings,
  partners,
  payouts,
}: {
  workspaceId: string;
  settings: PartnersSettingsOut;
  partners: readonly PartnerRow[];
  payouts: PartnerPayoutsOut;
}) {
  const s = settings.settings;
  return (
    <>
      <Text className="px-1 text-[13.5px] leading-[19px] text-text-2">{W.about}</Text>
      <ListLabel>{W.phone.paidTitle}</ListLabel>
      <List testID="partners-paid">
        <ListRow label={W.settings.share} end={rateWords(s.rateBp)} chevron={false} />
        <ListRow
          label={W.settings.smallestPayout}
          end={money(s.smallestPayoutCents)}
          chevron={false}
        />
        <ListRow
          label={W.settings.calendar}
          detail={settings.linkCalendar?.name ?? W.phone.calendarNone}
          chevron={false}
        />
        <ListRow label={W.terms.title} end={W.phone.terms(s.termsVersion)} chevron={false} />
        <ListRow
          label={W.phone.changeOnWeb}
          external
          onPress={() => void openWeb(`/app/w/${workspaceId}/settings/partners`)}
          testID="partners-change-on-web"
        />
      </List>
      <Payouts workspaceId={workspaceId} payouts={payouts} />
      <ListLabel>{W.list.title}</ListLabel>
      {partners.length ? (
        <>
          <Totals earnings={sumOf(partners)} testID="partners-totals" />
          <List testID="partners-list">
            {partners.map((p) => (
              <ListRow
                key={p.partnerId}
                label={p.name}
                detail={[
                  p.ownRate ? W.list.ownShare(rateWords(p.rateBp)) : rateWords(p.rateBp),
                  W.list.clients(p.clients),
                  `${W.earnings.earned} ${money(p.earnings.earnedCents)}`,
                  p.status === 'active' ? null : W.status[p.status],
                  !p.termsAccepted && p.status !== 'ended' ? W.list.termsWaiting : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onPress={() => router.push(partnerHref(workspaceId, p.partnerId))}
                testID="partners-row"
              />
            ))}
          </List>
          <Text className="px-1 text-[12.5px] leading-[18px] text-text-3">{W.earnings.about}</Text>
        </>
      ) : (
        <Text className="px-1 text-[13.5px] text-text-2" testID="partners-empty">
          {W.list.empty}
        </Text>
      )}
    </>
  );
}

/**
 * Paying partners through HandsFreeOS (stage 3), to read: the card, the next payout as it stands and the latest
 * payouts. The card goes on through Stripe's own page, on the web.
 */
function Payouts({ workspaceId, payouts }: { workspaceId: string; payouts: PartnerPayoutsOut }) {
  const next = payouts.next;
  const card = payouts.card;
  return (
    <>
      <ListLabel>{P.title}</ListLabel>
      {payouts.open ? (
        <List testID="partners-payouts">
          <ListRow
            label={P.card.title}
            detail={card ? P.card.ends(card.brand, card.last4) : P.card.none}
            chevron={false}
            testID="partners-payouts-card"
          />
          <ListRow
            label={P.next.title}
            detail={
              next.lines.length
                ? `${P.next.pays(next.lines.length)} · ${P.totals.charge} ${money(next.totals.chargeCents)}`
                : P.next.none
            }
            end={next.soon ? P.next.soon : P.next.on(formatDateOnly(next.month))}
            chevron={false}
            testID="partners-payouts-next"
          />
          {payouts.payouts.slice(0, 6).map((p) => (
            <ListRow
              key={p.payoutId}
              label={P.history.month(p.month)}
              detail={[
                P.status[p.status],
                P.history.pays(p.partners),
                p.livemode ? null : P.history.test,
              ]
                .filter(Boolean)
                .join(' · ')}
              end={money(p.totals.chargeCents)}
              chevron={false}
              testID="partners-payout"
            />
          ))}
          <ListRow
            label={W.phone.changeOnWeb}
            external
            onPress={() => void openWeb(`/app/w/${workspaceId}/settings/partners`)}
            testID="partners-payouts-on-web"
          />
        </List>
      ) : (
        <Text className="px-1 text-[13px] text-text-2" testID="partners-payouts-closed">
          {P.notOpen}
        </Text>
      )}
    </>
  );
}

export function PartnerScreen({ partnerId }: { partnerId: string }) {
  const { business } = useBusiness();
  const load = React.useCallback(async () => {
    const calls = partnerCalls(business.id);
    const [got, settings, origin] = await Promise.all([
      calls.get(partnerId),
      calls.settings(),
      calls.origin(),
    ]);
    return { got, settings, origin };
  }, [business.id, partnerId]);
  const answer = useLiveAnswer(load, `${business.id}:${partnerId}`, W.phone.needsSignal);
  const data = answer.data;
  return (
    <Screen
      title={data?.got.partner.name ?? W.menu}
      leading="back"
      back={businessHref(business.id, 'settings/partners') as Href}
      testID="partner"
      contentClassName="gap-2"
    >
      {data ? (
        <PartnerBody
          workspaceId={business.id}
          got={data.got}
          businessRateBp={data.settings.settings.rateBp}
          hasTerms={data.settings.settings.termsVersion > 0}
          origin={data.origin}
          onChanged={answer.reload}
        />
      ) : (
        <Missing words={answer.loading ? null : answer.error} testID="partner-missing" />
      )}
    </Screen>
  );
}

export function PartnerBody({
  workspaceId,
  got,
  businessRateBp,
  hasTerms,
  origin,
  onChanged,
}: {
  workspaceId: string;
  got: PartnerGetOut;
  /** The business's share for partners, which they earn unless they have their own. */
  businessRateBp: number;
  /** Whether the business has terms for partners to accept. */
  hasTerms: boolean;
  /** Where the business's public links live: its own domain once it's serving, else HandsFreeOS's address. */
  origin: string;
  onChanged: () => void;
}) {
  const p = got.partner;
  const grants = useGrants();
  const canSendPage = holds(grants, 'records.write');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [ending, setEnding] = React.useState(false);
  const [rating, setRating] = React.useState(false);
  const [rateText, setRateText] = React.useState('');
  const calls = partnerCalls(workspaceId);

  async function act(key: string, run: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(key);
    try {
      await run();
      toast.show(done);
      onChanged();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const setStatus = (status: PartnerStatus) =>
    act(status, () => calls.update(p.partnerId, { status }), W.partner.statusSaved[status](p.name));

  const link = p.linkPath ? `${origin}${p.linkPath}` : null;
  const statusLine = W.partner.statusLine[p.status];
  const typedBp = parseRate(rateText);
  return (
    <>
      <Card className="gap-2 p-4" testID="partner-head">
        <View className="flex-row items-center gap-2">
          <Badge variant={badgeOf(p.status)} testID="partner-status">
            <Text>{W.status[p.status]}</Text>
          </Badge>
          <Text className="text-[13px] text-text-2">{W.partner.since(formatDate(p.addedAt))}</Text>
        </View>
        {statusLine ? (
          <Text className="text-[13px] leading-[18px] text-text-2" testID="partner-status-line">
            {statusLine(p.name)}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2 pt-1">
          {p.status === 'active' ? (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'paused'}
              onPress={() => void setStatus('paused')}
              testID="partner-pause"
            >
              {W.partner.pause}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'active'}
              onPress={() => void setStatus('active')}
              testID="partner-resume"
            >
              {W.partner.resume}
            </Button>
          )}
          {p.status === 'ended' ? null : (
            <Button
              variant="ghostDanger"
              size="sm"
              onPress={() => setEnding(true)}
              testID="partner-end"
            >
              {W.partner.end}
            </Button>
          )}
        </View>
      </Card>

      <List>
        <ListRow
          label={W.partner.share}
          detail={W.partner.shareHint(rateWords(businessRateBp))}
          end={p.ownRate ? W.list.ownShare(rateWords(p.rateBp)) : rateWords(p.rateBp)}
          onPress={() => {
            setRateText(String(p.rateBp / 100));
            setRating(true);
          }}
          testID="partner-rate"
        />
        <ListRow
          label={W.partner.openContact}
          onPress={() =>
            router.push(businessHref(workspaceId, `customers/people/${p.personId}`) as Href)
          }
          testID="partner-contact"
        />
      </List>

      <ListLabel>{W.partner.link}</ListLabel>
      <Card className="gap-2 p-4" testID="partner-link">
        {link && p.status !== 'ended' ? (
          <>
            <Text className="text-[13px] text-text-2">{W.partner.linkHint}</Text>
            <Text className="font-mono text-[12.5px]" numberOfLines={2} testID="partner-link-url">
              {link}
            </Text>
            <Button
              variant="secondary"
              icon={ShareIcon}
              onPress={() => void Share.share({ message: link, url: link })}
              testID="partner-share-link"
            >
              {W.phone.shareLink}
            </Button>
          </>
        ) : (
          <Text className="text-[13px] leading-[18px] text-text-2">
            {p.status === 'ended' ? W.partner.statusLine.ended(p.name) : W.partner.noLink}
          </Text>
        )}
        {hasTerms && p.status !== 'ended' ? (
          <Text
            className={cn(
              'text-[12.5px] leading-[18px]',
              p.termsAccepted ? 'text-text-3' : 'text-warning-text',
            )}
            testID="partner-terms"
          >
            {p.termsAccepted ? W.partner.termsAccepted : W.partner.termsWaiting}
          </Text>
        ) : null}
      </Card>

      <ListLabel>{W.partner.page}</ListLabel>
      <Card className="gap-2 p-4" testID="partner-page">
        <Text className="text-[13px] leading-[18px] text-text-2">{W.partner.pageHint}</Text>
        {p.email ? (
          <Button
            variant="secondary"
            disabled={!canSendPage}
            loading={busy === 'send'}
            onPress={() =>
              void act('send', () => calls.sendPage(p.personId), W.partner.sent(p.email!))
            }
            testID="partner-send-page"
          >
            {W.partner.send}
          </Button>
        ) : (
          <Text className="text-[13px] text-warning-text">{W.partner.noEmail(p.name)}</Text>
        )}
      </Card>

      <ListLabel>{W.partner.commissions.title}</ListLabel>
      <Totals earnings={p.earnings} testID="partner-earnings" />
      {got.commissions.length ? (
        <List testID="partner-commissions">
          {got.commissions.map((c) => (
            <CommissionRow key={c.commissionId} c={c} />
          ))}
        </List>
      ) : (
        <Text className="px-1 text-[13px] text-text-2">{W.partner.commissions.empty}</Text>
      )}

      <ListLabel>{P.partner.title}</ListLabel>
      <Text className="px-1 text-[13px] text-text-2" testID="partner-payouts-account">
        {got.payouts.account
          ? `${got.payouts.account.ready ? P.partner.ready : P.partner.needsMore} ${P.partner.bank(payoutCountryIn(got.payouts.account.country))}`
          : P.partner.noAccount}
      </Text>
      {got.payouts.lines.length ? (
        <List testID="partner-payout-lines">
          {got.payouts.lines.map((l) => (
            <ListRow
              key={l.lineId}
              label={P.history.month(l.month)}
              detail={payoutLineWords(l, formatDate)}
              end={money(l.amountCents)}
              chevron={false}
            />
          ))}
        </List>
      ) : null}

      <ListLabel>{W.partner.clients.title}</ListLabel>
      {got.clients.length ? (
        <List testID="partner-clients">
          {got.clients.map((c) => (
            <ListRow
              key={c.referralId}
              label={c.name}
              detail={[
                `${c.how === 'link' ? W.partner.clients.viaLink : W.partner.clients.byHand} · ${formatDate(c.referredAt)}`,
                c.monthsEndAt
                  ? W.partner.clients.until(formatDate(c.monthsEndAt))
                  : W.partner.clients.notYet,
              ].join('\n')}
              end={money(c.earnedCents)}
              onPress={
                c.personId
                  ? () =>
                      router.push(
                        businessHref(workspaceId, `customers/people/${c.personId}`) as Href,
                      )
                  : undefined
              }
            />
          ))}
        </List>
      ) : (
        <Text className="px-1 text-[13px] text-text-2">{W.partner.clients.empty}</Text>
      )}

      <Sheet
        open={rating}
        onClose={() => setRating(false)}
        title={W.partner.share}
        description={W.partner.shareHint(rateWords(businessRateBp))}
        testID="partner-rate-sheet"
      >
        <View className="gap-3 pt-2">
          <View className="flex-row items-center gap-2">
            <Input
              value={rateText}
              onChangeText={setRateText}
              keyboardType="decimal-pad"
              accessibilityLabel={W.partner.share}
              className="flex-1"
              testID="partner-rate-input"
            />
            <Text className="text-base text-text-2">%</Text>
          </View>
          {typedBp === null ? (
            <Text className="text-[12.5px] text-danger-text">{W.phone.rateBad}</Text>
          ) : null}
          <Button
            disabled={typedBp === null}
            loading={busy === 'rate'}
            onPress={async () => {
              if (typedBp === null) return;
              if (
                await act(
                  'rate',
                  () => calls.update(p.partnerId, { rateBp: typedBp }),
                  W.partner.shareSaved,
                )
              )
                setRating(false);
            }}
            testID="partner-rate-save"
          >
            {W.phone.rateSave}
          </Button>
          {p.ownRate ? (
            <Button
              variant="ghost"
              loading={busy === 'rate-default'}
              onPress={async () => {
                if (
                  await act(
                    'rate-default',
                    () => calls.update(p.partnerId, { rateBp: null }),
                    W.partner.shareSaved,
                  )
                )
                  setRating(false);
              }}
              testID="partner-rate-default"
            >
              {W.partner.useYours(rateWords(businessRateBp))}
            </Button>
          ) : null}
        </View>
      </Sheet>

      <Sheet
        open={ending}
        onClose={() => setEnding(false)}
        title={W.partner.endTitle(p.name)}
        description={W.partner.endBody}
        testID="partner-end-sheet"
      >
        <View className="gap-2 pt-2">
          <Button
            variant="danger"
            loading={busy === 'ended'}
            onPress={async () => {
              if (await setStatus('ended')) setEnding(false);
            }}
            testID="partner-end-confirm"
          >
            {W.partner.end}
          </Button>
          <Button variant="secondary" onPress={() => setEnding(false)}>
            {W.partner.endKeep}
          </Button>
        </View>
      </Sheet>
    </>
  );
}

function CommissionRow({ c }: { c: PartnerCommissionRow }) {
  const C = W.partner.commissions;
  const rate = rateWords(c.rateBp);
  const what = C.what(c.kind, rate, money(c.baseCents));
  const when = c.test
    ? C.test
    : c.held
      ? C.held
      : new Date(c.payableAt).getTime() > Date.now()
        ? C.freeOn(formatDate(c.payableAt))
        : C.free;
  return (
    <ListRow
      label={c.invoiceNumber ? `${c.clientName} · ${C.invoice(c.invoiceNumber)}` : c.clientName}
      detail={`${formatDate(c.earnedAt)} · ${what}\n${when}`}
      end={money(c.amountCents)}
      chevron={false}
      testID="partner-commission"
    />
  );
}

/** 12 → 1,200; "8.25" → 825; nonsense, nothing or more than 100% → null. */
export function parseRate(text: string): number | null {
  const t = text.trim().replace(/%$/, '').replace(',', '.');
  if (!/^\d*(?:\.\d{0,2})?$/.test(t) || t === '' || t === '.') return null;
  const bp = Math.round(Number(t) * 100);
  return bp >= 1 && bp <= 10_000 ? bp : null;
}
