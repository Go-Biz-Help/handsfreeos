import {
  AI_CALL_PURPOSES,
  fmtDateShort,
  localDateOf,
  localInstant,
  minutesPastMidnight,
  PHONE_VOICE_PICK_WORDS,
  phoneVoiceInfo,
  TEST_CALL_GOAL_MAX,
  TEST_CALL_REASONS,
  TEST_CHANNEL_NAMES,
  timeOptionsWith,
  type TestConsoleChannel,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  ArrowUp,
  BookOpen,
  CalendarCheck,
  ChevronRight,
  CircleAlert,
  CloudOff,
  Hand,
  Hourglass,
  Info,
  MessageSquare,
  Mic,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench,
} from '@/components/icons';
import { Chips, clockOf, Field, nextDays } from '@/components/calendar/new-appointment';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { VoiceBar, VoiceError } from '@/components/voice/voice-bar';
import {
  turnHeading,
  turnMeta,
  turnSteps,
  type LogIcon,
  type LogLine,
  type LogTone,
  type Turn,
} from '@/ai-team/test-console';
import type { TestPerson, TestConsoleState } from '@/ai-team/use-test-console';
import { matchesSearch } from '@/sync/compute';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { ReplyFeedback } from './reply-feedback';
import { VoicePicker } from './voice-picker';

/**
 * The AI teammate's test console on the phone: everything the web's has (apps/web/src/components/ai-team/
 * test-console.tsx). Write as someone in Contacts or an unknown visitor, by text, chat or email, or play a phone
 * call either way (they call in, or it calls them to confirm a visit, ring back a missed call, follow up a quote or
 * for a campaign), now or at a pretend time. The reply streams in, and "What Ava did" shows what it looked up, the
 * knowledge it used, the checks it passed, and anything it would have done. Look-ups are real, changes are
 * pretend, and nothing is sent. It tests the saved settings: the builder is on the web. On a call, the mic talks
 * out loud: say what the caller says, and hear the teammate answer in its phone voice. Each reply takes a thumbs up
 * or down, and a written one can be tried again with the fix (`ReplyFeedback`).
 */

/** A customer it can be, with what a search matches. */
export interface TestCustomer extends TestPerson {
  readonly searchText: string;
}

/** Short enough for four in a row on a phone; the full names are for screen readers. */
const CHANNEL_SHORT: Readonly<Record<TestConsoleChannel, string>> = {
  sms: 'Text',
  chat: 'Chat',
  email: 'Email',
  phone: 'Call',
};

const LOG_ICONS: Readonly<Record<LogIcon, LucideIcon>> = {
  message: MessageSquare,
  'call-in': PhoneIncoming,
  'call-out': PhoneOutgoing,
  phone: Phone,
  who: UserRound,
  note: Sparkles,
  knowledge: BookOpen,
  tool: Wrench,
  would: CalendarCheck,
  check: ShieldCheck,
  hand: Hand,
  'hung-up': PhoneOff,
  draft: Hourglass,
  send: Send,
  wait: Info,
  error: CircleAlert,
  retry: RotateCcw,
};

const TONES: Readonly<Record<LogTone, string>> = {
  ok: 'bg-success-soft text-success-text',
  run: 'bg-card-2 text-text-2',
  ai: 'bg-accent-soft text-accent-text',
  held: 'bg-warning-soft text-warning-text',
  wait: 'bg-card-2 text-text-3',
  bad: 'bg-danger-soft text-danger-text',
};

const FAILURE_WORDS = {
  no_signal: {
    title: 'The test console needs signal.',
    body: 'It asks HandsFreeOS each time, so it works once your phone is back online. What you wrote is still here.',
  },
  not_configured: {
    title: 'The test console isn’t in this build.',
    body: 'Open it on the web, under AI teammate.',
  },
  gone: {
    title: 'The test console arrives with the teammate’s runtime.',
    body: 'Once it’s in, you can try your AI teammate here before any customer does.',
  },
} as const;

