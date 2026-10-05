import { fmtTime } from '@hfos/core';
import {
  HOME_STATUSES,
  type HomeStatus,
  type ListingFacts,
} from '@hfos/core/addons/realestate/homes';
import {
  factsOf,
  firstNames,
  homeFactsLine,
  interestByHome,
  mlsSupplier,
  reactionOf,
  roomsLine,
  street,
  RE_BUYER_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-buyer';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import {
  homesOfCopy,
  matchesOfCopy,
  type HomesView,
} from '@hfos/core/addons/realestate/views/buyer';
import { fieldNotesOfCopy, type FieldNote } from '@hfos/core/addons/realestate/views/field';
import type { TourInterest } from '@hfos/core/addons/realestate/tours';
import { toursOfCopy } from '@hfos/core/addons/realestate/views/tours';
import * as React from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import { Chips, Field } from '@/components/calendar/new-appointment';
import { Pencil, Plus, Route, Sparkles } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';

import { addFieldNote, addHome, lookUpHome, setHomeStatus } from './buyer-actions';
import {
  attempt,
  DealNotHere,
  GroupLabel,
  KeyValues,
  MlsPhoto,
  SummaryHead,
  TextSheet,
  useBuyerDeal,
  type BuyerDeal,
  type KeyValue,
} from './buyer-kit';
import { NeedsSignalCard, openRe, reHref, SignalButton, useLiveAnswer } from './kit';

/**
 * A buyer's homes (board 82, second and third panels): each with where it stands on the MLS, the client's reaction
 * from their portal or a tour, and the MLS's credit line; and one home's facts, each marked with where it came from
 * and when. Adding a home and saying where one stands work with no signal; looking one up on the MLS needs it.
 * `?add=1` opens Add a home and `?home=<id>` one home, as the web's links do.
 */

export type Home = HomesView['homes'][number];

