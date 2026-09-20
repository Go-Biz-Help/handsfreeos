'use client';
import { formatPhone, normalizePhone } from '@hfos/core';
import { CircleAlert, CircleCheck, Paperclip, Send, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { PORT_DOCUMENT_ACCEPT, uploadPortDocument } from '@/lib/ports/upload';
import type { Ok } from '@/lib/api/types';

type Port = Ok<'/v1/queries/number_port.list'>['ports'][number];
type Kind = Port['kind'];

/** One number on its way here, as the page hands it down. */
export type PortInfo = Port;

/**
 * What each status means to a business owner who has never heard the word "port" (M17).
 *
 * Deliberately not the carrier's vocabulary. `carrier_review` is the one that matters: it is where a port
 * spends almost all of its life, and "with your old carrier" is the true and useful thing to say, because the
 * wait is theirs and there is nothing we or the business can do to hurry it.
 */
const STATUS_WORD: Readonly<Record<Port['status'], string>> = {
  draft: 'Not sent yet',
  submitted: 'Sent',
  carrier_review: 'With your old carrier',
  scheduled: 'Moving day set',
  complete: 'Moved',
  rejected: 'Turned down',
  cancelled: 'Called off',
  failed: 'Did not go through',
};

const STATUS_TONE: Readonly<Record<Port['status'], 'member' | 'accent' | 'pending' | 'danger'>> = {
  draft: 'member',
  submitted: 'pending',
  carrier_review: 'pending',
  scheduled: 'accent',
  complete: 'accent',
  rejected: 'danger',
  cancelled: 'member',
  failed: 'danger',
};

/** The true, plain difference between the two kinds. A business chooses on this and nothing else. */
const KINDS: readonly { kind: Kind; title: string; description: string }[] = [
  {
    kind: 'full',
    title: 'Texts and calls',
    description:
      'Everything moves here. Two to four weeks, and your old carrier has to agree — they usually do, but they can say no if anything on the account does not match.',
  },
  {
    kind: 'hosted_messaging',
    title: 'Texting only',
    description:
      'We take over texting; calls keep ringing exactly where they do today, on the phone you already have. Usually a few days, and much harder to get wrong.',
  },
];

/**
 * Bringing a number a business already has (M17).
 *
 * The screen a business sees after choosing "I already have a number", and the one that decides whether
 * porting works at all in practice — carriers turn down more ports for a mistyped account number than for
 * anything else. So the form asks for what the carrier asks for, in the carrier's own words ("the account
 * number on your bill, not your phone number"), and `number_port.submit` refuses until all of it is there.
 *
 * Nothing here ever shows the account number or the PIN back. They go in once and are never returned by any
 * query; the screen says which details are *filled*, which is also all the API will tell it.
 */
export function PortStep({
  workspaceId,
  ports,
  onBack,
}: {
  workspaceId: string;
  /** Ports already under way, newest first, from `number_port.list`. */
  ports: readonly Port[];
  onBack: () => void;
}) {
  const router = useRouter();
  const inFlight = ports.filter((p) => p.status !== 'cancelled' && p.status !== 'complete');
  const draft = inFlight.find((p) => p.status === 'draft' || p.status === 'rejected') ?? null;

  return (
    <div data-testid="port-step">
      <button
        type="button"
        onClick={onBack}
        className="text-[13px] text-text-3 hover:text-text"
        data-testid="port-back"
      >
        ← A new number instead
      </button>
      <h2 className="mt-3 text-lg font-semibold tracking-tight">Bring your number here</h2>
      <p className="mb-[18px] mt-1 text-[13px] text-text-2">
        Your customers keep dialing the number they always have. Your old carrier has to hand it
        over, so this takes days or weeks rather than minutes — and until it lands, everything keeps
        working exactly where it does now.
      </p>

      {inFlight
        .filter((p) => p !== draft)
        .map((p) => (
          <PortRow key={p.id} workspaceId={workspaceId} port={p} />
        ))}

      {draft ? (
        <PortForm workspaceId={workspaceId} port={draft} onDone={() => router.refresh()} />
      ) : (
        <StartPort workspaceId={workspaceId} />
      )}
    </div>
  );
}

/** Step one: which number, and which kind of move. */
function StartPort({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('full');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    const e164 = normalizePhone(typed);
    if (!e164) {
      setError('That does not look like a US phone number. Ten digits, like (713) 555-0123.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/number_port.start', {
          body: { workspaceId, e164, kind },
        }),
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="What moves"
        className="mb-[18px] grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {KINDS.map((k) => (
          <RadioCard
            key={k.kind}
            selected={kind === k.kind}
            onSelect={() => setKind(k.kind)}
            testId={`port-kind-${k.kind}`}
            title={k.title}
            description={k.description}
          />
        ))}
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <Field label="The number you have now" htmlFor="port-e164">
          <Input
            id="port-e164"
            inputMode="tel"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="(713) 555-0123"
            className="h-9 w-56"
            data-testid="port-e164"
          />
        </Field>
        <Button type="submit" loading={busy} data-testid="port-start">
          Start
        </Button>
      </form>
      {error ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3">
          {error}
        </Callout>
      ) : null}
    </div>
  );
}

