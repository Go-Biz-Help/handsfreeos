import {
  dnsHostFor,
  EMAIL_SETUP_WORDS as W,
  emailSetupDomainOf,
  emailSetupDomainSource,
  emailSetupFreeAddress,
  emailSetupOffersReceiving,
  emailSetupReceives,
  emailSetupSenderAddress,
  emailSetupShownRecords,
  emailSetupTeamChoices,
  isConsumerMailDomain,
  MAIL_HOST_LABELS,
  normalizeEmailDomain,
  type EmailSetupAnswers,
  type EmailSetupRecord,
  type EmailSetupState,
} from '@hfos/core';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { AppState, Pressable, Share, View } from 'react-native';

import { Field, Option } from '@/components/ai-setup/fields';
import {
  Check,
  Clock,
  ExternalLink,
  Laptop,
  Lock,
  Mail,
  Send,
  Share as ShareIcon,
  Users,
} from '@/components/icons';
import { Note } from '@/components/onboarding-setup/screens';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { config } from '@/lib/config';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import type { EmailSetupCalls } from '@/email-setup/calls';
import { NotInThisBuild } from '@/lib/not-in-this-build';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

/**
 * The business email step's three screens on the phone, as the web's components/email-setup/screens.tsx: the address
 * booking emails go out from, the domain's records, and the person's own email. The onboarding setup shows them as
 * its "Your business email" stop, and Home's card on a screen of their own (app/w/<id>/email-setup.tsx). They only
 * show and change the answers; whoever shows them checks and saves. Adding records is easier on a computer, so the
 * records screen leads with emailing the steps, to the person or to whoever looks after the domain; the records are
 * there too, to read off or share.
 */
export interface EmailScreenProps {
  readonly state: EmailSetupState;
  readonly answers: EmailSetupAnswers;
  readonly set: (next: EmailSetupAnswers) => void;
  /** By path into the answers: `email.domain`, `email.local`. */
  readonly problems: Readonly<Record<string, string>>;
  readonly calls: EmailSetupCalls;
}

/** A name box with the domain after it: [hello]@bellassalon.com. */
function LocalPartInput({
  value,
  domain,
  label,
  error,
  onChange,
  testID,
}: {
  value: string;
  domain: string;
  label: string;
  error: string | undefined;
  onChange: (v: string) => void;
  testID: string;
}) {
  return (
    <View className="gap-1.5">
      <Label>{label}</Label>
      <Input
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        invalid={!!error}
        accessibilityLabel={label}
        trailing={
          <Text className="max-w-[60%] pr-3.5 font-mono text-[13px] text-text-2" numberOfLines={1}>
            @{domain}
          </Text>
        }
        testID={testID}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </View>
  );
}

function Shaded({ children }: { children: React.ReactNode }) {
  return <View className="gap-4 rounded-menu bg-card-2 p-4">{children}</View>;
}

