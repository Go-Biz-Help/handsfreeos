import { addDays, fmtMonthDay } from '@hfos/core';
import {
  RE_LISTING_ONLY,
  RE_MARKETING_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-listing';
import {
  listingFlyerOfCopy,
  listingMarketingOfCopy,
  type ListingFlyerView,
  type ListingMarketingView,
} from '@hfos/core/addons/realestate/views/listing';
import * as React from 'react';
import { View } from 'react-native';

import { Check, Clock, FileText, Globe, Share } from '@/components/icons';
import { List } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { markLive, requestPosts } from './listing-actions';
import { SignalButton } from './kit';
import {
  ChangeButton,
  CheckRow,
  Chips,
  DealSubpage,
  FieldError,
  FieldLabel,
  SignalNote,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * What's out and what's ready for a listing (board 88, second panel): live on the MLS, the flyer, the listing's page
 * and the social posts. The list reads anywhere; writing a post needs signal (the AI, and the fair housing check that
 * stays on the server). Nothing public goes before the MLS (Chris, 2026-10-01), so `?live=1` (the deal's card) opens
 * marking it live.
 */

export function ListingMarketingScreen({ dealId, live }: { dealId: string; live?: boolean }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const marketing = React.useMemo(
    () => listingMarketingOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const flyer = React.useMemo(
    () => listingFlyerOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.listing.marketing', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
    `listing-marketing:${dealId}`,
    'marketing',
  );
  const [marking, setMarking] = React.useState(!!live);
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-listing-marketing"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="marketing">
          {(data) => <MarketingBody marketing={data} flyer={null} />}
        </SummaryAnswer>
      ) : marketing ? (
        <MarketingBody
          marketing={marketing}
          flyer={flyer}
          onMarkLive={() => setMarking(true)}
          onWrite={async () => {
            await requestPosts({ workspaceId: ctx.workspaceId, dealId });
            toast.show(W.asked);
          }}
        />
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{RE_LISTING_ONLY(deal?.name ?? '')}</Text>
        </Card>
      )}
      {marketing && !marketing.mls ? (
        <MarkLiveSheet
          open={marking}
          today={ctx.today}
          onClose={() => setMarking(false)}
          onMark={async (mlsNumber, liveOn) => {
            await markLive({ workspaceId: ctx.workspaceId, dealId, mlsNumber, liveOn });
            toast.show(W.marked);
          }}
        />
      ) : null}
    </DealSubpage>
  );
}

export function MarketingBody({
  marketing: m,
  flyer,
  onMarkLive,
  onWrite,
}: {
  marketing: ListingMarketingView;
  flyer: ListingFlyerView | null;
  onMarkLive?: () => void;
  onWrite?: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <View className="gap-3" testID="marketing-body">
      <List testID="marketing-list">
        {m.mls ? (
          <CheckRow
            icon={Check}
            label={W.live}
            line={W.liveLine(fmtMonthDay(m.mls.liveOn), m.mls.number)}
            testID="marketing-mls"
          />
        ) : (
          <CheckRow icon={Clock} label={W.notLive} line={m.hold} testID="marketing-mls" />
        )}
        {flyer ? (
          <CheckRow
            icon={FileText}
            label={W.flyer}
            line={
              flyer.flyer
                ? flyer.flyer.page
                  ? W.flyerReady
                  : W.flyerReadyNoPage
                : flyer.refused.words
            }
            testID="marketing-flyer"
          />
        ) : null}
        <CheckRow
          icon={Globe}
          label={W.page}
          line={W.pageStates[m.page.state] ?? m.page.state}
          testID="marketing-page"
        />
        {m.posts.state === 'ready' && m.posts.items.length ? (
          m.posts.items.map((p, i) => (
            <CheckRow
              key={p.id}
              icon={Share}
              label={W.post(i + 1)}
              line={[p.words, W.postLine].filter(Boolean).join(' · ')}
              testID={`marketing-post-${i}`}
            />
          ))
        ) : (
          <CheckRow
            icon={Share}
            label={W.posts}
            line={
              m.posts.state === 'drafting'
                ? W.postsDrafting
                : m.posts.state === 'failed'
                  ? m.posts.failure
                  : W.noPosts
            }
            testID="marketing-posts"
          />
        )}
      </List>
      {onMarkLive && !m.mls ? (
        <Button variant="secondary" onPress={onMarkLive} testID="marketing-mark-live">
          {W.markLive}
        </Button>
      ) : null}
      <FieldError>{error}</FieldError>
      {onWrite && m.mls ? (
        <SignalButton
          label={W.write}
          variant="secondary"
          disabled={busy || m.posts.state === 'drafting'}
          onPress={() => {
            setBusy(true);
            setError(null);
            onWrite()
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
          testID="marketing-write"
        />
      ) : null}
      <SignalNote>{W.note}</SignalNote>
    </View>
  );
}

/** Marking the listing live on the MLS: its number and since when. */
export function MarkLiveSheet({
  open,
  today,
  onClose,
  onMark,
}: {
  open: boolean;
  today: string;
  onClose: () => void;
  onMark: (mlsNumber: string, liveOn: string) => Promise<void>;
}) {
  const [number, setNumber] = React.useState('');
  const [day, setDay] = React.useState<'today' | 'yesterday'>('today');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setNumber('');
    setDay('today');
    setError(null);
  }, [open]);
  const mark = async () => {
    setBusy(true);
    setError(null);
    try {
      await onMark(number.trim(), day === 'today' ? today : addDays(today, -1));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={W.markTitle}
      description={W.markAbout}
      testID="marketing-live-sheet"
    >
      <View className="gap-3">
        <FieldLabel>{W.mlsNumber}</FieldLabel>
        <Input
          value={number}
          onChangeText={setNumber}
          placeholder={W.mlsHint}
          autoCapitalize="characters"
          testID="marketing-mls-number"
        />
        <FieldLabel>{W.liveOn}</FieldLabel>
        <Chips
          value={day}
          onChange={setDay}
          options={[
            ['today', W.today],
            ['yesterday', W.yesterday],
          ]}
          testID="marketing-live-on"
        />
        <FieldError>{error}</FieldError>
        <ChangeButton
          command="realestate.listing.mark_live"
          label={W.mark}
          why={W.markWhy}
          loading={busy}
          disabled={!number.trim()}
          onPress={() => void mark()}
          testID="marketing-mark"
        />
      </View>
    </Sheet>
  );
}
