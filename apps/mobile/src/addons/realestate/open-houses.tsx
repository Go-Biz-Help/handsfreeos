import { addDays, fmtDateShort, fmtTime, fmtWhen, localInstant, smsConsentWords } from '@hfos/core';
import { streetOf } from '@hfos/core/addons/realestate/listing';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import {
  RE_LISTING_ONLY,
  RE_OPEN_HOUSE_WORDS as W,
  RE_VISITOR_WORDS as V,
} from '@hfos/core/addons/realestate/phone-words-listing';
import { addressOfCopy } from '@hfos/core/addons/realestate/views/listing';
import { openHousesOfCopy, type OpenHousesView } from '@hfos/core/addons/realestate/views/showings';
import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CalendarDays, CircleCheck, ShieldCheck, Users } from '@/components/icons';
import { CheckInSheet } from '@/components/safety/check-in-sheet';
import { useBusiness } from '@/components/shell/business-context';
import { List, ListLabel } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { useReChanges } from './deal-bits';
import { planOpenHouse, signInVisitor } from './listing-actions';
import {
  ChangeButton,
  CheckRow,
  Chips,
  DealSubpage,
  FieldError,
  FieldLabel,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * Hosting an open house on the phone (board 88, third panel): the one on now or next, who's hosting and how many
 * signed in, the sign-in sheet handed to a visitor (it works with no signal: each sign-in waits on the phone and says
 * so in the list until it sends), and Check in for showing safety (board 90). `?plan=1` opens planning one, which goes
 * on the calendar.
 */

type OpenHouse = OpenHousesView['openHouses'][number];
export type Visitor = OpenHouse['visitors'][number];

export function OpenHousesScreen({ dealId, plan }: { dealId: string; plan?: boolean }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const { business } = useBusiness();
  const view = React.useMemo(
    () => openHousesOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const address = addressOfCopy(copy, dealId);
  const street = address ? streetOf(address) : (deal?.name ?? '');
  const changes = useReChanges(ctx.workspaceId);
  // Sign-ins made on this phone that haven't reached HandsFreeOS yet, by the phone's id.
  const waiting = React.useMemo(
    () =>
      new Set(
        changes
          .filter((c) => c.name === 'realestate.open_house.sign_in')
          .map((c) => c.input.id)
          .filter((x): x is string => typeof x === 'string'),
      ),
    [changes],
  );
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.open_houses', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
    `open-houses:${dealId}`,
    'open houses',
  );
  const [planning, setPlanning] = React.useState(!!plan);
  const [checkIn, setCheckIn] = React.useState<OpenHouse | null>(null);
  const [handed, setHanded] = React.useState<OpenHouse | null>(null);
  const current = view ? currentOpenHouse(view, ctx.now) : null;
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={current ? W.title : W.titleMany}
      subtitle={address ? street : undefined}
      testID="re-open-houses"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="open houses">
          {(data) => <OpenHousesBody view={data} now={ctx.now} timeZone={ctx.timeZone} />}
        </SummaryAnswer>
      ) : view ? (
        <OpenHousesBody
          view={view}
          now={ctx.now}
          timeZone={ctx.timeZone}
          waiting={waiting}
          onHand={setHanded}
          onCheckIn={setCheckIn}
          onPlan={() => setPlanning(true)}
        />
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{RE_LISTING_ONLY(deal?.name ?? '')}</Text>
        </Card>
      )}
      <PlanSheet
        open={planning && !!view}
        today={ctx.today}
        onClose={() => setPlanning(false)}
        onPlan={async (date, time, hours) => {
          await planOpenHouse({
            workspaceId: ctx.workspaceId,
            dealId,
            startsAt: new Date(localInstant(date, time, ctx.timeZone)).toISOString(),
            durationMinutes: hours * 60,
          });
          toast.show(W.planned);
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
      <VisitorSignIn
        openHouse={handed}
        street={street}
        business={business.name}
        timeZone={ctx.timeZone}
        onHandBack={() => setHanded(null)}
        onSignIn={async (v) => {
          if (!handed) return;
          await signInVisitor({
            workspaceId: ctx.workspaceId,
            dealId,
            openHouseId: handed.id,
            ...v,
          });
        }}
      />
    </DealSubpage>
  );
}

/** The open house on now, else the next one planned. */
export function currentOpenHouse(view: OpenHousesView, now: number): OpenHouse | null {
  return view.openHouses.find((o) => o.state === 'planned' && Date.parse(o.endsAt) > now) ?? null;
}