export function TestConsoleView({
  state: c,
  name,
  timeZone,
  customers,
  pane,
}: {
  state: TestConsoleState;
  name: string;
  timeZone: string;
  customers: readonly TestCustomer[];
  pane: 'chat' | 'log';
}) {
  const [setupOpen, setSetupOpen] = React.useState(false);
  const chatRef = React.useRef<ScrollView>(null);
  const logRef = React.useRef<ScrollView>(null);

  React.useEffect(() => {
    const t = setTimeout(() => {
      chatRef.current?.scrollToEnd({ animated: true });
      logRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(t);
  }, [c.turns]);

  const how = c.phone
    ? c.outbound
      ? `Outgoing call · ${TEST_CALL_REASONS[c.purpose].toLowerCase()}`
      : 'Incoming call'
    : TEST_CHANNEL_NAMES[c.channel];
  const when = c.at ? atWords(c.at, timeZone) : 'Now';
  const voiceName = c.phone ? ` · ${phoneVoiceInfo(c.voicePick.callVoice).name} voice` : '';
  const failure =
    c.failure === 'no_signal' || c.failure === 'not_configured' || c.failure === 'gone'
      ? FAILURE_WORDS[c.failure]
      : null;

  return (
    <View className="flex-1" testID="test-console">
      <Pressable
        role="button"
        accessibilityLabel="Change who, how and when"
        onPress={() => setSetupOpen(true)}
        testID="test-console-setup"
        className="flex-row items-center gap-2 border-b border-border bg-card px-3.5 py-2.5 active:bg-card-2"
      >
        <View className="min-w-0 flex-1">
          <Text className="text-[13px] font-semibold" numberOfLines={1}>
            As {c.person ? c.person.name : c.who}
          </Text>
          <Text className="text-xs text-text-3" numberOfLines={1} testID="test-console-how">
            {how} · {when}
            {voiceName}
          </Text>
        </View>
        <Text className="text-[13px] font-medium text-accent-text">Change</Text>
        <Icon as={ChevronRight} className="size-4 text-text-3" />
      </Pressable>

      {pane === 'chat' ? (
        <View className="flex-1 bg-card-2">
          {failure ? (
            <View className="m-3.5 gap-1.5 rounded-card border border-border bg-card px-3.5 py-3">
              <View className="flex-row items-center gap-2">
                <Icon as={CloudOff} className="size-4 text-warning-text" />
                <Text
                  className="min-w-0 flex-1 text-[15px] font-semibold"
                  testID="test-console-off"
                >
                  {failure.title}
                </Text>
              </View>
              <Text className="text-[13px] leading-[18px] text-text-2">{failure.body}</Text>
            </View>
          ) : null}
          <ScrollView
            ref={chatRef}
            className="flex-1"
            contentContainerClassName="gap-3 px-3.5 pb-3 pt-3"
            keyboardShouldPersistTaps="handled"
            testID="test-console-chat"
          >
            <Text className="self-center text-xs font-medium text-text-3">
              {c.phone ? 'Test call' : 'Test chat'} · {how.toLowerCase()}
            </Text>
            {!c.phone && !c.turns.length ? (
              <Text className="mt-3 text-center text-[13px] text-text-2">
                Write as {c.who} to see how {name} answers.
              </Text>
            ) : null}
            {c.turns.map((t) => (
              <TurnBubbles key={t.id} turn={t} name={name} c={c} />
            ))}
            {c.phone && !c.onCall && !c.busy ? (
              <View className="mt-3 items-center gap-3">
                <Text className="text-center text-[13px] text-text-2">
                  {c.cantCall ??
                    (c.outbound
                      ? `${name} calls ${c.who} to ${TEST_CALL_REASONS[c.purpose].toLowerCase()}. You answer as them.`
                      : `Call in as ${c.who} to hear how ${name} picks up.`)}
                </Text>
                <Button
                  size="md"
                  icon={PhoneCall}
                  disabled={!!c.cantCall}
                  onPress={c.startCall}
                  testID="test-console-start-call"
                >
                  Start the call
                </Button>
                <Button
                  size="md"
                  variant={c.talking ? 'primary' : 'secondary'}
                  icon={Mic}
                  accessibilityState={{ selected: c.talking }}
                  accessibilityHint={`Say what the caller says, and hear ${name} answer out loud`}
                  onPress={() => void c.toggleTalk()}
                  testID="test-console-talk"
                >
                  {c.talking ? 'Talking out loud' : 'Talk out loud'}
                </Button>
                <VoiceError snap={c.voiceSnap} className="text-center" />
                {c.cantCall && c.outbound && !c.person ? (
                  <Button variant="ghost" size="sm" onPress={() => setSetupOpen(true)}>
                    Pick a customer
                  </Button>
                ) : null}
              </View>
            ) : null}
            {c.callOver ? (
              <View className="items-center gap-2 pt-1" testID="test-console-call-over">
                <Text className="text-xs font-medium text-text-3">The call ended.</Text>
                <Button variant="secondary" size="md" icon={PhoneCall} onPress={c.startCall}>
                  Call again
                </Button>
              </View>
            ) : null}
          </ScrollView>
          {c.phone ? <VoiceBar session={c.voice} snap={c.voiceSnap} onTalk={c.talkNow} /> : null}
          {c.canWrite ? <Composer c={c} /> : null}
        </View>
      ) : (
        <ScrollView
          ref={logRef}
          className="flex-1"
          contentContainerClassName="px-3.5 pb-6 pt-3"
          testID="test-console-log"
        >
          <Text className="text-[15px] font-semibold">What {name} did</Text>
          {!c.turns.length ? (
            <Text className="mt-1 text-[13px] leading-[18px] text-text-2">
              Each reply shows what it looked up, the knowledge it used, the checks it passed, and
              anything it would have done.
            </Text>
          ) : (
            c.turns.map((t, i) => (
              <View
                key={t.id}
                className={cn('mt-2', i > 0 && 'border-t border-border pt-3')}
                testID="test-console-log-turn"
              >
                <View className="flex-row items-center justify-between gap-2">
                  <Text className="text-[13px] font-semibold">
                    {turnHeading(c.turns, i, name, c.outbound)}
                  </Text>
                  <Text className="text-xs text-text-3">{turnMeta(t)}</Text>
                </View>
                {turnSteps(t) ? (
                  <Text className="mt-0.5 text-xs text-text-3" testID="test-console-steps">
                    {turnSteps(t)}
                  </Text>
                ) : null}
                {t.log.map((l) => (
                  <LogRow key={l.id} line={l} timeZone={timeZone} />
                ))}
              </View>
            ))
          )}
        </ScrollView>
      )}

      <View className="flex-row items-start gap-2 border-t border-border bg-card px-3.5 py-2">
        <Icon as={Info} className="mt-px size-3.5 text-text-3" />
        <Text className="min-w-0 flex-1 text-xs leading-[16px] text-text-3">
          Tests don’t count toward training wheels and never reach a customer. It tests the saved
          settings.
          {c.phone
            ? ` On a test call nothing rings: type what they say, or tap the mic to say it and hear ${name} answer.`
            : ''}
        </Text>
      </View>

      <SetupSheet
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        c={c}
        name={name}
        timeZone={timeZone}
        customers={customers}
      />
    </View>
  );
}

function TurnBubbles({ turn: t, name, c }: { turn: Turn; name: string; c: TestConsoleState }) {
  const who = c.who;
  return (
    <>
      {t.customer ? (
        <View className="max-w-[86%] items-end gap-[3px] self-end">
          <View className="rounded-2xl bg-accent px-[13px] py-[9px]">
            <Text className="text-sm leading-[20px] text-white">{t.customer}</Text>
          </View>
          <Text className="text-xs text-text-3">You, as {who}</Text>
        </View>
      ) : null}
      {t.error && !t.reply ? null : (
        <View className="max-w-[90%] gap-[5px] self-start">
          <Text className="text-xs font-semibold text-text-2">
            {name} (AI){t.kind !== 'written' ? ' says' : ''}
          </Text>
          <View
            className="rounded-2xl border border-border bg-card px-[13px] py-[9px]"
            testID="test-console-reply"
          >
            {t.reply ? (
              <Text className="text-sm leading-[20px]">{t.reply}</Text>
            ) : (
              <Text className="text-sm leading-[20px] text-text-3">
                {t.done ? 'No reply.' : t.kind === 'greeting' ? 'Ringing…' : 'Writing…'}
              </Text>
            )}
          </View>
          {t.done ? (
            <View className="flex-row flex-wrap gap-1.5">
              {t.draft ? (
                <Tag className="bg-warning-soft" textClass="text-warning-text" icon={Hourglass}>
                  Draft (training wheels)
                </Tag>
              ) : null}
              {t.outcome === 'handed_off' ? (
                <Tag className="bg-warning-soft" textClass="text-warning-text" icon={Hand}>
                  {t.kind === 'call' ? 'Connected to the team' : 'Handed to a person'}
                </Tag>
              ) : t.ended ? (
                <Tag className="bg-card" textClass="text-text-2" icon={PhoneOff}>
                  Hung up
                </Tag>
              ) : null}
              {t.would.map((w, i) => (
                <Tag key={i} className="bg-card" textClass="text-text-2" icon={CalendarCheck}>
                  {w}
                </Tag>
              ))}
            </View>
          ) : null}
          {t.done && t.runId && t.reply.trim() && !t.error ? (
            <ReplyFeedback
              state={c.feedback}
              reply={t.reply}
              runId={t.runId}
              asked={t.customer || null}
              onRetry={
                t.kind === 'written' && !c.busy ? (coaching) => c.retry(t, coaching) : undefined
              }
            />
          ) : null}
        </View>
      )}
      {t.error ? (
        <Text role="alert" className="text-xs text-danger-text" testID="test-console-error">
          {t.error}
        </Text>
      ) : null}
    </>
  );
}

function Tag({
  children,
  icon,
  className,
  textClass,
}: {
  children: string;
  icon: LucideIcon;
  className: string;
  textClass: string;
}) {
  return (
    <View
      className={cn(
        'max-w-full flex-row items-center gap-1 rounded-[6px] px-1.5 py-0.5',
        className,
      )}
    >
      <Icon as={icon} className={cn('size-3', textClass)} />
      <Text className={cn('shrink text-[11.5px] font-medium', textClass)}>{children}</Text>
    </View>
  );
}

function LogRow({ line: l, timeZone }: { line: LogLine; timeZone: string }) {
  const tone = TONES[l.tone];
  const [bg, fg] = tone.split(' ');
  return (
    <View className="mt-2.5 flex-row gap-2.5">
      <View className={cn('size-7 items-center justify-center rounded-full', bg)}>
        <Icon as={LOG_ICONS[l.icon]} className={cn('size-3.5', fg)} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline justify-between gap-2">
          <Text className="min-w-0 flex-1 text-[13.5px] font-medium">{l.title}</Text>
          <Text className="text-[11px] text-text-3">{clockWords(l.at, timeZone)}</Text>
        </View>
        {l.quote ? (
          <Text className="text-[13px] italic leading-[18px] text-text-2">“{l.quote}”</Text>
        ) : null}
        {l.detail ? (
          <Text className="text-[12.5px] leading-[17px] text-text-2">{l.detail}</Text>
        ) : null}
        {l.knowledge?.length ? (
          <Text className="text-[12.5px] leading-[17px] text-text-2">
            Knowledge used: {l.knowledge.join(', ')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Composer({ c }: { c: TestConsoleState }) {
  const colors = useColors();
  const canSend = c.text.trim().length > 0 && !c.busy;
  const verb = c.phone ? 'Say' : 'Write';
  return (
    <View className="flex-none border-t border-border bg-card pb-2.5 pt-2">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-1.5 px-2.5 pb-2"
        testID="test-console-samples"
      >
        {c.samples.map((s) => (
          <Pressable
            key={s}
            role="button"
            disabled={c.busy}
            onPress={() => c.send(s)}
            className={cn(
              'h-9 justify-center rounded-full border border-border-strong bg-card px-3 active:bg-card-2',
              c.busy && 'opacity-50',
            )}
          >
            <Text className="text-[13px] font-medium text-text-2">{s}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View className="flex-row items-end gap-1.5 px-2.5">
        {c.phone ? (
          <Pressable
            role="button"
            accessibilityLabel={c.talking ? 'Stop talking' : 'Talk out loud'}
            accessibilityState={{ selected: c.talking }}
            testID="test-console-mic"
            onPress={() => void c.toggleTalk()}
            className={cn(
              'size-11 shrink-0 items-center justify-center rounded-full border active:bg-card-2',
              c.talking ? 'border-accent bg-accent-soft' : 'border-border-strong',
            )}
          >
            <Icon
              as={Mic}
              className={cn('size-[18px]', c.talking ? 'text-accent-text' : 'text-text-2')}
            />
          </Pressable>
        ) : null}
        <View className="min-h-11 min-w-0 flex-1 justify-center rounded-[22px] border border-border-strong bg-card px-4 py-1">
          <TextInput
            value={c.text}
            onChangeText={c.setText}
            multiline
            maxLength={2000}
            placeholder={`${verb} as ${c.who}…`}
            placeholderTextColor={colors.placeholder}
            selectionColor={colors.accent}
            cursorColor={colors.accent}
            aria-label={`${verb} as ${c.who}`}
            testID="test-console-input"
            className="max-h-[120px] py-0 font-sans text-base leading-[22px] text-text"
          />
        </View>
        <Pressable
          role="button"
          accessibilityLabel={c.phone ? 'Say it' : 'Send'}
          accessibilityState={{ disabled: !canSend, busy: c.busy }}
          testID="test-console-send"
          disabled={!canSend}
          onPress={() => c.send(c.text)}
          className={cn(
            'size-11 shrink-0 items-center justify-center rounded-full bg-accent active:bg-accent-hover',
            !canSend && 'opacity-45',
          )}
        >
          <Icon as={ArrowUp} className="size-[18px] text-white" />
        </Pressable>
      </View>
    </View>
  );
}

/** Who, how and when: changing any of them starts the test over. */
function SetupSheet({
  open,
  onClose,
  c,
  name,
  timeZone,
  customers,
}: {
  open: boolean;
  onClose: () => void;
  c: TestConsoleState;
  name: string;
  timeZone: string;
  customers: readonly TestCustomer[];
}) {
  const [typed, setTyped] = React.useState('');
  const wanted = typed.trim().toLowerCase();
  const matching = (
    wanted ? customers.filter((p) => matchesSearch(p.searchText, wanted)) : customers
  ).slice(0, 8);
  const today = localDateOf(Date.now(), timeZone);
  const day = c.at ? localDateOf(Date.parse(c.at), timeZone) : today;
  const minutes = c.at
    ? minutesPastMidnight(Date.parse(c.at), timeZone)
    : Math.ceil(minutesPastMidnight(Date.now(), timeZone) / 30) * 30;
  const pretend = (d: string, m: number) =>
    c.setAt(new Date(localInstant(d, clockOf(m % (24 * 60)), timeZone)).toISOString());

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Test setup"
      scroll
      testID="test-console-setup-sheet"
    >
      <Field label="Test as">
        {c.person ? (
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-[15px] font-medium" numberOfLines={1}>
              {c.person.name}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => c.setPerson(null)}
              testID="test-as-nobody"
            >
              {c.phone ? 'Use an unknown caller' : 'Use an unknown visitor'}
            </Button>
          </View>
        ) : (
          <>
            <Input
              value={typed}
              onChangeText={setTyped}
              placeholder="Search by name, number or street"
              accessibilityLabel="Test as"
              autoCorrect={false}
              testID="test-as-search"
            />
            <Chips
              options={matching.map((p) => ({ value: p.id, label: p.name }))}
              value=""
              onChange={(id) => {
                const p = customers.find((x) => x.id === id);
                if (p) c.setPerson({ id: p.id, name: p.name });
                setTyped('');
              }}
              testID="test-as"
            />
          </>
        )}
      </Field>

      <Field label="By">
        <Segmented
          label="Channel"
          value={c.channel}
          onChange={c.setChannel}
          options={(['sms', 'chat', 'email', 'phone'] as const).map((ch) => ({
            value: ch,
            label: CHANNEL_SHORT[ch],
            testID: `test-channel-${ch}`,
          }))}
        />
      </Field>

      {c.phone ? (
        <Field label="Call">
          <Segmented
            label="Which way the call goes"
            value={c.direction}
            onChange={c.setDirection}
            options={[
              { value: 'inbound', label: 'Incoming', testID: 'test-call-inbound' },
              { value: 'outbound', label: 'Outgoing', testID: 'test-call-outbound' },
            ]}
          />
        </Field>
      ) : null}

      {c.phone ? (
        <Field label={PHONE_VOICE_PICK_WORDS.label}>
          <VoicePicker pick={c.voicePick} />
        </Field>
      ) : null}

      {c.outbound ? (
        <Field label={`Why ${name} calls`}>
          <Chips
            options={AI_CALL_PURPOSES.map((p) => ({ value: p, label: TEST_CALL_REASONS[p] }))}
            value={c.purpose}
            onChange={(p) => c.setPurpose(p as typeof c.purpose)}
            testID="test-call-why"
          />
          {c.goalAsk ? (
            <Input
              className="mt-2"
              value={c.goal}
              onChangeText={c.setGoal}
              placeholder={c.goalAsk.placeholder}
              accessibilityLabel={c.goalAsk.label}
              maxLength={TEST_CALL_GOAL_MAX}
              testID="test-call-goal"
            />
          ) : null}
          {!c.person ? (
            <Text className="mt-1.5 text-xs text-text-3">
              Pick a customer above: it only calls people in Contacts.
            </Text>
          ) : null}
        </Field>
      ) : null}

      <Field label="At">
        <Chips
          options={[
            { value: 'now', label: 'Now' },
            { value: 'pick', label: 'Pick a time' },
          ]}
          value={c.at ? 'pick' : 'now'}
          onChange={(v) => (v === 'now' ? c.setAt(null) : pretend(day, minutes))}
          testID="test-at"
        />
        {c.at ? (
          <View className="mt-2 gap-2">
            <Chips
              options={nextDays(today, timeZone).map((d) => ({ value: d, label: fmtDateShort(d) }))}
              value={day}
              onChange={(d) => pretend(d, minutes)}
              testID="test-at-day"
            />
            <Chips
              options={timeOptionsWith(minutes)
                .filter(([m]) => m % 30 === 0 || m === minutes)
                .map(([m, label]) => ({ value: String(m), label }))}
              value={String(minutes)}
              onChange={(m) => pretend(day, Number(m))}
              testID="test-at-time"
            />
          </View>
        ) : null}
      </Field>

      <Button className="mt-2" onPress={onClose} testID="test-console-setup-done">
        Done
      </Button>
    </Sheet>
  );
}

/** "9:41:07 AM" on the business's clock. */
function clockWords(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(at));
}

/** "Thu, Oct 2 · 9:30 AM" on the business's clock. */
function atWords(at: string, timeZone: string): string {
  const d = new Date(at);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}
