import { addDays, fmtDateShort, fmtTime, localInstant } from '@hfos/core';
import {
  RE_LISTING_ONLY,
  RE_SHOWING_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-listing';
import { addressOfCopy } from '@hfos/core/addons/realestate/views/listing';
import {
  showingListOfCopy,
  type ShowingListView,
} from '@hfos/core/addons/realestate/views/showings';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { CalendarDays, Plus, Star } from '@/components/icons';
import { CheckInSheet } from '@/components/safety/check-in-sheet';
import { List, ListLabel } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { addShowing, decideShowing } from './listing-actions';
import { ShowingLockboxes } from './lockboxes';
import {
  CheckRow,
  Chips,
  DealSubpage,
  FieldError,
  FieldLabel,
  SignalNote,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
  whenWords,
} from './subpage';

/**
 * A listing's showings on the phone (board 89, first two panels): requests to answer, what's coming up and what
 * buyers said. Answering reaches the buyer's agent, so it goes on its own while fresh and asks again after 30 minutes
 * with no signal; the lockbox code never reaches the phone. A showing coming up offers Check in for showing safety.
 * Under them, the listing's lockboxes and who opened them (round seven, board 98), while there's signal.
 */

type Showing = ShowingListView['showings'][number];
type Decision = 'confirm' | 'decline';

export function ShowingsScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const view = React.useMemo(
    () =>
      showingListOfCopy(copy, dealId, {
        userId: ctx.userId,
        now: ctx.now,
        timeZone: ctx.timeZone,
      }),
    [copy, dealId, ctx.userId, ctx.now, ctx.timeZone],
  );
  const address = addressOfCopy(copy, dealId);
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.showing.list', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
    `showings:${dealId}`,
    'showings',
  );
  const [open, setOpen] = React.useState<Showing | null>(null);
  const [another, setAnother] = React.useState<Showing | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [checkIn, setCheckIn] = React.useState<Showing | null>(null);
  const decide = (s: Showing, decision: Decision, note: string | null = null) =>
    decideShowing({ workspaceId: ctx.workspaceId, showingId: s.id, decision, note }).then(() => {
      toast.show(note ? W.offered : decision === 'confirm' ? W.confirmed : W.declined);
    });
  const street = view?.street ?? deal?.name ?? '';
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-showings"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="showings">
          {(data) => (
            <ShowingsBody view={data} now={ctx.now} today={ctx.today} timeZone={ctx.timeZone} />
          )}
        </SummaryAnswer>
      ) : view ? (
        <ShowingsBody
          view={view}
          now={ctx.now}
          today={ctx.today}
          timeZone={ctx.timeZone}
          onOpen={setOpen}
          onDecide={(s, d) => void decide(s, d).catch((e: unknown) => toast.error(errorMessage(e)))}
          onAnother={setAnother}
          onCheckIn={setCheckIn}
          onAdd={() => setAdding(true)}
        />
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{RE_LISTING_ONLY(deal?.name ?? '')}</Text>
        </Card>
      )}
      {view || server.data ? (
        <ShowingLockboxes
          workspaceId={ctx.workspaceId}
          dealId={dealId}
          today={ctx.today}
          timeZone={ctx.timeZone}
        />
      ) : null}
      {view ? (
        <RequestSheet
          showing={open}
          view={view}
          onClose={() => setOpen(null)}
          onConfirm={(s) => decide(s, 'confirm')}
          onAnother={(s) => {
            setOpen(null);
            setAnother(s);
          }}
        />
      ) : null}
      <AnotherSheet
        showing={another}
        onClose={() => setAnother(null)}
        onSend={(s, note) => decide(s, 'decline', note)}
      />
      <AddShowingSheet
        open={adding}
        today={ctx.today}
        onClose={() => setAdding(false)}
        onAdd={async (s) => {
          await addShowing({
            workspaceId: ctx.workspaceId,
            dealId,
            startsAt: new Date(localInstant(s.date, s.time, ctx.timeZone)).toISOString(),
            minutes: view?.settings.minutes ?? 30,
            agentName: s.agentName,
            brokerage: s.brokerage,
            agentPhone: s.phone,
          });
          toast.show(W.added);
        }}
      />
      <CheckInSheet
        open={!!checkIn}
        onClose={() => setCheckIn(null)}
        workspaceId={ctx.workspaceId}
        place={address ?? street}
        about={W.about(street)}
        startsAt={checkIn?.startsAt}
        endsAt={checkIn?.endsAt}
      />
    </DealSubpage>
  );
}

