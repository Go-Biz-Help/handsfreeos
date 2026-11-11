'use client';
/**
 * The business email step's three screens on the web (messaging/email-setup.ts): the address booking emails go out
 * from, the domain's records with the steps for where it's managed, and the person's own email. Onboarding's setup
 * shows them as its "Your business email" stop, and Home's card as a page of their own (email-setup-flow.tsx). They
 * only show and change the answers; whoever shows them checks and saves. The records screen asks for a check and
 * sends the steps itself, and the last one connects Outlook, since those don't wait for Next.
 */
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
import { Check, Clock, ExternalLink, Laptop, Lock, Mail, Send, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout, Note } from '@/components/ai-team/parts';
import { Option } from '@/components/ai-setup/fields';
import { GoogleLogo, MicrosoftLogo } from '@/components/settings/provider-logos';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Field, FieldError, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { publicEnv } from '@/lib/env';
import { cn } from '@/lib/utils';

export interface EmailScreenProps {
  readonly workspaceId: string;
  readonly state: EmailSetupState;
  readonly answers: EmailSetupAnswers;
  readonly set: (next: EmailSetupAnswers) => void;
  /** By path into the answers: `email.domain`, `email.local`. */
  readonly problems: Readonly<Record<string, string>>;
}

/** A name box with the domain after it: [hello]@bellassalon.com. */
function LocalPartInput({
  id,
  value,
  domain,
  invalid,
  onChange,
  testId,
}: {
  id: string;
  value: string;
  domain: string;
  invalid: boolean;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <div
      className={cn(
        'flex h-10 min-w-0 items-center overflow-hidden rounded-control border bg-card focus-within:ring-[3px] focus-within:ring-ring',
        invalid ? 'border-danger' : 'border-border-strong',
      )}
    >
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        className="h-full w-[9rem] min-w-0 flex-none bg-transparent px-3 text-[14px] outline-none max-sm:w-[7rem]"
        data-testid={testId}
      />
      <span className="min-w-0 truncate pr-3 font-mono text-[12.5px] text-text-2">@{domain}</span>
    </div>
  );
}

