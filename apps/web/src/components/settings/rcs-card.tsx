'use client';
/**
 * Settings → Texting: RCS (0101).
 *
 * **One setting for the whole business, nothing in the composer.** Once a sender is connected and the carriers
 * approve it, every text goes RCS first — the business's name and logo at the top, pictures, buttons to tap —
 * and a phone that can't show RCS gets the same message as an SMS or MMS by itself. So this card is the only
 * place RCS is set up; the inbox just says which way each text went.
 *
 * **Made at Twilio, connected here.** Twilio onboards RCS senders only in its console (the brand, the logo, the
 * carriers' review), so the sender is made there, in the business's own Twilio account, and connected here by
 * its id. The card lists the senders it finds in that account, so nobody has to copy one.
 */
import { formatDate, rcsSenderIdInput } from '@hfos/core';
import { CircleAlert, Clock, Info, MessageSquareText, RefreshCw, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { ChannelIcon } from '@/components/inbox/bits';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PhoneNumberInfo, PhoneSetupStatus } from '@/lib/api/types';
import { findRcsSenders, type FoundRcsSender } from '@/lib/api/worker';
import { cn } from '@/lib/utils';
import { SetRow } from './set-row';

type Sender = NonNullable<PhoneSetupStatus['rcsSender']>;

/** The badge beside the card's title: where RCS stands for the business, in a word or two. */
function badgeOf(s: Sender | null): { label: string; variant: BadgeVariant } {
  if (!s) return { label: 'Off', variant: 'gray' };
  switch (s.status) {
    case 'connecting':
      return { label: 'Connecting', variant: 'pending' };
    case 'in_review':
      return { label: 'In review', variant: 'pending' };
    case 'active':
      if (s.sending) return { label: 'On', variant: 'ok' };
      return s.enabled
        ? { label: 'Finishing setup', variant: 'pending' }
        : { label: 'Paused', variant: 'gray' };
    case 'offline':
      return { label: 'Offline', variant: 'danger' };
    case 'failed':
      return { label: 'Not connected', variant: 'danger' };
    case 'disconnecting':
      return { label: 'Disconnecting', variant: 'gray' };
    default:
      return { label: 'Off', variant: 'gray' };
  }
}

const FOUND_STATE: Record<FoundRcsSender['state'], string> = {
  online: 'Approved',
  in_review: 'In review',
  offline: 'Offline',
  failed: 'Not approved',
};

/** A business's name for a line: "Main line · (713) 555-0100", or the number alone. */
const lineName = (n: PhoneNumberInfo) => (n.label ? `${n.label} · ${n.display}` : n.display);

