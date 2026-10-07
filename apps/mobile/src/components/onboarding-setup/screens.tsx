import {
  AI_SETUP_FIELD_WORDS as AW,
  aiSetupProblemAt,
  CUSTOMER_SOURCES,
  LINK_WORDS,
  ONBOARDING_GOALS,
  ONBOARDING_SETUP_HAND_OVER_WORDS as HW,
  ONBOARDING_KIND_INFO,
  ONBOARDING_SETUP_MAX,
  ONBOARDING_SETUP_WORDS as W,
  PAY_WITH,
  PICKED_CONTACT_WORDS as PC,
  QUESTION_WORDS,
  setupFor,
  TEAM_SIZES,
  withAiName,
  WIZARD_WORDS,
  type AiSetupAnswers,
  type AiSetupProblems,
  type CustomerSource,
  type HandOverRole,
  type OnboardingSetupAnswers,
  type OnboardingSetupState,
  type OnboardingStepKey,
  type Permission,
} from '@hfos/core';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, Share, View } from 'react-native';

import { Field, Option, Pills, ServicesField, TextArea } from '@/components/ai-setup/fields';
import { HoursField } from '@/components/ai-setup/hours';
import {
  Check,
  CircleAlert,
  Clock,
  ExternalLink,
  Info,
  Mail,
  Plus,
  Share as ShareIcon,
  Trash,
  TriangleAlert,
  UserPlus,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { usePickCustomer } from '@/customers/pick-contact';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { NotInThisBuild, type OnboardingSetupCalls } from '@/onboarding-setup/calls';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * The onboarding setup's own screens on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8),
 * as the web's components/onboarding-setup/screens.tsx: the goal, about the business, the hours, the customers, the
 * booking page, payments and reviews. The first screen is business.tsx, the number number.tsx, and the AI teammate's
 * are the AI quick setup's own. Each only shows and changes answers, or does a stop's job in place where a phone
 * can (the payment provider's sign-in); the frame (quick-setup.tsx) checks, keeps and saves. What's easier on a
 * computer (a spreadsheet, the move from GoHighLevel, a calendar's sign-in) emails the person a link, as Getting
 * started does on the phone.
 *
 * Someone from the business's agency setting it up for the owner (`state.forClient`, §9) leaves what's the owner's
 * to them: the booking page, payments and the phone's contacts. They hand it over in place of "Stay in the loop"
 * (`HandOverScreen`), and the owner first checks what they set up (`CheckScreen`).
 */

type OwnField = Exclude<keyof OnboardingSetupAnswers, 'ai'>;

export interface OwnScreenProps {
  readonly workspaceId: string;
  readonly state: OnboardingSetupState;
  readonly answers: OnboardingSetupAnswers;
  readonly set: <K extends OwnField>(key: K, value: OnboardingSetupAnswers[K]) => void;
  readonly setAi: <K extends keyof AiSetupAnswers>(key: K, value: AiSetupAnswers[K]) => void;
  /** By path into the answers: `reviewLink`, `ai.services.0.name`, `invite.0`. */
  readonly problems: AiSetupProblems;
  readonly calls: OnboardingSetupCalls;
  /** The AI teammate's name, for the words. */
  readonly name: string;
  /** Whether this person may do it: `channels.manage` for the number, `money.manage` for payments. */
  readonly can: (permission: Permission) => boolean;
  /** Asks where the setup stands now: after a number is bought, or back from a sign-in. */
  readonly refresh: () => Promise<void>;
}

/** The AI part's problems at its own paths, as its fields read them: `ai.services.0.name` → `services.0.name`. */
export const aiProblemsOf = (problems: AiSetupProblems): AiSetupProblems =>
  Object.fromEntries(
    Object.entries(problems).flatMap(([path, message]) =>
      path.startsWith('ai.') ? [[path.slice(3), message]] : [],
    ),
  );

const NOTE_TONES = {
  info: { box: 'bg-card-2', text: 'text-text-2', icon: 'text-text-3' },
  accent: { box: 'bg-accent-soft', text: 'text-accent-text', icon: 'text-accent-text' },
  success: { box: 'bg-success-soft', text: 'text-success-text', icon: 'text-success-text' },
  warning: { box: 'bg-warning-soft', text: 'text-warning-text', icon: 'text-warning-text' },
  danger: { box: 'bg-danger-soft', text: 'text-danger-text', icon: 'text-danger-text' },
} as const;

/** A line in a tinted box: what's happening, or what to know, with a button under it when there's one. */
export function Note({
  tone = 'info',
  icon,
  busy,
  children,
  action,
  testID,
}: {
  tone?: keyof typeof NOTE_TONES;
  icon?: LucideIcon;
  /** A spinner in place of the icon: something's still going. */
  busy?: boolean;
  children: string;
  action?: React.ReactNode;
  testID?: string;
}) {
  const look = NOTE_TONES[tone];
  const colors = useColors();
  return (
    <View
      className={cn('flex-row items-start gap-2.5 rounded-menu px-3.5 py-3', look.box)}
      role={tone === 'warning' || tone === 'danger' ? 'alert' : undefined}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tone === 'accent' ? colors.accent : colors.text3} />
      ) : icon ? (
        <Icon as={icon} className={cn('mt-0.5 size-4', look.icon)} />
      ) : null}
      <View className="min-w-0 flex-1 items-start gap-2">
        <Text className={cn('text-[13.5px] leading-[19px]', look.text)}>{children}</Text>
        {action}
      </View>
    </View>
  );
}

