import { fmtMonthDay, localDayOf } from '@hfos/core';
import {
  RE_DESCRIPTION_WORDS as W,
  RE_LISTING_ONLY,
} from '@hfos/core/addons/realestate/phone-words-listing';
import {
  listingOfCopy,
  type ListingDescriptionView,
} from '@hfos/core/addons/realestate/views/listing';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { List, ListLabel } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { requestDescription } from './listing-actions';
import { SignalButton } from './kit';
import {
  CheckRow,
  DealSubpage,
  FieldError,
  SignalNote,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * A listing's description on the phone (board 87, third panel): the live words and every version, read with no
 * signal. Writing a new version needs signal: the AI drafts it, and the fair-housing check runs on the server.
 */

type Version = ListingDescriptionView['history'][number];

export function ListingDescriptionScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const listing = React.useMemo(
    () => listingOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const client = copy.clients.get(dealId);
  const seller = (client ? copy.personParts(client)?.firstName : null) || 'The seller';
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.listing', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ).listing.description,
    `listing-description:${dealId}`,
    'description',
  );
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-listing-description"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="description">
          {(data) => <DescriptionBody description={data} seller={seller} timeZone={ctx.timeZone} />}
        </SummaryAnswer>
      ) : listing ? (
        <DescriptionBody
          description={listing.description}
          seller={seller}
          timeZone={ctx.timeZone}
          onWrite={async () => {
            await requestDescription({ workspaceId: ctx.workspaceId, dealId });
            toast.show(W.asked);
          }}
        />
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{RE_LISTING_ONLY(deal?.name ?? '')}</Text>
        </Card>
      )}
    </DealSubpage>
  );
}

/** "Oct 1 · Maria OK’d it in the portal", "Sep 28 · AI draft". */
export function versionLine(
  v: Version,
  inUse: ListingDescriptionView['inUse'],
  seller: string,
  timeZone: string,
): string {
  const how =
    v.state === 'signed'
      ? inUse?.id === v.id && inUse.how === 'let_through'
        ? W.letThrough
        : W.okd(seller)
      : v.state === 'drafting'
        ? W.drafting
        : v.source === 'ai'
          ? W.ai
          : W.person;
  return `${fmtMonthDay(localDayOf(v.at, timeZone))} · ${how}`;
}

export function DescriptionBody({
  description: d,
  seller,
  timeZone,
  onWrite,
}: {
  description: ListingDescriptionView;
  seller: string;
  timeZone: string;
  onWrite?: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState<Version | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const shown = d.inUse
    ? { title: W.live(d.inUse.version), words: d.inUse.words }
    : d.working
      ? { title: W.working(d.working.version), words: d.working.words }
      : null;
  return (
    <View className="gap-3" testID="description-body">
      {shown ? (
        <Card className="gap-2 p-4" testID="description-live">
          <View className="flex-row items-start justify-between gap-2">
            <Text className="flex-1 text-[15px] font-semibold">{shown.title}</Text>
            <Badge variant="gray">{W.fairHousing}</Badge>
          </View>
          <Text className="text-[14px] leading-[21px]" numberOfLines={4}>
            {shown.words ?? W.noWords}
          </Text>
        </Card>
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.none}</Text>
        </Card>
      )}
      {d.history.length ? (
        <>
          <ListLabel>{W.versions}</ListLabel>
          <List testID="description-versions">
            {d.history.map((v) => (
              <CheckRow
                key={v.id}
                label={W.version(v.version, d.inUse?.id === v.id)}
                line={versionLine(v, d.inUse, seller, timeZone)}
                onPress={() => setOpen(v)}
                testID={`description-version-${v.version}`}
              />
            ))}
          </List>
        </>
      ) : null}
      <FieldError>{error}</FieldError>
      {onWrite ? (
        <>
          <SignalButton
            label={W.write}
            variant="secondary"
            disabled={busy || d.working?.state === 'drafting'}
            onPress={() => {
              setBusy(true);
              setError(null);
              onWrite()
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
            testID="description-write"
          />
          <SignalNote>{W.writeWhy}</SignalNote>
        </>
      ) : null}
      <Sheet
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? W.version(open.version, d.inUse?.id === open.id) : undefined}
        description={open ? versionLine(open, d.inUse, seller, timeZone) : undefined}
        testID="description-version-sheet"
      >
        <ScrollView className="max-h-96">
          <Text className="text-[15px] leading-[22px]">{open?.words ?? W.noWords}</Text>
        </ScrollView>
      </Sheet>
    </View>
  );
}
