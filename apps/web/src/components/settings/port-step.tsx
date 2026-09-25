'use client';
import { formatPhone, normalizePhone } from '@hfos/core';
import { CircleAlert, CircleCheck, Paperclip, Plus, Send, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { PortLetter, type LetterProfile } from '@/components/settings/port-letter';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Textarea } from '@/components/ui/textarea';
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

/** A number a migration found the business using, offered so it is not typed in again. */
export type MigratedNumber = Ok<'/v1/queries/number_port.list'>['fromMigration'][number];

/**
 * Bringing numbers a business already has (M17).
 *
 * The screen a business sees after choosing "I already have a number", and the one that decides whether
 * porting works at all in practice — carriers turn down more ports for a mistyped account number than for
 * anything else. So the form asks for what the carrier asks for, in the carrier's own words ("the account
 * number on your bill, not your phone number"), and `number_port.submit` refuses until all of it is there.
 *
 * **Several numbers go together.** A business moving off another system rarely has one number, and the
 * details, the signed letter and the bill are the same for every number on one account with the old carrier.
 * So every number not yet sent is one batch: the details are typed once and saved to each, one letter names
 * all of them and is attached to each, and one press sends them all. Each is still its own port underneath,
 * with its own status, and can be called off on its own.
 *
 * Nothing here ever shows the account number or the PIN back. They go in once and are never returned by any
 * query; the screen says which details are *filled*, which is also all the API will tell it.
 */
export function PortStep({
  workspaceId,
  ports,
  fromMigration,
  profile,
  onBack,
}: {
  workspaceId: string;
  /** Ports already under way, newest first, from `number_port.list`. */
  ports: readonly Port[];
  /** Numbers a migration found this business using that are not on their way here yet. */
  fromMigration: readonly MigratedNumber[];
  /** What we already know about the business, for the letter. */
  profile: LetterProfile;
  onBack: () => void;
}) {
  const router = useRouter();
  const inFlight = ports.filter((p) => p.status !== 'cancelled' && p.status !== 'complete');
  // Oldest first, so a number added later joins the end of the list rather than the top.
  const editable = inFlight
    .filter((p) => p.status === 'draft' || p.status === 'rejected')
    .reverse();

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
      <h2 className="mt-3 text-lg font-semibold tracking-tight">Bring your numbers here</h2>
      <p className="mb-[18px] mt-1 text-[13px] text-text-2">
        Your customers keep dialing the numbers they always have. Your old carrier has to hand them
        over, so this takes days or weeks rather than minutes — and until they land, everything
        keeps working exactly where it does now.
      </p>

      {inFlight
        .filter((p) => !editable.includes(p))
        .map((p) => (
          <PortRow key={p.id} workspaceId={workspaceId} port={p} />
        ))}

      {editable.length ? (
        <PortBatch
          workspaceId={workspaceId}
          ports={editable}
          fromMigration={fromMigration}
          profile={profile}
          onDone={() => router.refresh()}
        />
      ) : (
        <StartPort workspaceId={workspaceId} fromMigration={fromMigration} />
      )}
    </div>
  );
}

/**
 * The numbers in whatever someone typed: one per line, or separated by commas or semicolons. Not by spaces —
 * "(713) 555-0123" has two of its own.
 */
function parseNumbers(text: string): { good: string[]; bad: string[] } {
  const good: string[] = [];
  const bad: string[] = [];
  for (const piece of text.split(/[\n,;]+/)) {
    const typed = piece.trim();
    if (!typed) continue;
    const e164 = normalizePhone(typed);
    if (e164) {
      if (!good.includes(e164)) good.push(e164);
    } else bad.push(typed);
  }
  return { good, bad };
}

/**
 * Step one: which numbers, and which kind of move.
 *
 * With `kind` set it is adding to a batch already started, which already chose — so it does not ask again.
 */
