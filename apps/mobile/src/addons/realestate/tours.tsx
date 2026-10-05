import { addDays, fmtDateShort, fmtRange, localInstant, TIME_OPTIONS } from '@hfos/core';
import {
  factsOf,
  homeFactsLine,
  interestWords,
  roomsLine,
  stopClock,
  stopLine,
  stopNotesWords,
  stopTimes,
  street,
  tourName,
  RE_BUYER_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-buyer';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import type { ListingFacts } from '@hfos/core/addons/realestate/homes';
import { TOUR_INTEREST_KEYS, type TourInterest } from '@hfos/core/addons/realestate/tours';
import {
  buyerProfileOfCopy,
  homesOfCopy,
  type BuyerProfileView,
} from '@hfos/core/addons/realestate/views/buyer';
import { fieldNotesOfCopy, type FieldNote } from '@hfos/core/addons/realestate/views/field';
import { toursOfCopy, type ToursView } from '@hfos/core/addons/realestate/views/tours';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { takePhoto } from '@/changes/photo-device';
import { newId } from '@/changes';
import { Chips, Field } from '@/components/calendar/new-appointment';
import {
  Camera,
  Check,
  ChevronRight,
  MapPin,
  Mic,
  Pencil,
  Route,
  ShieldCheck,
} from '@/components/icons';
import { CheckInSheet } from '@/components/safety/check-in-sheet';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useActiveCheckIn } from '@/safety/use-check-in';

import {
  addFieldNote,
  giveFeedback,
  keepDealFile,
  planTour,
  recordVisit,
  setTourStops,
} from './buyer-actions';
import {
  attempt,
  DealNotHere,
  directionsUrl,
  GroupLabel,
  KeyValues,
  problemWords,
  SummaryHead,
  TextSheet,
  useBuyerDeal,
  type BuyerDeal,
  type KeyValue,
} from './buyer-kit';
import type { Home } from './homes';
import { NotesList } from './homes';
import { NeedsSignalCard, reHref, SignalButton, useLiveAnswer } from './kit';
import { keepRecording } from './recorder';
import { VoiceNoteSheet } from './voice-note';

/**
 * Tours in the field (board 83): the day's stops in order with Directions and Check in; at each stop, what to see and
 * ask, the client's reaction, and notes by text, voice or photo, all of it with no signal; and after the tour, what
 * the client thought of each home with the agent's notes, ready for their portal. `?stop=<id>` opens a stop and
 * `?feedback=<tour id>` the feedback after; `?plan=1&home=<id>` opens Plan a tour from a home, as the web's links do.
 */

type Tour = ToursView['tours'][number];
type Stop = Tour['stops'][number];
type Profile = BuyerProfileView['profile'];

