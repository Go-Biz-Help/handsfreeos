import {
  AFFILIATE_ADMIN_WORDS,
  AFFILIATE_STATUS_WORDS,
  affiliateLink,
  affiliatePercentToBp,
  affiliateRateWords,
  deskCountHeading,
  money,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, Share, View } from 'react-native';

import { desk, useLive, type Ok } from '@/admin/live';
import { DESK_PHONE_WORDS } from '@/admin/words';
import { DeskWaiting, Line, Section } from '@/components/admin/bits';
import { OnlyAdmins, Row } from '@/components/admin/money-desk-bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useColors } from '@/theme';

const W = AFFILIATE_ADMIN_WORDS;

type Program = Ok<'/v1/queries/platform.affiliates'>;
type Affiliate = Program['affiliates'][number];

const BADGE: Readonly<Record<Affiliate['status'], 'pending' | 'ok' | 'gray'>> = {
  applied: 'pending',
  approved: 'ok',
  turned_down: 'gray',
  paused: 'pending',
  ended: 'gray',
};

/**
 * Affiliates (the web's /admin/affiliates, 20261027014000): the share everyone earns, the applications waiting, and
 * every affiliate. For support admins (`platform.affiliates.manage`).
 *
 * Approving turns their link on and emails it to them; turning down asks first, since it emails them too. Tapping an
 * affiliate opens their share, Pause and End. Each row says what they've earned (20261027014200); their link code, the
 * businesses they sent and each share earned are on the web's page for them, where there's room for the lists.
 */
export default function Affiliates() {
  const can = useDeskCan('platform.affiliates.manage');
  return can ? <AffiliatesDesk /> : <OnlyAdmins section="affiliates" />;
}

