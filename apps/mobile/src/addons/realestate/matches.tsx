import { money } from '@hfos/core';
import {
  matchTag,
  newMatchesLabel,
  roomsLine,
  street,
  RE_BUYER_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-buyer';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { matchesOfCopy, type MatchesView } from '@hfos/core/addons/realestate/views/buyer';
import {
  suggestionsOfCopy,
  type SuggestionsView,
} from '@hfos/core/addons/realestate/views/suggestions';
import * as React from 'react';
import { View } from 'react-native';

import { MessageCircle } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';

import { addSuggestion, dismissMatch, notAFit, sendMatch } from './buyer-actions';
import {
  attempt,
  DealNotHere,
  GroupLabel,
  MlsPhoto,
  SignalNote,
  SummaryHead,
  useBuyerDeal,
  type BuyerDeal,
} from './buyer-kit';
import { NeedsSignalCard, reHref, SignalButton, useLiveAnswer } from './kit';

/**
 * New matches (board 82, fourth panel): homes the buyer's saved search found on the MLS, for the agent to send to the
 * client's portal with its MLS credit, or keep from them. Sending reaches the client, so with no signal it waits and
 * asks again after 30 minutes; keeping one back waits as long as it takes. Under them, our own listings that fit,
 * which need signal to add.
 */

type Match = MatchesView['matches'][number];
type Suggestion = SuggestionsView['suggestions'][number];

export function MatchesScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal } = useBuyerDeal(dealId);
  const kept = React.useMemo(
    () => ({
      matches: matchesOfCopy(copy, dealId, {}, ctx),
      suggestions: suggestionsOfCopy(copy, dealId, ctx),
    }),
    [copy, dealId, ctx],
  );
  const full = deal?.full ?? false;
  const live = useLiveAnswer(
    deal && !full && deal.side === 'buyer'
      ? () =>
          api
            .POST('/v1/queries/realestate.matches', {
              body: { workspaceId: ctx.workspaceId, dealId },
            })
            .then(unwrap)
      : null,
    `matches:${dealId}`,
    RE_PHONE_WORDS.summaryNeedsSignal(W.matches),
  );
  if (!deal) return <DealNotHere title={W.matchesTitle} workspaceId={ctx.workspaceId} />;
  const view = full ? kept.matches : live.data;
  return (
    <Screen
      title={W.matchesTitle}
      subtitle={deal.name}
      leading="back"
      back={reHref(ctx.workspaceId, `deals/${dealId}/buyer`)}
      testID="re-matches"
    >
      {!full ? <SummaryHead /> : null}
      {deal.side !== 'buyer' ? (
        <NeedsSignalCard words={W.buyersOnly} />
      ) : view ? (
        <MatchesBody
          workspaceId={ctx.workspaceId}
          userId={ctx.userId}
          deal={deal}
          matches={view.matches}
          searchOn={view.search?.on ?? false}
          suggestions={full ? (kept.suggestions?.suggestions ?? []) : []}
          now={ctx.now}
          today={ctx.today}
          timeZone={ctx.timeZone}
          editable={full}
        />
      ) : live.error ? (
        <NeedsSignalCard words={live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

export function MatchesBody({
  workspaceId,
  userId,
  deal,
  matches,
  searchOn,
  suggestions,
  now,
  today,
  timeZone,
  editable,
}: {
  workspaceId: string;
  userId: string;
  deal: BuyerDeal;
  matches: readonly Match[];
  searchOn: boolean;
  suggestions: readonly Suggestion[];
  now: number;
  today: string;
  timeZone: string;
  editable: boolean;
}) {
  const fresh = matches.filter((m) => m.state === 'new');
  const sent = matches.filter((m) => m.state === 'sent');
  const skipped = matches.filter((m) => m.state === 'dismissed');
  const ours = suggestions.filter((s) => s.state === 'new');
  const who = deal.who;
  return (
    <View className="gap-3" testID="re-matches-body">
      {fresh.length ? (
        <>
          <GroupLabel count={fresh.length}>{newMatchesLabel(fresh, today, timeZone)}</GroupLabel>
          {fresh.map((m) => (
            <View key={m.id} className="gap-2">
              <MatchCard match={m} tag={matchTag(m, now, today, timeZone)} />
              {editable ? (
                <View className="flex-row gap-2">
                  <Button
                    className="flex-1"
                    icon={MessageCircle}
                    onPress={() =>
                      void attempt(() => sendMatch(workspaceId, m.id, userId), W.sentWaits(who))
                    }
                    testID={`re-match-send-${m.id}`}
                  >
                    {W.sendTo(who)}
                  </Button>
                  <Button
                    className="flex-1"
                    variant="secondary"
                    onPress={() =>
                      void attempt(() => dismissMatch(workspaceId, m.id, userId), W.dismissed(who))
                    }
                    testID={`re-match-skip-${m.id}`}
                  >
                    {W.notFor(who)}
                  </Button>
                </View>
              ) : null}
            </View>
          ))}
          {editable ? <SignalNote words={W.sendNote(who)} testID="re-matches-note" /> : null}
        </>
      ) : (
        <Card className="px-4 py-5">
          <Text className="text-[14.5px] leading-[21px] text-text-2" testID="re-matches-none">
            {W.noMatches(who, searchOn)}
          </Text>
        </Card>
      )}
      {ours.length ? (
        <>
          <GroupLabel count={ours.length}>{W.ourListings}</GroupLabel>
          {ours.map((s) => (
            <Card key={s.id} className="gap-2 p-3" testID={`re-suggestion-${s.id}`}>
              <Text className="text-base font-semibold">{street(s.address)}</Text>
              <Text className="text-[13px] text-text-2">
                {[
                  s.priceCents !== null ? money(s.priceCents) : null,
                  roomsLine(s.facts as { beds?: number; baths?: number; sqft?: number }) || null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {editable ? (
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <SignalButton
                      label={W.addToHomes}
                      onPress={() =>
                        void attempt(() => addSuggestion(workspaceId, s.id), W.suggestionAdded(who))
                      }
                      testID={`re-suggestion-add-${s.id}`}
                    />
                  </View>
                  <View className="flex-1">
                    <SignalButton
                      variant="secondary"
                      label={W.notAFit}
                      onPress={() => void attempt(() => notAFit(workspaceId, s.id))}
                      testID={`re-suggestion-skip-${s.id}`}
                    />
                  </View>
                </View>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}
      {sent.length ? <Decided label={W.sentLabel} matches={sent} /> : null}
      {skipped.length ? <Decided label={W.skippedLabel} matches={skipped} /> : null}
    </View>
  );
}

export function MatchCard({ match, tag }: { match: Match; tag: string | null }) {
  const price =
    match.mls.status === 'sold' && match.mls.soldPriceCents !== null
      ? money(match.mls.soldPriceCents)
      : match.mls.listPriceCents !== null
        ? money(match.mls.listPriceCents)
        : null;
  return (
    <Card className="flex-row gap-3 p-3" testID={`re-match-${match.id}`}>
      <MlsPhoto url={match.mls.photos[0]?.url} className="h-[72px] w-[84px] rounded-control" />
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base font-semibold">{street(match.address)}</Text>
        <Text className="text-[13px] leading-[18px] text-text-2">
          {[price, roomsLine(match.mls.facts) || null].filter(Boolean).join(' · ')}
        </Text>
        {tag ? <Badge variant="accent">{tag}</Badge> : null}
        {match.mls.display.courtesy ? (
          <Text className="text-[12px] leading-[16px] text-text-3">
            {match.mls.display.courtesy}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

function Decided({ label, matches }: { label: string; matches: readonly Match[] }) {
  return (
    <>
      <GroupLabel count={matches.length}>{label}</GroupLabel>
      <Card>
        {matches.map((m, i) => (
          <View key={m.id} className={i > 0 ? 'border-t border-border px-3.5 py-3' : 'px-3.5 py-3'}>
            <Text className="text-[14.5px]">{street(m.address)}</Text>
            {m.decidedBy ? (
              <Text className="text-[12.5px] text-text-3">{m.decidedBy.fullName}</Text>
            ) : null}
          </View>
        ))}
      </Card>
    </>
  );
}