/** "Your business email": which address customers see, and the name with it. */
export function EmailSenderScreen({ state, answers, set, problems }: EmailScreenProps) {
  const own = answers.with !== 'free';
  const domain = normalizeEmailDomain(answers.domain);
  const source = domain ? emailSetupDomainSource(state, domain) : null;
  const address = emailSetupSenderAddress({ ...answers, with: own ? 'domain' : 'free' }, state);
  const gmail = !!state.myEmail && isConsumerMailDomain(state.myEmail.split('@')[1] ?? '');
  const put = (patch: Partial<EmailSetupAnswers>) => set({ ...answers, ...patch });
  return (
    <>
      <View className="gap-2">
        <Label>{W.which}</Label>
        <View className="gap-2" role="radiogroup" accessibilityLabel={W.which}>
          <Option
            on={own}
            onSelect={() => put({ with: 'domain' })}
            title={W.ownDomain}
            badge={<Badge variant="ok">{W.best}</Badge>}
            description={W.ownDomainHint}
            testID="email-setup-with-domain"
          />
          {own ? (
            <Shaded>
              <Field
                label={W.domainLabel}
                error={problems['email.domain']}
                hint={
                  source === 'website'
                    ? W.domainFromWebsite
                    : source === 'email'
                      ? W.domainFromEmail
                      : null
                }
              >
                <Input
                  value={answers.domain}
                  placeholder="yourbusiness.com"
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  invalid={!!problems['email.domain']}
                  onChangeText={(v) => put({ domain: v })}
                  accessibilityLabel={W.domainLabel}
                  testID="email-setup-domain"
                />
              </Field>
              <View className="gap-2">
                <LocalPartInput
                  label={W.addressLabel}
                  value={answers.local}
                  domain={domain || 'yourbusiness.com'}
                  error={problems['email.local']}
                  onChange={(local) => put({ local })}
                  testID="email-setup-local"
                />
                <View className="flex-row flex-wrap gap-1.5">
                  {emailSetupTeamChoices(state).map((c) => {
                    const on = answers.local.trim().toLowerCase() === c;
                    return (
                      <Pressable
                        key={c}
                        onPress={() => put({ local: c })}
                        role="button"
                        aria-selected={on}
                        accessibilityLabel={c}
                        hitSlop={{ top: 6, bottom: 6 }}
                        className={cn(
                          'h-8 justify-center rounded-full border px-3',
                          on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
                        )}
                        testID={`email-setup-local-${c}`}
                      >
                        <Text
                          className={cn(
                            'text-[13px]',
                            on ? 'font-semibold text-accent-text' : 'text-text',
                          )}
                        >
                          {c}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <Note icon={Users}>{`${W.teamReads} ${W.teamReadsNext}`}</Note>
            </Shaded>
          ) : null}
          <Option
            on={!own}
            onSelect={() => put({ with: 'free' })}
            title={W.free}
            description={`${emailSetupFreeAddress(answers, state)}. ${W.freeHint}`}
            testID="email-setup-with-free"
          />
          {!own ? (
            <Shaded>
              <LocalPartInput
                label={W.freeLabel}
                value={answers.freeLocal}
                domain={state.sharedDomain}
                error={problems['email.freeLocal']}
                onChange={(freeLocal) => put({ freeLocal })}
                testID="email-setup-free"
              />
              {gmail ? <Note>{W.whyNotGmail}</Note> : null}
            </Shaded>
          ) : null}
        </View>
      </View>
      <Field label={W.nameLabel} error={problems['email.name']}>
        <Input
          value={answers.name}
          maxLength={120}
          invalid={!!problems['email.name']}
          onChangeText={(v) => put({ name: v })}
          accessibilityLabel={W.nameLabel}
          testID="email-setup-name"
        />
      </Field>
      <View
        className="flex-row items-center gap-3 rounded-menu border border-border bg-card px-3.5 py-3"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <View className="size-9 items-center justify-center rounded-full bg-accent">
          <Text className="text-[14px] font-semibold text-white">
            {(answers.name.trim() || state.businessName || 'B').charAt(0).toUpperCase()}
          </Text>
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[14px] font-semibold" numberOfLines={1}>
            {answers.name.trim() || state.businessName}
          </Text>
          <Text className="font-mono text-[12px] text-text-2" numberOfLines={1}>
            {address}
          </Text>
          <Text className="text-[13px] text-text-2" numberOfLines={1}>
            Your appointment is booked: Tue, Nov 18…
          </Text>
        </View>
      </View>
    </>
  );
}

function RecordCard({ r }: { r: EmailSetupRecord }) {
  return (
    <View
      className="gap-2 rounded-menu border border-border bg-card px-3.5 py-3"
      testID={`email-setup-record-${r.type.toLowerCase()}`}
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="font-mono text-[13px] font-medium">
          {r.type}
          {r.priority != null ? ` · priority ${r.priority}` : ''}
        </Text>
        <Badge variant={r.found ? 'ok' : 'pending'}>{r.found ? W.found : W.waiting}</Badge>
      </View>
      <View className="gap-0.5">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
          Name
        </Text>
        <Text selectable className="font-mono text-[13px]">
          {r.host}
        </Text>
      </View>
      <View className="gap-0.5">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
          Value
        </Text>
        <Text selectable className="font-mono text-[13px]">
          {r.value}
        </Text>
      </View>
    </View>
  );
}

/** How often the records screen looks again on its own while a record is still on its way, and how many times. */
const LOOK_AGAIN_MS = 60_000;
const LOOKS = 10;

/** "Add N records at GoDaddy": the domain's records, where to add them, and who else can. */
export function EmailRecordsScreen({
  state,
  answers,
  set,
  calls,
  onChanged,
}: EmailScreenProps & {
  /** Asks for the state again; kept the same between draws. */
  readonly onChanged: () => unknown;
}) {
  const { online } = useNetwork();
  const d = emailSetupDomainOf(state, answers);
  const [checking, setChecking] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [sending, setSending] = React.useState<'me' | 'them' | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const looks = React.useRef(0);
  const receive = emailSetupReceives(d, answers);
  const records = d ? emailSetupShownRecords(d, state.inboundMxHost, receive) : [];
  const waiting = records.some((r) => !r.found);

  async function check(quiet = false) {
    if (!d) return;
    if (!online) {
      if (!quiet) toast.error(P.needsSignal);
      return;
    }
    setChecking(true);
    try {
      await calls.verify(d.id);
      // The worker answers in a moment: ask again then.
      setTimeout(() => void onChanged(), 4_000);
    } catch (e) {
      if (!quiet) toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }
  const checkRef = React.useRef(check);
  checkRef.current = check;
  React.useEffect(() => {
    if (!d || !waiting || d.status === 'verified') return;
    const timer = setInterval(() => {
      if (looks.current >= LOOKS) return;
      looks.current += 1;
      void checkRef.current(true);
    }, LOOK_AGAIN_MS);
    return () => clearInterval(timer);
  }, [d, waiting]);
  // Still being made (a few seconds): ask again until they're there.
  React.useEffect(() => {
    if (d && records.length) return;
    const timer = setInterval(() => void onChanged(), 3_000);
    return () => clearInterval(timer);
  }, [d, records.length, onChanged]);
  // Back in the app after adding them on the computer: look again.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void onChanged();
    });
    return () => sub.remove();
  }, [onChanged]);

  async function send(who: 'me' | 'them') {
    if (!d) return;
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

  if (!d || !records.length)
    return (
      <Note busy testID="email-setup-records-making">
        {W.recordsMaking}
      </Note>
    );
  const host = dnsHostFor(d.dnsHost);
  const found = records.filter((r) => r.found).length;
  const own = emailSetupSenderAddress(answers, state);
  const share = () =>
    void Share.share({
      message: [
        W.recordsHint(d.domain, host?.label ?? null),
        ...records.map(
          (r) =>
            `${r.type}${r.priority != null ? ` (priority ${r.priority})` : ''}\nName: ${r.host}\nValue: ${r.value}`,
        ),
      ].join('\n\n'),
    });
  return (
    <>
      <Text className="text-[14px] leading-[20px] text-text-2" testID="email-setup-records-hint">
        <Text className="font-semibold text-text">
          {W.recordsTitle(records.length, host?.label ?? null)}.
        </Text>{' '}
        {W.recordsHint(d.domain, host?.label ?? null)}
      </Text>
      {d.status !== 'verified' ? (
        <View className="gap-3 rounded-menu bg-card-2 p-4" testID="email-setup-easier">
          <View className="flex-row items-start gap-2.5">
            <Icon as={Laptop} className="mt-0.5 size-4 text-text-3" />
            <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">
              {W.easierOnComputer}
            </Text>
          </View>
          {state.myEmail ? (
            <Button
              icon={Mail}
              loading={sending === 'me'}
              disabled={sending !== null}
              onPress={() => void send('me')}
              testID="email-setup-send-me"
            >
              {W.emailMe}
            </Button>
          ) : null}
          <Input
            value={to}
            onChangeText={setTo}
            placeholder={W.sendTo}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={W.sendTo}
            testID="email-setup-send-to"
          />
          <Button
            variant="secondary"
            icon={Send}
            loading={sending === 'them'}
            disabled={!to.trim() || sending !== null}
            onPress={() => void send('them')}
            testID="email-setup-send"
          >
            {W.sendToSomeone}
          </Button>
          {state.myEmail ? (
            <Text className="text-[12.5px] text-text-3">{W.goesTo(state.myEmail)}</Text>
          ) : null}
          {sendError ? <FieldError>{sendError}</FieldError> : null}
        </View>
      ) : null}
      {emailSetupOffersReceiving(d) ? (
        <View className="flex-row items-start gap-3 rounded-menu border border-border bg-card px-3.5 py-3">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-[14.5px] font-semibold">{W.receiveLabel(d.domain)}</Text>
            <Text className="text-[13px] leading-[18px] text-text-2">
              {d.mailHost === 'handsfreeos' ? W.receiveHere : W.receiveHint}
            </Text>
          </View>
          <Switch
            checked={receive}
            onCheckedChange={(on) => set({ ...answers, receive: on })}
            label={W.receiveLabel(d.domain)}
            disabled={d.receiving !== 'off'}
            testID="email-setup-receive"
          />
        </View>
      ) : d.mailHost && d.mailHost !== 'none' ? (
        <Note icon={Mail}>{W.mailElsewhere(d.domain, MAIL_HOST_LABELS[d.mailHost])}</Note>
      ) : null}
      <View className="gap-2">
        <Text className="text-[14px] leading-[20px]">
          {host ? W.stepsAt(d.domain, host.label, host.where, host.add) : W.stepsAnywhere(d.domain)}
        </Text>
        {host?.note ? <Note>{host.note}</Note> : null}
        <View className="flex-row flex-wrap gap-2">
          {host ? (
            <Button
              variant="ghost"
              size="sm"
              icon={ExternalLink}
              onPress={() => void WebBrowser.openBrowserAsync(host.url)}
              testID="email-setup-open-host"
            >
              {W.openHost(host.label)}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon={ShareIcon}
            onPress={share}
            testID="email-setup-share"
          >
            Share
          </Button>
        </View>
      </View>
      <View className="gap-2.5">
        {records.map((r) => (
          <RecordCard key={`${r.type}-${r.host}`} r={r} />
        ))}
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <Text className="text-[13.5px] text-text-2" testID="email-setup-found">
          {W.foundOf(found, records.length)}
        </Text>
        <Button
          variant="secondary"
          size="sm"
          loading={checking}
          onPress={() => void check()}
          testID="email-setup-check"
        >
          {W.checkNow}
        </Button>
      </View>
      {d.status === 'verified' ? (
        <Note tone="success" icon={Check} testID="email-setup-verified">
          {W.verified(own)}
        </Note>
      ) : (
        <>
          <Note icon={Clock}>
            {W.until(
              state.sender?.domain ? state.sender.address : emailSetupFreeAddress(answers, state),
              own,
            )}
          </Note>
          <Text className="text-[13px] text-text-2">{W.later}</Text>
        </>
      )}
    </>
  );
}

/** "Your own email": an address just for the person, and the Gmail or Outlook they use now. */
export function EmailOwnScreen({
  state,
  answers,
  set,
  problems,
  calls,
  onChanged,
  forClient = false,
}: EmailScreenProps & { readonly onChanged: () => unknown; readonly forClient?: boolean }) {
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState<'microsoft' | 'google' | null>(null);
  const sender = emailSetupSenderAddress(answers, state);
  if (forClient) return <Note>{W.keepsGoing(sender)}</Note>;
  const domain = normalizeEmailDomain(answers.domain);
  const put = (patch: Partial<EmailSetupAnswers>) => set({ ...answers, ...patch });
  const theirs = state.myEmail && isConsumerMailDomain(state.myEmail.split('@')[1] ?? '');
  const connected = state.mailboxes.filter((m) => m.mine && m.status === 'active');

  // The provider's own page, in the phone's browser over the app; closing it comes straight back here.
  async function connect(provider: 'microsoft' | 'google') {
    if (!online) {
      toast.error(P.needsSignal);
      return;
    }
    setBusy(provider);
    try {
      await WebBrowser.openBrowserAsync(await calls.mailboxSignIn(provider));
      await onChanged();
    } catch (e) {
      toast.error(e instanceof NotInThisBuild ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {answers.with === 'domain' ? (
        state.mine ? (
          <Note tone="success" icon={Lock} testID="email-setup-mine-have">
            {W.mineHave(state.mine.address)}
          </Note>
        ) : (
          <View className="gap-2">
            <Label>{W.mineQuestion}</Label>
            <View className="gap-2" role="radiogroup" accessibilityLabel={W.mineQuestion}>
              <Option
                on={!answers.mine}
                onSelect={() => put({ mine: false })}
                title={W.mineNo(answers.local.trim() || 'hello')}
                testID="email-setup-mine-no"
              />
              <Option
                on={answers.mine}
                onSelect={() => put({ mine: true })}
                title={W.mineYes}
                testID="email-setup-mine-yes"
              />
            </View>
            {answers.mine ? (
              <Shaded>
                <LocalPartInput
                  label={W.mineLabel}
                  value={answers.mineLocal}
                  domain={domain}
                  error={problems['email.mineLocal']}
                  onChange={(mineLocal) => put({ mineLocal })}
                  testID="email-setup-mine-local"
                />
                <Note icon={Lock}>{W.mineNote}</Note>
              </Shaded>
            ) : null}
          </View>
        )
      ) : null}
      {answers.with === 'domain' ? <View className="h-px bg-border" /> : null}
      <View className="gap-2.5">
        <Text className="text-[14px] font-semibold">{W.bringIn}</Text>
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          {W.bringInHint(theirs ? state.myEmail : null)}
        </Text>
        {connected.map((m) => (
          <Note
            key={`${m.provider}-${m.accountEmail}`}
            tone="success"
            icon={Check}
            testID="email-setup-connected"
          >
            {W.connected(m.accountEmail ?? 'Your mailbox')}
          </Note>
        ))}
        <Button
          variant="secondary"
          disabled={!config.gmailEnabled || busy !== null}
          loading={busy === 'google'}
          onPress={() => void connect('google')}
          testID="email-setup-connect-gmail"
        >
          {config.gmailEnabled ? W.connectGmail : W.gmailSoon}
        </Button>
        <Button
          variant="secondary"
          disabled={busy !== null}
          loading={busy === 'microsoft'}
          onPress={() => void connect('microsoft')}
          testID="email-setup-connect-outlook"
        >
          {W.connectOutlook}
        </Button>
        <Text className="text-[13px] text-text-2">{W.keepsGoing(sender)}</Text>
      </View>
    </>
  );
}
