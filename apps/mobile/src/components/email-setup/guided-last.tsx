import {
  EMAIL_GUIDED_WORDS as W,
  EMAIL_SETUP_WORDS as S,
  emailGuidedDone,
  emailGuidedLastStep,
  GUIDED_SETUP_WORDS as G,
  type EmailSetupDomain,
  type EmailSetupRecord,
  type EmailSetupState,
} from '@hfos/core';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { Share, View } from 'react-native';

import { GuidedNote, GuidedPage } from '@/components/guided-setup/frame';
import {
  Check,
  CircleAlert,
  Clock,
  ExternalLink,
  Info,
  Laptop,
  Mail,
  RefreshCw,
  Send,
  Share as ShareIcon,
} from '@/components/icons';
import { Note } from '@/components/onboarding-setup/screens';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import type { EmailSetupCalls } from '@/email-setup/calls';
import { EMAIL_GUIDED_PHONE_WORDS as PW } from '@/email-setup/words';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

/**
 * The guided email setup's last step and its Done screen on the phone (the owner, 22 Nov 2026), as the web's
 * components/email-setup/guided-last.tsx at phone size. After Set it up, a website name still needs its records
 * where it is looked after: the ones that let HandsFreeOS send as it, our mail record when its mail is to arrive
 * here, and the old mail records to delete, each said to be found or still there, with "Where things stand" under
 * them. Adding records is easier on a computer, so the step leads with emailing the steps, to the person or to
 * whoever looks after the name; the records are there too, to read off, hold to copy, or share. It looks again on
 * its own, and Check now asks at once.
 *
 * What is left, which records and every word are core's (emailGuidedLastStep, emailGuidedDone), shared with the web.
 */

/** How often the step looks again on its own while something is still missing, and how many times. */
const LOOK_AGAIN_MS = 60_000;
const LOOKS = 10;
/** The worker answers a check in a moment: when the phone asks how things stand after one. */
const ASK_AFTER_MS = [4_000, 12_000];

