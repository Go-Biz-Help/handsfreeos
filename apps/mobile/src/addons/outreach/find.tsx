import {
  FIND_PAGE_WORDS as F,
  FIND_WAY_KEYS,
  FIND_WAYS,
  findWayCounts,
  findWayLine,
  type FindWay,
} from '@hfos/core/addons/outreach/find-page';
import type { FindsWeekOutput } from '@hfos/core/addons/outreach/finds';
import { PLATFORMS, WORKING_PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { OUTREACH_PAGES } from '@hfos/core/addons/outreach/pages';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, errorMessage, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import {
  NeedsSignal,
  Note,
  openOutreach,
  useOutreachAnswer,
  useOutreachContext,
  type OutreachTab,
} from './kit';
import { LikeYoursSection, type LikeYoursProps } from './like-yours';
import { NetworkFilter } from './networks';

/**
 * Find people on the phone (decision 128), as the web's page: a card for each way Social Outreach finds new people
 * (`find-page.ts` in core), with what it found for the person in the last week and how many the AI called a good fit
 * (`outreach.finds.week`); Groups opens the groups, Searches the playbooks where their words are kept, Partners the
 * Partners list. Then the business's accounts like yours on Instagram (decision 110), added and removed here with
 * signal. Every network's ways, or one network's. It needs signal.
 */

const failed = (e: unknown) => (e instanceof ChangeError ? e.message : errorMessage(e));

export function FindScreen({ net: first = null }: { net?: Platform | null }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [net, setNet] = React.useState<Platform | null>(first);
  const week = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.finds.week', {
          body: { workspaceId: ws, ...(net ? { platform: net } : {}) },
        }),
      ),
    `finds-week:${ws}:${net ?? 'all'}`,
    OUTREACH_PAGES.find,
  );
  const likeYours = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.like_yours.list', { body: { workspaceId: ws } })),
    `like-yours:${ws}`,
    OUTREACH_PAGES.find,
  );
  return (
    <FindBody
      net={net}
      onNet={setNet}
      week={week.data}
      error={week.error}
      onRetry={week.reload}
      online={ctx.online}
      onOpen={(view, more) => openOutreach(ws, view, more)}
      likeYours={{
        list: likeYours.data,
        timeZone: ctx.timeZone,
        onAdd: async (account) => {
          try {
            await change('outreach.like_yours.add', { workspaceId: ws, account });
            likeYours.reload();
            return null;
          } catch (e) {
            return failed(e);
          }
        },
        onRemove: async (id) => {
          try {
            await change('outreach.like_yours.remove', { workspaceId: ws, id });
            likeYours.reload();
            return null;
          } catch (e) {
            return failed(e);
          }
        },
      }}
    />
  );
}

/** Where each way's button goes, for the ways that have one. */
const WAY_OPENS: Partial<Record<FindWay, { readonly view: OutreachTab; readonly words: string }>> =
  {
    groups: { view: 'groups', words: F.openGroups },
    searches: { view: 'playbooks', words: F.editWords },
    partners: { view: 'partners', words: F.seePartners },
  };

export function FindBody({
  net = null,
  onNet,
  week,
  error,
  onRetry,
  online,
  onOpen,
  likeYours = null,
}: {
  net?: Platform | null;
  onNet?: (net: Platform | null) => void;
  week: FindsWeekOutput | null;
  error: string | null;
  onRetry: () => void;
  online: boolean;
  onOpen: (view: OutreachTab, more?: string) => void;
  likeYours?: LikeYoursProps | null;
}) {
  const counts = week ? findWayCounts(week) : null;
  const shownOn = (on: readonly Platform[]) => !net || on.includes(net);
  const ways = FIND_WAY_KEYS.filter((way) => shownOn(FIND_WAYS[way].on));
  return (
    <OutreachFrame page="find" testID="outreach-find">
      {onNet ? <NetworkFilter value={net} onChange={onNet} /> : null}
      <View className="gap-0.5">
        <Text className="text-[17px] font-semibold">{F.week}</Text>
        <Note>{F.weekAbout}</Note>
      </View>
      {counts ? (
        ways.map((way) => {
          const w = FIND_WAYS[way];
          const opens = WAY_OPENS[way];
          return (
            <Card key={way} className="gap-1.5 px-4 py-3.5" testID={`find-way-${way}`}>
              <View className="flex-row flex-wrap items-center gap-1.5">
                <Text className="mr-auto text-[15px] font-semibold">{w.title}</Text>
                {w.on.length < WORKING_PLATFORMS.length
                  ? w.on.map((p) => (
                      <Badge key={p} variant="gray">
                        <Text>{PLATFORMS[p]}</Text>
                      </Badge>
                    ))
                  : null}
              </View>
              <Text
                className="text-[14px] font-medium tabular-nums"
                testID={`find-way-${way}-line`}
              >
                {findWayLine(way, counts[way])}
              </Text>
              <Note>{w.about}</Note>
              {opens ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onPress={() => onOpen(opens.view)}
                  testID={`find-way-${way}-open`}
                >
                  {opens.words}
                </Button>
              ) : null}
            </Card>
          );
        })
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="find-needs-signal" />
      ) : null}
      {shownOn(['instagram']) && likeYours?.list ? (
        <LikeYoursSection likeYours={likeYours} boxed disabled={!online} testID="find" />
      ) : null}
    </OutreachFrame>
  );
}