/** A stop's own part while it's fetched. */
export function Loading() {
  return (
    <Note busy testID="onboarding-setup-loading">
      {W.loading}
    </Note>
  );
}

/** While Ava reads the website for these screens. */
function Reading({ state, name }: { state: OnboardingSetupState; name: string }) {
  if (!state.reading) return null;
  return (
    <Note tone="accent" busy testID="ai-setup-reading">
      {withAiName(AW.reading, name)}
    </Note>
  );
}

/** A few answers to pick one of. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-2" role="radiogroup" accessibilityLabel={label}>
      {children}
    </View>
  );
}

/**
 * "Email me a link": a part that's easier on a computer, sent to the person's own email
 * (`onboarding.send_link`), as Getting started does on the phone.
 */
export function EmailMeALink({
  workspaceId,
  step,
  testID,
}: {
  workspaceId: string;
  step: OnboardingStepKey;
  testID: string;
}) {
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState(false);
  const send = async () => {
    if (!online) {
      toast.error(P.needsSignal);
      return;
    }
    setBusy(true);
    try {
      const out = unwrap(
        await api.POST('/v1/commands/onboarding.send_link', { body: { workspaceId, step } }),
      );
      toast.show(out.sent ? LINK_WORDS.sent(out.email) : LINK_WORDS.alreadySent(out.email));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={Mail}
      loading={busy}
      onPress={() => void send()}
      testID={testID}
    >
      {LINK_WORDS.action}
    </Button>
  );
}

// ---- What do you want help with first? ----

export function GoalScreen({
  state,
  answers,
  set,
  problems,
  invites,
  setInvites,
}: OwnScreenProps & {
  /** "Invite them now", as typed. */
  readonly invites: readonly string[];
  readonly setInvites: (next: string[]) => void;
}) {
  const room = ONBOARDING_SETUP_MAX.invites - invites.length;
  return (
    <>
      <Group label={QUESTION_WORDS.goal}>
        {ONBOARDING_GOALS.map((goal) => (
          <Option
            key={goal}
            on={answers.goal === goal}
            onSelect={() => set('goal', goal)}
            title={W.goals[goal]}
            testID={`setup-goal-${goal}`}
          />
        ))}
      </Group>
      <Pills
        name="team-size"
        legend={W.teamSize}
        options={TEAM_SIZES}
        labels={W.teams}
        value={answers.teamSize}
        onChange={(teamSize) => set('teamSize', teamSize)}
      />
      {answers.teamSize !== 'solo' ? (
        <View className="gap-2" testID="setup-invites">
          <View className="gap-1">
            <Label>{W.inviteNow}</Label>
            <Text className="text-[13px] leading-[18px] text-text-3">{W.inviteHint}</Text>
          </View>
          {invites.map((email, i) => (
            <View key={i} className="gap-1">
              <View className="flex-row items-center gap-1">
                <View className="min-w-0 flex-1">
                  <Input
                    value={email}
                    onChangeText={(text) => setInvites(invites.map((x, j) => (j === i ? text : x)))}
                    placeholder={W.inviteEmail}
                    accessibilityLabel={W.inviteEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    maxLength={254}
                    invalid={!!problems[`invite.${i}`]}
                    testID={`setup-invite-${i}`}
                  />
                </View>
                <Pressable
                  role="button"
                  accessibilityLabel={W.removeInvite}
                  onPress={() => setInvites(invites.filter((_, j) => j !== i))}
                  testID={`setup-invite-${i}-remove`}
                  hitSlop={4}
                  className="size-11 items-center justify-center rounded-full active:bg-card-2"
                >
                  <Icon as={Trash} className="size-[18px] text-text-3" />
                </Pressable>
              </View>
              <FieldError>{problems[`invite.${i}`]}</FieldError>
            </View>
          ))}
          {room > 0 ? (
            <Button
              variant="ghost"
              size="md"
              icon={Plus}
              className="self-start"
              onPress={() => setInvites([...invites, ''])}
              testID="setup-invite-add"
            >
              {W.addInvite}
            </Button>
          ) : null}
          <FieldError>{problems['invite']}</FieldError>
          {state.team.invited.map((email) => (
            <View key={email} className="flex-row items-center gap-2">
              <Icon as={Check} className="size-4 text-success-text" strokeWidth={2} />
              <Text className="text-[13.5px] text-success-text">{W.invited(email)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

// ---- About your business ----

export function AboutScreen({ state, answers, set, setAi, problems, name }: OwnScreenProps) {
  const ai = aiProblemsOf(problems);
  const { area } = setupFor(state.industry);
  return (
    <>
      <Reading state={state} name={name} />
      <Field label={AW.description} error={ai['description']}>
        <TextArea
          value={answers.ai.description}
          onChangeText={(text) => setAi('description', text)}
          maxLength={2000}
          invalid={!!ai['description']}
          accessibilityLabel={AW.description}
          testID="ai-setup-description"
        />
      </Field>
      <ServicesField
        services={answers.ai.services}
        onChange={(next) => setAi('services', next)}
        problems={ai}
        legend={ONBOARDING_KIND_INFO[state.kind].services}
        priced
      />
      <Field label={area.question} error={ai['area']}>
        <Input
          value={answers.ai.area}
          onChangeText={(text) => setAi('area', text)}
          maxLength={500}
          placeholder={area.example}
          invalid={!!ai['area']}
          accessibilityLabel={area.question}
          testID="ai-setup-area"
        />
      </Field>
      <View className="gap-1.5">
        <Pills
          name="books-time"
          legend={W.booksTime}
          options={['yes', 'no'] as const}
          labels={{ yes: AW.yes, no: AW.no }}
          value={answers.booksTime ? 'yes' : 'no'}
          onChange={(v) => set('booksTime', v === 'yes')}
        />
        <Text className="text-[13px] leading-[18px] text-text-3">{W.booksTimeHint}</Text>
      </View>
    </>
  );
}

// ---- When are you open? ----

export function HoursScreen({ state, answers, setAi, problems, name }: OwnScreenProps) {
  return (
    <>
      <Reading state={state} name={name} />
      <View className="gap-1">
        <Label>{AW.openHours}</Label>
        <HoursField
          value={answers.ai.openHours}
          onChange={(next) => setAi('openHours', next)}
          idPrefix="setup-open"
          error={aiSetupProblemAt(aiProblemsOf(problems), 'openHours')}
        />
      </View>
    </>
  );
}

// ---- Where are your customers now? ----

const SOURCE_HINTS: Readonly<Record<CustomerSource, string>> = {
  ghl: W.ghlHint,
  sheet: W.sheetHint,
  crm: W.crmHint,
  phone: P.phoneHint,
  none: W.noneHint,
};

export function CustomersScreen({ workspaceId, state, answers, set, can }: OwnScreenProps) {
  const source = answers.customersIn;
  return (
    <>
      <Group label={QUESTION_WORDS.customersIn}>
        {CUSTOMER_SOURCES.map((s) => (
          <Option
            key={s}
            on={source === s}
            onSelect={() => set('customersIn', s)}
            title={W.sources[s]}
            description={SOURCE_HINTS[s]}
            testID={`setup-customers-${s}`}
          />
        ))}
      </Group>
      {source === 'ghl' || source === 'sheet' || source === 'crm' ? (
        <Note
          icon={Info}
          action={
            <EmailMeALink
              workspaceId={workspaceId}
              step="customers"
              testID="setup-customers-link"
            />
          }
          testID="setup-customers-computer"
        >
          {P.customersOnComputer}
        </Note>
      ) : source === 'phone' && state.forClient ? (
        // This phone's contacts aren't the business's: the owner picks theirs once they join.
        <Note icon={Info} testID="setup-customers-owner">
          {HW.phoneWaits}
        </Note>
      ) : source === 'phone' && can('records.write') ? (
        <PickFromContacts workspaceId={workspaceId} />
      ) : null}
    </>
  );
}

/**
 * Customers picked from this phone's contacts one at a time (call 8), each added as it's picked, and the list of who
 * came in so far. Someone already a customer is listed as such rather than added twice.
 */
function PickFromContacts({ workspaceId }: { workspaceId: string }) {
  const { pick, picking } = usePickCustomer(workspaceId);
  const [picked, setPicked] = React.useState<
    readonly { readonly id: string; readonly name: string; readonly already: boolean }[]
  >([]);

  const onPick = async () => {
    const result = await pick();
    if (result.kind === 'failed') toast.error(result.message);
    if (result.kind !== 'added' && result.kind !== 'already') return;
    setPicked((list) => [
      ...list.filter((p) => p.id !== result.id),
      { id: result.id, name: result.name, already: result.kind === 'already' },
    ]);
  };

  return (
    <View className="gap-3">
      <Note
        icon={Info}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={UserPlus}
            loading={picking}
            onPress={() => void onPick()}
            testID="setup-customers-pick"
          >
            {picked.length ? PC.pickAnother : PC.pick}
          </Button>
        }
        testID="setup-customers-contacts"
      >
        {PC.onlyPicked}
      </Note>
      {picked.length ? (
        <View testID="setup-customers-picked">
          {picked.map((p) => (
            <View
              key={p.id}
              className="min-h-11 flex-row items-center justify-between gap-3 border-b border-border py-2"
              testID={`setup-picked-${p.id}`}
            >
              <Text className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>
                {p.name}
              </Text>
              <Badge variant={p.already ? 'gray' : 'ok'}>
                {p.already ? PC.alreadyTag : PC.addedTag}
              </Badge>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---- Your booking page is ready ----

/** What making the booking page did, from the frame, which makes it as the screen opens. */
export interface BookingMade {
  readonly making: boolean;
  readonly changes: readonly string[];
  readonly notes: readonly string[];
  readonly error: string | null;
}

export function BookingScreen({
  workspaceId,
  state,
  calls,
  booking,
  onRetry,
}: OwnScreenProps & { readonly booking: BookingMade; readonly onRetry: () => void }) {
  const [origin, setOrigin] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void calls.publicOrigin().then((o) => {
      if (!cancelled) setOrigin(o);
    });
    return () => {
      cancelled = true;
    };
  }, [calls]);
  const site = state.booking.site;
  const link = site && origin ? `${origin}/book/${site.slug}` : null;
  // The owner makes it when they finish: the question and its hint say so.
  if (state.forClient) return null;
  return (
    <>
      {booking.making ? (
        <Note tone="accent" busy testID="setup-booking-making">
          {W.makingBooking}
        </Note>
      ) : null}
      {booking.error ? (
        <Note
          tone="danger"
          icon={TriangleAlert}
          action={
            <Button variant="secondary" size="sm" onPress={onRetry} testID="setup-booking-retry">
              {WIZARD_WORDS.calendarMake}
            </Button>
          }
        >
          {booking.error}
        </Note>
      ) : null}
      {booking.changes.length ? (
        <View className="gap-1.5" testID="setup-booking-changes">
          {booking.changes.map((line) => (
            <View key={line} className="flex-row items-start gap-2">
              <Icon as={Check} className="mt-0.5 size-4 text-success-text" strokeWidth={2} />
              <Text className="min-w-0 flex-1 text-[14.5px] leading-[20px]">{line}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {booking.notes.map((note) => (
        <Note key={note} tone="warning" icon={TriangleAlert}>
          {note}
        </Note>
      ))}
      {link && state.booking.on ? (
        <View className="gap-2" testID="setup-booking-link">
          <Label>{W.bookingAt}</Label>
          <View className="rounded-menu border border-border bg-card px-3.5 py-3">
            <Text className="text-[14.5px]" selectable numberOfLines={2}>
              {link}
            </Text>
          </View>
          <View className="flex-row flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={ShareIcon}
              onPress={() => void Share.share({ message: link, url: link })}
              testID="setup-booking-share"
            >
              {P.share}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={ExternalLink}
              onPress={() => void Linking.openURL(link)}
              testID="setup-booking-open"
            >
              {W.openBooking}
            </Button>
          </View>
        </View>
      ) : null}
      <View className="gap-2 rounded-menu border border-border p-4">
        <View className="gap-0.5">
          <Text className="text-[15px] font-semibold">{W.connectCalendar}</Text>
          <Text className="text-[13px] leading-[18px] text-text-2">
            {`${W.connectCalendarHint} ${P.calendarOnComputer}`}
          </Text>
        </View>
        <View className="flex-row">
          <EmailMeALink workspaceId={workspaceId} step="my_calendar" testID="setup-calendar-link" />
        </View>
      </View>
    </>
  );
}

// ---- Get paid, and get reviews ----

const PROVIDER_NAME = { stripe: 'Stripe', square: 'Square' } as const;

export function PaidScreen({
  workspaceId,
  state,
  answers,
  set,
  problems,
  calls,
  can,
  refresh,
}: OwnScreenProps) {
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState(false);
  const [help, setHelp] = React.useState(false);
  const [noBuild, setNoBuild] = React.useState(false);

  // Back from the provider's sign-in: what it connected.
  const away = React.useRef(false);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && away.current) {
        away.current = false;
        void refresh();
      }
    });
    return () => sub.remove();
  }, [refresh]);

  const connect = async (provider: 'stripe' | 'square') => {
    if (!online) {
      toast.error(P.needsSignal);
      return;
    }
    setBusy(true);
    try {
      const url = await calls.paymentsSignIn(provider);
      away.current = true;
      // The provider's own page, in the phone's browser over the app. Closing it comes straight back here.
      await WebBrowser.openBrowserAsync(url);
      await refresh();
    } catch (e) {
      if (e instanceof NotInThisBuild) setNoBuild(true);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const p = state.payments;
  const provider = p.provider ? PROVIDER_NAME[p.provider] : null;
  const picked = answers.payWith === 'later' ? null : answers.payWith;
  const mayConnect = can('money.manage');
  return (
    <>
      <View className="gap-2">
        <Label>{W.payWith}</Label>
        <Group label={W.payWith}>
          {PAY_WITH.map((pay) => (
            <Option
              key={pay}
              on={answers.payWith === pay}
              onSelect={() => set('payWith', pay)}
              title={W.payWithLabels[pay]}
              badge={
                pay === 'stripe' ? (
                  <Badge variant="gray">{WIZARD_WORDS.providers.stripe.badge}</Badge>
                ) : null
              }
              description={pay === 'later' ? W.payLater : WIZARD_WORDS.providers[pay].detail}
              testID={`setup-pay-${pay}`}
            />
          ))}
        </Group>
      </View>
      {p.active && provider ? (
        p.checking ? (
          <Note tone="warning" icon={Clock} testID="setup-pay-checking">
            {WIZARD_WORDS.paymentsWaiting(provider)}
          </Note>
        ) : (
          <Note tone="success" icon={Check} testID="setup-pay-connected">
            {W.payConnected(provider)}
          </Note>
        )
      ) : p.broken && p.provider && provider && !state.forClient ? (
        <Note
          tone="danger"
          icon={CircleAlert}
          action={
            mayConnect ? (
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onPress={() => void connect(p.provider!)}
              >
                {WIZARD_WORDS.connect(provider)}
              </Button>
            ) : null
          }
        >
          {W.paySignInAgain(provider)}
        </Note>
      ) : null}
      {picked && !(p.provider === picked && (p.active || p.broken)) ? (
        state.forClient ? (
          // Payments go to the owner's own account, so they sign in when they finish.
          <Note icon={Info} testID="setup-pay-owner">
            {HW.payWaits(W.payWithLabels[picked])}
          </Note>
        ) : !mayConnect ? (
          <Note icon={Info}>{W.cantDo}</Note>
        ) : noBuild ? (
          <Note
            icon={Info}
            action={
              <EmailMeALink workspaceId={workspaceId} step="payments" testID="setup-pay-link" />
            }
          >
            {P.payOnComputer}
          </Note>
        ) : (
          <View className="gap-1.5">
            <Button
              className="self-start"
              loading={busy}
              onPress={() => void connect(picked)}
              testID="setup-pay-connect"
            >
              {WIZARD_WORDS.connect(W.payWithLabels[picked])}
            </Button>
            <Text className="text-[13px] leading-[18px] text-text-3">{P.payBack}</Text>
          </View>
        )
      ) : null}
      <View className="gap-1.5">
        <Field label={W.reviewLink} error={problems['reviewLink']} hint={W.reviewLinkHint}>
          <Input
            value={answers.reviewLink}
            onChangeText={(text) => set('reviewLink', text)}
            placeholder="g.page/r/…"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={ONBOARDING_SETUP_MAX.reviewLink}
            invalid={!!problems['reviewLink']}
            accessibilityLabel={W.reviewLink}
            testID="setup-review-link"
          />
        </Field>
        <Pressable
          role="button"
          aria-expanded={help}
          onPress={() => setHelp((v) => !v)}
          hitSlop={8}
          className="self-start py-1"
          testID="setup-review-help"
        >
          <Text className="text-[13.5px] font-medium text-accent-text">{W.findReviewLink}</Text>
        </Pressable>
        {help ? <Note icon={Info}>{W.reviewLinkHelp}</Note> : null}
      </View>
    </>
  );
}

// ---- Hand it to the owner ----

/** For someone from the agency, in place of "Stay in the loop": whom to invite to check it and finish. */
export function HandOverScreen({
  email,
  onChange,
  role,
  error,
}: {
  readonly email: string;
  readonly onChange: (email: string) => void;
  /** What they're invited as: an owner, when whoever hands it over may make one. */
  readonly role: HandOverRole;
  readonly error?: string;
}) {
  return (
    <Field label={HW.ownerEmail} error={error} hint={HW.ownerEmailHint(role)}>
      <Input
        value={email}
        onChangeText={onChange}
        placeholder="owner@theirbusiness.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        maxLength={254}
        invalid={!!error}
        accessibilityLabel={HW.ownerEmail}
        testID="setup-owner-email"
      />
    </Field>
  );
}

// ---- Check what your agency set up ----

/** The owner's first look at what their agency set up: what works now, then what's left for them to do. */
export function CheckScreen({
  lines,
  part,
}: {
  readonly lines: readonly string[];
  /** "Your part", one line each (`onboardingSetupOwnerPart`). */
  readonly part: readonly string[];
}) {
  return (
    <>
      <View className="gap-2.5" testID="onboarding-setup-check">
        {lines.map((line) => (
          <View
            key={line}
            className="flex-row items-start gap-2.5 rounded-menu bg-card-2 px-3.5 py-3"
          >
            <Icon as={Check} className="mt-0.5 size-4 text-success-text" strokeWidth={2} />
            <Text className="min-w-0 flex-1 text-[14.5px] leading-[20px]">{line}</Text>
          </View>
        ))}
      </View>
      <View className="gap-2.5" testID="onboarding-setup-your-part">
        <Text className="text-[15px] font-semibold">{HW.yourPart}</Text>
        {part.map((line, i) => (
          <View key={line} className="flex-row items-start gap-2.5">
            <View className="size-5 items-center justify-center rounded-full bg-accent-soft">
              <Text className="text-[12px] font-semibold text-accent-text">{i + 1}</Text>
            </View>
            <Text className="min-w-0 flex-1 text-[14.5px] leading-[20px]">{line}</Text>
          </View>
        ))}
      </View>
    </>
  );
}