export function EmailGuidedLast({
  state,
  d,
  calls,
  refresh,
  onLater,
  leaving,
}: {
  state: EmailSetupState;
  /** The website name being set up, as it stands now. */
  d: EmailSetupDomain;
  calls: EmailSetupCalls;
  /** Asks for the state again; kept the same between draws. */
  refresh: () => Promise<unknown>;
  onLater: () => void;
  leaving: boolean;
}) {
  const { online } = useNetwork();
  const step = emailGuidedLastStep(d, state);
  const [checking, setChecking] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [sending, setSending] = React.useState<'me' | 'them' | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const looks = React.useRef(0);
  const asks = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const free = state.sender?.address ?? state.free?.address ?? '';
  React.useEffect(
    () => () => {
      for (const t of asks.current) clearTimeout(t);
    },
    [],
  );

  async function check(quiet = false) {
    if (!online) {
      if (!quiet) toast.error(P.needsSignal);
      return;
    }
    setChecking(!quiet);
    try {
      // Its sending records are checked by one command, its mail record by asking for the mail again.
      if (step.left === 'records') await calls.verify(d.id);
      else await calls.receive(d.id);
      // The worker answers in a moment; the phone hears nothing on its own, so it asks.
      for (const ms of ASK_AFTER_MS) asks.current.push(setTimeout(() => void refresh(), ms));
    } catch (e) {
      if (!quiet) toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }
  const checkRef = React.useRef(check);
  checkRef.current = check;
  React.useEffect(() => {
    if (step.left === 'done') return;
    const timer = setInterval(() => {
      if (looks.current >= LOOKS) return;
      looks.current += 1;
      void checkRef.current(true);
    }, LOOK_AGAIN_MS);
    return () => clearInterval(timer);
  }, [step.left, d.id]);
  // Its records are still being made (a few seconds): ask again until they're there.
  const making = step.left === 'records' && !step.sending.length;
  React.useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [making, refresh]);

  async function send(who: 'me' | 'them') {
    if (!online) {
      setSendError(P.needsSignal);
      return;
    }
    const email = who === 'me' ? (state.myEmail ?? '') : to.trim();
    setSending(who);
    setSendError(null);
    try {
      await calls.sendSteps(d.id, email);
      toast.show(W.sentTo(email));
      if (who === 'them') setTo('');
    } catch (e) {
      setSendError(errorMessage(e));
    } finally {
      setSending(null);
    }
  }

  const host = step.host;
  const title = step.left === 'records' ? W.recordsTitle(host?.label ?? null) : W.mailTitle;
  const sendingFound = step.sending.length > 0 && step.sending.every((r) => r.found);
  // The things to do, in order: opening the records, then whichever of the three this name still needs.
  const order = [
    'open',
    ...(step.left === 'records' ? ['sending'] : []),
    ...(step.ours ? ['ours'] : []),
    ...(step.old.length ? ['old'] : []),
  ];
  const n = (key: string) => order.indexOf(key) + 1;
  const share = () =>
    void Share.share({
      message: [
        `${title}: ${d.domain}`,
        ...(step.left === 'records'
          ? step.sending.map((r) => `${r.type}\n${W.host}: ${r.host}\n${W.value}: ${r.value}`)
          : []),
        ...(step.ours
          ? [
              `${W.addMail}\n${W.type}: MX\n${W.pointsTo}: ${step.ours.host}\n${W.priority}: ${step.ours.priority}`,
            ]
          : []),
        ...(step.old.length
          ? [
              `${W.deleteOld(step.old.length)}\n${step.old.map((r) => `MX ${r.host} (${W.priority} ${r.priority})`).join('\n')}`,
            ]
          : []),
      ].join('\n\n'),
    });

  return (
    <GuidedPage
      screen={`last_${step.left}`}
      testID="email-guided"
      kicker={W.lastStep}
      settingUp={W.kicker}
      progress={null}
      title={title}
      hint={
        step.left === 'records' ? W.recordsHint(d.domain, free) : W.mailHint(d.domain, step.where)
      }
      saved="idle"
      onLeave={onLater}
      leaving={leaving}
      footer={
        <View className="flex-row items-center gap-3">
          <Button variant="ghost" onPress={onLater} disabled={leaving} testID="email-guided-later">
            {W.later}
          </Button>
          <Button
            className="flex-1"
            icon={RefreshCw}
            onPress={() => void check()}
            loading={checking}
            testID="email-guided-check"
          >
            {W.checkNow}
          </Button>
        </View>
      }
    >
      <View className="gap-3 rounded-menu bg-card-2 p-4" testID="email-guided-easier">
        <View className="flex-row items-start gap-2.5">
          <Icon as={Laptop} className="mt-0.5 size-4 text-text-3" />
          <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">
            {S.easierOnComputer}
          </Text>
        </View>
        {state.myEmail ? (
          <Button
            icon={Mail}
            variant="secondary"
            loading={sending === 'me'}
            disabled={sending !== null}
            onPress={() => void send('me')}
            testID="email-guided-send-me"
          >
            {S.emailMe}
          </Button>
        ) : null}
        <Input
          value={to}
          onChangeText={setTo}
          placeholder={W.sendStepsTo}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={W.sendStepsTo}
          testID="email-guided-send-to"
        />
        <Button
          variant="secondary"
          icon={Send}
          loading={sending === 'them'}
          disabled={!to.trim() || sending !== null}
          onPress={() => void send('them')}
          testID="email-guided-send"
        >
          {W.sendStepsSend}
        </Button>
        {state.myEmail ? (
          <Text className="text-[12.5px] text-text-3">{S.goesTo(state.myEmail)}</Text>
        ) : null}
        <FieldError>{sendError}</FieldError>
      </View>

      <View className="gap-6">
        <Step n={n('open')} done={false} title={W.openRecords(host?.label ?? null)}>
          <Text className="text-[14px] leading-[20px] text-text-2">
            {host
              ? W.openRecordsHow(d.domain, host.label, host.where)
              : W.openRecordsAnywhere(d.domain)}
          </Text>
          {host?.note ? (
            <GuidedNote>
              <Text className="text-[13.5px] leading-[19px] text-text-2">{host.note}</Text>
            </GuidedNote>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {host ? (
              <Button
                variant="secondary"
                size="sm"
                icon={ExternalLink}
                onPress={() => void WebBrowser.openBrowserAsync(host.url)}
                testID="email-guided-open-host"
              >
                {W.openHost(host.label)}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon={ShareIcon}
              onPress={share}
              testID="email-guided-share"
            >
              {PW.share}
            </Button>
          </View>
        </Step>

        {step.left === 'records' ? (
          <Step
            n={n('sending')}
            done={sendingFound}
            title={W.addSending(Math.max(1, step.sending.length))}
            testID="sending"
          >
            <Text className="text-[14px] leading-[20px] text-text-2">
              {`${W.addSendingHow(host?.add ?? null)} ${PW.holdToCopy}`}
            </Text>
            {step.sending.length ? (
              <View className="gap-2.5">
                {step.sending.map((r) => (
                  <SendingRecord key={`${r.type}-${r.host}`} r={r} />
                ))}
              </View>
            ) : (
              <Note busy testID="email-guided-records-making">
                {S.recordsMaking}
              </Note>
            )}
          </Step>
        ) : null}

        {step.ours ? (
          <Step n={n('ours')} done={step.ours.found} title={W.addMail} testID="ours">
            <Text className="text-[14px] leading-[20px] text-text-2">
              {W.addMailHow(host?.add ?? null)}
            </Text>
            <MailRecord
              host={step.ours.host}
              priority={step.ours.priority}
              badge={
                <Badge variant={step.ours.found ? 'ok' : 'pending'}>
                  {step.ours.found ? W.found : W.waiting}
                </Badge>
              }
            />
          </Step>
        ) : null}

        {step.old.length ? (
          <Step n={n('old')} done={false} title={W.deleteOld(step.old.length)} testID="old">
            <Text className="text-[14px] leading-[20px] text-text-2">
              {W.deleteOldHow(step.old.length, step.where)}
            </Text>
            <View className="gap-2.5">
              {step.old.map((r) => (
                <MailRecord
                  key={`${r.host}-${r.priority}`}
                  host={r.host}
                  priority={r.priority}
                  badge={<Badge variant="pending">{W.stillThere}</Badge>}
                />
              ))}
            </View>
          </Step>
        ) : null}
      </View>

      {step.notDone ? (
        <Note tone="warning" icon={Clock} testID="email-guided-not-done">
          {`${W.notDone} ${step.notDone}`}
        </Note>
      ) : null}

      <View className="gap-2">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
          {W.stand}
        </Text>
        <View className="gap-1.5">
          {step.stand.map((l) => (
            <View
              key={l.key}
              className={cn(
                'flex-row items-start gap-2.5 rounded-menu px-3 py-2.5',
                l.done ? 'bg-card-2' : 'border border-border bg-card',
              )}
              testID={`email-guided-stand-${l.key}`}
              accessibilityLabel={`${l.label}: ${l.value}`}
            >
              <Icon
                as={l.done ? Check : CircleAlert}
                className={cn('mt-0.5 size-4', l.done ? 'text-success' : 'text-warning-text')}
                strokeWidth={l.done ? 2.5 : 1.75}
              />
              <View className="min-w-0 flex-1">
                <Text className="text-[13px] font-medium">{l.label}</Text>
                <Text className="text-[13px] leading-[18px] text-text-2">{l.value}</Text>
              </View>
            </View>
          ))}
        </View>
        {step.wantsMail ? (
          <View className="gap-1 rounded-menu border border-border bg-card p-3.5">
            <Text className="text-[13px] font-semibold">{W.nothingLost}</Text>
            <Text className="text-[13px] leading-[18px] text-text-2">
              {W.nothingLostBody(step.where)}
            </Text>
          </View>
        ) : null}
      </View>
    </GuidedPage>
  );
}

/** One thing to do where the website name is looked after: its number, or a tick once it's found. */
function Step({
  n,
  done,
  title,
  testID,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View
      className="flex-row items-start gap-3"
      testID={testID ? `email-guided-step-${testID}` : undefined}
    >
      <View
        className={cn(
          'mt-0.5 size-7 items-center justify-center rounded-full',
          done ? 'bg-success' : 'border-[1.5px] border-accent',
        )}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        {done ? (
          <Icon as={Check} className="size-4 text-white" strokeWidth={3} />
        ) : (
          <Text className="text-[13px] font-semibold text-accent-text">{n}</Text>
        )}
      </View>
      <View className="min-w-0 flex-1 gap-2.5">
        <Text className="pt-0.5 text-[16px] font-semibold leading-[22px]">{title}</Text>
        {children}
      </View>
    </View>
  );
}

const Heading = ({ children }: { children: string }) => (
  <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
    {children}
  </Text>
);

/** A record that lets HandsFreeOS send as the website name: its name and value to copy, and whether it's found. */
function SendingRecord({ r }: { r: EmailSetupRecord }) {
  return (
    <View
      className="gap-2 rounded-menu border border-border bg-card px-3.5 py-3"
      testID={`email-guided-record-${r.type.toLowerCase()}`}
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="font-mono text-[13px] font-medium">{r.type}</Text>
        <Badge variant={r.found ? 'ok' : 'pending'}>{r.found ? W.found : W.waiting}</Badge>
      </View>
      <View className="gap-0.5">
        <Heading>{W.host}</Heading>
        <Text selectable className="font-mono text-[13px]">
          {r.host}
        </Text>
      </View>
      <View className="gap-0.5">
        <Heading>{W.value}</Heading>
        <Text selectable className="font-mono text-[13px]">
          {r.value}
        </Text>
      </View>
    </View>
  );
}

/** A mail record: ours to add, or an old one to find and delete. */
function MailRecord({
  host,
  priority,
  badge,
}: {
  host: string;
  priority: number;
  badge: React.ReactNode;
}) {
  return (
    <View
      className="gap-2 rounded-menu border border-border bg-card px-3.5 py-3"
      testID="email-guided-mx"
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="font-mono text-[13px] font-medium">
          MX
          <Text className="font-sans text-[13px] text-text-3">{` · ${W.priority} `}</Text>
          {priority}
        </Text>
        {badge}
      </View>
      <View className="gap-0.5">
        <Heading>{W.pointsTo}</Heading>
        <Text selectable className="font-mono text-[13px]">
          {host}
        </Text>
      </View>
    </View>
  );
}

/** "Your email is ready": each address with who reads it, and where to go next. */
export function EmailGuidedDone({
  workspaceId,
  state,
  d,
  onClose,
  onInbox,
}: {
  workspaceId: string;
  state: EmailSetupState;
  /** The website name that was set up; null with a free address. */
  d: EmailSetupDomain | null;
  onClose: () => void;
  onInbox: () => void;
}) {
  const done = emailGuidedDone(state, d);
  const settings = () => void openWeb(`/app/w/${workspaceId}/settings/email`);
  return (
    <GuidedPage
      screen="done"
      testID="email-guided"
      kicker={W.kicker}
      progress={null}
      title={W.doneTitle}
      hint={done.line}
      saved="idle"
      onLeave={onClose}
      leaveLabel={G.close}
      footer={
        <View className="flex-row items-center gap-3">
          <Button variant="ghost" onPress={settings} testID="email-guided-to-settings">
            {W.emailSettings}
          </Button>
          <Button className="flex-1" onPress={onInbox} testID="email-guided-to-inbox">
            {W.goToInbox}
          </Button>
        </View>
      }
    >
      {done.rows.length ? (
        <View className="overflow-hidden rounded-menu border border-border bg-card">
          {done.rows.map((r, i) => (
            <View
              key={r.address}
              className={cn(
                'flex-row items-start gap-3 px-4 py-3.5',
                i > 0 && 'border-t border-border',
              )}
              testID="email-guided-done-row"
            >
              <View className="mt-0.5 size-5 items-center justify-center rounded-full bg-success">
                <Icon as={Check} className="size-3 text-white" strokeWidth={3} />
              </View>
              <View className="min-w-0 flex-1 gap-1">
                <Text className="font-mono text-[14px]">{r.address}</Text>
                {r.isDefault ? (
                  <Badge variant="accent" className="self-start">
                    {W.hearFrom}
                  </Badge>
                ) : null}
                <Text className="text-[13.5px] leading-[19px] text-text-2">{r.line}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <View className="flex-row items-start gap-2">
        <Icon as={Info} className="mt-0.5 size-4 text-text-2" />
        <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">
          {`${W.changeLaterLead} `}
          <Text
            className="text-[13.5px] font-medium leading-[19px] text-accent-text"
            role="link"
            onPress={settings}
          >
            {W.settingsEmail}
          </Text>
          {`, ${PW.onTheWeb}.`}
        </Text>
      </View>
    </GuidedPage>
  );
}