function AffiliatesDesk() {
  const colors = useColors();
  const live = useLive(() => desk('/v1/queries/platform.affiliates', {}), 'affiliates');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [rate, setRate] = React.useState<string | null>(null);
  // The application being turned down and the affiliate open in the sheet; each kept while its sheet slides away.
  const [turningDown, setTurningDown] = React.useState<Affiliate | null>(null);
  const [turnDownOpen, setTurnDownOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<Affiliate | null>(null);
  const [pickedOpen, setPickedOpen] = React.useState(false);

  /** One change, then the program asked for again; the database's own sentence when it refuses. */
  const run = async (what: string, fn: () => Promise<unknown>, said: string) => {
    setBusy(what);
    try {
      await fn();
      toast.show(said);
      live.reload();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const program = live.data;
  if (!program)
    return (
      <Screen
        title={W.title}
        leading="back"
        back={deskHref()}
        scroll={false}
        testID="desk-affiliates"
      >
        <DeskWaiting live={live} testID="affiliates" />
      </Screen>
    );

  const typed = rate ?? String(program.settings.rateBp / 100);
  const saveRate = () => {
    const rateBp = affiliatePercentToBp(typed);
    if (rateBp === null) return toast.error(W.percentProblem);
    void run('rate', () => desk('/v1/commands/affiliates.save_settings', { rateBp }), W.saved).then(
      (ok) => ok && setRate(null),
    );
  };

  return (
    <Screen
      title={W.title}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-affiliates"
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={live.refreshing}
            onRefresh={live.reload}
            tintColor={colors.accent}
          />
        }
      >
        <Text className="px-1 text-[13px] leading-[19px] text-text-3">{W.intro}</Text>

        <Section title={W.everyone} detail={W.everyoneHelp} testID="affiliates-everyone">
          <View className="flex-row items-end gap-2">
            <View className="w-28 gap-1.5">
              <Label>{W.percent}</Label>
              <Input
                value={typed}
                onChangeText={setRate}
                keyboardType="decimal-pad"
                accessibilityLabel={W.percent}
                testID="affiliates-rate"
              />
            </View>
            <Button
              variant="secondary"
              loading={busy === 'rate'}
              disabled={busy !== null || affiliatePercentToBp(typed) === program.settings.rateBp}
              onPress={saveRate}
              testID="affiliates-rate-save"
            >
              {W.save}
            </Button>
          </View>
        </Section>

        <Section
          title={deskCountHeading(W.waiting, program.applications.length)}
          testID="affiliates-applications"
        >
          {program.applications.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{W.noneWaiting}</Text>
          ) : (
            program.applications.map((a, i) => (
              <Row
                key={a.affiliateId}
                first={i === 0}
                className="gap-2"
                testID={`affiliate-application-${a.code}`}
              >
                <View className="gap-0.5">
                  <Text className="text-[14.5px] font-semibold">{a.name}</Text>
                  <Text selectable className="text-[13px] text-text-3">
                    {a.email}
                  </Text>
                  <Text className="text-[13px] text-text-3">{W.wantsCode(a.code)}</Text>
                </View>
                {/* Their own words, in full: they're what the decision rests on. */}
                {a.pitch ? (
                  <Text
                    selectable
                    className="rounded-[10px] bg-card-2 px-3 py-2 text-[13.5px] leading-[19px] text-text-2"
                  >
                    {a.pitch}
                  </Text>
                ) : null}
                {a.links ? (
                  <Text selectable className="text-[13px] leading-[18px] text-text-3">
                    {a.links}
                  </Text>
                ) : null}
                <View className="flex-row gap-2">
                  <Button
                    size="md"
                    className="flex-1"
                    loading={busy === `approve:${a.affiliateId}`}
                    disabled={busy !== null}
                    onPress={() =>
                      void run(
                        `approve:${a.affiliateId}`,
                        () =>
                          desk('/v1/commands/affiliate.decide', {
                            affiliateId: a.affiliateId,
                            decision: 'approve',
                          }),
                        AFFILIATE_STATUS_WORDS.approved,
                      )
                    }
                    testID={`affiliate-approve-${a.code}`}
                  >
                    {W.approve}
                  </Button>
                  <Button
                    size="md"
                    variant="secondary"
                    className="flex-1"
                    disabled={busy !== null}
                    onPress={() => {
                      setTurningDown(a);
                      setTurnDownOpen(true);
                    }}
                    testID={`affiliate-turn-down-${a.code}`}
                  >
                    {W.turnDown}
                  </Button>
                </View>
              </Row>
            ))
          )}
        </Section>

        <Section
          title={deskCountHeading(W.affiliates, program.affiliates.length)}
          testID="affiliates-list"
        >
          {program.affiliates.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{W.noneYet}</Text>
          ) : (
            program.affiliates.map((a, i) => (
              <Row key={a.affiliateId} first={i === 0}>
                <Pressable
                  onPress={() => {
                    setPicked(a);
                    setPickedOpen(true);
                  }}
                  accessibilityRole="button"
                  className="gap-1 active:opacity-70"
                  testID={`affiliate-${a.code}`}
                >
                  <View className="flex-row items-center gap-2">
                    <Text className="min-w-0 flex-1 text-[14.5px] font-semibold" numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Badge variant={BADGE[a.status]}>
                      <Text>{AFFILIATE_STATUS_WORDS[a.status]}</Text>
                    </Badge>
                  </View>
                  <Text className="text-[13px] text-text-3" numberOfLines={1}>
                    {affiliateLink(a.code)}
                  </Text>
                  <Text className="text-[13px] text-text-2">
                    {affiliateRateWords(a.rateBp)}
                    {a.ownRateBp !== null ? ` (${W.ownShare.toLowerCase()})` : ''} ·{' '}
                    {W.businessCount(a.businesses)}
                    {a.earnedCents ? ` · ${W.businessEarned(money(a.earnedCents))}` : ''}
                  </Text>
                  <Text className="text-[13px] text-text-3">
                    {W.clicks(a.clicks30, a.clicksAll)}
                  </Text>
                </Pressable>
              </Row>
            ))
          )}
        </Section>
      </ScrollView>

      <Sheet
        open={turnDownOpen}
        onClose={() => setTurnDownOpen(false)}
        title={turningDown ? W.turnDownTitle(turningDown.name) : undefined}
        description={W.turnDownBody}
        testID="affiliate-turn-down-sheet"
      >
        <View className="mt-4 gap-3">
          <Button
            variant="danger"
            loading={turningDown !== null && busy === `turn_down:${turningDown.affiliateId}`}
            onPress={() =>
              turningDown &&
              void run(
                `turn_down:${turningDown.affiliateId}`,
                () =>
                  desk('/v1/commands/affiliate.decide', {
                    affiliateId: turningDown.affiliateId,
                    decision: 'turn_down',
                  }),
                AFFILIATE_STATUS_WORDS.turned_down,
              ).then((ok) => ok && setTurnDownOpen(false))
            }
            testID="affiliate-turn-down-confirm"
          >
            {W.turnDown}
          </Button>
          <Button variant="secondary" onPress={() => setTurnDownOpen(false)}>
            {DESK_PHONE_WORDS.cancel}
          </Button>
        </View>
      </Sheet>

      <Sheet
        open={pickedOpen}
        onClose={() => setPickedOpen(false)}
        title={picked?.name}
        description={picked ? AFFILIATE_STATUS_WORDS[picked.status] : undefined}
        testID="affiliate-sheet"
      >
        {picked ? (
          <AffiliateForm
            key={picked.affiliateId}
            affiliate={picked}
            everyoneBp={program.settings.rateBp}
            busy={busy}
            run={run}
            onDone={() => setPickedOpen(false)}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** One affiliate: their link to share, their own share, and Pause, Bring back or End, each End asked twice. */
function AffiliateForm({
  affiliate: a,
  everyoneBp,
  busy,
  run,
  onDone,
}: {
  affiliate: Affiliate;
  everyoneBp: number;
  busy: string | null;
  run: (what: string, fn: () => Promise<unknown>, said: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [rate, setRate] = React.useState(a.ownRateBp === null ? '' : String(a.ownRateBp / 100));
  const [problem, setProblem] = React.useState<string | null>(null);
  const [asking, setAsking] = React.useState<'paused' | 'ended' | null>(null);
  const link = affiliateLink(a.code);

  const saveRate = (rateBp: number | null) =>
    void run(
      'own-rate',
      () => desk('/v1/commands/affiliate.set_rate', { affiliateId: a.affiliateId, rateBp }),
      W.saved,
    ).then((ok) => ok && onDone());

  const setStatus = (status: 'approved' | 'paused' | 'ended') =>
    void run(
      'status',
      () => desk('/v1/commands/affiliate.set_status', { affiliateId: a.affiliateId, status }),
      AFFILIATE_STATUS_WORDS[status],
    ).then((ok) => ok && onDone());

  if (asking)
    return (
      <View className="mt-4 gap-3">
        <Text className="text-[15px] font-semibold">
          {asking === 'ended' ? W.endTitle(a.name) : W.pauseTitle(a.name)}
        </Text>
        <Text className="text-[14px] leading-[20px] text-text-2">
          {asking === 'ended' ? W.endBody : W.pauseBody}
        </Text>
        <Button
          variant={asking === 'ended' ? 'danger' : 'primary'}
          loading={busy === 'status'}
          onPress={() => setStatus(asking)}
          testID="affiliate-status-confirm"
        >
          {asking === 'ended' ? W.end : W.pause}
        </Button>
        <Button variant="secondary" onPress={() => setAsking(null)}>
          {DESK_PHONE_WORDS.cancel}
        </Button>
      </View>
    );

  const decided = a.status !== 'applied' && a.status !== 'turned_down';
  return (
    <View className="mt-4 gap-4" style={keyboard ? { paddingBottom: keyboard } : undefined}>
      <View className="gap-1.5">
        <Line label={W.link} value={a.code} />
        <Button
          variant="secondary"
          size="md"
          onPress={() => void Share.share({ message: link, url: link })}
        >
          {link}
        </Button>
      </View>

      <View className="gap-1.5">
        <Text className="text-[13.5px] text-text-2" testID="affiliate-share">
          {a.ownRateBp === null
            ? W.everyones(affiliateRateWords(everyoneBp))
            : `${W.ownShare}: ${affiliateRateWords(a.ownRateBp)}`}
        </Text>
        <Label>{W.setOwn}</Label>
        <View className="flex-row gap-2">
          <Input
            className="w-28"
            value={rate}
            onChangeText={setRate}
            placeholder={String(everyoneBp / 100)}
            keyboardType="decimal-pad"
            accessibilityLabel={W.setOwn}
            testID="affiliate-own-rate"
          />
          <Button
            variant="secondary"
            loading={busy === 'own-rate'}
            disabled={busy !== null}
            onPress={() => {
              const rateBp = affiliatePercentToBp(rate);
              if (rateBp === null) return setProblem(W.percentProblem);
              setProblem(null);
              saveRate(rateBp);
            }}
          >
            {W.save}
          </Button>
        </View>
        {a.ownRateBp !== null ? (
          <Button variant="ghost" size="md" disabled={busy !== null} onPress={() => saveRate(null)}>
            {W.useEveryones}
          </Button>
        ) : null}
        {problem ? <FieldError>{problem}</FieldError> : null}
      </View>

      {decided && a.status !== 'ended' ? (
        <View className="gap-2 border-t border-border pt-4">
          {a.status === 'paused' ? (
            <Button
              variant="secondary"
              loading={busy === 'status'}
              onPress={() => setStatus('approved')}
              testID="affiliate-resume"
            >
              {W.resume}
            </Button>
          ) : (
            <Button
              variant="secondary"
              onPress={() => setAsking('paused')}
              testID="affiliate-pause"
            >
              {W.pause}
            </Button>
          )}
          <Button variant="dangerOutline" onPress={() => setAsking('ended')} testID="affiliate-end">
            {W.end}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