function Shaded({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 rounded-menu bg-card-2 p-4">{children}</div>;
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
      <div className="flex flex-col gap-2">
        <Label id="email-setup-which">{W.which}</Label>
        <div role="radiogroup" aria-labelledby="email-setup-which" className="flex flex-col gap-2">
          <Option
            on={own}
            onSelect={() => put({ with: 'domain' })}
            title={W.ownDomain}
            badge={
              <Badge variant="ok" className="h-5 text-[11.5px]">
                {W.best}
              </Badge>
            }
            description={W.ownDomainHint}
            testId="email-setup-with-domain"
          />
          {own ? (
            <Shaded>
              <Field
                label={W.domainLabel}
                htmlFor="email-setup-domain"
                error={problems['email.domain']}
                hint={
                  source === 'website'
                    ? W.domainFromWebsite
                    : source === 'email'
                      ? W.domainFromEmail
                      : undefined
                }
              >
                <Input
                  id="email-setup-domain"
                  value={answers.domain}
                  placeholder="yourbusiness.com"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  invalid={!!problems['email.domain']}
                  onChange={(e) => put({ domain: e.target.value })}
                  data-testid="email-setup-domain"
                />
              </Field>
              <div>
                <Label htmlFor="email-setup-local">{W.addressLabel}</Label>
                <LocalPartInput
                  id="email-setup-local"
                  value={answers.local}
                  domain={domain || 'yourbusiness.com'}
                  invalid={!!problems['email.local']}
                  onChange={(local) => put({ local })}
                  testId="email-setup-local"
                />
                {problems['email.local'] ? (
                  <FieldError>{problems['email.local']}</FieldError>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {emailSetupTeamChoices(state).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => put({ local: c })}
                      aria-pressed={answers.local.trim().toLowerCase() === c}
                      className={cn(
                        'h-8 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                        answers.local.trim().toLowerCase() === c
                          ? 'border-accent bg-accent-soft font-semibold text-accent-text'
                          : 'border-border-strong bg-card hover:bg-card-2',
                      )}
                      data-testid={`email-setup-local-${c}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <Note icon={Users}>
                <b className="font-semibold text-text">{W.teamReads}</b> {W.teamReadsNext}
              </Note>
            </Shaded>
          ) : null}
          <Option
            on={!own}
            onSelect={() => put({ with: 'free' })}
            title={W.free}
            description={
              <>
                <span className="font-mono text-[12px] text-text">
                  {emailSetupFreeAddress(answers, state)}
                </span>
                . {W.freeHint}
              </>
            }
            testId="email-setup-with-free"
          />
          {!own ? (
            <Shaded>
              <div>
                <Label htmlFor="email-setup-free">{W.freeLabel}</Label>
                <LocalPartInput
                  id="email-setup-free"
                  value={answers.freeLocal}
                  domain={state.sharedDomain}
                  invalid={!!problems['email.freeLocal']}
                  onChange={(freeLocal) => put({ freeLocal })}
                  testId="email-setup-free"
                />
                {problems['email.freeLocal'] ? (
                  <FieldError>{problems['email.freeLocal']}</FieldError>
                ) : null}
              </div>
              {gmail ? <Note>{W.whyNotGmail}</Note> : null}
            </Shaded>
          ) : null}
        </div>
      </div>
      <Field label={W.nameLabel} htmlFor="email-setup-name" error={problems['email.name']}>
        <Input
          id="email-setup-name"
          value={answers.name}
          maxLength={120}
          invalid={!!problems['email.name']}
          onChange={(e) => put({ name: e.target.value })}
          data-testid="email-setup-name"
        />
      </Field>
      <div
        className="flex items-center gap-3 rounded-menu border border-border bg-card px-3.5 py-3"
        aria-hidden
      >
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-[14px] font-semibold text-white">
          {(answers.name.trim() || state.businessName || 'B').charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-semibold">
            {answers.name.trim() || state.businessName}
          </span>
          <span className="truncate font-mono text-[12px] text-text-2">{address}</span>
          <span className="truncate text-[13px] text-text-2">
            Your appointment is booked: Tue, Nov 18…
          </span>
        </span>
      </div>
    </>
  );
}

const ago = (at: string | null) => {
  if (!at) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60_000));
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};

function RecordCard({ r }: { r: EmailSetupRecord }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-menu border border-border bg-card px-3.5 py-3"
      data-testid={`email-setup-record-${r.type.toLowerCase()}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[13px] font-medium">
          {r.type}
          {r.priority != null ? ` · priority ${r.priority}` : ''}
        </span>
        <Badge variant={r.found ? 'ok' : 'pending'}>{r.found ? W.found : W.waiting}</Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <div className="min-w-0">
          <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Name
          </div>
          <CopyField value={r.host} label="Copy the name" copied="Copied the name" />
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Value
          </div>
          <CopyField value={r.value} label="Copy the value" copied="Copied the value" />
        </div>
      </div>
    </div>
  );
}

/** How often the records screen looks again on its own while a record is still on its way, and how many times. */
const LOOK_AGAIN_MS = 60_000;
const LOOKS = 10;

/** "Add N records at GoDaddy": the domain's records, where to add them, and who else can. */
export function EmailRecordsScreen({
  workspaceId,
  state,
  answers,
  set,
  onChanged,
}: EmailScreenProps & {
  /** Asks for the state again; kept the same between draws. */
  readonly onChanged: () => unknown;
}) {
  const d = emailSetupDomainOf(state, answers);
  const [checking, setChecking] = useState(false);
  const [to, setTo] = useState('');
  const [sending, setSending] = useState<'me' | 'them' | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const looks = useRef(0);
  const receive = emailSetupReceives(d, answers);
  const records = d ? emailSetupShownRecords(d, state.inboundMxHost, receive) : [];
  const waiting = records.some((r) => !r.found);

  async function check(quiet = false) {
    if (!d) return;
    setChecking(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/email_domain.verify', {
          body: { workspaceId, emailDomainId: d.id },
        }),
      );
      // The worker answers in a moment; the live update brings it, and this asks again in case it doesn't.
      setTimeout(() => void onChanged(), 4_000);
    } catch (e) {
      if (!quiet) toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (!d || !waiting || d.status === 'verified') return;
    const timer = setInterval(() => {
      if (looks.current >= LOOKS) return;
      looks.current += 1;
      void checkRef.current(true);
    }, LOOK_AGAIN_MS);
    return () => clearInterval(timer);
  }, [d, waiting]);
  // Still being made (Postmark answers in a few seconds): ask again until they're there.
  useEffect(() => {
    if (d && records.length) return;
    const timer = setInterval(() => void onChanged(), 3_000);
    return () => clearInterval(timer);
  }, [d, records.length, onChanged]);

  async function send(who: 'me' | 'them') {
    if (!d) return;
    const email = who === 'me' ? (state.myEmail ?? '') : to.trim();
    setSending(who);
    setSendError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/email_domain.send_steps', {
          body: { workspaceId, emailDomainId: d.id, to: email },
        }),
      );
      toast.success(W.sentTo(email));
      if (who === 'them') setTo('');
    } catch (e) {
      setSendError(errorMessage(e));
    } finally {
      setSending(null);
    }
  }

  if (!d || !records.length)
    return (
      <Callout icon={Clock} testId="email-setup-records-making">
        {W.recordsMaking}
      </Callout>
    );
  const host = dnsHostFor(d.dnsHost);
  const found = records.filter((r) => r.found).length;
  const own = emailSetupSenderAddress(answers, state);
  return (
    <>
      <p className="text-[14px] leading-[1.5] text-text-2" data-testid="email-setup-records-hint">
        <b className="font-semibold text-text">
          {W.recordsTitle(records.length, host?.label ?? null)}.
        </b>{' '}
        {W.recordsHint(d.domain, host?.label ?? null)}
      </p>
      {emailSetupOffersReceiving(d) ? (
        <div className="flex items-start gap-3 rounded-menu border border-border bg-card px-3.5 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold">{W.receiveLabel(d.domain)}</span>
            <span className="text-[13px] text-text-2">
              {d.mailHost === 'handsfreeos' ? W.receiveHere : W.receiveHint}
            </span>
          </div>
          <Switch
            checked={receive}
            onChange={(on) => set({ ...answers, receive: on })}
            label={W.receiveLabel(d.domain)}
            disabled={d.receiving !== 'off'}
            testId="email-setup-receive"
          />
        </div>
      ) : d.mailHost && d.mailHost !== 'none' ? (
        <Note icon={Mail}>{W.mailElsewhere(d.domain, MAIL_HOST_LABELS[d.mailHost])}</Note>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span className="text-[14px] leading-[1.5]">
          {host ? W.stepsAt(d.domain, host.label, host.where, host.add) : W.stepsAnywhere(d.domain)}
        </span>
        {host?.note ? <Note>{host.note}</Note> : null}
        {host ? (
          <a
            href={host.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-[14px] font-semibold text-accent-text hover:underline"
            data-testid="email-setup-open-host"
          >
            {W.openHost(host.label)}
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          </a>
        ) : null}
      </div>
      <div className="flex flex-col gap-2.5">
        {records.map((r) => (
          <RecordCard key={`${r.type}-${r.host}`} r={r} />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13.5px] text-text-2" data-testid="email-setup-found">
          {W.foundOf(found, records.length)}
          {d.lastCheckedAt ? ` · ${ago(d.lastCheckedAt)}` : ''}
        </span>
        <Button
          variant="secondary"
          size="sm"
          loading={checking}
          onClick={() => void check()}
          data-testid="email-setup-check"
        >
          {W.checkNow}
        </Button>
      </div>
      {d.status === 'verified' ? (
        <Callout icon={Check} testId="email-setup-verified">
          {W.verified(own)}
        </Callout>
      ) : (
        <Note>
          {W.until(
            state.sender?.domain ? state.sender.address : emailSetupFreeAddress(answers, state),
            own,
          )}
        </Note>
      )}
      <div className="flex flex-col gap-2 rounded-menu bg-card-2 p-4">
        <span className="text-[14px] font-semibold">{W.someoneElse}</span>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={W.sendTo}
            placeholder={W.sendTo}
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="min-w-[12rem] flex-1"
            data-testid="email-setup-send-to"
          />
          <Button
            variant="secondary"
            loading={sending === 'them'}
            disabled={!to.trim()}
            onClick={() => void send('them')}
            data-testid="email-setup-send"
          >
            <Send className="h-4 w-4" strokeWidth={1.75} />
            {W.sendSteps}
          </Button>
        </div>
        {state.myEmail ? (
          <button
            type="button"
            onClick={() => void send('me')}
            disabled={sending !== null}
            className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-accent-text hover:underline disabled:opacity-60"
            data-testid="email-setup-send-me"
          >
            <Laptop className="h-3.5 w-3.5" strokeWidth={1.75} />
            {W.emailMe} ({state.myEmail})
          </button>
        ) : null}
        {sendError ? <FieldError>{sendError}</FieldError> : null}
      </div>
      {d.status !== 'verified' ? <p className="text-[13px] text-text-2">{W.later}</p> : null}
    </>
  );
}

/** "Your own email": an address just for the person, and the Gmail or Outlook they use now. */
export function EmailOwnScreen({
  workspaceId,
  state,
  answers,
  set,
  problems,
  forClient = false,
}: EmailScreenProps & { readonly forClient?: boolean }) {
  const [busy, setBusy] = useState<'microsoft' | 'google' | null>(null);
  const sender = emailSetupSenderAddress(answers, state);
  if (forClient) return <Note>{W.keepsGoing(sender)}</Note>;
  const domain = normalizeEmailDomain(answers.domain);
  const put = (patch: Partial<EmailSetupAnswers>) => set({ ...answers, ...patch });
  const theirs = state.myEmail && isConsumerMailDomain(state.myEmail.split('@')[1] ?? '');
  const connected = state.mailboxes.filter((m) => m.mine && m.status === 'active');

  // Sign-in opens in a new tab, so this screen stays where it is; the mailbox shows here once it's connected.
  async function connect(provider: 'microsoft' | 'google') {
    setBusy(provider);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/mailbox.connect', {
          body: { workspaceId, provider },
        }),
      );
      window.open(
        `${publicEnv.workerUrl}/oauth/${provider}/start?state=${encodeURIComponent(out.state)}`,
        '_blank',
        'noopener',
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {answers.with === 'domain' ? (
        state.mine ? (
          <Callout icon={Lock} testId="email-setup-mine-have">
            {W.mineHave(state.mine.address)}
          </Callout>
        ) : (
          <div className="flex flex-col gap-2">
            <Label id="email-setup-mine">{W.mineQuestion}</Label>
            <div
              role="radiogroup"
              aria-labelledby="email-setup-mine"
              className="flex flex-col gap-2"
            >
              <Option
                on={!answers.mine}
                onSelect={() => put({ mine: false })}
                title={W.mineNo(answers.local.trim() || 'hello')}
                testId="email-setup-mine-no"
              />
              <Option
                on={answers.mine}
                onSelect={() => put({ mine: true })}
                title={W.mineYes}
                testId="email-setup-mine-yes"
              />
            </div>
            {answers.mine ? (
              <Shaded>
                <div>
                  <Label htmlFor="email-setup-mine-local">{W.mineLabel}</Label>
                  <LocalPartInput
                    id="email-setup-mine-local"
                    value={answers.mineLocal}
                    domain={domain}
                    invalid={!!problems['email.mineLocal']}
                    onChange={(mineLocal) => put({ mineLocal })}
                    testId="email-setup-mine-local"
                  />
                  {problems['email.mineLocal'] ? (
                    <FieldError>{problems['email.mineLocal']}</FieldError>
                  ) : null}
                </div>
                <Note icon={Lock}>{W.mineNote}</Note>
              </Shaded>
            ) : null}
          </div>
        )
      ) : null}
      {answers.with === 'domain' ? <div className="h-px bg-border" /> : null}
      <div className="flex flex-col gap-2.5">
        <span className="text-[14px] font-semibold">{W.bringIn}</span>
        <p className="text-[13.5px] leading-[1.5] text-text-2">
          {W.bringInHint(theirs ? state.myEmail : null)}
        </p>
        {connected.map((m) => (
          <Callout
            key={`${m.provider}-${m.accountEmail}`}
            icon={Check}
            testId="email-setup-connected"
          >
            {W.connected(m.accountEmail ?? 'Your mailbox')}
          </Callout>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={!publicEnv.gmailEnabled}
            loading={busy === 'google'}
            onClick={() => void connect('google')}
            data-testid="email-setup-connect-gmail"
          >
            <GoogleLogo className="h-4 w-4" />
            {publicEnv.gmailEnabled ? W.connectGmail : W.gmailSoon}
          </Button>
          <Button
            variant="secondary"
            loading={busy === 'microsoft'}
            onClick={() => void connect('microsoft')}
            data-testid="email-setup-connect-outlook"
          >
            <MicrosoftLogo className="h-4 w-4" />
            {W.connectOutlook}
          </Button>
        </div>
        <p className="text-[13px] text-text-2">{W.keepsGoing(sender)}</p>
      </div>
    </>
  );
}