function StartPort({
  workspaceId,
  fromMigration,
  kind: fixedKind,
  onCancel,
}: {
  workspaceId: string;
  fromMigration: readonly MigratedNumber[];
  kind?: Kind;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [chosenKind, setKind] = useState<Kind>('full');
  const kind = fixedKind ?? chosenKind;
  // Every number the migration found starts ticked: they were found because customers text and ring them.
  const [picked, setPicked] = useState<readonly string[]>(() => fromMigration.map((n) => n.e164));
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offered = fromMigration.map((n) => n.e164);
  const chosen = picked.filter((e) => offered.includes(e));
  const { good } = parseNumbers(typed);
  const count = new Set([...chosen, ...good]).size;

  async function start() {
    const { good: typedNumbers, bad } = parseNumbers(typed);
    if (bad.length) {
      setError(
        `${bad.join(', ')} ${bad.length === 1 ? 'does' : 'do'} not look like a US phone number. Ten digits, like (713) 555-0123.`,
      );
      return;
    }
    const numbers = [...new Set([...chosen, ...typedNumbers])];
    if (!numbers.length) {
      setError(
        offered.length
          ? 'Tick a number above, or type the one you have now.'
          : 'Type the number you have now.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    let started = 0;
    try {
      // One at a time, and stop at the first the server turns down: the usual reason is the ten-number
      // ceiling, which every number after it would hit too.
      for (const e164 of numbers) {
        try {
          unwrap(
            await apiBrowser().POST('/v1/commands/number_port.start', {
              body: { workspaceId, e164, kind },
            }),
          );
          started += 1;
        } catch (e) {
          const rest = numbers.length - started - 1;
          setError(
            `${formatPhone(e164)}: ${errorMessage(e)}${rest > 0 ? ` ${rest === 1 ? 'The number after it was' : `The ${rest} numbers after it were`} not started.` : ''}`,
          );
          break;
        }
      }
      if (started === numbers.length) {
        setTyped('');
        onCancel?.();
      }
      if (started > 0) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="port-start-form">
      {fixedKind ? null : (
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
      )}

      {fromMigration.length ? (
        <fieldset
          className="mb-4 rounded-card border border-border p-3"
          data-testid="port-migrated"
        >
          <legend className="px-1 text-[13px] font-medium">From your old CRM</legend>
          <p className="mb-2 text-xs text-text-3">
            Your migration found your customers texting and calling{' '}
            {fromMigration.length === 1 ? 'this number' : 'these numbers'}. Tick the ones to bring
            here.
          </p>
          <div className="flex flex-col gap-1.5">
            {fromMigration.map((n) => (
              <Checkbox
                key={n.e164}
                className="font-mono text-[13px]"
                checked={picked.includes(n.e164)}
                onChange={(e) =>
                  setPicked((was) =>
                    e.target.checked ? [...was, n.e164] : was.filter((x) => x !== n.e164),
                  )
                }
                label={n.display}
                data-testid={`port-migrated-${n.e164}`}
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <Field
          label={
            fromMigration.length
              ? 'Other numbers you have now'
              : fixedKind
                ? 'More numbers to bring'
                : 'The numbers you have now'
          }
          htmlFor="port-e164"
          hint="One per line, or separated by commas. They should all be on the same account with your old carrier."
        >
          <Textarea
            id="port-e164"
            inputMode="tel"
            rows={3}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={'(713) 555-0123\n(713) 555-0199'}
            className="max-w-sm font-mono text-[14px]"
            data-testid="port-e164"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={busy} data-testid="port-start">
            {count > 1 ? `Start moving ${count} numbers` : fixedKind ? 'Add' : 'Start'}
          </Button>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              Never mind
            </Button>
          ) : null}
        </div>
      </form>
      {error ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3">
          {error}
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * Step two, for every number not yet sent at once: what the losing carrier wants, the papers, and the send.
 *
 * Each command still takes one port, so each of these loops over them — one at a time, so the first failure
 * names the number it happened on and stops there, rather than leaving a business to work out which of six
 * went through.
 */
function PortBatch({
  workspaceId,
  ports,
  fromMigration,
  profile,
  onDone,
}: {
  workspaceId: string;
  ports: readonly Port[];
  fromMigration: readonly MigratedNumber[];
  profile: LetterProfile;
  onDone: () => void;
}) {
  const [accountNumber, setAccountNumber] = useState('');
  const [pin, setPin] = useState('');
  const [authorizedBy, setAuthorizedBy] = useState('');
  const [serviceAddress, setServiceAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState<'loa' | 'bill' | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const api = apiBrowser();
  const many = ports.length > 1;
  const detailsReady = ports.every((p) => p.detailsReady);
  const loaReady = ports.every((p) => p.documents.loa);

  /** Runs one command per port, in order, and stops at the first that fails — naming its number. */
  async function eachPort(run: (p: Port) => Promise<unknown>): Promise<boolean> {
    for (const p of ports) {
      try {
        await run(p);
      } catch (e) {
        setError(many ? `${p.display}: ${errorMessage(e)}` : errorMessage(e));
        return false;
      }
    }
    return true;
  }

  async function save() {
    setSaving(true);
    setError(null);
    const submission = {
      accountNumber: accountNumber.trim(),
      pin: pin.trim(),
      authorizedBy: authorizedBy.trim(),
      serviceAddress: serviceAddress.trim(),
    };
    try {
      const ok = await eachPort(async (p) =>
        unwrap(
          await api.POST('/v1/commands/number_port.save', {
            body: { workspaceId, portId: p.id, submission },
          }),
        ),
      );
      if (ok) {
        // Cleared the moment they are saved. They are the old carrier's credentials, and leaving them
        // sitting in a form on a shared office screen is the one avoidable way they leak.
        setAccountNumber('');
        setPin('');
        toast.success(many ? `Saved for all ${ports.length} numbers.` : 'Saved.');
      }
      onDone();
    } finally {
      setSaving(false);
    }
  }

  async function attach(document: 'loa' | 'bill', file: File | null) {
    if (!file) return;
    setUploading(document);
    setError(null);
    try {
      const ok = await eachPort((p) => uploadPortDocument(workspaceId, p.id, document, file));
      if (ok) {
        const what = document === 'loa' ? 'Letter' : 'Bill';
        toast.success(
          many ? `${what} attached to all ${ports.length} numbers.` : `${what} attached.`,
        );
      }
      onDone();
    } finally {
      setUploading(null);
    }
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const ok = await eachPort(async (p) =>
        unwrap(
          await api.POST('/v1/commands/number_port.submit', {
            body: { workspaceId, portId: p.id },
          }),
        ),
      );
      if (ok)
        toast.success(
          many
            ? `All ${ports.length} numbers sent to your old carrier.`
            : 'Sent to your old carrier.',
        );
      onDone();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-card border border-border bg-card-2 p-4" data-testid="port-form">
      <ul className="flex flex-col divide-y divide-border" data-testid="port-batch">
        {ports.map((p) => (
          <li key={p.id} className="py-2 first:pt-0" data-testid={`port-batch-${p.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px]">{p.display}</span>
              <Badge variant={STATUS_TONE[p.status]}>{STATUS_WORD[p.status]}</Badge>
              <span className="text-xs text-text-3">
                {p.kind === 'full' ? 'Texts and calls' : 'Texting only'}
              </span>
              {many ? (
                <span className="text-xs text-text-3">
                  ·{' '}
                  {!p.detailsReady
                    ? 'Needs the details'
                    : !p.documents.loa
                      ? 'Needs the letter'
                      : 'Ready'}
                </span>
              ) : null}
              <span className="ml-auto">
                <CancelPort workspaceId={workspaceId} port={p} onDone={onDone} />
              </span>
            </div>
            {p.status === 'rejected' && p.rejectionReason ? (
              <Callout tone="danger" icon={CircleAlert} className="mt-2">
                Your old carrier turned this down: {p.rejectionReason} Fix it below and send it
                again.
              </Callout>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-2">
        {adding ? (
          <div className="rounded-card border border-border bg-card p-3">
            <StartPort
              workspaceId={workspaceId}
              fromMigration={fromMigration}
              kind={ports[0]!.kind}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdding(true)}
              data-testid="port-add-more"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
              Add another number
            </Button>
            {fromMigration.length ? (
              <span className="text-xs text-text-3">
                {fromMigration.length} more from your old CRM
              </span>
            ) : null}
          </div>
        )}
      </div>

      <p className="mt-3 border-t border-border pt-3 text-[13px] text-text-2">
        This all has to match your old carrier’s records exactly. It is on your bill, or they will
        read it to you if you call them.
        {many
          ? ' It is saved to every number above, so they all have to be on the same account — send numbers on another account on their own.'
          : ''}
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
          {many ? `Save for all ${ports.length} numbers` : 'Save these details'}
        </Button>
        {detailsReady ? (
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
        <PortLetter
          workspaceId={workspaceId}
          ports={ports}
          profile={profile}
          signerName={authorizedBy.trim()}
          serviceAddress={serviceAddress.trim()}
          onAttached={onDone}
        />
        {loaReady ? null : (
          <DocumentRow
            label="Or attach a letter you signed on paper"
            hint="A scan or photo of the signed letter, if you would rather sign it by hand."
            done={false}
            busy={uploading === 'loa'}
            testId="loa"
            onPick={(f) => void attach('loa', f)}
          />
        )}
        <DocumentRow
          label="A recent bill"
          hint="Optional, but most carriers ask for one. Any bill from the last few months will do."
          done={ports.every((p) => p.documents.bill)}
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
          disabled={!detailsReady || !loaReady}
          onClick={() => void send()}
          data-testid="port-submit"
        >
          <Send className="h-3.5 w-3.5" strokeWidth={1.8} />
          {many ? `Send all ${ports.length} to your old carrier` : 'Send it to your old carrier'}
        </Button>
        {!detailsReady || !loaReady ? (
          <span className="text-xs text-text-3">
            {!detailsReady
              ? many
                ? 'Save the details for every number first.'
                : 'Fill the details in first.'
              : 'Sign the letter first.'}
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
