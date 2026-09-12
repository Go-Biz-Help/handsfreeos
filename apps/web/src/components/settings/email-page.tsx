'use client';
import { AtSign, CircleAlert, Globe, RotateCw, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { PersonDialog } from '@/components/crm/person-dialog';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { ChannelIcon } from '@/components/inbox/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyField, copyText } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  EmailAddressInfo,
  EmailDomainInfo,
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

/** The DNS name to type at the provider: relative to the domain, as most providers want it. */
const relativeHost = (host: string, domain: string) =>
  host.toLowerCase().endsWith(`.${domain}`) ? host.slice(0, -(domain.length + 1)) : host;

function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-[13px] text-text-2">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </Card>
  );
}

async function run<T>(fn: () => Promise<T>, done?: string): Promise<T | null> {
  try {
    const out = await fn();
    if (done) toast.success(done);
    return out;
  } catch (e) {
    toast.error(errorMessage(e));
    return null;
  }
}

// ---------- sending address ----------
function SendingAddress({
  workspaceId,
  addresses,
  onChanged,
}: {
  workspaceId: string;
  addresses: EmailAddressInfo[];
  onChanged: () => void;
}) {
  const ordered = [...addresses].sort((a, b) => Number(!!b.domain) - Number(!!a.domain));
  const ownDefault = addresses.some((a) => a.isDefault && a.domain);
  const current =
    addresses.find((a) => a.isDefault)?.displayName ?? addresses[0]?.displayName ?? '';
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);

  async function makeDefault(a: EmailAddressInfo) {
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_address.update', {
            body: { workspaceId, emailAddressId: a.id, isDefault: true },
          }),
        ),
      `${a.address} is now the default`,
    );
    if (ok) onChanged();
  }
  // Customers see one business name: it goes on every address.
  async function saveName() {
    setSaving(true);
    const ok = await run(async () => {
      for (const a of addresses)
        unwrap(
          await apiBrowser().POST('/v1/commands/email_address.update', {
            body: { workspaceId, emailAddressId: a.id, displayName: name.trim() },
          }),
        );
      return true;
    }, 'Saved');
    setSaving(false);
    if (ok) onChanged();
  }

  return (
    <Section
      title="Sending address"
      description="Customers see your business name, and their replies land in the inbox."
    >
      <div className="mt-4 flex flex-col gap-2" data-testid="email-addresses">
        {ordered.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-3 rounded-menu border border-border px-3.5 py-3"
            data-testid={`email-address-${a.localPart}`}
          >
            <ChannelIcon icon={AtSign} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{a.displayName}</div>
              <div className="truncate font-mono text-[12.5px] text-text-2">{a.address}</div>
            </div>
            {a.isDefault ? <Badge variant="owner">Default</Badge> : null}
            {!a.domain && !a.isDefault && ownDefault ? <Badge variant="gray">Backup</Badge> : null}
            {!a.isDefault && a.usable ? (
              <Button variant="ghost" size="sm" onClick={() => void makeDefault(a)}>
                Make default
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              title="Copy address"
              aria-label={`Copy ${a.address}`}
              onClick={() => void copyText(a.address, `Copied ${a.address}`)}
            >
              <CopyGlyph />
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <Label htmlFor="email-display-name">Name customers see</Label>
        <div className="flex gap-2">
          <Input
            id="email-display-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="secondary"
            loading={saving}
            disabled={!name.trim() || name.trim() === current}
            onClick={() => void saveName()}
          >
            Save
          </Button>
        </div>
      </div>
    </Section>
  );
}

function CopyGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

// ---------- own domain ----------
function RecordBox({
  type,
  purpose,
  host,
  value,
  verified,
  domain,
}: {
  type: 'TXT' | 'CNAME';
  purpose: string;
  host: string;
  value: string;
  verified: boolean;
  domain: string;
}) {
  return (
    <div className="rounded-menu border border-border px-3.5 py-3" data-testid={`dns-${type}`}>
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
      </div>
    </div>
  );
}

function OwnDomain({
  workspaceId,
  domain,
  sharedAddress,
  displayName,
  onChanged,
}: {
  workspaceId: string;
  domain: EmailDomainInfo | null;
  sharedAddress: string;
  displayName: string;
  onChanged: () => void;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState('');
  // "Check now" asks the worker, which answers a moment later; the result toast waits for that answer.
  const waiting = useRef<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);

  useEffect(() => {
    if (!domain || waiting.current === null) return;
    if (domain.lastCheckedAt && domain.lastCheckedAt !== waiting.current) {
      waiting.current = null;
      setJustChecked(true);
      if (domain.status === 'verified') toast.success(`${domain.domain} is verified`);
      else if (domain.dkimVerifiedAt && !domain.returnPathVerifiedAt)
        toast('DKIM found. The Return-Path record isn’t showing yet.');
      else if (!domain.dkimVerifiedAt && domain.returnPathVerifiedAt)
        toast('Return-Path found. The DKIM record isn’t showing yet.');
      else toast('Neither record is showing yet. DNS changes can take a few hours.');
    }
  }, [domain]);

  async function add() {
    setBusy('add');
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/email_domain.add', {
          body: { workspaceId, domain: input },
        }),
      );
      toast.success('Domain added. Now add the two records.');
      setInput('');
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function check() {
    if (!domain) return;
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
    if (!domain) return;
    setBusy('remove');
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_domain.remove', {
            body: { workspaceId, emailDomainId: domain.id },
          }),
        ),
      `Domain removed. Email keeps going out from ${sharedAddress}.`,
    );
    setBusy(null);
    if (ok) onChanged();
  }
  async function addAddress() {
    if (!domain) return;
    setBusy('address');
    setError(null);
    try {
      const made = unwrap(
        await apiBrowser().POST('/v1/commands/email_address.create', {
          body: {
            workspaceId,
            localPart: local,
            emailDomainId: domain.id,
            displayName,
            isDefault: true,
          },
        }),
      );
      toast.success(`${made.address} is now the default address`);
      setLocal('');
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const status = domain?.status ?? null;
  const description =
    status === 'verified'
      ? 'Verified. Addresses on this domain can send now.'
      : status
        ? `Waiting for the DNS records below. Until then, email goes out from ${sharedAddress}.`
        : `Send from an address like office@yourbusiness.com. Until it’s verified, email keeps going out from ${sharedAddress}.`;
  const hasRecords = !!(domain?.dkimHost && domain.dkimValue && domain.returnPathHost);

  return (
    <Section
      title="Use your own domain"
      description={description}
      aside={
        status === 'verified' ? (
          <Badge variant="ok">Verified</Badge>
        ) : status === 'failed' ? (
          <Badge variant="danger">Needs attention</Badge>
        ) : status ? (
          <Badge variant="pending">Waiting for DNS</Badge>
        ) : null
      }
    >
      {!domain ? (
        <div className="mt-4">
          <div className="flex gap-2">
            <Input
              aria-label="Your domain"
              placeholder="yourbusiness.com"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && input.trim()) void add();
              }}
              data-testid="domain-input"
            />
            <Button loading={busy === 'add'} disabled={!input.trim()} onClick={() => void add()}>
              Add domain
            </Button>
          </div>
          {error ? (
            <p className="mt-1.5 text-xs text-danger-text" role="alert">
              {error}
            </p>
          ) : (
            <Hint>
              Next you add two records where your domain is managed, such as GoDaddy, Cloudflare or
              Namecheap.
            </Hint>
          )}
        </div>
      ) : (
        <>
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
          {status === 'failed' && domain.lastError ? (
            <Callout tone="danger" icon={CircleAlert} className="mt-3">
              {domain.lastError}
            </Callout>
          ) : null}
          {status !== 'verified' ? (
            <p className="mt-2.5 text-[13px] text-text-2">
              {hasRecords
                ? 'Add these two records at your DNS provider. Changes can take a few hours to show up. We check once a day and email you when it works.'
                : 'Getting your records ready. They show here in a moment.'}
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
                value={domain.returnPathValue ?? 'pm.mtasv.net'}
                verified={!!domain.returnPathVerifiedAt}
                domain={domain.domain}
              />
            </div>
          ) : null}
          {status === 'verified' ? (
            <div className="mt-4">
              <Label htmlFor="domain-local">{`Add an address on ${domain.domain}`}</Label>
              <div className="flex gap-2">
                <div className="flex min-w-0 flex-1 overflow-hidden rounded-control border border-border-strong bg-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring">
                  <input
                    id="domain-local"
                    aria-label="Address name"
                    value={local}
                    onChange={(e) =>
                      setLocal(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
                    }
                    placeholder="office"
                    className="h-[38px] min-w-0 flex-1 bg-transparent px-3 text-[15px] focus:outline-none"
                  />
                  <span className="inline-flex h-[38px] items-center border-l border-border bg-card-2 px-3 font-mono text-[12.5px] text-text-2">
                    @{domain.domain}
                  </span>
                </div>
                <Button
                  loading={busy === 'address'}
                  disabled={!local}
                  onClick={() => void addAddress()}
                >
                  Add address
                </Button>
              </div>
              {error ? (
                <p className="mt-1.5 text-xs text-danger-text" role="alert">
                  {error}
                </p>
              ) : (
                <Hint>
                  {`It becomes the default. ${sharedAddress} stays as the backup in case the domain ever stops verifying.`}
                </Hint>
              )}
            </div>
          ) : null}
          <div className="mt-3.5 flex gap-2">
            {status !== 'verified' ? (
              <Button
                size="sm"
                loading={busy === 'check'}
                onClick={() => void check()}
                data-testid="domain-check"
              >
                <RotateCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                Check now
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="text-danger-text"
              loading={busy === 'remove'}
              onClick={() => void remove()}
            >
              Remove domain
            </Button>
          </div>
        </>
      )}
    </Section>
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
      description="Email between these mailboxes and people in Customers shows in the inbox and on the timeline. Other mail stays private."
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
        {publicEnv.gmailEnabled ? null : (
          <Badge variant="pending">Waiting on Google’s review</Badge>
        )}
      </div>
      {publicEnv.gmailEnabled ? null : (
        <p className="mt-2 text-xs text-text-3">
          Gmail opens up once Google finishes its security review of HandsFreeOS.
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

// ---------- mail from people not in Customers ----------
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
  return (
    <Section
      title="Mail from people not in Customers"
      description="Replies to the workspace address from someone we can’t match wait here."
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

/** Settings → Email: the sending address, the workspace's own domain, mailboxes, blocked and unmatched mail. */
export function EmailPage({
  workspaceId,
  workspaceName,
  status,
  blocked,
  unmatched,
  tags,
  mailboxResult,
}: {
  workspaceId: string;
  workspaceName: string;
  status: EmailSetupStatus;
  blocked: EmailSuppression[];
  unmatched: EmailUnmatched[];
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
  ]);
  const shared = status.addresses.find((a) => !a.domain);
  const displayName =
    status.addresses.find((a) => a.isDefault)?.displayName ?? shared?.displayName ?? workspaceName;
  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2" data-testid="email-settings">
      <div className={cn('flex flex-col gap-5')}>
        <SendingAddress
          workspaceId={workspaceId}
          addresses={status.addresses}
          onChanged={refresh}
        />
        <OwnDomain
          workspaceId={workspaceId}
          domain={status.domains[0] ?? null}
          sharedAddress={shared?.address ?? `your address @${status.sharedDomain}`}
          displayName={displayName}
          onChanged={refresh}
        />
      </div>
      <div className="flex flex-col gap-5">
        <Mailboxes workspaceId={workspaceId} mailboxes={status.mailboxes} onChanged={refresh} />
        <Blocked workspaceId={workspaceId} items={blocked} onChanged={refresh} />
        <Unmatched workspaceId={workspaceId} items={unmatched} tags={tags} onChanged={refresh} />
      </div>
    </div>
  );
}