export function ToursScreen({
  dealId,
  stopId,
  feedbackTourId,
  plan,
  homeId,
}: {
  dealId: string;
  stopId?: string;
  feedbackTourId?: string;
  plan?: boolean;
  homeId?: string;
}) {
  const { ctx, copy, deal } = useBuyerDeal(dealId);
  const kept = React.useMemo(
    () => ({
      tours: toursOfCopy(copy, dealId, ctx),
      homes: homesOfCopy(copy, dealId, {}, ctx)?.homes ?? [],
      profile: buyerProfileOfCopy(copy, dealId, ctx)?.profile ?? null,
      notes: fieldNotesOfCopy(copy, dealId, { aboutKind: 'tour_stop' }, ctx)?.notes ?? [],
    }),
    [copy, dealId, ctx],
  );
  const full = deal?.full ?? false;
  const live = useLiveAnswer(
    deal && !full
      ? () =>
          api
            .POST('/v1/queries/realestate.tours', {
              body: { workspaceId: ctx.workspaceId, dealId },
            })
            .then(unwrap)
      : null,
    `tours:${dealId}`,
    RE_PHONE_WORDS.summaryNeedsSignal(W.tours),
  );
  if (!deal) return <DealNotHere title={W.toursTitle} workspaceId={ctx.workspaceId} />;
  const back = reHref(ctx.workspaceId, `deals/${dealId}`);
  const toursHref = reHref(ctx.workspaceId, `deals/${dealId}/tours`);
  const view = full ? kept.tours : live.data;
  const tours = view?.tours ?? [];

  if (full && stopId) {
    const tour = tours.find((t) => t.stops.some((s) => s.id === stopId));
    const stop = tour?.stops.find((s) => s.id === stopId);
    const name = tour ? tourName(tour.startsAt, ctx.today, ctx.timeZone) : W.toursTitle;
    const index = tour && stop ? tour.stops.indexOf(stop) : -1;
    return (
      <Screen
        title={stop ? street(stop.address) : W.toursTitle}
        subtitle={stop ? W.stopOf(name, index + 1) : deal.name}
        leading="back"
        back={toursHref}
        testID="re-stop"
      >
        {tour && stop ? (
          <StopBody
            workspaceId={ctx.workspaceId}
            userId={ctx.userId}
            deal={deal}
            tour={tour}
            stop={stop}
            home={kept.homes.find((h) => h.id === stop.homeId) ?? null}
            profile={kept.profile}
            notes={kept.notes.filter((n) => n.aboutId === stop.id)}
          />
        ) : (
          <NeedsSignalCard words={W.stopGone} />
        )}
      </Screen>
    );
  }

  if (full && feedbackTourId) {
    const tour = tours.find((t) => t.id === feedbackTourId);
    const name = tour ? tourName(tour.startsAt, ctx.today, ctx.timeZone) : W.feedbackTitle;
    return (
      <Screen
        title={W.feedbackTitle}
        subtitle={tour ? name : deal.name}
        leading="back"
        back={toursHref}
        testID="re-tour-feedback"
      >
        {tour ? (
          <FeedbackBody
            workspaceId={ctx.workspaceId}
            userId={ctx.userId}
            deal={deal}
            tour={tour}
            name={name}
            notes={kept.notes}
          />
        ) : (
          <NeedsSignalCard words={W.stopGone} />
        )}
      </Screen>
    );
  }

  return (
    <Screen title={W.toursTitle} subtitle={deal.name} leading="back" back={back} testID="re-tours">
      {!full ? <SummaryHead /> : null}
      {view ? (
        <ToursBody
          workspaceId={ctx.workspaceId}
          deal={deal}
          view={view}
          homes={kept.homes}
          today={ctx.today}
          timeZone={ctx.timeZone}
          planning={!!plan && full}
          planHome={homeId ?? null}
          editable={full}
        />
      ) : live.error ? (
        <NeedsSignalCard words={live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

const openStop = (workspaceId: string, dealId: string, stopId: string) =>
  router.push(reHref(workspaceId, `deals/${dealId}/tours?stop=${stopId}`));

export function ToursBody({
  workspaceId,
  deal,
  view,
  homes,
  today,
  timeZone,
  planning,
  planHome,
  editable,
}: {
  workspaceId: string;
  deal: BuyerDeal;
  view: Pick<ToursView, 'agreement' | 'tours'>;
  homes: readonly Home[];
  today: string;
  timeZone: string;
  planning: boolean;
  planHome: string | null;
  editable: boolean;
}) {
  const [plan, setPlan] = React.useState(planning);
  const [checkIn, setCheckIn] = React.useState<Tour | null>(null);
  const planned = view.tours
    .filter((t) => t.status === 'planned')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const done = view.tours
    .filter((t) => t.status === 'done')
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const clients = deal.clients.map((c) => c.name).join(' and ');
  const card = (t: Tour) => {
    const name = tourName(t.startsAt, today, timeZone);
    const times = stopTimes(t.startsAt, t.endsAt, t.stops.length);
    return (
      <View key={t.id} className="gap-1.5" testID={`re-tour-${t.id}`}>
        <Card className="gap-2.5 p-3.5">
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="text-[17px] font-semibold">{name}</Text>
            {t.status === 'planned' && view.agreement.ok ? (
              <Badge variant="ok">{W.agreementOnFile}</Badge>
            ) : t.status === 'done' ? (
              <Badge variant="gray">{W.tourDone}</Badge>
            ) : null}
          </View>
          <Text className="text-[13.5px] leading-[19px] text-text-2" testID="re-tour-line">
            {W.tourLine(clients, t.stops.length, fmtRange(t.startsAt, t.endsAt, timeZone))}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="md"
              variant="secondary"
              icon={Route}
              onPress={() => void Linking.openURL(directionsUrl(t.stops.map((s) => s.address)))}
              testID={`re-tour-directions-${t.id}`}
            >
              {W.directions}
            </Button>
            {t.status === 'planned' ? (
              <Button
                size="md"
                variant="secondary"
                icon={ShieldCheck}
                onPress={() => setCheckIn(t)}
                testID={`re-tour-checkin-${t.id}`}
              >
                {W.checkIn}
              </Button>
            ) : (
              <Button
                size="md"
                variant="secondary"
                onPress={() =>
                  router.push(reHref(workspaceId, `deals/${deal.id}/tours?feedback=${t.id}`))
                }
                testID={`re-tour-feedback-${t.id}`}
              >
                {W.feedback}
              </Button>
            )}
          </View>
        </Card>
        <GroupLabel>{W.stops}</GroupLabel>
        <Card>
          {t.stops.map((s, i) => (
            <Pressable
              key={s.id}
              role="button"
              disabled={!editable}
              onPress={() => openStop(workspaceId, deal.id, s.id)}
              className={cn(
                'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
                i > 0 && 'border-t border-border',
              )}
              testID={`re-stop-row-${s.id}`}
            >
              <Icon
                as={s.status === 'visited' ? Check : MapPin}
                className={cn(
                  'size-[18px]',
                  s.status === 'visited' ? 'text-success-text' : 'text-text-2',
                )}
              />
              <View className="min-w-0 flex-1 gap-px">
                <Text className="text-base">{street(s.address)}</Text>
                <Text className="text-[13px] leading-[18px] text-text-3">
                  {stopLine(s.status, s.note)}
                </Text>
              </View>
              <Text className="text-sm text-text-2">{stopClock(times[i]!, timeZone)}</Text>
              {editable ? <Icon as={ChevronRight} className="size-4 text-text-3" /> : null}
            </Pressable>
          ))}
        </Card>
      </View>
    );
  };
  return (
    <View className="gap-3" testID="re-tours-body">
      {!view.agreement.ok && view.agreement.words ? (
        <Card className="bg-warning-soft px-4 py-3.5">
          <Text
            className="text-[13.5px] leading-[19px] text-warning-text"
            testID="re-tours-agreement"
          >
            {view.agreement.words}
          </Text>
        </Card>
      ) : null}
      {planned.length === 0 && done.length === 0 ? (
        <Card className="px-4 py-5">
          <Text className="text-[14.5px] leading-[21px] text-text-2">{W.toursEmpty}</Text>
        </Card>
      ) : null}
      {planned.map(card)}
      {done.map(card)}
      {editable ? (
        <SignalButton
          variant="secondary"
          label={W.planTour}
          why={W.planWhy}
          onPress={() => setPlan(true)}
          testID="re-tours-plan"
        />
      ) : null}
      {editable ? (
        <PlanTourSheet
          open={plan}
          onClose={() => setPlan(false)}
          workspaceId={workspaceId}
          dealId={deal.id}
          homes={homes}
          firstHome={planHome}
          planned={planned}
          agreement={view.agreement}
          today={today}
          timeZone={timeZone}
        />
      ) : null}
      {checkIn ? (
        <CheckInSheet
          open
          onClose={() => setCheckIn(null)}
          workspaceId={workspaceId}
          appointmentId={checkIn.appointmentId ?? undefined}
          place={(checkIn.stops.find((s) => s.status === 'planned') ?? checkIn.stops[0])?.address}
          about={tourName(checkIn.startsAt, today, timeZone)}
          startsAt={checkIn.startsAt}
          endsAt={checkIn.endsAt}
        />
      ) : null}
    </View>
  );
}

/** What to ask at a stop: the client's must-haves and deal-breakers, and what the listing doesn't say. */
export function stopQuestions(
  profile: Profile,
  home: Home | null,
  who: string,
): { readonly words: string; readonly why: string }[] {
  return [
    ...(profile?.mustHaves ?? []).map((m) => ({ words: m, why: W.theirMustHave(who) })),
    ...(profile?.dealBreakers ?? []).map((m) => ({ words: m, why: W.theirDealBreaker(who) })),
    ...(home?.fit.lines ?? [])
      .filter((l) => l.met === null)
      .map((l) => ({ words: l.words, why: W.notOnListing })),
  ];
}

/** A stop's facts at a glance: price; beds, baths and size; when it was built and its HOA. */
export function stopFactRows(facts: ListingFacts): KeyValue[] {
  const rows: KeyValue[] = [];
  if (facts.price_cents != null)
    rows.push({ label: W.price, value: homeFactsLine({ price_cents: facts.price_cents }) });
  if (facts.beds != null || facts.baths != null || facts.sqft != null)
    rows.push({
      label: W.bedsBathsSize,
      value: [
        facts.beds != null ? String(facts.beds) : '—',
        facts.baths != null ? String(facts.baths) : '—',
        facts.sqft != null ? roomsLine({ sqft: facts.sqft }) : '—',
      ].join(' · '),
    });
  if (facts.year_built != null || facts.hoa_monthly_cents != null)
    rows.push({
      label: W.builtHoa,
      value: [
        facts.year_built != null ? String(facts.year_built) : '—',
        facts.hoa_monthly_cents != null ? W.hoaValue(facts.hoa_monthly_cents) : W.noHoa,
      ].join(' · '),
    });
  return rows;
}

export function StopBody({
  workspaceId,
  userId,
  deal,
  tour,
  stop,
  home,
  profile,
  notes,
}: {
  workspaceId: string;
  userId: string;
  deal: BuyerDeal;
  tour: Tour;
  stop: Stop;
  home: Home | null;
  profile: Profile;
  notes: readonly FieldNote[];
}) {
  const [sheet, setSheet] = React.useState<'note' | 'voice' | 'skip' | 'checkin' | null>(null);
  const checkedIn = useActiveCheckIn(workspaceId, userId);
  const index = tour.stops.indexOf(stop);
  const next = tour.stops[index + 1] ?? null;
  const facts: ListingFacts = home ? factsOf(home) : {};
  const questions = stopQuestions(profile, home, deal.who);
  const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
  const ref = { id: stop.id, tourId: tour.id, homeId: stop.homeId, status: stop.status };

  const goOn = async () => {
    if (stop.status === 'planned') {
      const ok = await attempt(() => recordVisit(workspaceId, stop.id, 'visited'));
      if (!ok) return;
    }
    router.replace(
      reHref(
        workspaceId,
        next
          ? `deals/${deal.id}/tours?stop=${next.id}`
          : `deals/${deal.id}/tours?feedback=${tour.id}`,
      ) as Href,
    );
  };

  const photo = async () => {
    const fileId = newId();
    const taken = await takePhoto({ userId, source: 'camera', fileId });
    if (taken.kind === 'no-camera-permission') {
      toast.error(W.noCamera);
      return;
    }
    if (taken.kind !== 'kept') return;
    await attempt(async () => {
      const upload = await keepDealFile(workspaceId, deal.id, {
        fileId,
        localName: taken.photo.localName,
        sizeBytes: taken.photo.sizeBytes,
      });
      await addFieldNote(
        workspaceId,
        deal.id,
        { aboutKind: 'tour_stop', aboutId: stop.id, photoFileIds: [fileId] },
        userId,
        [upload],
      );
    }, W.photoKept);
  };

  const keepVoice = async (recording: { uri: string; seconds: number }) =>
    attempt(async () => {
      const fileId = newId();
      const file = keepRecording({ userId, fileId, uri: recording.uri });
      const upload = await keepDealFile(workspaceId, deal.id, {
        fileId,
        localName: file.localName,
        sizeBytes: file.sizeBytes,
        name: `Voice note, ${street(stop.address)}.m4a`,
        mimeType: 'audio/mp4',
      });
      await addFieldNote(
        workspaceId,
        deal.id,
        { aboutKind: 'tour_stop', aboutId: stop.id, audioFileId: fileId },
        userId,
        [upload],
      );
    }, W.heard);

  return (
    <View className="gap-3" testID="re-stop-body">
      {/* Checked in, the banner over every screen says so, with Check out (board 90). */}
      {!checkedIn ? (
        <Button
          variant="secondary"
          icon={ShieldCheck}
          onPress={() => setSheet('checkin')}
          testID="re-stop-checkin"
        >
          {W.checkIn}
        </Button>
      ) : null}
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-lg font-semibold">{street(stop.address)}</Text>
        <Text className="text-[13px] text-text-3" testID="re-stop-count">
          {W.stopCount(index + 1, tour.stops.length)}
        </Text>
      </View>
      <KeyValues rows={stopFactRows(facts)} testID="re-stop-facts" />
      {questions.length ? (
        <>
          <GroupLabel>{W.askThere}</GroupLabel>
          <Card>
            {questions.map((q, i) => (
              <View
                key={`${q.words}-${i}`}
                className={cn('gap-0.5 px-3.5 py-3', i > 0 && 'border-t border-border')}
              >
                <Text className="text-[15px]">{q.words}</Text>
                <Text className="text-[12.5px] text-text-3">{q.why}</Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}
      {deal.clients.map((c) => {
        const who = firstName(c.name);
        const said = stop.feedback.find((f) => f.personId === c.personId)?.interest;
        return (
          <View key={c.personId} className="gap-1.5">
            <GroupLabel>{W.whatTheyThought(who)}</GroupLabel>
            <Segmented<TourInterest | 'none'>
              label={W.whatTheyThought(who)}
              value={said ?? 'none'}
              onChange={(interest) => {
                if (interest === 'none') return;
                void attempt(() =>
                  giveFeedback(workspaceId, ref, deal.id, c.personId, interest, userId),
                );
              }}
              options={TOUR_INTEREST_KEYS.map((k) => ({
                value: k,
                label: interestWords(k, who),
                testID: `re-stop-interest-${c.personId}-${k}`,
              }))}
              testID={`re-stop-interest-${c.personId}`}
            />
          </View>
        );
      })}
      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          size="md"
          variant="secondary"
          icon={Pencil}
          onPress={() => setSheet('note')}
          testID="re-stop-note"
        >
          {W.note}
        </Button>
        <Button
          className="flex-1"
          size="md"
          variant="secondary"
          icon={Mic}
          onPress={() => setSheet('voice')}
          testID="re-stop-voice"
        >
          {W.voice}
        </Button>
        <Button
          className="flex-1"
          size="md"
          variant="secondary"
          icon={Camera}
          onPress={() => void photo()}
          testID="re-stop-photo"
        >
          {W.photo}
        </Button>
      </View>
      {notes.length ? (
        <>
          <GroupLabel>{W.notesHere}</GroupLabel>
          <NotesList notes={notes} />
        </>
      ) : null}
      <Button onPress={() => void goOn()} testID="re-stop-next">
        {next ? W.nextStop(next.address) : W.finishTour}
      </Button>
      {stop.status === 'planned' ? (
        <Button variant="ghost" onPress={() => setSheet('skip')} testID="re-stop-skip">
          {W.skipStop}
        </Button>
      ) : null}
      <TextSheet
        open={sheet === 'note'}
        onClose={() => setSheet(null)}
        title={W.note}
        description={street(stop.address)}
        submit={W.save}
        onSubmit={(body) =>
          attempt(
            () =>
              addFieldNote(
                workspaceId,
                deal.id,
                { aboutKind: 'tour_stop', aboutId: stop.id, body },
                userId,
              ),
            W.noted,
          )
        }
        testID="re-stop-note-sheet"
      />
      <TextSheet
        open={sheet === 'skip'}
        onClose={() => setSheet(null)}
        title={W.skipStop}
        placeholder={W.skipWhy}
        submit={W.skipStop}
        onSubmit={(why) =>
          attempt(() => recordVisit(workspaceId, stop.id, 'skipped', why), W.skipped)
        }
        testID="re-stop-skip-sheet"
      />
      <VoiceNoteSheet
        open={sheet === 'voice'}
        onClose={() => setSheet(null)}
        address={stop.address}
        onKeep={keepVoice}
      />
      {sheet === 'checkin' ? (
        <CheckInSheet
          open
          onClose={() => setSheet(null)}
          workspaceId={workspaceId}
          appointmentId={tour.appointmentId ?? undefined}
          place={stop.address}
          about={W.stopOf(street(stop.address), index + 1)}
          startsAt={tour.startsAt}
          endsAt={tour.endsAt}
        />
      ) : null}
    </View>
  );
}

export function FeedbackBody({
  workspaceId,
  userId,
  deal,
  tour,
  name,
  notes,
}: {
  workspaceId: string;
  userId: string;
  deal: BuyerDeal;
  tour: Tour;
  name: string;
  notes: readonly FieldNote[];
}) {
  const [busy, setBusy] = React.useState(false);
  const first = deal.clients[0] ?? null;
  const who = deal.who;
  // What goes to the portal: each stop seen with the client's reaction, and the agent's notes as its words.
  const sendable = tour.stops.flatMap((s) => {
    const words = stopNotesWords(notes.filter((n) => n.aboutId === s.id));
    return s.status === 'visited'
      ? s.feedback
          .filter((f) => deal.clients.some((c) => c.personId === f.personId))
          .filter((f) => words && (f.words ?? '') !== words)
          .map((f) => ({ stop: s, personId: f.personId, interest: f.interest, words }))
      : [];
  });
  const send = async () => {
    setBusy(true);
    try {
      for (const one of sendable)
        await giveFeedback(
          workspaceId,
          { id: one.stop.id, tourId: tour.id, homeId: one.stop.homeId, status: one.stop.status },
          deal.id,
          one.personId,
          one.interest,
          userId,
          one.words,
        );
      toast.show(W.sentToPortal(who));
    } catch (e) {
      toast.error(problemWords(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3" testID="re-feedback-body">
      <GroupLabel>{W.whatTheySaid(name, who)}</GroupLabel>
      {tour.stops.map((s) => {
        const said =
          (first ? s.feedback.find((f) => f.personId === first.personId) : null) ??
          s.feedback[0] ??
          null;
        const here = notes
          .filter((n) => n.aboutId === s.id)
          .sort((a, b) => a.notedAt.localeCompare(b.notedAt));
        return (
          <Card key={s.id} className="gap-1.5 p-3.5" testID={`re-feedback-${s.id}`}>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="text-[15.5px] font-semibold">{street(s.address)}</Text>
              {said ? (
                <Badge variant={said.interest === 'love' ? 'ok' : 'gray'}>
                  {interestWords(said.interest, firstOf(said.name))}
                </Badge>
              ) : null}
            </View>
            {s.status === 'skipped' ? (
              <Text className="text-[13.5px] leading-[19px] text-text-2">
                {W.skippedBecause(s.note ?? '—')}
              </Text>
            ) : null}
            {said?.words ? (
              <Text className="text-[13.5px] leading-[19px] text-text-2">{`“${said.words}”`}</Text>
            ) : null}
            {here.map((n) =>
              n.audioFileId ? (
                <Text key={n.id} className="text-[13.5px] leading-[19px] text-text-2">
                  {W.voiceNoteLine(n.transcript, n.transcriptState === 'waiting')}
                </Text>
              ) : n.body ? (
                <Text key={n.id} className="text-[13.5px] leading-[19px]">
                  {n.body}
                </Text>
              ) : null,
            )}
            {!said && !here.length && s.status !== 'skipped' ? (
              <Text className="text-[13px] text-text-3">{W.nothingSaid}</Text>
            ) : null}
          </Card>
        );
      })}
      {sendable.length ? (
        <Button loading={busy} onPress={() => void send()} testID="re-feedback-send">
          {W.sendToPortal(who)}
        </Button>
      ) : null}
    </View>
  );
}

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Half hours from 8 AM to 6 PM, for a tour's start. */
const STARTS = Array.from({ length: 21 }, (_, i) => 8 * 60 + i * 30);
const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Plan a tour from the phone: its homes in order, the day and the time. It goes on the calendar and the clients are
 * invited, so it needs signal. From a home (`?plan=1&home=<id>`), that home is picked first, and a tour already planned
 * can take it instead.
 */
export function PlanTourSheet({
  open,
  onClose,
  workspaceId,
  dealId,
  homes,
  firstHome,
  planned,
  agreement,
  today,
  timeZone,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  homes: readonly Home[];
  firstHome: string | null;
  planned: readonly Tour[];
  agreement: ToursView['agreement'];
  today: string;
  timeZone: string;
}) {
  const [picked, setPicked] = React.useState<string[]>(firstHome ? [firstHome] : []);
  const [day, setDay] = React.useState(addDays(today, 1));
  const [start, setStart] = React.useState(10 * 60);
  React.useEffect(() => {
    if (open) setPicked(firstHome ? [firstHome] : []);
  }, [open, firstHome]);
  const choosable = homes.filter((h) => h.status !== 'passed' && h.status !== 'removed');
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const fromHome = firstHome ? homes.find((h) => h.id === firstHome) : null;
  return (
    <Sheet open={open} onClose={onClose} title={W.planTour} scroll testID="re-plan-tour">
      <View className="mt-3 gap-1">
        {!agreement.ok && agreement.words ? (
          <Text
            className="mb-3 text-[13.5px] leading-[19px] text-warning-text"
            testID="re-plan-agreement"
          >
            {agreement.words}
          </Text>
        ) : null}
        {fromHome
          ? planned
              .filter((t) => !t.stops.some((s) => s.homeId === fromHome.id))
              .map((t) => (
                <View key={t.id} className="mb-3">
                  <SignalButton
                    variant="secondary"
                    label={W.addToThat(tourName(t.startsAt, today, timeZone))}
                    onPress={() =>
                      void attempt(
                        () =>
                          setTourStops(workspaceId, t.id, [
                            ...t.stops.map((s) => s.homeId),
                            fromHome.id,
                          ]),
                        W.addedToThat(tourName(t.startsAt, today, timeZone)),
                      ).then((ok) => ok && onClose())
                    }
                    testID={`re-plan-add-${t.id}`}
                  />
                </View>
              ))
          : null}
        <Field label={W.planHomes}>
          <Card>
            {choosable.map((h, i) => {
              const at = picked.indexOf(h.id);
              return (
                <Pressable
                  key={h.id}
                  role="button"
                  accessibilityState={{ selected: at >= 0 }}
                  onPress={() => toggle(h.id)}
                  className={cn(
                    'min-h-12 flex-row items-center gap-3 px-3.5 py-2 active:bg-card-2',
                    i > 0 && 'border-t border-border',
                  )}
                  testID={`re-plan-home-${h.id}`}
                >
                  <View
                    className={cn(
                      'size-6 items-center justify-center rounded-full border',
                      at >= 0 ? 'border-transparent bg-accent' : 'border-border-strong',
                    )}
                  >
                    {at >= 0 ? (
                      <Text className="text-xs font-semibold text-white">{at + 1}</Text>
                    ) : null}
                  </View>
                  <Text className="flex-1 text-[15px]">{street(h.address)}</Text>
                </Pressable>
              );
            })}
          </Card>
        </Field>
        <Field label={W.planWhen}>
          <Chips
            options={days.map((d) => ({ value: d, label: fmtDateShort(d) }))}
            value={day}
            onChange={setDay}
            testID="re-plan-day"
          />
        </Field>
        <Field label={W.planTime}>
          <Chips
            options={TIME_OPTIONS.filter(([m]) => STARTS.includes(m)).map(([m, label]) => ({
              value: String(m),
              label,
            }))}
            value={String(start)}
            onChange={(v) => setStart(Number(v))}
            testID="re-plan-time"
          />
        </Field>
        <SignalButton
          label={W.planTour}
          why={W.planWhy}
          disabled={!picked.length || !agreement.ok}
          onPress={() =>
            void attempt(
              () =>
                planTour({
                  workspaceId,
                  dealId,
                  homeIds: picked,
                  startsAt: new Date(localInstant(day, clock(start), timeZone)).toISOString(),
                }),
              W.planned,
            ).then((ok) => ok && onClose())
          }
          testID="re-plan-save"
        />
      </View>
    </Sheet>
  );
}
