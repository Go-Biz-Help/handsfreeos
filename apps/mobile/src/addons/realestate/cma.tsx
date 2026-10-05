import { fmtMonthDay } from '@hfos/core';
import type { CmaPage } from '@hfos/core/addons/realestate/cma';
import {
  compLine,
  milesWords,
  RE_BUYER_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-buyer';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { cmaOfCopy } from '@hfos/core/addons/realestate/views/cma';
import * as React from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { findComps, requestCmaSummary } from './buyer-actions';
import {
  attempt,
  DealNotHere,
  GroupLabel,
  SignalNote,
  SummaryHead,
  useBuyerDeal,
} from './buyer-kit';
import { NeedsSignalCard, reHref, SignalButton, useLiveAnswer } from './kit';

/**
 * A CMA (board 84, fourth panel): the suggested range from the comps it counts, and each comp with when it sold, for
 * how much and how far away. It reads with no signal; finding comps on the MLS and the AI's summary need signal.
 */

export function CmaScreen({ dealId, cmaId }: { dealId: string; cmaId: string }) {
  const { ctx, copy, deal } = useBuyerDeal(dealId);
  const kept = React.useMemo(() => cmaOfCopy(copy, cmaId, ctx)?.cma ?? null, [copy, cmaId, ctx]);
  const full = deal?.full ?? false;
  const live = useLiveAnswer(
    deal && !kept
      ? () =>
          api
            .POST('/v1/queries/realestate.cma', { body: { workspaceId: ctx.workspaceId, cmaId } })
            .then(unwrap)
      : null,
    `cma:${cmaId}`,
    RE_PHONE_WORDS.summaryNeedsSignal(W.cma),
  );
  if (!deal) return <DealNotHere title={W.cmaTitle} workspaceId={ctx.workspaceId} />;
  const cma: CmaPage | null = kept ?? live.data?.cma ?? null;
  return (
    <Screen
      title={W.cmaTitle}
      subtitle={
        cma ? W.cmaSub(deal.name, fmtMonthDay(cma.asOf, Number(ctx.today.slice(0, 4)))) : deal.name
      }
      leading="back"
      back={reHref(ctx.workspaceId, `deals/${dealId}`)}
      testID="re-cma"
    >
      {!full ? <SummaryHead /> : null}
      {cma ? (
        <CmaBody workspaceId={ctx.workspaceId} cma={cma} today={ctx.today} editable={full} />
      ) : live.error ? (
        <NeedsSignalCard words={full ? W.cmaGone : live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

export function CmaBody({
  workspaceId,
  cma,
  today,
  editable,
}: {
  workspaceId: string;
  cma: CmaPage;
  today: string;
  editable: boolean;
}) {
  const counted = cma.comps.filter((c) => c.counted);
  const fromMls = cma.comps.find((c) => c.mls)?.mls ?? null;
  const allMls = counted.length > 0 && counted.every((c) => c.source === 'mls');
  const draft = cma.status === 'draft';
  return (
    <View className="gap-3" testID="re-cma-body">
      <Card className="gap-1.5 p-3.5">
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text className="text-[16px] font-semibold">{W.suggestedRange}</Text>
          {cma.range ? (
            <Badge variant="ok" testID="re-cma-from">
              {W.fromComps(cma.range.counted, allMls)}
            </Badge>
          ) : null}
        </View>
        {cma.range ? (
          <>
            <Text className="text-[20px] font-bold tracking-[-0.2px]" testID="re-cma-range">
              {W.rangeShort(cma.range.lowCents, cma.range.highCents)}
            </Text>
            <Text className="text-[13px] text-text-2">{W.mostLikely(cma.range.likelyCents)}</Text>
          </>
        ) : (
          <Text className="text-[14px] leading-[20px] text-text-2" testID="re-cma-missing">
            {cma.missing ?? W.noRange}
          </Text>
        )}
      </Card>
      {cma.comps.length ? (
        <>
          <GroupLabel>{W.comps}</GroupLabel>
          <Card>
            {cma.comps.map((c, i) => (
              <View
                key={c.id}
                className={cn(
                  'flex-row items-center gap-3 px-3.5 py-3',
                  i > 0 && 'border-t border-border',
                  !c.counted && 'opacity-60',
                )}
                testID={`re-comp-${c.id}`}
              >
                <View className="min-w-0 flex-1 gap-px">
                  <Text className="text-base">{c.address.split(',')[0]}</Text>
                  <Text className="text-[13px] leading-[18px] text-text-3">
                    {compLine(c, today)}
                  </Text>
                  {!c.counted ? (
                    <Text className="text-[12.5px] leading-[17px] text-text-3">
                      {[W.notCounted, c.why].filter(Boolean).join(': ')}
                    </Text>
                  ) : null}
                </View>
                {c.distanceMiles !== null ? (
                  <Text className="text-sm text-text-2">{milesWords(c.distanceMiles)}</Text>
                ) : null}
              </View>
            ))}
          </Card>
        </>
      ) : null}
      {fromMls ? (
        <Text className="px-1 text-[12px] leading-[16px] text-text-3" testID="re-cma-source">
          {W.soldVia(fromMls.sourceWords)}
        </Text>
      ) : null}
      {cma.findComps.words ? (
        <Text className="px-1 text-[13px] leading-[18px] text-text-2">{cma.findComps.words}</Text>
      ) : null}
      {cma.summary.text ? (
        <>
          <GroupLabel>{W.cmaSummary}</GroupLabel>
          <Card className="gap-2 p-3.5">
            <Text className="text-[14.5px] leading-[21px]">{cma.summary.text}</Text>
            {cma.summary.unsupportedAmounts.length ? (
              <Text className="text-[13px] leading-[18px] text-warning-text">
                {W.unsupported(cma.summary.unsupportedAmounts)}
              </Text>
            ) : null}
          </Card>
        </>
      ) : cma.summary.failure ? (
        <Text className="px-1 text-[13px] leading-[18px] text-text-2">{cma.summary.failure}</Text>
      ) : null}
      {editable && draft ? (
        <View className="gap-2">
          {cma.findComps.state !== 'finding' ? (
            <SignalButton
              variant="secondary"
              label={W.findComps}
              onPress={() => void attempt(() => findComps(workspaceId, cma.id), W.asked)}
              testID="re-cma-find"
            />
          ) : null}
          {cma.summary.state !== 'drafting' && cma.range ? (
            <SignalButton
              variant="secondary"
              label={W.writeSummary}
              onPress={() => void attempt(() => requestCmaSummary(workspaceId, cma.id), W.asked)}
              testID="re-cma-summary"
            />
          ) : null}
        </View>
      ) : null}
      <SignalNote words={W.cmaSignal} testID="re-cma-signal" />
    </View>
  );
}
