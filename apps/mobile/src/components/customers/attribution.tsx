import type { paths } from '@hfos/api-client';
import {
  adLookupNote,
  attributionSummary,
  formatDate,
  touchFacts,
  touchKindWords,
  touchTitle,
} from '@hfos/core';
import * as React from 'react';
import { Image, Pressable, View } from 'react-native';

import { ChevronDown, Megaphone } from '@/components/icons';
import { Instagram, Messenger } from '@/components/inbox/social-icons';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

/**
 * Where a customer came from (20261025000200): every Facebook or Instagram ad or link that brought them, newest first,
 * each kept as it came, with the ad's campaign, ad set and creative once Meta has said. The web's card, in core's
 * words. None of it is in the phone's copy, so it's asked for while there's signal and stays out of the way without.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

type AttributionList = Ok<'/v1/queries/attribution.list'>;
type Touch = AttributionList['touches'][number];

/** How many touches show before "Show more": somebody an ad brings back often still reads at a glance. */
const SHOWN = 3;

/** One customer's or one conversation's touches; null until they come, without signal, and on trouble. */
function useAttribution(
  workspaceId: string,
  of: { readonly personId: string } | { readonly conversationId: string },
): AttributionList | null {
  const { online } = useNetwork();
  const [got, setGot] = React.useState<AttributionList | null>(null);
  const personId = 'personId' in of ? of.personId : null;
  const conversationId = 'conversationId' in of ? of.conversationId : null;
  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    api
      .POST('/v1/queries/attribution.list', {
        body: {
          workspaceId,
          ...(personId ? { personId } : { conversationId: conversationId! }),
          limit: 25,
        },
      })
      .then((r) => {
        if (!cancelled) setGot(unwrap(r));
      })
      .catch(() => {
        // Where somebody came from is a side note: what can't load stays out of the way.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, personId, conversationId, online]);
  return got;
}

function TouchRow({ touch: t, first }: { touch: Touch; first: boolean }) {
  const picture = t.ad?.creativeThumbnailUrl ?? t.adPhotoUrl;
  const facts = touchFacts(t);
  const note = adLookupNote(t);
  return (
    <View className="flex-row gap-2.5" testID={`attribution-touch-${t.id}`}>
      {picture ? (
        // Meta's own copy of the ad's picture, as the customer saw it.
        <Image
          source={{ uri: picture }}
          accessibilityIgnoresInvertColors
          className="size-10 rounded-[8px] border border-border bg-card-2"
        />
      ) : (
        <View className="size-10 items-center justify-center rounded-[8px] bg-accent-soft">
          <Icon
            as={t.adId ? Megaphone : t.platform === 'instagram' ? Instagram : Messenger}
            className="size-4 text-accent-text"
          />
        </View>
      )}
      <View className="min-w-0 flex-1">
        <Text className="text-[14px] font-medium leading-[19px]">{touchTitle(t)}</Text>
        <Text className="mt-0.5 text-xs text-text-3">
          {`${touchKindWords(t)} · ${formatDate(t.touchedAt, { time: true })}${first ? ' · First' : ''}`}
        </Text>
        {facts.map((f) => (
          <Text key={f.label} numberOfLines={1} className="mt-0.5 text-xs text-text-2">
            <Text className="text-xs text-text-3">{`${f.label}  `}</Text>
            {f.value}
          </Text>
        ))}
        {note ? <Text className="mt-1 text-xs leading-[17px] text-text-3">{note}</Text> : null}
      </View>
    </View>
  );
}

function TouchList({ data }: { data: AttributionList }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? data.touches : data.touches.slice(0, SHOWN);
  const more = data.touches.length - shown.length;
  return (
    <View className="gap-3">
      {shown.map((t) => (
        <TouchRow key={t.id} touch={t} first={t.id === data.first && data.total > 1} />
      ))}
      {more > 0 ? (
        <Pressable
          role="button"
          onPress={() => setAll(true)}
          hitSlop={8}
          className="self-start py-1"
          testID="attribution-more"
        >
          <Text className="text-[13px] font-semibold text-accent-text">
            {more === 1 ? 'Show one more' : `Show ${more} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The customer's page: a card of its own, only when something brought them. */
export function AttributionCard({
  workspaceId,
  personId,
}: {
  workspaceId: string;
  personId: string;
}) {
  const data = useAttribution(workspaceId, { personId });
  if (!data || data.total === 0) return null;
  return (
    <Card className="gap-2 px-3.5 py-3.5" testID="attribution-card">
      <Text className="text-[15px] font-semibold">Where they came from</Text>
      <Text className="text-[13.5px] leading-[19px] text-text-2" testID="attribution-summary">
        {attributionSummary(data.touches, data.first, data.total)}
      </Text>
      <View className="mt-1">
        <TouchList data={data} />
      </View>
    </Card>
  );
}

/**
 * Over a Messenger or Instagram conversation: the line that says which ad or link brought them, which opens to the
 * campaign, ad set and the rest.
 */
export function AttributionStrip({
  workspaceId,
  conversationId,
}: {
  workspaceId: string;
  conversationId: string;
}) {
  const data = useAttribution(workspaceId, { conversationId });
  const [open, setOpen] = React.useState(false);
  if (!data || data.total === 0) return null;
  return (
    <View className="border-b border-border bg-card" testID="attribution-strip">
      <Pressable
        role="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        className="min-h-11 flex-row items-center gap-2 px-4 py-2 active:bg-card-2"
      >
        <Icon as={Megaphone} className="size-4 text-accent-text" />
        <Text
          numberOfLines={open ? undefined : 1}
          className="min-w-0 flex-1 text-[13px] text-text-2"
        >
          {attributionSummary(data.touches, data.first, data.total)}
        </Text>
        <Icon as={ChevronDown} className={cn('size-4 text-text-3', open ? '' : '-rotate-90')} />
      </Pressable>
      {open ? (
        <View className="px-4 pb-3 pt-1">
          <TouchList data={data} />
        </View>
      ) : null}
    </View>
  );
}
