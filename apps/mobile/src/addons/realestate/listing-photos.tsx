import { RE_PHOTO_WORDS } from '@hfos/core/addons/realestate/phone-words-closing';
import {
  RE_LISTING_ONLY,
  RE_PHOTOS_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-listing';
import { listingPhotosOnPhoneOfCopy } from '@hfos/core/addons/realestate/views/listing';
import * as React from 'react';
import { View } from 'react-native';

import { Camera } from '@/components/icons';
import { List } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { addListingPhoto, arrangeListingPhotos } from './listing-actions';
import {
  CheckRow,
  DealSubpage,
  PhotoFrame,
  SignalNote,
  SummaryAnswer,
  takeDealPhoto,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * A listing's photos on the phone (board 87, second panel), in order, the first the cover. More are taken on the
 * spot with no signal: each is kept on the phone, uploads when signal comes back, and goes on the listing then; its
 * order and the cover save the same way. The files stay at HandsFreeOS, so the phone shows each photo's place.
 */

export interface PhonePhoto {
  readonly id: string;
  readonly caption: string | null;
  readonly public: boolean;
  /** Taken here and still uploading. */
  readonly waiting: boolean;
}

export function ListingPhotosScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const photos = React.useMemo(() => listingPhotosOnPhoneOfCopy(copy, dealId), [copy, dealId]);
  const listing = whole && deal?.data.side === 'listing';
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.listing', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ).listing.photos.map((p) => ({ ...p, waiting: false })),
    `listing-photos:${dealId}`,
    'photos',
  );
  const [busy, setBusy] = React.useState(false);
  const take = async () => {
    setBusy(true);
    try {
      const taken = await takeDealPhoto({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        dealId,
        source: 'camera',
      });
      if (taken.kind !== 'kept') return;
      await addListingPhoto({
        workspaceId: ctx.workspaceId,
        dealId,
        fileId: taken.fileId,
        upload: taken.changeId,
        position: photos.length,
      });
      toast.show(W.added);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-listing-photos"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="photos">
          {(data) => <ListingPhotosBody photos={data} />}
        </SummaryAnswer>
      ) : listing ? (
        <ListingPhotosBody
          photos={photos}
          taking={busy}
          onTake={() => void take()}
          onArrange={async (list) => {
            await arrangeListingPhotos({
              workspaceId: ctx.workspaceId,
              dealId,
              photos: list.map((p) => ({ id: p.id, caption: p.caption, public: p.public })),
            });
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

/** The list with one photo moved: to the front (the cover), or a place earlier or later. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [one] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, one!);
  return next;
}

export function ListingPhotosBody({
  photos,
  taking,
  onTake,
  onArrange,
}: {
  photos: readonly PhonePhoto[];
  taking?: boolean;
  onTake?: () => void;
  onArrange?: (photos: readonly PhonePhoto[]) => Promise<void>;
}) {
  const [open, setOpen] = React.useState<number | null>(null);
  const waiting = photos.filter((p) => p.waiting).length;
  const arrange = (to: number) => {
    if (open === null || !onArrange) return;
    const next = moved(photos, open, to);
    setOpen(null);
    void onArrange(next).catch((e: unknown) => toast.error(errorMessage(e)));
  };
  return (
    <View className="gap-3" testID="listing-photos-body">
      <View className="flex-row items-center justify-between gap-2 px-1 pt-2">
        <Text variant="group">{W.count(photos.length)}</Text>
        {waiting ? (
          <Badge variant="pending" testID="photos-waiting">
            {RE_PHOTO_WORDS.waitingToUpload(waiting)}
          </Badge>
        ) : null}
      </View>
      {photos.length ? (
        <View className="flex-row flex-wrap gap-2" testID="listing-photos">
          {photos.map((p, i) => (
            <View key={p.id} className="w-[31.5%]">
              <PhotoFrame
                label={i === 0 ? W.cover : String(i + 1)}
                waiting={p.waiting}
                selected={i === 0}
                onPress={onArrange ? () => setOpen(i) : undefined}
                testID={`listing-photo-${i}`}
              />
            </View>
          ))}
        </View>
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.none}</Text>
        </Card>
      )}
      {onTake ? (
        <>
          <Button icon={Camera} loading={taking} onPress={onTake} testID="photos-take">
            {W.take}
          </Button>
          <SignalNote>{W.note}</SignalNote>
        </>
      ) : null}
      <Sheet
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open !== null ? (open === 0 ? W.cover : W.photo(open + 1)) : undefined}
        description={open !== null && !photos[open]?.public ? W.hidden : undefined}
        testID="listing-photo-sheet"
      >
        <List>
          {open !== null && open > 0 ? (
            <CheckRow label={W.makeCover} onPress={() => arrange(0)} testID="photo-cover" />
          ) : null}
          {open !== null && open > 0 ? (
            <CheckRow label={W.earlier} onPress={() => arrange(open - 1)} testID="photo-earlier" />
          ) : null}
          {open !== null && open < photos.length - 1 ? (
            <CheckRow label={W.later} onPress={() => arrange(open + 1)} testID="photo-later" />
          ) : null}
        </List>
      </Sheet>
    </View>
  );
}