/** "Lee Wong, Compass" */
const whoOf = (s: Showing) => [s.agentName, s.brokerage].filter(Boolean).join(', ');

export function ShowingsBody({
  view,
  now,
  today,
  timeZone,
  onOpen,
  onDecide,
  onAnother,
  onCheckIn,
  onAdd,
}: {
  view: ShowingListView;
  now: number;
  today: string;
  timeZone: string;
  onOpen?: (showing: Showing) => void;
  onDecide?: (showing: Showing, decision: Decision) => void;
  onAnother?: (showing: Showing) => void;
  onCheckIn?: (showing: Showing) => void;
  onAdd?: () => void;
}) {
  const asked = view.showings
    .filter((s) => s.state === 'requested' && s.can.confirm)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const coming = view.showings
    .filter((s) => s.state === 'confirmed' && Date.parse(s.endsAt) > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const t = view.themes;
  return (
    <View className="gap-3" testID="showings-body">
      {asked.length ? (
        <>
          <ListLabel>{`${W.asked}  ${asked.length}`}</ListLabel>
          {asked.map((s) => (
            <Card key={s.id} className="gap-2.5 p-4" testID={`showing-request-${s.id}`}>
              <Pressable
                role="button"
                onPress={onOpen ? () => onOpen(s) : undefined}
                className="gap-1"
              >
                <Text className="text-[15px] font-semibold">
                  {`${whenWords(s.startsAt, today, timeZone)} · ${whoOf(s)}`}
                </Text>
                <Text className="text-[13.5px] text-text-2">
                  {[s.sourceLabel, s.stateWords].join(' · ')}
                </Text>
              </Pressable>
              {onDecide ? (
                <View className="flex-row gap-2">
                  <Button
                    size="md"
                    className="flex-1"
                    onPress={() => onDecide(s, 'confirm')}
                    testID={`showing-yes-${s.id}`}
                  >
                    {W.yes}
                  </Button>
                  <Button
                    size="md"
                    variant="secondary"
                    className="flex-1"
                    onPress={() => onAnother?.(s)}
                    testID={`showing-another-${s.id}`}
                  >
                    {W.another}
                  </Button>
                  <Button
                    size="md"
                    variant="ghost"
                    onPress={() => onDecide(s, 'decline')}
                    testID={`showing-no-${s.id}`}
                  >
                    {W.no}
                  </Button>
                </View>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}
      {coming.length ? (
        <>
          <ListLabel>{`${W.coming}  ${coming.length}`}</ListLabel>
          <List testID="showings-coming">
            {coming.map((s) => (
              <CheckRow
                key={s.id}
                icon={CalendarDays}
                label={whenWords(s.startsAt, today, timeZone)}
                line={[whoOf(s), s.stateWords].filter(Boolean).join(' · ')}
                end={
                  onCheckIn ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => onCheckIn(s)}
                      testID={`showing-check-in-${s.id}`}
                    >
                      {W.checkIn}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </List>
        </>
      ) : null}
      {!asked.length && !coming.length && !view.showings.length ? (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.none}</Text>
        </Card>
      ) : null}
      {view.summary.answered ? (
        <>
          <ListLabel>{W.said}</ListLabel>
          <List testID="showings-said">
            <CheckRow
              icon={Star}
              label={t ? W.liked(t.likedWords) : view.summary.words}
              line={
                t
                  ? W.didnt(t.dislikedWords, view.summary.interestWords)
                  : view.summary.interestWords
              }
            />
          </List>
        </>
      ) : null}
      {onAdd ? (
        <Button variant="secondary" icon={Plus} onPress={onAdd} testID="showings-add">
          {W.add}
        </Button>
      ) : null}
      <SignalNote>{W.answerNote}</SignalNote>
    </View>
  );
}

/** Everything about one request; the lockbox code is never shown until it's sent. */
export function RequestSheet({
  showing: s,
  view,
  onClose,
  onConfirm,
  onAnother,
}: {
  showing: Showing | null;
  view: ShowingListView;
  onClose: () => void;
  onConfirm: (showing: Showing) => Promise<void>;
  onAnother: (showing: Showing) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setError(null), [s]);
  const seller = view.sellerFirstName;
  return (
    <Sheet
      open={!!s}
      onClose={onClose}
      title={s ? s.when : undefined}
      description={
        s ? [s.agentName, s.brokerage, s.agentPhone].filter(Boolean).join(' · ') : undefined
      }
      testID="showing-request-sheet"
    >
      {s ? (
        <View className="gap-3">
          <List>
            <CheckRow label={W.getIn} end={W.getInWords(view.settings.accessHours)} />
            {seller ? <CheckRow label={seller} end={s.stateWords} /> : null}
            <CheckRow label={W.feedback} end={W.feedbackWords(view.settings.feedbackHours)} />
          </List>
          <FieldError>{error}</FieldError>
          {s.can.confirm ? (
            <Button
              loading={busy}
              onPress={() => {
                setBusy(true);
                setError(null);
                onConfirm(s)
                  .then(onClose)
                  .catch((e: unknown) => setError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }}
              testID="showing-confirm"
            >
              {W.confirm}
            </Button>
          ) : null}
          {s.can.decline ? (
            <Button variant="secondary" onPress={() => onAnother(s)} testID="showing-offer-another">
              {W.offerAnother}
            </Button>
          ) : null}
          <SignalNote>{W.never}</SignalNote>
        </View>
      ) : null}
    </Sheet>
  );
}

/** Another time: the request is declined with what to offer, and the agent hears it. */
export function AnotherSheet({
  showing,
  onClose,
  onSend,
}: {
  showing: Showing | null;
  onClose: () => void;
  onSend: (showing: Showing, note: string) => Promise<void>;
}) {
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setNote('');
    setError(null);
  }, [showing]);
  return (
    <Sheet
      open={!!showing}
      onClose={onClose}
      title={W.anotherTitle}
      description={showing ? `${showing.when} · ${whoOf(showing)}` : undefined}
      testID="showing-another-sheet"
    >
      <View className="gap-3">
        <FieldLabel>{W.anotherWhat}</FieldLabel>
        <Input
          value={note}
          onChangeText={setNote}
          placeholder={W.anotherHint}
          testID="showing-another-note"
        />
        <FieldError>{error}</FieldError>
        <Button
          loading={busy}
          disabled={!note.trim()}
          onPress={() => {
            if (!showing) return;
            setBusy(true);
            setError(null);
            onSend(showing, note.trim())
              .then(onClose)
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
          testID="showing-another-send"
        >
          {W.sendIt}
        </Button>
        <SignalNote>{W.answerNote}</SignalNote>
      </View>
    </Sheet>
  );
}

export interface NewShowing {
  readonly agentName: string;
  readonly brokerage: string | null;
  readonly phone: string | null;
  readonly date: string;
  readonly time: string;
}

const TIMES = [
  '09:00',
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00',
  '18:00',
];

/** A showing asked for by phone, added by hand. */
export function AddShowingSheet({
  open,
  today,
  onClose,
  onAdd,
}: {
  open: boolean;
  today: string;
  onClose: () => void;
  onAdd: (showing: NewShowing) => Promise<void>;
}) {
  const days = React.useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(today, i)), [today]);
  const [agentName, setAgentName] = React.useState('');
  const [brokerage, setBrokerage] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [date, setDate] = React.useState(today);
  const [time, setTime] = React.useState('16:00');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setAgentName('');
    setBrokerage('');
    setPhone('');
    setDate(today);
    setError(null);
  }, [open, today]);
  const add = async () => {
    if (!agentName.trim()) {
      setError(W.sayWho);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd({
        agentName: agentName.trim(),
        brokerage: brokerage.trim() || null,
        phone: phone.trim() || null,
        date,
        time,
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.addTitle} testID="showing-add-sheet">
      <View className="gap-3">
        <FieldLabel>{W.agentName}</FieldLabel>
        <Input
          value={agentName}
          onChangeText={setAgentName}
          invalid={!!error && !agentName.trim()}
          testID="showing-add-agent"
        />
        <FieldLabel>{W.brokerage}</FieldLabel>
        <Input value={brokerage} onChangeText={setBrokerage} testID="showing-add-brokerage" />
        <FieldLabel>{W.phone}</FieldLabel>
        <Input
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          testID="showing-add-phone"
        />
        <FieldLabel>{W.when}</FieldLabel>
        <Chips
          value={date}
          onChange={setDate}
          options={days.map((d) => [d, fmtDateShort(d)] as const)}
          testID="showing-add-day"
        />
        <FieldLabel>{W.at}</FieldLabel>
        <Chips
          value={time}
          onChange={setTime}
          options={TIMES.map((t) => [t, fmtTime(`2000-01-01T${t}:00Z`, 'UTC')] as const)}
          testID="showing-add-time"
        />
        <FieldError testID="showing-add-error">{error}</FieldError>
        <Button loading={busy} onPress={() => void add()} testID="showing-add-save">
          {W.addIt}
        </Button>
      </View>
    </Sheet>
  );
}