/** Where a customer's first RCS message starts its thread, when the business has more than one line. */
function LineSelect({
  id,
  numbers,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  numbers: readonly PhoneNumberInfo[];
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const fallback = numbers.find((n) => n.isDefault) ?? numbers[0];
  return (
    <Select
      id={id}
      selectSize="sm"
      aria-label="New RCS conversations start on"
      className="w-[240px] max-w-full"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      data-testid="rcs-line"
    >
      <option value="">
        {fallback ? `The default number (${fallback.display})` : 'The default number'}
      </option>
      {numbers.map((n) => (
        <option key={n.id} value={n.id}>
          {lineName(n)}
        </option>
      ))}
    </Select>
  );
}

/**
 * Connect a sender: the ones found in the business's Twilio account to pick from, or its id typed in. The same
 * form tries again after a sender could not be connected, starting from the id that failed.
 */
function ConnectForm({
  workspaceId,
  businessName,
  lines,
  retryId,
  onConnected,
}: {
  workspaceId: string;
  businessName: string;
  lines: readonly PhoneNumberInfo[];
  retryId: string | null;
  onConnected: () => void;
}) {
  const inputId = useId();
  const lineId = useId();
  const [senderId, setSenderId] = useState(retryId ?? '');
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [found, setFound] = useState<{
    accountSid: string | null;
    senders: FoundRcsSender[];
  } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // What is already in the business's Twilio account, looked up once when the form opens.
  useEffect(() => {
    let cancelled = false;
    findRcsSenders(workspaceId)
      .then((r) => {
        if (cancelled) return;
        setFound(r);
        // One sender and nothing typed: that is the one.
        if (r.senders.length === 1) setSenderId((v) => v || r.senders[0]!.senderId);
      })
      .catch((e) => {
        if (!cancelled) setLookupError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    const parsed = rcsSenderIdInput.safeParse(senderId);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the sender’s id from Twilio.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/rcs_sender.connect', {
          body: { workspaceId, senderId: parsed.data, ...(line ? { phoneNumberId: line } : {}) },
        }),
      );
      toast.success('Connecting your RCS sender…');
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const senders = found?.senders ?? [];
  return (
    <form onSubmit={(e) => void connect(e)} className="mt-4 flex flex-col gap-3.5" noValidate>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] text-text-2">
        <li>
          Make an RCS sender for {businessName} in the Twilio console, under Messaging → Senders
          {found?.accountSid ? (
            <>
              {' '}
              in account{' '}
              <span className="font-mono text-xs" data-testid="rcs-account">
                {found.accountSid}
              </span>
            </>
          ) : null}
          . That is where your name, logo and colors go.
        </li>
        <li>Connect it here. The carriers review it, which can take a few weeks.</li>
        <li>Once they approve it, texts go as RCS by themselves. Nothing changes until then.</li>
      </ol>

      {senders.length ? (
        <div className="flex flex-col gap-1.5" data-testid="rcs-found">
          <span className="text-[13px] font-medium">In your Twilio account</span>
          {senders.map((s) => (
            <button
              key={s.sid}
              type="button"
              onClick={() => setSenderId(s.senderId)}
              aria-pressed={senderId === s.senderId}
              className={cn(
                'flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors',
                senderId === s.senderId
                  ? 'border-accent bg-accent-soft'
                  : 'border-border hover:border-border-strong',
              )}
              data-testid="rcs-found-sender"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium">
                  {s.displayName ?? s.senderId}
                </span>
                <span className="truncate font-mono text-xs text-text-3">{s.senderId}</span>
              </span>
              <Badge
                variant={
                  s.state === 'online' ? 'ok' : s.state === 'in_review' ? 'pending' : 'danger'
                }
              >
                {FOUND_STATE[s.state]}
              </Badge>
            </button>
          ))}
        </div>
      ) : found ? (
        <p className="text-xs text-text-3" data-testid="rcs-found-none">
          No RCS senders in your Twilio account yet. Once you make one, it shows up here.
        </p>
      ) : lookupError ? (
        <p className="text-xs text-text-3">
          Couldn’t look in your Twilio account ({lookupError}). You can still type the sender’s id.
        </p>
      ) : null}

      <Field
        label="Sender id"
        htmlFor={inputId}
        hint="From the sender’s page in Twilio, like lonestar_hvac_agent. With or without rcs: in front."
        error={error}
      >
        <Input
          id={inputId}
          value={senderId}
          onChange={(e) => setSenderId(e.target.value)}
          placeholder="lonestar_hvac_agent"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error || undefined}
          data-testid="rcs-sender-id"
        />
      </Field>
      {lines.length > 1 ? (
        <Field
          label="New RCS conversations start on"
          htmlFor={lineId}
          hint="When a customer messages your RCS sender first, their conversation goes with this number."
        >
          <LineSelect id={lineId} numbers={lines} value={line} onChange={setLine} />
        </Field>
      ) : null}
      <div>
        <Button type="submit" loading={saving} data-testid="rcs-connect">
          Connect RCS sender
        </Button>
      </div>
    </form>
  );
}

/** What is going on with a connected sender right now, when there is something to say. */
function stateNote(
  s: Sender,
): { tone: 'info' | 'warning' | 'danger' | 'neutral'; text: string } | null {
  switch (s.status) {
    case 'connecting':
      return { tone: 'neutral', text: 'Checking the sender with Twilio. This takes a moment.' };
    case 'in_review':
      return {
        tone: 'info',
        text: 'The carriers are reviewing your sender. This can take a few weeks. Texts keep going as SMS and MMS until then, and we’ll email you when RCS is on.',
      };
    case 'offline':
      return {
        tone: 'warning',
        text: `Twilio says this sender is offline${s.providerStatus ? ` (${s.providerStatus})` : ''}. Texts go as SMS and MMS until it’s back. Check the sender in the Twilio console, then check again here.`,
      };
    case 'disconnecting':
      return {
        tone: 'neutral',
        text: 'Taking the sender off your texting. Texts go as SMS and MMS.',
      };
    case 'active':
      if (!s.enabled)
        return {
          tone: 'neutral',
          text: 'RCS is paused. Every text goes as SMS or MMS, and the sender stays connected.',
        };
      if (!s.sending)
        return {
          tone: 'neutral',
          text: 'Approved. Adding the sender to your texting, which takes a moment.',
        };
      return null;
    default:
      return null;
  }
}