export function HomesScreen({
  dealId,
  homeId,
  add,
}: {
  dealId: string;
  homeId?: string;
  add?: boolean;
}) {
  const { ctx, copy, deal } = useBuyerDeal(dealId);
  const kept = React.useMemo(
    () => ({
      homes: homesOfCopy(copy, dealId, {}, ctx),
      tours: toursOfCopy(copy, dealId, ctx),
      matches: matchesOfCopy(copy, dealId, {}, ctx),
      notes: homeId
        ? fieldNotesOfCopy(copy, dealId, { aboutKind: 'home', aboutId: homeId }, ctx)
        : null,
    }),
    [copy, dealId, ctx, homeId],
  );
  const full = deal?.full ?? false;
  const live = useLiveAnswer(
    deal && !full
      ? () =>
          api
            .POST('/v1/queries/realestate.homes', {
              body: { workspaceId: ctx.workspaceId, dealId },
            })
            .then(unwrap)
      : null,
    `homes:${dealId}`,
    RE_PHONE_WORDS.summaryNeedsSignal(W.homes),
  );
  if (!deal) return <DealNotHere title={W.homesTitle} workspaceId={ctx.workspaceId} />;
  const homes = full ? (kept.homes?.homes ?? []) : (live.data?.homes ?? null);
  const interest = interestByHome(kept.tours?.tours ?? []);
  const back = reHref(ctx.workspaceId, `deals/${dealId}`);

  if (homeId) {
    const home = homes?.find((h) => h.id === homeId) ?? null;
    return (
      <Screen
        title={home ? street(home.address) : W.homesTitle}
        subtitle={deal.name}
        leading="back"
        back={reHref(ctx.workspaceId, `deals/${dealId}/homes`)}
        testID="re-home"
      >
        {!full ? <SummaryHead /> : null}
        {home ? (
          <HomeBody
            workspaceId={ctx.workspaceId}
            userId={ctx.userId}
            deal={deal}
            home={home}
            notes={kept.notes?.notes ?? []}
            timeZone={ctx.timeZone}
            editable={full}
          />
        ) : homes ? (
          <NeedsSignalCard words={W.homeGone} />
        ) : live.error ? (
          <NeedsSignalCard words={live.error} onRetry={live.reload} />
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen
      title={W.homesTitle}
      subtitle={homes ? W.homesCount(deal.name, homes.length) : deal.name}
      leading="back"
      back={back}
      testID="re-homes"
    >
      {!full ? <SummaryHead /> : null}
      {homes ? (
        <HomesBody
          workspaceId={ctx.workspaceId}
          userId={ctx.userId}
          deal={deal}
          homes={homes}
          interest={interest}
          newMatches={kept.matches?.counts.new ?? 0}
          adding={!!add}
          editable={full}
        />
      ) : live.error ? (
        <NeedsSignalCard words={live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

/** The MLS's status as a badge: for sale in green, pending in amber, the rest quiet. */
function MlsBadge({ mls }: { mls: NonNullable<Home['mls']> }) {
  return (
    <Badge variant={mls.status === 'active' ? 'ok' : mls.status === 'pending' ? 'pending' : 'gray'}>
      {mls.statusWords}
    </Badge>
  );
}

export function HomesBody({
  workspaceId,
  userId,
  deal,
  homes,
  interest,
  newMatches,
  adding,
  editable,
}: {
  workspaceId: string;
  userId: string;
  deal: BuyerDeal;
  homes: readonly Home[];
  interest: ReadonlyMap<string, TourInterest>;
  newMatches: number;
  adding: boolean;
  editable: boolean;
}) {
  const [add, setAdd] = React.useState(adding);
  return (
    <View className="gap-3" testID="re-homes-body">
      {newMatches > 0 ? (
        <Card>
          <Pressable
            role="button"
            onPress={() => openRe(workspaceId, `deals/${deal.id}/matches`)}
            className="flex-row items-center gap-3 px-3.5 py-3 active:bg-card-2"
            testID="re-homes-matches"
          >
            <Icon as={Sparkles} className="size-[18px] text-accent-text" />
            <Text className="flex-1 text-[14.5px]">{`${W.matchesTitle} · ${newMatches}`}</Text>
          </Pressable>
        </Card>
      ) : null}
      {homes.length === 0 ? (
        <Card className="px-4 py-5">
          <Text className="text-[14.5px] leading-[21px] text-text-2">{W.homesEmpty(deal.who)}</Text>
        </Card>
      ) : (
        homes.map((h) => (
          <HomeCard
            key={h.id}
            home={h}
            interest={interest.get(h.id) ?? null}
            onPress={() => openRe(workspaceId, `deals/${deal.id}/homes?home=${h.id}`)}
          />
        ))
      )}
      {editable ? (
        <>
          <Button
            variant="secondary"
            icon={Plus}
            onPress={() => setAdd(true)}
            testID="re-homes-add"
          >
            {W.addHome}
          </Button>
          <AddHomeSheet
            open={add}
            onClose={() => setAdd(false)}
            onAdd={(home) =>
              attempt(() => addHome(workspaceId, deal.id, home, userId), W.added(home.address))
            }
          />
        </>
      ) : null}
    </View>
  );
}

export function HomeCard({
  home,
  interest,
  onPress,
}: {
  home: Home;
  interest: TourInterest | null;
  onPress: () => void;
}) {
  const facts = factsOf(home);
  const reaction = reactionOf(home, interest);
  const line = [
    homeFactsLine(facts) || null,
    home.addedByClient ? W.addedBy(firstNames([home.addedByClient.name])) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card>
      <Pressable
        role="button"
        onPress={onPress}
        className="flex-row gap-3 p-3 active:bg-card-2"
        testID={`re-home-${home.id}`}
        accessibilityLabel={street(home.address)}
      >
        <MlsPhoto url={home.mls?.photos[0]?.url} className="h-[72px] w-[84px] rounded-control" />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-semibold">{street(home.address)}</Text>
          {line ? <Text className="text-[13px] leading-[18px] text-text-2">{line}</Text> : null}
          {home.mls || reaction ? (
            <View className="flex-row flex-wrap gap-1.5">
              {home.mls ? <MlsBadge mls={home.mls} /> : null}
              {reaction ? (
                <Badge variant={reaction.tone} testID={`re-home-reaction-${home.id}`}>
                  {reaction.words}
                </Badge>
              ) : null}
            </View>
          ) : null}
          {home.mls?.display.courtesy ? (
            <Text className="text-[12px] leading-[16px] text-text-3">
              {home.mls.display.courtesy}
            </Text>
          ) : home.mlsWords ? (
            <Text className="text-[12px] leading-[16px] text-text-3">{home.mlsWords}</Text>
          ) : null}
        </View>
      </Pressable>
    </Card>
  );
}

/** Each fact the home has, with where it came from: the MLS (the first saying whose feed and when), the listing's words, or the agent. */
export function homeFactRows(home: Home, timeZone: string): KeyValue[] {
  const facts = factsOf(home);
  const mls = home.mls;
  const supplier = mlsSupplier(mls?.sourceWords);
  let firstFromMls = true;
  const sourceOf = (keys: readonly (keyof ListingFacts)[]): string | undefined => {
    const fromMls = !!mls && keys.every((k) => facts[k] === undefined || facts[k] === mls.facts[k]);
    if (fromMls) {
      if (firstFromMls) {
        firstFromMls = false;
        return W.fromMlsAt(supplier, fmtTime(mls!.checkedAt, timeZone));
      }
      return W.fromMls;
    }
    if (home.factsState === 'suggested' && keys.some((k) => home.factSources[k]))
      return W.fromListing;
    return home.factsState === 'confirmed' ? W.keptBy : undefined;
  };
  const rows: KeyValue[] = [];
  const add = (label: string, keys: (keyof ListingFacts)[], value: string | null) => {
    if (value) rows.push({ label, value, sub: sourceOf(keys), testID: `re-fact-${keys[0]}` });
  };
  add(
    W.price,
    ['price_cents'],
    facts.price_cents != null ? homeFactsLine({ price_cents: facts.price_cents }) : null,
  );
  add(
    W.beds,
    ['beds', 'baths'],
    facts.beds != null || facts.baths != null
      ? `${facts.beds ?? '—'} · ${facts.baths ?? '—'}`
      : null,
  );
  add(W.size, ['sqft'], facts.sqft != null ? roomsLine({ sqft: facts.sqft }) : null);
  add(
    W.hoa,
    ['hoa_monthly_cents'],
    facts.hoa_monthly_cents != null ? W.hoaValue(facts.hoa_monthly_cents) : null,
  );
  add(W.built, ['year_built'], facts.year_built != null ? String(facts.year_built) : null);
  add(W.lot, ['lot_sqft'], facts.lot_sqft != null ? roomsLine({ sqft: facts.lot_sqft }) : null);
  add(
    W.garage,
    ['garage_spaces'],
    facts.garage_spaces != null ? W.garageValue(facts.garage_spaces) : null,
  );
  return rows;
}

const MARKS: readonly HomeStatus[] = ['saved', 'shortlisted', 'passed'];

export function HomeBody({
  workspaceId,
  userId,
  deal,
  home,
  notes,
  timeZone,
  editable,
}: {
  workspaceId: string;
  userId: string;
  deal: BuyerDeal;
  home: Home;
  notes: readonly FieldNote[];
  timeZone: string;
  editable: boolean;
}) {
  const { width } = useWindowDimensions();
  const [page, setPage] = React.useState(0);
  const [noting, setNoting] = React.useState(false);
  const photos = home.mls?.photos ?? [];
  const marks = MARKS.includes(home.status) ? MARKS : [...MARKS, home.status];
  const notice = [home.mls?.display.courtesy, home.mls?.display.notice].filter(Boolean).join(' ');
  const canLookUp = !home.mls && home.mlsState !== 'looking';
  return (
    <View className="gap-3" testID="re-home-body">
      {photos.length ? (
        <View className="-mx-3 -mt-3">
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) =>
              setPage(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width)))
            }
          >
            {photos.map((p) => (
              <MlsPhoto key={p.url} url={p.url} width={width} className="h-[210px]" />
            ))}
          </ScrollView>
          <Text
            className="absolute bottom-2 left-2 text-[12px] text-text-2"
            testID="re-home-photo-of"
          >
            {W.photoOf(photos[page]?.caption ?? null, page + 1, photos.length)}
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-between gap-2 px-1">
        <Text className="text-lg font-semibold">{street(home.address)}</Text>
        {home.mls ? (
          <Badge variant={home.mls.status === 'active' ? 'ok' : 'gray'} testID="re-home-mls">
            {W.mlsBadge(home.mls.statusWords, home.mls.mlsNumber)}
          </Badge>
        ) : null}
      </View>
      <KeyValues rows={homeFactRows(home, timeZone)} testID="re-home-facts" />
      {notice ? (
        <Text className="px-1 text-[12px] leading-[17px] text-text-3" testID="re-home-notice">
          {notice}
        </Text>
      ) : home.mlsWords ? (
        <Text className="px-1 text-[12.5px] leading-[17px] text-text-3">{home.mlsWords}</Text>
      ) : null}
      {photos.length ? (
        <Text className="px-1 text-[12px] leading-[16px] text-text-3">{W.photosWithSignal}</Text>
      ) : null}
      {editable ? (
        <View className="gap-2.5">
          <Button
            icon={Route}
            onPress={() => openRe(workspaceId, `deals/${deal.id}/tours?plan=1&home=${home.id}`)}
            testID="re-home-tour"
          >
            {W.addToTour}
          </Button>
          <Button
            variant="secondary"
            icon={Pencil}
            onPress={() => setNoting(true)}
            testID="re-home-note"
          >
            {W.note}
          </Button>
          {canLookUp ? (
            <SignalButton
              variant="secondary"
              label={W.lookUp}
              why={W.lookUpWhy}
              onPress={() => void attempt(() => lookUpHome(workspaceId, home.id), W.lookingUp)}
              testID="re-home-lookup"
            />
          ) : null}
          <Field label={W.where}>
            <Chips
              options={marks.map((s) => ({ value: s, label: HOME_STATUSES[s] }))}
              value={home.status}
              onChange={(s) =>
                s !== home.status &&
                void attempt(
                  () => setHomeStatus(workspaceId, home.id, s as HomeStatus),
                  W.marked(s as HomeStatus),
                )
              }
              testID="re-home-status"
            />
          </Field>
        </View>
      ) : null}
      {home.reactions.length ? (
        <KeyValues
          rows={home.reactions.map((r) => ({
            label: firstNames([r.name]),
            value: r.reaction === 'saved' ? W.savedIt : W.passedIt,
            sub: r.note ?? undefined,
          }))}
        />
      ) : null}
      {notes.length ? (
        <>
          <GroupLabel>{W.notesHere}</GroupLabel>
          <NotesList notes={notes} />
        </>
      ) : null}
      <TextSheet
        open={noting}
        onClose={() => setNoting(false)}
        title={W.note}
        description={street(home.address)}
        submit={W.save}
        onSubmit={(body) =>
          attempt(
            () =>
              addFieldNote(
                workspaceId,
                deal.id,
                { aboutKind: 'home', aboutId: home.id, body },
                userId,
              ),
            W.noted,
          )
        }
        testID="re-home-note-sheet"
      />
    </View>
  );
}

/** Notes taken in the field, newest first: typed words, a recording's words (or that they're coming), photos. */
export function NotesList({ notes }: { notes: readonly FieldNote[] }) {
  return (
    <Card>
      {notes.map((n, i) => (
        <View
          key={n.id}
          className={i > 0 ? 'gap-1 border-t border-border px-3.5 py-3' : 'gap-1 px-3.5 py-3'}
          testID={`re-note-${n.id}`}
        >
          {n.body ? <Text className="text-[14.5px] leading-[20px]">{n.body}</Text> : null}
          {n.audioFileId ? (
            <Text className="text-[13.5px] leading-[19px] text-text-2">
              {W.voiceNoteLine(n.transcript, n.transcriptState === 'waiting')}
            </Text>
          ) : null}
          {n.photoFileIds.length ? (
            <Text className="text-[13px] text-text-3">
              {W.photoNoteLine(n.photoFileIds.length)}
            </Text>
          ) : null}
        </View>
      ))}
    </Card>
  );
}

function AddHomeSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (home: { address: string; mlsNumber?: string; note?: string }) => Promise<boolean>;
}) {
  const [address, setAddress] = React.useState('');
  const [mls, setMls] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setAddress('');
      setMls('');
      setNote('');
    }
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={W.addHome} testID="re-add-home">
      <View className="mt-3">
        <Field label={W.address}>
          <Input
            value={address}
            onChangeText={setAddress}
            placeholder={W.addressHint}
            autoFocus
            testID="re-add-home-address"
          />
        </Field>
        <Field label={W.mlsNumber}>
          <Input
            value={mls}
            onChangeText={setMls}
            autoCapitalize="characters"
            testID="re-add-home-mls"
          />
        </Field>
        <Field label={W.addNote}>
          <Input value={note} onChangeText={setNote} testID="re-add-home-note" />
        </Field>
        <Button
          disabled={address.trim().length < 3}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            const ok = await onAdd({ address, mlsNumber: mls, note });
            setBusy(false);
            if (ok) onClose();
          }}
          testID="re-add-home-save"
        >
          {W.addHome}
        </Button>
      </View>
    </Sheet>
  );
}