/** Step two: what the losing carrier wants, the papers, and the send. */
function PortForm({
  workspaceId,
  port,
  onDone,
}: {
  workspaceId: string;
  port: Port;
  onDone: () => void;
}) {
  const [accountNumber, setAccountNumber] = useState('');
  const [pin, setPin] = useState('');
  const [authorizedBy, setAuthorizedBy] = useState('');
  const [serviceAddress, setServiceAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState<'loa' | 'bill' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = apiBrowser();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      unwrap(
        await api.POST('/v1/commands/number_port.save', {
          body: {
            workspaceId,
            portId: port.id,
            submission: {
              accountNumber: accountNumber.trim(),
              pin: pin.trim(),
              authorizedBy: authorizedBy.trim(),
              serviceAddress: serviceAddress.trim(),
            },
          },
        }),
      );
      // Cleared the moment they are saved. They are the old carrier's credentials, and leaving them sitting
      // in a form on a shared office screen is the one avoidable way they leak.
      setAccountNumber('');
      setPin('');
      toast.success('Saved.');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function attach(document: 'loa' | 'bill', file: File | null) {
    if (!file) return;
    setUploading(document);
    setError(null);
    try {
      await uploadPortDocument(workspaceId, port.id, document, file);
      toast.success(document === 'loa' ? 'Authorisation attached.' : 'Bill attached.');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(null);
    }
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      unwrap(
        await api.POST('/v1/commands/number_port.submit', {
          body: { workspaceId, portId: port.id },
        }),
      );
      toast.success('Sent to your old carrier.');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-card border border-border bg-card-2 p-4" data-testid="port-form">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">{port.display}</span>
        <Badge variant={STATUS_TONE[port.status]}>{STATUS_WORD[port.status]}</Badge>
        <span className="text-xs text-text-3">
          {port.kind === 'full' ? 'Texts and calls' : 'Texting only'}
        </span>
      </div>

      {port.status === 'rejected' && port.rejectionReason ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3">
          Your old carrier turned this down: {port.rejectionReason} Fix it below and send it again.
        </Callout>
      ) : null}

      <p className="mt-3 text-[13px] text-text-2">
        This all has to match your old carrier’s records exactly. It is on your bill, or they will
        read it to you if you call them.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Account number" htmlFor="port-account">
          <Input
            id="port-account"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
            placeholder="On your bill — not your phone number"
            data-testid="port-account"
          />
        </Field>
        <Field label="Transfer PIN or passcode" htmlFor="port-pin">
          <Input
            id="port-pin"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="Some carriers call it a port-out PIN"
            data-testid="port-pin"
          />
        </Field>
        <Field label="Who is authorising it" htmlFor="port-authorized">
          <Input
            id="port-authorized"
            value={authorizedBy}
            onChange={(e) => setAuthorizedBy(e.target.value)}
            placeholder="The name on the account"
            data-testid="port-authorized"
          />
        </Field>
        <Field label="Service address" htmlFor="port-address">
          <Input
            id="port-address"
            value={serviceAddress}
            onChange={(e) => setServiceAddress(e.target.value)}
            placeholder="As your old carrier has it, with the ZIP"
            data-testid="port-address"
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          loading={saving}
          onClick={() => void save()}
          data-testid="port-save"
        >
          Save these details
        </Button>
        {port.detailsReady ? (
          <span className="flex items-center gap-1.5 text-xs text-success-text">
            <CircleCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
            Details are in
          </span>
        ) : (
          <span className="text-xs text-text-3">
            Nothing is shown back once saved — these are your old carrier’s credentials.
          </span>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <DocumentRow
          label="Signed authorisation"
          hint="The letter that tells your old carrier to release the number. Carriers turn down a port without one."
          done={port.documents.loa}
          busy={uploading === 'loa'}
          testId="loa"
          onPick={(f) => void attach('loa', f)}
        />
        <DocumentRow
          label="A recent bill"
          hint="Optional, but most carriers ask for one. Any bill from the last few months will do."
          done={port.documents.bill}
          busy={uploading === 'bill'}
          testId="bill"
          onPick={(f) => void attach('bill', f)}
        />
      </div>

      {error ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3">
          {error}
        </Callout>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button
          loading={sending}
          disabled={!port.detailsReady || !port.documents.loa}
          onClick={() => void send()}
          data-testid="port-submit"
        >
          <Send className="h-3.5 w-3.5" strokeWidth={1.8} />
          Send it to your old carrier
        </Button>
        <CancelPort workspaceId={workspaceId} port={port} onDone={onDone} />
        {!port.detailsReady || !port.documents.loa ? (
          <span className="text-xs text-text-3">
            {!port.detailsReady
              ? 'Fill the details in first.'
              : 'Attach the signed authorisation first.'}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One paper: what it is, why the carrier wants it, and whether it is in. */
function DocumentRow({
  label,
  hint,
  done,
  busy,
  testId,
  onPick,
}: {
  label: string;
  hint: string;
  done: boolean;
  busy: boolean;
  testId: string;
  onPick: (file: File | null) => void;
}) {
  return (
    <label
      className="flex cursor-pointer flex-wrap items-center gap-3 py-2"
      data-testid={`port-doc-${testId}`}
    >
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-card">
        {done ? (
          <CircleCheck className="h-4 w-4 text-success-text" strokeWidth={1.8} />
        ) : (
          <Paperclip className="h-4 w-4 text-text-3" strokeWidth={1.8} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="block text-xs text-text-3">{hint}</span>
      </span>
      {/* The label is the control — clicking anywhere on the row opens the picker — so this is a span that
          looks like a button rather than a real one. A button inside a label swallows the click. */}
      <span className="flex flex-none items-center gap-1.5 rounded-menu px-2.5 py-1.5 text-[13px] font-medium text-text-2">
        <Upload className="h-3.5 w-3.5" strokeWidth={1.8} />
        {busy ? 'Uploading…' : done ? 'Replace' : 'Attach'}
      </span>
      <input
        type="file"
        className="hidden"
        accept={PORT_DOCUMENT_ACCEPT}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        data-testid={`port-doc-input-${testId}`}
      />
    </label>
  );
}

/** A port already with the carrier: what it is doing, and the way out. */
function PortRow({ workspaceId, port }: { workspaceId: string; port: Port }) {
  const router = useRouter();
  return (
    <div
      className="mb-3 rounded-card border border-border bg-card-2 p-4"
      data-testid={`port-row-${port.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">{port.display}</span>
        <Badge variant={STATUS_TONE[port.status]}>{STATUS_WORD[port.status]}</Badge>
        <span className="text-xs text-text-3">
          {port.kind === 'full' ? 'Texts and calls' : 'Texting only'}
        </span>
      </div>
      <p className="mt-2 text-[13px] text-text-2">
        {port.scheduledFor
          ? `Your old carrier has set ${port.scheduledFor} as the day it moves. Nothing changes for you until then.`
          : port.status === 'failed'
            ? 'Something went wrong on the way to your old carrier. Call it off and start again, or talk to us.'
            : 'Waiting on your old carrier. They take days for texting only, and two to four weeks for everything. Nothing changes until they move it.'}
      </p>
      <div className="mt-3">
        <CancelPort workspaceId={workspaceId} port={port} onDone={() => router.refresh()} />
      </div>
    </div>
  );
}

/** Calling a port off. Two presses, because it may already be too late to undo. */
function CancelPort({
  workspaceId,
  port,
  onDone,
}: {
  workspaceId: string;
  port: Port;
  onDone: () => void;
}) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!sure)
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setSure(true)}
        data-testid={`port-cancel-${port.id}`}
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.8} />
        Call it off
      </Button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-text-2">
        {port.status === 'draft'
          ? `Throw away this request for ${formatPhone(port.e164)}?`
          : `Ask your old carrier to stop the move of ${formatPhone(port.e164)}? If they have already moved it, it is too late.`}
      </span>
      <Button
        variant="danger"
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void apiBrowser()
            .POST('/v1/commands/number_port.cancel', { body: { workspaceId, portId: port.id } })
            .then((r) => {
              unwrap(r);
              onDone();
            })
            .catch((e: unknown) => toast.error(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
        data-testid={`port-cancel-confirm-${port.id}`}
      >
        Call it off
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setSure(false)}>
        Keep it
      </Button>
    </span>
  );
}