/** Settings → Texting's RCS card: connect a sender, follow its review, pause it, or let it go. */
export function RcsCard({
  workspaceId,
  businessName,
  sender,
  numbers,
  canManage,
}: {
  workspaceId: string;
  businessName: string;
  sender: Sender | null;
  numbers: readonly PhoneNumberInfo[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'refresh' | 'disconnect' | 'enabled' | 'line' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const badge = badgeOf(sender);
  const lines = numbers.filter((n) => n.status === 'active');
  const connected = sender && sender.status !== 'failed';
  const note = connected ? stateNote(sender) : null;
  const settled = connected && sender.status !== 'connecting' && sender.status !== 'disconnecting';
  // Connecting and letting go take seconds: look again every few, in case the live channel is down.
  const moving = sender?.status === 'connecting' || sender?.status === 'disconnecting';
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [moving, router]);

  async function act(kind: 'refresh' | 'disconnect', success: string): Promise<void> {
    setBusy(kind);
    try {
      if (kind === 'refresh')
        unwrap(
          await apiBrowser().POST('/v1/commands/rcs_sender.refresh', { body: { workspaceId } }),
        );
      else
        unwrap(
          await apiBrowser().POST('/v1/commands/rcs_sender.disconnect', { body: { workspaceId } }),
        );
      toast.success(success);
      setConfirmOff(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function update(
    change: { enabled?: boolean; phoneNumberId?: string | null },
    success: string,
  ): Promise<void> {
    setBusy(change.enabled !== undefined ? 'enabled' : 'line');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/rcs_sender.update', {
          body: { workspaceId, ...change },
        }),
      );
      toast.success(success);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-6" id="rcs" data-testid="rcs-card" data-status={sender?.status ?? 'none'}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">RCS messaging</h2>
        <Badge variant={badge.variant} data-testid="rcs-badge">
          {badge.label}
        </Badge>
      </div>
      <p className="mt-1 text-[13px] text-text-2">
        Phones that support RCS get your texts with your name and logo, bigger pictures, and buttons
        to tap. Other phones still get a regular text. It all stays in the same conversations, and
        each message shows how it went.
      </p>

      {sender?.status === 'failed' ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-4 px-3 py-2.5">
          <span data-testid="rcs-error">
            Couldn’t connect <span className="font-mono text-xs">{sender.senderId}</span>
            {sender.lastError ? `: ${sender.lastError}` : '.'}
          </span>
        </Callout>
      ) : null}

      {connected ? (
        <>
          <div className="mt-4 flex items-center gap-3.5">
            <ChannelIcon icon={MessageSquareText} size={44} />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-medium" data-testid="rcs-name">
                {sender.displayName ?? businessName}
              </div>
              <div className="truncate text-xs text-text-3">
                <span className="font-mono">{sender.senderId}</span>
                {sender.connectedAt ? ` · approved ${formatDate(sender.connectedAt)}` : ''}
              </div>
            </div>
          </div>
          {note ? (
            <Callout
              tone={note.tone}
              icon={note.tone === 'warning' ? CircleAlert : note.tone === 'info' ? Clock : Info}
              className="mt-3.5 px-3 py-2.5"
              data-testid="rcs-note"
            >
              {note.text}
            </Callout>
          ) : null}
          {sender.status === 'offline' && sender.lastError ? (
            <p className="mt-2 text-xs text-text-3">{sender.lastError}</p>
          ) : null}
          {settled && canManage ? (
            <div className="mt-2">
              <SetRow
                first
                center
                title="Send as RCS when the phone supports it"
                description="Off sends every text as SMS or MMS. The sender stays connected."
              >
                <Switch
                  checked={sender.enabled}
                  label="Send as RCS"
                  disabled={busy !== null}
                  testId="rcs-enabled"
                  onChange={(on) =>
                    void update({ enabled: on }, on ? 'RCS is back on' : 'RCS paused')
                  }
                />
              </SetRow>
              {lines.length > 1 ? (
                <SetRow
                  title="New RCS conversations start on"
                  description="When a customer messages your RCS sender first, their conversation goes with this number."
                >
                  <LineSelect
                    numbers={lines}
                    value={sender.phoneNumberId}
                    disabled={busy !== null}
                    onChange={(id) => void update({ phoneNumberId: id }, 'Saved')}
                  />
                </SetRow>
              ) : null}
            </div>
          ) : null}
          {settled && canManage ? (
            confirmOff ? (
              <div
                className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] bg-card-2 px-3 py-2.5"
                data-testid="rcs-disconnect-confirm"
              >
                <span className="min-w-[200px] flex-1 text-[13px] text-text-2">
                  Disconnect RCS? Texts go as SMS and MMS again. The sender stays in your Twilio
                  account.
                </span>
                <Button variant="ghost" size="sm" onClick={() => setConfirmOff(false)}>
                  Keep it
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy === 'disconnect'}
                  onClick={() => void act('disconnect', 'RCS disconnected')}
                  data-testid="rcs-disconnect-yes"
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'refresh'}
                  disabled={busy !== null}
                  onClick={() => void act('refresh', 'Checking with Twilio…')}
                  data-testid="rcs-refresh"
                >
                  {busy === 'refresh' ? null : (
                    <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                  Check now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setConfirmOff(true)}
                  data-testid="rcs-disconnect"
                >
                  <Unplug className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Disconnect
                </Button>
              </div>
            )
          ) : null}
        </>
      ) : canManage ? (
        <ConnectForm
          workspaceId={workspaceId}
          businessName={businessName}
          lines={lines}
          retryId={sender?.senderId ?? null}
          onConnected={() => router.refresh()}
        />
      ) : null}

      {!canManage ? (
        <p className="mt-3 text-xs text-text-3">Owners and admins can change this.</p>
      ) : null}
    </Card>
  );
}
