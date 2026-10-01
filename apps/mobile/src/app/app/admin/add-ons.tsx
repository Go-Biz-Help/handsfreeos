import {
  ADDON_CATEGORY_WORDS,
  ADDON_PICK_HOW_WORDS,
  ADDON_RACE_SHOWN,
  ADDON_VOTES_WORDS,
  addonPickDay,
  addonVotesCount,
  addonWeekChoices,
  addonWeekResult,
  deskCountHeading,
  deskSectionLabel,
  filterAddonRace,
  type AddonCategory,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { desk, useLive, type Ok } from '@/admin/live';
import { DeskWaiting, PickSheet, SearchBox, Section } from '@/components/admin/bits';
import { OnlyAdmins, Row } from '@/components/admin/money-desk-bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { ChevronDown } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useColors } from '@/theme';

type Overview = Ok<'/v1/queries/addon_pick.overview'>;
type Waiting = Overview['waiting'][number];

/**
 * Add-on votes (the web's /admin/add-ons, 0109): the weeks that closed with nothing voted for or a tie, waiting for
 * one of us to choose; what's coming soon; every planned add-on by votes; and how the last weeks closed. The one
 * change here is choosing a week's pick, and the businesses that voted for it are told, as for a winner. For support
 * admins (`platform.addons.manage`).
 */
export default function AddonVotes() {
  const can = useDeskCan('platform.addons.manage');
  return can ? <Votes /> : <OnlyAdmins section="add-ons" />;
}

function Votes() {
  const colors = useColors();
  const live = useLive(() => desk('/v1/queries/addon_pick.overview', {}), 'addon-votes');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<Record<string, string>>({});
  // The week whose pick is being chosen; kept while its sheet slides away.
  const [picking, setPicking] = React.useState<Waiting | null>(null);
  const [pickOpen, setPickOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [all, setAll] = React.useState(false);

  const overview = live.data;
  const names = React.useMemo(
    () => new Map((overview?.race ?? []).map((r) => [r.addonId, r] as const)),
    [overview],
  );
  const nameOf = (id: string) => names.get(id)?.name ?? id;

  const choose = async (weekId: string, addonId: string) => {
    setBusy(weekId);
    try {
      await desk('/v1/commands/addon_pick.choose', { weekId, addonId });
      toast.show(ADDON_VOTES_WORDS.chosen(nameOf(addonId)));
      live.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const title = deskSectionLabel('add-ons');
  if (!overview)
    return (
      <Screen title={title} leading="back" back={deskHref()} scroll={false} testID="desk-add-ons">
        <DeskWaiting live={live} testID="addon-votes" />
      </Screen>
    );

  const race = filterAddonRace(overview.race, typed);
  const searching = typed.trim() !== '';
  const shown = all || searching ? race : race.slice(0, ADDON_RACE_SHOWN);
  const pickOf = (w: Waiting) => chosen[w.weekId] ?? addonWeekChoices(w, overview.race)[0] ?? '';

  return (
    <Screen title={title} leading="back" back={deskHref()} scroll={false} testID="desk-add-ons">
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
        <Text className="px-1 text-[13.5px] leading-[20px] text-text-2" testID="addon-votes-intro">
          {ADDON_VOTES_WORDS.intro} {ADDON_VOTES_WORDS.nextPick}{' '}
          <Text className="text-[13.5px] font-medium text-text">
            {ADDON_VOTES_WORDS.nextPickAt(overview.nextPickAt)}
          </Text>
          .
        </Text>

        <Section
          title={deskCountHeading(ADDON_VOTES_WORDS.waiting, overview.waiting.length)}
          testID="addon-waiting"
        >
          {overview.waiting.length === 0 ? (
            <Text className="text-[13.5px] text-text-3" testID="addon-picks-none-waiting">
              {ADDON_VOTES_WORDS.noneWaiting}
            </Text>
          ) : (
            overview.waiting.map((w, i) => {
              const pick = pickOf(w);
              const votes = names.get(pick)?.votes;
              return (
                <Row
                  key={w.weekId}
                  first={i === 0}
                  className="gap-2"
                  testID={`addon-week-${w.weekId}`}
                >
                  <Text className="text-[14.5px] font-semibold">
                    {ADDON_VOTES_WORDS.weekEnding(w.endsAt)}
                  </Text>
                  <Text className="text-[13.5px] leading-[19px] text-text-2">
                    {w.outcome === 'tie'
                      ? ADDON_VOTES_WORDS.tie(w.tied.map(nameOf), w.topVotes)
                      : ADDON_VOTES_WORDS.noVotes}
                  </Text>
                  <Pressable
                    role="button"
                    accessibilityLabel={`${ADDON_VOTES_WORDS.choiceLabel}. ${pick ? nameOf(pick) : ''}`}
                    onPress={() => {
                      setPicking(w);
                      setPickOpen(true);
                    }}
                    disabled={busy !== null}
                    className="min-h-11 flex-row items-center gap-2 rounded-menu border border-border-strong bg-card px-3.5 active:bg-card-2"
                    testID={`addon-week-choice-${w.weekId}`}
                  >
                    <Text className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>
                      {pick ? nameOf(pick) : ''}
                      {votes !== undefined ? (
                        <Text className="text-[13.5px] text-text-3">
                          {` (${addonVotesCount(votes)})`}
                        </Text>
                      ) : null}
                    </Text>
                    <Icon as={ChevronDown} className="size-4 text-text-3" />
                  </Pressable>
                  <Button
                    size="md"
                    loading={busy === w.weekId}
                    disabled={!pick || busy !== null}
                    onPress={() => void choose(w.weekId, pick)}
                    testID={`addon-week-choose-${w.weekId}`}
                  >
                    {ADDON_VOTES_WORDS.choose}
                  </Button>
                </Row>
              );
            })
          )}
        </Section>

        <Section
          title={deskCountHeading(ADDON_VOTES_WORDS.comingSoon, overview.comingSoon.length, true)}
          testID="addon-coming-soon"
        >
          {overview.comingSoon.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{ADDON_VOTES_WORDS.nothingPicked}</Text>
          ) : (
            overview.comingSoon.map((c, i) => (
              <Row key={c.addonId} first={i === 0} testID={`addon-soon-${c.addonId}`}>
                <View className="flex-row items-center gap-2">
                  <Text className="min-w-0 flex-1 text-[14.5px] font-semibold" numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Badge variant={c.how === 'votes' ? 'accent' : 'gray'}>
                    {ADDON_PICK_HOW_WORDS[c.how]}
                  </Badge>
                </View>
                <Text className="text-[13px] tabular-nums text-text-3">
                  {ADDON_VOTES_WORDS.picked(c.votes, c.pickedAt)}
                </Text>
              </Row>
            ))
          )}
        </Section>

        <Section
          title={deskCountHeading(ADDON_VOTES_WORDS.race, overview.race.length, true)}
          testID="addon-race"
        >
          <SearchBox
            value={typed}
            onChange={setTyped}
            placeholder={ADDON_VOTES_WORDS.find}
            testID="addon-race-search"
          />
          {shown.map((r, i) => (
            <Row
              key={r.addonId}
              first={i === 0}
              className="flex-row items-center gap-3"
              testID={`addon-race-${r.addonId}`}
            >
              <View className="min-w-0 flex-1 gap-px">
                <Text className="text-[14.5px]" numberOfLines={1}>
                  {r.name}
                </Text>
                <Text className="text-[12.5px] text-text-3">
                  {ADDON_CATEGORY_WORDS[r.category as AddonCategory] ?? r.category}
                </Text>
              </View>
              <Text
                className="text-[14.5px] tabular-nums"
                accessibilityLabel={addonVotesCount(r.votes)}
              >
                {r.votes}
              </Text>
            </Row>
          ))}
          {!all && !searching && race.length > ADDON_RACE_SHOWN ? (
            <Button variant="ghost" size="md" onPress={() => setAll(true)} testID="addon-race-all">
              {ADDON_VOTES_WORDS.showAll(race.length)}
            </Button>
          ) : null}
        </Section>

        <Section title={ADDON_VOTES_WORDS.recentWeeks} testID="addon-weeks">
          {overview.weeks.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{ADDON_VOTES_WORDS.noWeeks}</Text>
          ) : (
            overview.weeks.map((w, i) => {
              const result = addonWeekResult(w);
              return (
                <Row key={w.weekId} first={i === 0} testID={`addon-closed-${w.weekId}`}>
                  <View className="flex-row items-baseline gap-2">
                    <Text className="min-w-0 flex-1 text-[14.5px]" numberOfLines={1}>
                      {result.what}
                    </Text>
                    <Text className="text-[13px] text-text-2">{addonPickDay(w.endsAt)}</Text>
                  </View>
                  {result.how ? (
                    <Text className="text-[13px] text-text-3">{result.how}</Text>
                  ) : null}
                </Row>
              );
            })
          )}
        </Section>
      </ScrollView>

      <PickSheet<string>
        open={pickOpen}
        onClose={() => setPickOpen(false)}
        title={ADDON_VOTES_WORDS.choiceLabel}
        value={picking ? pickOf(picking) : ''}
        options={(picking ? addonWeekChoices(picking, overview.race) : []).map((id) => {
          const r = names.get(id);
          return {
            value: id,
            label: nameOf(id),
            detail: r ? addonVotesCount(r.votes) : undefined,
          };
        })}
        onPick={(addonId) => {
          if (picking) setChosen((c) => ({ ...c, [picking.weekId]: addonId }));
        }}
        testID="addon-pick"
      />
    </Screen>
  );
}
