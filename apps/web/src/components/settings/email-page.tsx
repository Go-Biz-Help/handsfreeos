'use client';
import { dnsHostFor, relativeHost, RETURN_PATH_DEFAULT, type BusinessLook } from '@hfos/core';
import { ArrowRight, ChevronDown, CircleAlert, Globe, ListChecks, RotateCw, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { PersonDialog } from '@/components/crm/person-dialog';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type {
  EmailDomainInfo,
  EmailSenderRule,
  EmailSetupStatus,
  EmailSuppression,
  EmailUnmatched,
  MailboxInfo,
  Tag,
} from '@/lib/api/types';
import { publicEnv } from '@/lib/env';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { GoogleLogo, MicrosoftLogo, providerName } from './provider-logos';
import { SettingAnchor } from './setting-anchor';
import { run, Section, YourAddresses, type Person } from './email-addresses';
import { EmailLookCard } from './email-look';

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const clockOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "today", "yesterday", "on Sep 10". */
function dayWord(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round(
    (new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000,
  );
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `on ${shortDate(iso)}`;
}

/** "just now", "2 minutes ago", "3 hours ago", "Sep 10". */
function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return shortDate(iso);
}

// ---------- own domain ----------
function RecordBox({
  type,
  purpose,
  host,
  value,
  verified,
  domain,
  priority,
  testId,
}: {
  type: 'TXT' | 'CNAME' | 'MX';
  purpose: string;
  host: string;
  value: string;
  verified: boolean;
  domain: string;
  /** An MX record's priority, its own field at most DNS providers. */
  priority?: number;
  /** Beside `dns-${type}`, for a second record of the same type. */
  testId?: string;
}) {
  return (
    <div
      className="rounded-menu border border-border px-3.5 py-3"
      data-testid={testId ?? `dns-${type}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="gray" className="font-mono text-[11.5px]">
            {type}
          </Badge>
          <span className="text-[13px] font-medium">{purpose}</span>
        </div>
        {verified ? (
          <Badge variant="ok">Verified</Badge>
        ) : (
          <Badge variant="pending">Not found yet</Badge>
        )}
      </div>
      <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5">
        <span className="text-xs text-text-3">Host</span>
        <CopyField value={relativeHost(host, domain)} label="Copy host" copied="Copied the host" />
        <span className="text-xs text-text-3">Value</span>
        <CopyField value={value} label="Copy value" copied="Copied the value" />
        {priority != null ? (
          <>
            <span className="text-xs text-text-3">Priority</span>
            <CopyField
              value={String(priority)}
              label="Copy priority"
              copied="Copied the priority"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Where the guided setup opens from Settings → Email, so Finish later comes back here. */
const guidedHref = (workspaceId: string, more = '') =>
  `/onboarding/${workspaceId}/email?from=settings${more}`;

/** One row of a website name's card: what it is, how it stands, and what can be done about it. */
function Row({
  label,
  children,
  action,
  testId,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="grid items-center gap-x-5 gap-y-2 md:grid-cols-[11rem_minmax(0,1fr)_auto]"
      data-testid={testId}
    >
      <div className="text-[13px] font-medium text-text-2">{label}</div>
      <div className="min-w-0">{children}</div>
      {action ? (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">{action}</div>
      ) : null}
    </div>
  );
}

/** No website name yet: the guided setup adds one, a question at a time (the owner, 22 Nov 2026). */
function UseYourOwn({
  workspaceId,
  sharedAddress,
}: {
  workspaceId: string;
  sharedAddress: string;
}) {
  return (
    <Section
      title="Use your own website name"
      description={`Send from an address like office@yourbusiness.com, and read its mail here. Until it’s set up, email keeps going out from ${sharedAddress}.`}
    >
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <ButtonLink
          href={guidedHref(workspaceId)}
          variant="primary"
          data-testid="email-guided-open"
        >
          Set it up
          <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
        </ButtonLink>
        <span className="text-[13px] text-text-3">
          A few questions, one at a time. Your answers save as you go.
        </span>
      </div>
    </Section>
  );
}

/**
 * One of the business's website names, after the guided setup: whether its mail comes in here, and its records
 * (folded away once they're all found). While something is left, it says what and opens the guided setup's last
 * step, which walks through it.
 */
function OwnDomain({
  workspaceId,
  domain,
  sharedAddress,
  hasAddress,
  receivingOpen,
  inboundMxHost,
  onChanged,
}: {
  workspaceId: string;
  domain: EmailDomainInfo;
  sharedAddress: string;
  /** It has an address already, so it needn't say where to add the first one. */
  hasAddress: boolean;
  /** The business may receive mail at its domains (M19). */
  receivingOpen: boolean;
  inboundMxHost: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // "Check now" asks the worker, which answers a moment later; the result toast waits for that answer.
  const waiting = useRef<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);
  const status = domain.status;
  const left: 'records' | 'mail' | null =
    status !== 'verified'
      ? 'records'
      : domain.receiving === 'pending' || domain.receiving === 'lapsed'
        ? 'mail'
        : null;
  // The records show while any is still to add, and fold away once they're all found.
  const [shown, setShown] = useState(left !== null);

  useEffect(() => {
    if (waiting.current === null) return;
    if (domain.lastCheckedAt && domain.lastCheckedAt !== waiting.current) {
      waiting.current = null;
      setJustChecked(true);
      if (domain.status === 'verified') toast.success(`${domain.domain} is verified`);
      else if (domain.lastError) toast(domain.lastError);
      else if (domain.dkimVerifiedAt && domain.returnPathVerifiedAt)
        toast(
          'Both mail records found. The record that says the website name is yours isn’t showing yet.',
        );
      else if (domain.dkimVerifiedAt && !domain.returnPathVerifiedAt)
        toast('DKIM found. The Return-Path record isn’t showing yet.');
      else if (!domain.dkimVerifiedAt && domain.returnPathVerifiedAt)
        toast('Return-Path found. The DKIM record isn’t showing yet.');
      else toast('Neither mail record is showing yet. Changes can take a few hours to show.');
    }
  }, [domain]);

  async function check() {
    setBusy('check');
    waiting.current = domain.lastCheckedAt ?? '';
    const ok = await run(async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/email_domain.verify', {
          body: { workspaceId, emailDomainId: domain.id },
        }),
      ),
    );
    if (!ok) waiting.current = null;
    setBusy(null);
  }
  async function remove() {
    setBusy('remove');
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_domain.remove', {
            body: { workspaceId, emailDomainId: domain.id },
          }),
        ),
      `${domain.domain} removed. Email keeps going out from ${sharedAddress}.`,
    );
    setBusy(null);
    if (ok) onChanged();
  }
  const description =
    status === 'verified'
      ? hasAddress
        ? 'Its records are found. Addresses on it can send now.'
        : 'Its records are found. Click Add an address under Your addresses to start sending from it.'
      : `Waiting for its records. Until they’re found, email goes out from ${sharedAddress}.`;
  const hasRecords = !!(domain.dkimHost && domain.dkimValue && domain.returnPathHost);
  const host = dnsHostFor(domain.dnsHost)?.label ?? null;
  // Every record this website name needs, and whether each is found: the ones that let it send, the one that says
  // it is this business's, and ours for its mail once that is asked for.
  const wantsMail = domain.receiving !== 'off';
  const records = [
    ...(hasRecords ? [!!domain.dkimVerifiedAt, !!domain.returnPathVerifiedAt] : []),
    ...(hasRecords && domain.ownershipHost ? [!!domain.ownershipProvedAt] : []),
    ...(wantsMail ? [!!domain.mxVerifiedAt && domain.receiving === 'on'] : []),
  ];
  const found = records.filter(Boolean).length;

  return (
    <Section
      title="Your website name"
      description={description}
      aside={
        status === 'verified' ? (
          <Badge variant="ok">Verified</Badge>
        ) : status === 'failed' ? (
          <Badge variant="danger">Needs attention</Badge>
        ) : (
          <Badge variant="pending">Waiting for its records</Badge>
        )
      }
    >
      <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
        <Globe className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span className="font-mono text-sm font-medium" data-testid="domain-name">
          {domain.domain}
        </span>
        <span className="text-xs text-text-3">
          {status === 'verified'
            ? `Verified ${dayWord(domain.returnPathVerifiedAt ?? domain.dkimVerifiedAt ?? domain.createdAt)}`
            : justChecked
              ? 'Checked just now'
              : `Added ${dayWord(domain.createdAt)}${domain.lastCheckedAt ? ` · last checked ${clockOf(domain.lastCheckedAt)}` : ''}`}
        </span>
      </div>
      {status !== 'verified' && domain.lastError ? (
        <Callout
          tone={status === 'failed' ? 'danger' : 'warning'}
          icon={CircleAlert}
          className="mt-3"
        >
          {domain.lastError}
        </Callout>
      ) : null}
      {left ? (
        <Callout
          tone="info"
          icon={ListChecks}
          className="mt-3 items-center"
          data-testid="domain-left"
          action={
            <ButtonLink
              href={guidedHref(workspaceId, `&at=records&d=${domain.id}`)}
              size="sm"
              className="flex-none"
              data-testid="domain-steps"
            >
              Open the steps
            </ButtonLink>
          }
        >
          {left === 'records'
            ? `One step left: add your records${host ? ` at ${host}` : ''}. The steps walk you through it.`
            : `One step left: change the mail record${host ? ` at ${host}` : ''}, so mail to ${domain.domain} lands here. The steps walk you through it.`}
        </Callout>
      ) : null}
      <div className="mt-4 flex flex-col divide-y divide-border rounded-menu border border-border">
        {receivingOpen || wantsMail ? (
          <div className="px-3.5 py-3.5">
            <Receiving
              workspaceId={workspaceId}
              domain={domain}
              verified={status === 'verified'}
              onChanged={onChanged}
            />
          </div>
        ) : null}
        <div className="px-3.5 py-3.5">
          <Row
            label={`Records${host ? ` at ${host}` : ''}`}
            testId="domain-records"
            action={
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={shown}
                onClick={() => setShown((now) => !now)}
                data-testid="domain-records-toggle"
              >
                {shown ? 'Hide' : 'Show'}
                <ChevronDown
                  className={cn('h-3.5 w-3.5 transition-transform', shown && 'rotate-180')}
                  strokeWidth={1.5}
                />
              </Button>
            }
          >
            {records.length ? (
              <Badge variant={found === records.length ? 'ok' : 'pending'}>
                {found === records.length
                  ? `All ${found} found`
                  : `${found} of ${records.length} found`}
              </Badge>
            ) : (
              <span className="text-[13px] text-text-2">
                Getting them ready. They show here in a moment.
              </span>
            )}
          </Row>
          {shown ? (
            <div className="mt-3.5">
              {status !== 'verified' && hasRecords ? (
                <p className="text-[13px] text-text-2">
                  {`Add ${domain.ownershipHost ? 'these three records' : 'these two records'}${host ? ` at ${host}` : ' where your website name is looked after'}. Changes can take a few hours to show up. We check on our own and email you when it works.`}
                </p>
              ) : null}
              {hasRecords ? (
                <div className="mt-3 flex flex-col gap-2.5">
                  <RecordBox
                    type="TXT"
                    purpose="Proves the mail is yours (DKIM)"
                    host={domain.dkimHost!}
                    value={domain.dkimValue!}
                    verified={!!domain.dkimVerifiedAt}
                    domain={domain.domain}
                  />
                  <RecordBox
                    type="CNAME"
                    purpose="Handles bounces (Return-Path)"
                    host={domain.returnPathHost!}
                    value={domain.returnPathValue ?? RETURN_PATH_DEFAULT}
                    verified={!!domain.returnPathVerifiedAt}
                    domain={domain.domain}
                  />
                  {/* Which business set the name up (M19): the mail records alone say only that somebody did. */}
                  {domain.ownershipHost ? (
                    <RecordBox
                      type="TXT"
                      purpose="Says the website name is this business’s"
                      host={domain.ownershipHost}
                      value={domain.ownershipToken}
                      verified={!!domain.ownershipProvedAt}
                      domain={domain.domain}
                      testId="dns-TXT-ownership"
                    />
                  ) : null}
                  {/* Ours for its mail, once that is asked for: the old ones are deleted, and this one added. */}
                  {wantsMail ? (
                    <RecordBox
                      type="MX"
                      purpose="Brings your mail here"
                      host="@"
                      value={inboundMxHost}
                      priority={10}
                      verified={!!domain.mxVerifiedAt && domain.receiving === 'on'}
                      domain={domain.domain}
                    />
                  ) : null}
                </div>
              ) : null}
              {status !== 'verified' ? (
                <div className="mt-3.5">
                  <Button
                    size="sm"
                    loading={busy === 'check'}
                    onClick={() => void check()}
                    data-testid="domain-check"
                  >
                    <RotateCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Check now
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3.5">
        <Button
          variant="ghost"
          size="sm"
          className="text-danger-text"
          loading={busy === 'remove'}
          onClick={() => void remove()}
          data-testid="domain-remove"
        >
          Remove this website name
        </Button>
      </div>
    </Section>
  );
}

/**
 * "Mail coming in" (M19): once a website name's mail record points here, mail to every address on it arrives in
 * HandsFreeOS (the team's Inbox, or one person's own mail), with no Google or Outlook needed. The record itself
 * sits with the others under Records.
 */
function Receiving({
  workspaceId,
  domain,
  verified,
  onChanged,
}: {
  workspaceId: string;
  domain: EmailDomainInfo;
  /** Its sending records are found: mail can only be brought in after that. */
  verified: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const receiving = domain.receiving;
  async function start() {
    setBusy('start');
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_domain.receive', {
            body: { workspaceId, emailDomainId: domain.id },
          }),
        ),
      receiving === 'lapsed'
        ? 'Checking again. It takes up to 15 minutes.'
        : receiving === 'pending'
          ? 'Checking now. This shows Working once the mail record is found.'
          : 'Now change the mail record. Open the steps to see how.',
    );
    setBusy(null);
    if (ok) onChanged();
  }
  async function stop() {
    if (
      !window.confirm(
        `Stop receiving mail at ${domain.domain}? Mail that still comes here won’t be filed, so point the mail record back where it was first.`,
      )
    )
      return;
    setBusy('stop');
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_domain.stop_receiving', {
            body: { workspaceId, emailDomainId: domain.id },
          }),
        ),
      `Stopped. Mail to ${domain.domain} isn’t filed here anymore.`,
    );
    setBusy(null);
    if (ok) onChanged();
  }
  const stopButton = (
    <Button
      variant="ghost"
      size="sm"
      className="text-danger-text"
      loading={busy === 'stop'}
      onClick={() => void stop()}
    >
      Stop receiving here
    </Button>
  );
  const checkButton = (label: string) => (
    <Button size="sm" loading={busy === 'start'} onClick={() => void start()}>
      <RotateCw className="h-3.5 w-3.5" strokeWidth={1.5} />
      {label}
    </Button>
  );
  // How it stands, in a badge and a line, with what there is to do about it.
  const stand: { badge: ReactNode; line: string; more: string | null; action: ReactNode } =
    !verified
      ? {
          badge: <Badge variant="gray">Not yet</Badge>,
          line: 'Your records come first.',
          more: 'Once they’re found, you can bring your mail here.',
          action: null,
        }
      : receiving === 'on'
        ? {
            badge: <Badge variant="ok">Working</Badge>,
            line: 'Lands in HandsFreeOS',
            more: `${domain.mxCheckedAt ? `Checked ${ago(domain.mxCheckedAt)}. ` : ''}Mail to an address you haven’t added goes to the team’s Inbox.`,
            action: stopButton,
          }
        : receiving === 'pending'
          ? {
              badge: <Badge variant="pending">Waiting</Badge>,
              line: 'Not here yet',
              more: `Delete the old mail records for ${domain.domain} and add ours, with priority 10. We check every 15 minutes. Just changed it? Click Check now.`,
              action: (
                <>
                  {checkButton('Check now')}
                  {stopButton}
                </>
              ),
            }
          : receiving === 'lapsed'
            ? {
                badge: <Badge variant="danger">Not working</Badge>,
                line: 'The mail record doesn’t point here anymore',
                more: 'New mail may be going somewhere else. Put our record back, then check again.',
                action: (
                  <>
                    {checkButton('Check again')}
                    {stopButton}
                  </>
                ),
              }
            : {
                badge: <Badge variant="gray">Off</Badge>,
                line: 'Stays where it goes today',
                more: `Bring it here and all mail to ${domain.domain} is read in HandsFreeOS, with no Gmail or Outlook needed.`,
                action: (
                  <Button size="sm" loading={busy === 'start'} onClick={() => void start()}>
                    Receive mail here
                  </Button>
                ),
              };
  return (
    <>
      <Row label="Mail coming in" testId="domain-receiving" action={stand.action}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {stand.badge}
          <span className="text-sm">{stand.line}</span>
        </div>
        {stand.more ? <p className="mt-1 text-[13px] text-text-2">{stand.more}</p> : null}
      </Row>
      {verified && receiving === 'off' && domain.receivingError ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3" data-testid="receiving-error">
          {domain.receivingError}
        </Callout>
      ) : null}
      {verified && receiving === 'off' ? (
        <Callout tone="warning" icon={CircleAlert} className="mt-3">
          {`Once you change the mail record, mail to every address at ${domain.domain} comes to HandsFreeOS instead of where it goes now. Add everyone’s address first.`}
        </Callout>
      ) : null}
    </>
  );
}

// ---------- connected mailboxes ----------
const MAILBOX_BADGE: Record<
  MailboxInfo['status'],
  { variant: 'ok' | 'pending' | 'danger' | 'gray'; label: string }
> = {
  active: { variant: 'ok', label: 'Connected' },
  pending: { variant: 'pending', label: 'Connecting' },
  reauth_required: { variant: 'danger', label: 'Needs reconnecting' },
  error: { variant: 'danger', label: 'Not syncing' },
  disconnected: { variant: 'gray', label: 'Disconnected' },
};

function mailboxDetail(m: MailboxInfo): string {
  if (m.status === 'pending') return 'connecting…';
  if (m.status === 'reauth_required')
    return m.lastSyncedAt ? `lost access after ${shortDate(m.lastSyncedAt)}` : 'lost access';
  if (m.status === 'error') return m.lastError ?? 'the last sync failed';
  return m.lastSyncedAt ? `synced ${ago(m.lastSyncedAt)}` : 'syncing for the first time';
}

function Mailboxes({
  workspaceId,
  mailboxes,
  onChanged,
}: {
  workspaceId: string;
  mailboxes: MailboxInfo[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Sign-in happens in this tab: the worker sends it to Microsoft (or Google) and back to this page.
  async function connect(provider: 'microsoft' | 'google') {
    setBusy(provider);
    const out = await run(async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/mailbox.connect', {
          body: { workspaceId, provider },
        }),
      ),
    );
    if (out)
      window.location.assign(
        `${publicEnv.workerUrl}/oauth/${provider}/start?state=${encodeURIComponent(out.state)}`,
      );
    else setBusy(null);
  }
  async function disconnect(m: MailboxInfo) {
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/mailbox.disconnect', {
            body: { workspaceId, connectionId: m.id },
          }),
        ),
      `${m.accountEmail ?? 'The mailbox'} disconnected. Email already brought in stays.`,
    );
    if (ok) onChanged();
  }
  return (
    <Section
      title="Connected mailboxes"
      setting="email.mailboxes"
      description="Email between these mailboxes and people in Contacts shows in the inbox and on the timeline. Other mail stays private."
    >
      <div className="mt-3" data-testid="mailboxes">
        {mailboxes.map((m) => {
          const badge = MAILBOX_BADGE[m.status];
          return (
            <div key={m.id} className="flex items-center gap-3 border-t border-border py-3">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-menu border border-border bg-card">
                {m.provider === 'microsoft' ? <MicrosoftLogo /> : <GoogleLogo />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {m.accountEmail ?? 'Signing in…'}
                </div>
                <div className="truncate text-xs text-text-3">
                  {[m.userName, providerName(m.provider), mailboxDetail(m)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {m.status === 'reauth_required' || m.status === 'error' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === m.provider}
                  onClick={() => void connect(m.provider)}
                >
                  Reconnect
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                title="Disconnect"
                aria-label={`Disconnect ${m.accountEmail ?? 'this mailbox'}`}
                onClick={() => void disconnect(m)}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3.5">
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'microsoft'}
          onClick={() => void connect('microsoft')}
          data-testid="connect-outlook"
        >
          <MicrosoftLogo />
          Connect Outlook
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!publicEnv.gmailEnabled}
          loading={busy === 'google'}
          onClick={() => void connect('google')}
          data-testid="connect-gmail"
        >
          <GoogleLogo />
          Connect Gmail
        </Button>
        {publicEnv.gmailEnabled ? null : <Badge variant="pending">Coming soon</Badge>}
      </div>
      {publicEnv.gmailEnabled ? null : (
        <p className="mt-2 text-xs text-text-3">
          Gmail is coming soon. Until then, connect Outlook or send from your workspace address.
        </p>
      )}
    </Section>
  );
}

// ---------- blocked addresses ----------
const REASON: Record<EmailSuppression['reason'], string> = {
  hard_bounce: 'Bounced, the address doesn’t exist',
  spam_complaint: 'Marked as spam',
  manual: 'Stopped by hand',
};

function Blocked({
  workspaceId,
  items,
  onChanged,
}: {
  workspaceId: string;
  items: EmailSuppression[];
  onChanged: () => void;
}) {
  const active = items.filter((s) => !s.releasedAt);
  async function release(s: EmailSuppression) {
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_suppression.release', {
            body: { workspaceId, suppressionId: s.id },
          }),
        ),
      `${s.address} unblocked`,
    );
    if (ok) onChanged();
  }
  return (
    <Section
      title="Blocked addresses"
      setting="email.blocked"
      description="We stop emailing an address after it bounces or reports spam, to protect your sending reputation."
    >
      <div className="mt-2.5" data-testid="blocked-addresses">
        {active.length === 0 ? (
          <p className="border-t border-border py-2.5 text-[13px] text-text-3">Nothing blocked.</p>
        ) : (
          active.map((s) => (
            <div key={s.id} className="flex items-center gap-3 border-t border-border py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] font-medium">{s.address}</div>
                <div className="text-xs text-text-3">
                  {REASON[s.reason]} · {shortDate(s.createdAt)}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void release(s)}>
                Unblock
              </Button>
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

// ---------- mail from people not in Contacts ----------
const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

function ClaimDialog({
  workspaceId,
  item,
  tags,
  onClose,
  onDone,
}: {
  workspaceId: string;
  item: EmailUnmatched;
  tags: Tag[];
  onClose: () => void;
  onDone: () => void;
}) {
  const name = item.fromName ?? item.fromAddress;
  const [picked, setPicked] = useState<PickedRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  async function claim(personId: string, personName: string) {
    setBusy(true);
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email.claim_unmatched', {
            body: { workspaceId, unmatchedId: item.id, personId },
          }),
        ),
      `Filed under ${personName}. It’s in their email now.`,
    );
    setBusy(false);
    if (ok) onDone();
  }
  if (adding)
    return (
      <PersonDialog
        workspaceId={workspaceId}
        tags={tags}
        open
        onOpenChange={(open) => {
          if (!open) setAdding(false);
        }}
        defaultEmail={item.fromAddress}
        defaultName={item.fromName ?? ''}
        onSaved={(personId) => void claim(personId, name)}
      />
    );
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        title={`Add or link ${name}`}
        description={`Their email joins the customer’s email conversation. ${item.fromAddress}`}
      >
        <Field label="Link to a customer" htmlFor="claim-person" className="mt-4">
          <RecordPicker
            workspaceId={workspaceId}
            id="claim-person"
            addNew={false}
            value={picked}
            onChange={setPicked}
            autoFocus
          />
        </Field>
        {picked && picked.kind !== 'person' ? (
          <p className="mt-1.5 text-xs text-danger-text">Pick a person, not a company.</p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add as a new person
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!picked || picked.kind !== 'person'}
              onClick={() => picked && void claim(picked.id, picked.name)}
            >
              Link
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Unmatched({
  workspaceId,
  items,
  tags,
  onChanged,
}: {
  workspaceId: string;
  items: EmailUnmatched[];
  tags: Tag[];
  onChanged: () => void;
}) {
  const [claiming, setClaiming] = useState<EmailUnmatched | null>(null);
  async function dismiss(u: EmailUnmatched) {
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email.dismiss_unmatched', {
            body: { workspaceId, unmatchedId: u.id },
          }),
        ),
      'Dismissed',
    );
    if (ok) onChanged();
  }
  // New mail from strangers goes to Other mail in the inbox (M19); what was already here can still be filed, and
  // the list leaves once it's empty.
  if (items.length === 0 && !claiming) return null;
  return (
    <Section
      title="Mail from people not in Contacts"
      setting="email.unknown_senders"
      description="Mail that came before Other mail did waits here. New mail from people not in Contacts is in Other mail, in the inbox."
    >
      <div className="mt-2.5" data-testid="unmatched-mail">
        {items.length === 0 ? (
          <p className="border-t border-border py-2.5 text-[13px] text-text-3">All sorted.</p>
        ) : (
          items.map((u) => (
            <div key={u.id} className="flex items-start gap-3 border-t border-border py-3">
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-card-3 text-[10px] font-semibold text-text-2"
              >
                {initials(u.fromName ?? u.fromAddress)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {u.fromName ? <span className="font-semibold">{u.fromName} </span> : null}
                  <span className="text-text-3">{u.fromAddress}</span>
                </div>
                <div className="truncate text-[13px]">
                  {u.subject || u.snippet || '(no subject)'}
                </div>
                <div className="text-xs text-text-3">{ago(u.receivedAt)}</div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setClaiming(u)}>
                Add or link
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void dismiss(u)}>
                Dismiss
              </Button>
            </div>
          ))
        )}
      </div>
      {claiming ? (
        <ClaimDialog
          workspaceId={workspaceId}
          item={claiming}
          tags={tags}
          onClose={() => setClaiming(null)}
          onDone={() => {
            setClaiming(null);
            onChanged();
          }}
        />
      ) : null}
    </Section>
  );
}

// ---------- where senders' mail goes ----------
const RULE_FOLDER: Record<EmailSenderRule['folder'], string> = {
  inbox: 'To the Inbox',
  other: 'To Other mail',
  spam: 'To Spam',
};

/** The sender rules people saved when they moved a thread and picked Always (M19), and a way to forget one. */
function SenderRules({
  workspaceId,
  items,
  onChanged,
}: {
  workspaceId: string;
  items: EmailSenderRule[];
  onChanged: () => void;
}) {
  async function remove(r: EmailSenderRule) {
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_sender_rule.remove', {
            body: { workspaceId, address: r.address },
          }),
        ),
      `Forgot ${r.address}. Their next new email is sorted as usual.`,
    );
    if (ok) onChanged();
  }
  return (
    <Section
      title="Where senders’ mail goes"
      setting="email.sender_rules"
      description="Saved when someone moves an email and picks Always. Remove one and that sender’s new mail is sorted as usual."
    >
      <div className="mt-2.5" data-testid="sender-rules">
        {items.length === 0 ? (
          <p className="border-t border-border py-2.5 text-[13px] text-text-3">None yet.</p>
        ) : (
          items.map((r) => (
            <div key={r.address} className="flex items-center gap-3 border-t border-border py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{r.address}</div>
                <div className="text-xs text-text-3">
                  {`${RULE_FOLDER[r.folder]}${r.createdBy ? ` · ${r.createdBy.fullName}` : ''}, ${dayWord(r.createdAt)}`}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void remove(r)}>
                Remove
              </Button>
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

/** Settings → Email: the business's addresses, its own domains, mailboxes, blocked and unmatched mail. */
export function EmailPage({
  workspaceId,
  status,
  blocked,
  unmatched,
  senderRules,
  people,
  myUserId,
  tags,
  mailboxResult,
  look,
  canChangeLook,
}: {
  workspaceId: string;
  status: EmailSetupStatus;
  /** The brand kit, which holds how emails look (design tools, part 5). */
  look: BusinessLook;
  canChangeLook: boolean;
  blocked: EmailSuppression[];
  unmatched: EmailUnmatched[];
  senderRules: EmailSenderRule[];
  /** Everyone who works the inbox, who can be given an address of their own (M19). */
  people: Person[];
  /** The person looking: an address can be theirs alone, and only they hand their own back to the team. */
  myUserId: string;
  tags: Tag[];
  /** How the sign-in went, when the browser just came back from Microsoft or Google. */
  mailboxResult: string | null;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const told = useRef(false);
  useEffect(() => {
    if (!mailboxResult || told.current) return;
    told.current = true;
    if (mailboxResult === 'connected')
      toast.success('Connected. Email with customers comes in over the next few minutes.');
    else if (mailboxResult === 'cancelled') toast('Sign-in cancelled. Nothing was connected.');
    else if (mailboxResult === 'missing_permissions')
      toast.error(
        'HandsFreeOS needs permission to read and send mail. Connect again and leave every box ticked.',
      );
    else toast.error('That mailbox didn’t connect. Try again in a minute.');
    // Once told, the address loses the result so a reload doesn't say it again.
    router.replace(`/app/w/${workspaceId}/settings/email`, { scroll: false });
  }, [mailboxResult, router, workspaceId]);
  // The worker answers domain checks and mailbox sign-ins a moment later; those changes arrive live.
  useLiveRefresh([
    'email_domain',
    'email_address',
    'mailbox',
    'email_suppression',
    'email_unmatched',
    'email_sender_rule',
  ]);
  const sharedAddress =
    status.addresses.find((a) => !a.domain)?.address ?? `your address @${status.sharedDomain}`;
  const websiteNames = status.domains.length
    ? status.domains.map((d) => (
        <OwnDomain
          key={d.id}
          workspaceId={workspaceId}
          domain={d}
          sharedAddress={sharedAddress}
          hasAddress={status.addresses.some((x) => x.emailDomainId === d.id)}
          receivingOpen={status.receivingOpen}
          inboundMxHost={status.inboundMxHost}
          onChanged={refresh}
        />
      ))
    : [<UseYourOwn key="none" workspaceId={workspaceId} sharedAddress={sharedAddress} />];
  return (
    <div className="flex flex-col gap-5" data-testid="email-settings">
      {/* The addresses get the page's whole width: each row holds an address, who reads it and its buttons. */}
      <YourAddresses
        workspaceId={workspaceId}
        addresses={status.addresses}
        domains={status.domains}
        people={people}
        myUserId={myUserId}
        aiTeammate={status.aiTeammate ?? null}
        onChanged={refresh}
      />
      {/* Every website name the business has (up to three), each the page's whole width like the addresses above
          it; with none yet, the way to add one. Settings search jumps to the first card, whichever it is. */}
      {websiteNames.map((card, i) =>
        i === 0 ? (
          <SettingAnchor key={card.key} setting="email.own_domain">
            {card}
          </SettingAnchor>
        ) : (
          card
        ),
      )}
      {status.domains.length ? (
        <p className="-mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[13px] text-text-2">
          <span>Moving to a different website name, or adding another?</span>
          <Link
            href={guidedHref(workspaceId, '&again=1')}
            className="font-medium text-accent-text hover:underline"
            data-testid="email-guided-again"
          >
            Run the guided setup again
          </Link>
        </p>
      ) : null}
      <EmailLookCard
        workspaceId={workspaceId}
        look={look}
        name={status.emailLook?.name ?? ''}
        contact={status.emailLook?.contact ?? null}
        canChange={canChangeLook}
        onChanged={refresh}
      />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Mailboxes workspaceId={workspaceId} mailboxes={status.mailboxes} onChanged={refresh} />
          <SenderRules workspaceId={workspaceId} items={senderRules} onChanged={refresh} />
        </div>
        <div className="flex flex-col gap-5">
          <Blocked workspaceId={workspaceId} items={blocked} onChanged={refresh} />
          <Unmatched workspaceId={workspaceId} items={unmatched} tags={tags} onChanged={refresh} />
        </div>
      </div>
    </div>
  );
}