export function OpenHousesBody({
  view,
  now,
  timeZone,
  waiting,
  onHand,
  onCheckIn,
  onPlan,
}: {
  view: OpenHousesView;
  now: number;
  timeZone: string;
  /** Sign-ins made on this phone, not sent yet. */
  waiting?: ReadonlySet<string>;
  onHand?: (openHouse: OpenHouse) => void;
  onCheckIn?: (openHouse: OpenHouse) => void;
  onPlan?: () => void;
}) {
  const current = currentOpenHouse(view, now);
  const others = view.openHouses.filter((o) => o.id !== current?.id);
  const visitors = current ? [...current.visitors].reverse() : [];
  return (
    <View className="gap-3" testID="open-houses-body">
      {current ? (
        <>
          <Card className="gap-1 p-4" testID="open-house-current">
            <Text className="text-[15px] font-semibold">
              {W.card(fmtWhen(current.startsAt, current.endsAt, timeZone))}
            </Text>
            <Text className="text-[13.5px] text-text-2">
              {current.host
                ? W.hosting(current.host.fullName, current.visitors.length)
                : W.noHost(current.visitors.length)}
            </Text>
          </Card>
          {onHand ? (
            <Button icon={Users} onPress={() => onHand(current)} testID="open-house-hand">
              {W.handTo}
            </Button>
          ) : null}
          {onCheckIn ? (
            <Button
              variant="secondary"
              icon={ShieldCheck}
              onPress={() => onCheckIn(current)}
              testID="open-house-check-in"
            >
              {W.checkIn}
            </Button>
          ) : null}
          <ListLabel>{`${W.signedIn}  ${current.visitors.length}`}</ListLabel>
          {visitors.length ? (
            <List testID="open-house-visitors">
              {visitors.map((v) => {
                const sending = waiting?.has(v.id) ?? false;
                return (
                  <CheckRow
                    key={v.id}
                    label={[v.firstName, v.lastName].filter(Boolean).join(' ')}
                    line={
                      sending
                        ? RE_PHONE_WORDS.waitingToSend
                        : v.withAgent
                          ? W.agent(v.agentName)
                          : W.hasAgent(v.smsConsent)
                    }
                    end={fmtTime(v.signedInAt, timeZone)}
                    waiting={sending}
                    testID={`open-house-visitor-${v.id}`}
                  />
                );
              })}
            </List>
          ) : (
            <Text className="px-1 text-[13.5px] text-text-3">{W.noVisitors}</Text>
          )}
        </>
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.none}</Text>
        </Card>
      )}
      {others.length ? (
        <>
          <ListLabel>{W.others}</ListLabel>
          <List>
            {others.map((o) => (
              <CheckRow
                key={o.id}
                icon={o.visitors.length ? Users : CalendarDays}
                label={fmtWhen(o.startsAt, o.endsAt, timeZone)}
                line={[
                  W.states[o.state] ?? o.state,
                  o.visitors.length ? W.noHost(o.visitors.length) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
          </List>
        </>
      ) : null}
      {onPlan ? (
        <Button variant="secondary" icon={CalendarDays} onPress={onPlan} testID="open-house-plan">
          {W.plan}
        </Button>
      ) : null}
    </View>
  );
}

export interface VisitorEntry {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly withAgent: boolean;
  readonly agentName: string | null;
  readonly smsConsent: boolean;
}

/**
 * The sign-in sheet, safe to hand to a visitor: it covers the whole screen, with no way into the rest of the app, and
 * the public page's own words and rules (an email or a phone; texts only with a yes, never for someone with an
 * agent). After each sign-in it thanks them; "Done, hand it back" returns the host to the open house.
 */
export function VisitorSignIn({
  openHouse,
  street,
  business,
  timeZone,
  onSignIn,
  onHandBack,
}: {
  openHouse: OpenHouse | null;
  street: string;
  business: string;
  timeZone: string;
  onSignIn: (visitor: VisitorEntry) => Promise<void>;
  onHandBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [first, setFirst] = React.useState('');
  const [last, setLast] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [withAgent, setWithAgent] = React.useState<'yes' | 'no'>('no');
  const [agentName, setAgentName] = React.useState('');
  const [consent, setConsent] = React.useState(false);
  const [thanked, setThanked] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const clear = React.useCallback(() => {
    setFirst('');
    setLast('');
    setEmail('');
    setPhone('');
    setWithAgent('no');
    setAgentName('');
    setConsent(false);
    setThanked(null);
    setError(null);
  }, []);
  React.useEffect(() => {
    if (openHouse) clear();
  }, [openHouse, clear]);
  const words = smsConsentWords(business, 'form');
  const signIn = async () => {
    if (!first.trim() || (!email.trim() && !phone.trim())) {
      setError(V.needs);
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(V.badEmail);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const agent = withAgent === 'yes';
      await onSignIn({
        firstName: first.trim(),
        lastName: last.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        withAgent: agent,
        agentName: agent ? agentName.trim() || null : null,
        smsConsent: !agent && !!phone.trim() && consent,
      });
      setThanked(first.trim());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      visible={!!openHouse}
      animationType="slide"
      presentationStyle="fullScreen"
      // Only the host's "Done, hand it back" closes it: a visitor can't step back into the app.
      onRequestClose={() => undefined}
      testID="visitor-sign-in"
    >
      <KeyboardAvoidingView
        className="flex-1 bg-bg"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerClassName="gap-3 px-5"
          contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text variant="heading">{V.welcome(street)}</Text>
          {openHouse ? (
            <Text variant="lead">
              {V.when(
                fmtWhen(openHouse.startsAt, openHouse.endsAt, timeZone),
                openHouse.host?.fullName ?? null,
              )}
            </Text>
          ) : null}
          {thanked ? (
            <Card className="gap-2 p-5" testID="visitor-thanks">
              <View className="flex-row items-center gap-2">
                <Icon as={CircleCheck} className="size-5 text-success-text" />
                <Text className="text-lg font-semibold">{V.thanks(thanked)}</Text>
              </View>
              <Text className="text-[15px] text-text-2">{V.enjoy}</Text>
              <Button variant="secondary" onPress={clear} testID="visitor-next">
                {V.next}
              </Button>
            </Card>
          ) : (
            <>
              <View className="flex-row gap-3">
                <View className="flex-1 gap-1.5">
                  <FieldLabel>{V.first}</FieldLabel>
                  <Input
                    value={first}
                    onChangeText={setFirst}
                    autoComplete="given-name"
                    testID="visitor-first"
                  />
                </View>
                <View className="flex-1 gap-1.5">
                  <FieldLabel>{V.last}</FieldLabel>
                  <Input
                    value={last}
                    onChangeText={setLast}
                    autoComplete="family-name"
                    testID="visitor-last"
                  />
                </View>
              </View>
              <FieldLabel>{V.email}</FieldLabel>
              <Input
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                testID="visitor-email"
              />
              <FieldLabel>{V.phone}</FieldLabel>
              <Input
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                testID="visitor-phone"
              />
              <FieldLabel>{V.withAgent}</FieldLabel>
              <Segmented
                label={V.withAgent}
                value={withAgent}
                onChange={setWithAgent}
                options={[
                  { value: 'yes', label: V.yes, testID: 'visitor-agent-yes' },
                  { value: 'no', label: V.no, testID: 'visitor-agent-no' },
                ]}
              />
              {withAgent === 'yes' ? (
                <>
                  <FieldLabel>{V.agentName}</FieldLabel>
                  <Input value={agentName} onChangeText={setAgentName} testID="visitor-agent" />
                </>
              ) : phone.trim() ? (
                <View className="gap-1.5" testID="visitor-consent">
                  <View className="flex-row items-center gap-3">
                    <Text className="flex-1 text-[14px] font-medium">{words.title}</Text>
                    <Switch
                      label={words.title}
                      checked={consent}
                      onCheckedChange={setConsent}
                      testID="visitor-sms"
                    />
                  </View>
                  <Text className="text-xs leading-[17px] text-text-3">{words.detail}</Text>
                </View>
              ) : null}
              <FieldError testID="visitor-error">{error}</FieldError>
              <Button loading={busy} onPress={() => void signIn()} testID="visitor-sign-in-save">
                {V.signIn}
              </Button>
            </>
          )}
          <Text className="pt-2 text-[12.5px] text-text-3">{V.equal(business)}</Text>
          <Button variant="ghost" onPress={onHandBack} testID="visitor-hand-back">
            {V.handBack}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const TIMES = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00'] as const;

/** Planning an open house: the day, when it starts and how long. */
export function PlanSheet({
  open,
  today,
  onClose,
  onPlan,
}: {
  open: boolean;
  today: string;
  onClose: () => void;
  onPlan: (date: string, time: string, hours: number) => Promise<void>;
}) {
  const days = React.useMemo(
    () => Array.from({ length: 8 }, (_, i) => addDays(today, i + 1)),
    [today],
  );
  const [date, setDate] = React.useState(days[0]!);
  const [time, setTime] = React.useState<string>('13:00');
  const [hours, setHours] = React.useState<'2' | '3'>('2');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setDate(days[0]!);
    setError(null);
  }, [open, days]);
  return (
    <Sheet open={open} onClose={onClose} title={W.planTitle} testID="open-house-plan-sheet">
      <View className="gap-3">
        <FieldLabel>{W.day}</FieldLabel>
        <Chips
          value={date}
          onChange={setDate}
          options={days.map((d) => [d, fmtDateShort(d)] as const)}
          testID="open-house-day"
        />
        <FieldLabel>{W.starts}</FieldLabel>
        <Chips
          value={time}
          onChange={setTime}
          options={TIMES.map((t) => [t, fmtTime(`2000-01-01T${t}:00Z`, 'UTC')] as const)}
          testID="open-house-time"
        />
        <FieldLabel>{W.length}</FieldLabel>
        <Chips
          value={hours}
          onChange={setHours}
          options={[
            ['2', W.hours(2)],
            ['3', W.hours(3)],
          ]}
          testID="open-house-length"
        />
        <FieldError>{error}</FieldError>
        <ChangeButton
          command="realestate.open_house.plan"
          label={W.planIt}
          why={W.planWhy}
          loading={busy}
          onPress={() => {
            setBusy(true);
            setError(null);
            onPlan(date, time, Number(hours))
              .then(onClose)
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
          testID="open-house-plan-save"
        />
      </View>
    </Sheet>
  );
}
