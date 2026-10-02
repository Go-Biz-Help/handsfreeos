'use client';
import {
  HIGHLEVEL_MOVE_GUIDE_URL,
  movesWithSidsAlone,
  normalizePhone,
  transferRequestText,
} from '@hfos/core';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  KeyRound,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import {
  connectTwilio,
  disconnectTwilio,
  listOwnNumbers,
  listTwilioNumbers,
  lookupNumberHost,
  phoneAccountState,
  type NumberHost,
  type OwnAccountListing,
  type OwnAccountNumber,
  type TwilioAccountListing,
  type TwilioAccountNumber,
} from '@/lib/api/worker';
import { formatDate } from '@/lib/format';
import { useLiveVersion } from '@/lib/realtime/live-provider';

/**
 * Bringing a number that already lives in Twilio (20261010000900) — the business's own Twilio account, or
 * GoHighLevel / LeadConnector, whose LC Phone numbers are Twilio numbers in HighLevel's account.
 *
 * The number moves account to account inside Twilio, into this business's own HandsFreeOS Twilio account. The
 * public number never changes and no carrier is asked, so it is days rather than a port's weeks. HandsFreeOS
 * looks for it every few minutes and sets it up the moment it lands — texts, calls and delivery updates.
 *
 * **Nothing on this screen ever tells anybody to release or delete a number.** Releasing hands it back to the
 * carrier, and a released number can be gone for good; the words below say so, more than once, on purpose.
 *
 * **The number and its texting registration are two separate things**, shown side by side: a number can be
 * here and ringing while the carriers are still deciding whether its texts may go out.
 */

export type NumberImportInfo = Ok<'/v1/queries/number_import.list'>['imports'][number];
export type TwilioConnections = Ok<'/v1/queries/twilio_connection.list'>;
type MigratedNumber = Ok<'/v1/queries/number_import.list'>['fromMigration'][number];
type Where = 'twilio' | 'highlevel' | 'carrier';

const SOURCE_WORD = { twilio: 'your Twilio account', highlevel: 'HighLevel' } as const;

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Could not copy. Select it and copy it yourself.');
  }
}

/**
 * "Where is your number today?" — the question before any other, because the answer decides whether it moves
 * in days (it is in Twilio already) or weeks (a carrier port).
 */
export function BringNumberStep({
  workspaceId,
  imports,
  fromMigration,
  twilio,
  carrierPort,
  initial,
  onBack,
}: {
  workspaceId: string;
  imports: readonly NumberImportInfo[];
  fromMigration: readonly MigratedNumber[];
  twilio: TwilioConnections;
  /** The carrier-port screen, for a number with any other carrier. */
  carrierPort: (onBack: () => void) => ReactNode;
  /** Where to open: a port already under way opens on the port screen, so checking back is one step. */
  initial?: Where | null;
  onBack: () => void;
}) {
  // A migration from GoHighLevel found numbers: they are almost certainly LC Phone numbers, so start there.
  const [where, setWhere] = useState<Where | null>(
    initial ?? (fromMigration.length ? 'highlevel' : null),
  );
  if (where === 'carrier') return <>{carrierPort(() => setWhere(null))}</>;
  if (where === 'highlevel')
    return (
      <HighLevelImport
        workspaceId={workspaceId}
        fromMigration={fromMigration}
        onBack={() => setWhere(null)}
        onUseTwilio={() => setWhere('twilio')}
        onUseCarrier={() => setWhere('carrier')}
      />
    );
  if (where === 'twilio')
    return <TwilioImport workspaceId={workspaceId} twilio={twilio} onBack={() => setWhere(null)} />;

  const waiting = imports.filter((i) => i.status === 'waiting').length;
  return (
    <div data-testid="bring-number-step">
      <button
        type="button"
        onClick={onBack}
        className="text-[13px] text-text-3 hover:text-text"
        data-testid="bring-back"
      >
        ← A new number instead
      </button>
      <h2 className="mt-3 text-lg font-semibold tracking-tight">Where is your number today?</h2>
      <p className="mb-[18px] mt-1 text-[13px] text-text-2">
        Your customers keep dialing the number they always have. Until it moves, everything keeps
        working exactly where it does now.
        {waiting
          ? ` ${waiting === 1 ? 'One number is' : `${waiting} numbers are`} already on the way.`
          : ''}
      </p>
      <div role="radiogroup" aria-label="Where the number is" className="flex flex-col gap-3">
        <RadioCard
          selected={false}
          onSelect={() => setWhere('highlevel')}
          testId="bring-from-highlevel"
          title={
            <span className="flex items-center gap-2">
              GoHighLevel or LeadConnector <Badge variant="ok">Days, not weeks</Badge>
            </span>
          }
          description="An LC Phone number. It already lives in Twilio, under HighLevel’s account, so it moves straight across — no carrier port."
        />
        <RadioCard
          selected={false}
          onSelect={() => setWhere('twilio')}
          testId="bring-from-twilio"
          title={
            <span className="flex items-center gap-2">
              My own Twilio account <Badge variant="ok">Days, not weeks</Badge>
            </span>
          }
          description="Including a Twilio account you plugged into HighLevel. Connect it, see every number in it, and choose which business each one goes to."
        />
        <RadioCard
          selected={false}
          onSelect={() => setWhere('carrier')}
          testId="bring-from-carrier"
          title="Another phone company"
          description="Verizon, AT&T, RingCentral, a landline… Your old carrier hands it over with a port: two to four weeks for texts and calls, or a few days for texting only."
        />
      </div>
    </div>
  );
}

/** The one thing nobody moving a number must ever do, said where it will be read. */
function NeverRelease({ from }: { from: string }) {
  return (
    <Callout tone="warning" icon={CircleAlert} className="mb-4" data-testid="never-release">
      <span>
        <strong>Keep the number in {from}. Do not release or delete it.</strong> Releasing hands it
        back to the carrier, and a released number can be gone for good. It has to be transferred
        while it is still active.
      </span>
    </Callout>
  );
}

/** A GoHighLevel / LeadConnector number: check it is in Twilio, then watch for HighLevel to send it. */
function HighLevelImport({
  workspaceId,
  fromMigration,
  onBack,
  onUseTwilio,
  onUseCarrier,
}: {
  workspaceId: string;
  fromMigration: readonly MigratedNumber[];
  onBack: () => void;
  onUseTwilio: () => void;
  onUseCarrier: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const [raw, setRaw] = useState(fromMigration[0]?.display ?? '');
  const [host, setHost] = useState<NumberHost | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    const e164 = normalizePhone(raw);
    if (!e164) {
      setError('Enter the number with its area code, like (256) 555-0123.');
      return;
    }
    setError(null);
    setChecking(true);
    try {
      setHost(await lookupNumberHost(workspaceId, e164));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  async function start() {
    const e164 = host?.e164 ?? normalizePhone(raw);
    if (!e164) return;
    setStarting(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/number_import.start', {
          body: { workspaceId, e164, source: 'highlevel' },
        }),
      );
      toast.success('We are watching for it. Your request to HighLevel is ready to copy.');
      router.refresh();
      onBack();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div data-testid="highlevel-import">
      <button type="button" onClick={onBack} className="text-[13px] text-text-3 hover:text-text">
        ← Somewhere else
      </button>
      <h2 className="mt-3 text-lg font-semibold tracking-tight">
        Bring your GoHighLevel number here
      </h2>
      <p className="mb-[18px] mt-1 text-[13px] text-text-2">
        HighLevel’s LC Phone numbers live in Twilio, under HighLevel’s account. HighLevel’s support
        can send yours straight to your HandsFreeOS Twilio account — no carrier port, and your
        number stays exactly the same.
      </p>
      <NeverRelease from="HighLevel" />
      <ol className="mb-3 flex list-decimal flex-col gap-2 pl-5 text-[13px] text-text-2">
        <li>
          Check the number below. We make sure it is really in Twilio — a number HighLevel got from
          another carrier needs a port instead.
        </li>
        <li>
          Press <em>Start watching for it</em>. You get the request HighLevel asks for, ready to
          copy: the number, the Twilio Account SID, the destination sub-account SID, and your
          preferred cutover window.
        </li>
        <li>
          Open a HighLevel support ticket and paste it in. Their support coordinates the move and
          tells you when the number is live in Twilio. Leave everything running in HighLevel until
          then.
        </li>
        <li>
          We look for it every few minutes. The moment it lands, calls, texts and delivery updates
          come to HandsFreeOS — nothing for you to press. Then test it: call it and text it from
          your own phone.
        </li>
        <li>
          Texting needs its own registration here. HighLevel’s A2P 10DLC registration belongs to
          HighLevel’s brand and does not move with the number. Calls work without it.
        </li>
      </ol>
      <p className="mb-5 text-xs text-text-3">
        HighLevel’s own guide:{' '}
        <a
          href={HIGHLEVEL_MOVE_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-accent-text hover:underline"
        >
          Moving phone numbers from LC Phone to Twilio
        </a>
        .
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Your HighLevel number"
          htmlFor={`${id}-n`}
          className="w-full sm:w-64"
          error={error}
        >
          <Input
            id={`${id}-n`}
            value={raw}
            inputMode="tel"
            placeholder="(256) 555-0123"
            onChange={(e) => {
              setRaw(e.target.value);
              setHost(null);
            }}
            data-testid="highlevel-number"
          />
        </Field>
        <Button
          variant="secondary"
          onClick={check}
          loading={checking}
          data-testid="highlevel-check"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.8} />
          Check it
        </Button>
      </div>
      {fromMigration.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-text-3">
          Your migration found:
          {fromMigration.map((m) => (
            <button
              key={m.e164}
              type="button"
              className="font-mono text-accent-text hover:underline"
              onClick={() => {
                setRaw(m.display);
                setHost(null);
              }}
            >
              {m.display}
            </button>
          ))}
        </div>
      ) : null}

      {host ? (
        <div className="mt-4" data-testid="highlevel-host">
          {host.alreadyHere === 'yours' ? (
            <Callout tone="info" icon={CircleCheck}>
              {host.display} is already one of your numbers here.
            </Callout>
          ) : host.alreadyHere === 'elsewhere' ? (
            <Callout tone="warning" icon={CircleAlert}>
              {host.display} is already set up for another business on HandsFreeOS. If it should be
              this one, talk to us.
            </Callout>
          ) : host.hostedInTwilio ? (
            <Callout tone="info" icon={ShieldCheck} data-host="twilio">
              Good news: {host.display} is hosted in Twilio
              {host.carrierName ? ` (${host.carrierName})` : ''}. It can move straight across,
              usually within a few business days.
            </Callout>
          ) : (
            <Callout
              tone="warning"
              icon={CircleAlert}
              data-host="other"
              action={
                <Button size="sm" variant="secondary" onClick={onUseCarrier}>
                  Port it instead
                </Button>
              }
            >
              {host.carrierName
                ? `The carrier lookup says ${host.display} is with ${host.carrierName}, not Twilio.`
                : `We could not tell who hosts ${host.display}.`}{' '}
              {host.carrierName
                ? 'A number that is not in Twilio cannot be sent account to account, so it moves with a carrier port.'
                : 'You can still start — we will watch for it all the same.'}
            </Callout>
          )}
          {!host.alreadyHere && !movesWithSidsAlone(host.e164) ? (
            <Callout tone="warning" icon={CircleAlert} className="mt-3" data-testid="international">
              Numbers outside the US and Canada also need a Regulatory Bundle SID and an Address SID
              in the account they move to. HandsFreeOS doesn’t set those up yet — talk to us before
              asking HighLevel to move this one.
            </Callout>
          ) : null}
          {host.alreadyHere ? null : (
            <Button
              className="mt-3"
              onClick={start}
              loading={starting}
              data-testid="highlevel-start"
            >
              Start watching for it
            </Button>
          )}
        </div>
      ) : null}

      <p className="mt-6 text-xs text-text-3">
        Does your agency plug its own Twilio account into HighLevel instead of using LC Phone? Then
        the number is in that Twilio account —{' '}
        <button type="button" className="text-accent-text hover:underline" onClick={onUseTwilio}>
          connect it instead
        </button>
        .
      </p>
    </div>
  );
}

/** The business's own Twilio account: connect it, see what is in it, choose where each number goes. */
function TwilioImport({
  workspaceId,
  twilio,
  onBack,
}: {
  workspaceId: string;
  twilio: TwilioConnections;
  onBack: () => void;
}) {
  const active = twilio.connections.filter((c) => c.status === 'active');
  const [listing, setListing] = useState<TwilioAccountListing | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(!active.length);

  async function show(connectionId: string) {
    setLoading(connectionId);
    try {
      setListing(await listTwilioNumbers(workspaceId, connectionId));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(null);
    }
  }

  return (
    <div data-testid="twilio-import">
      <button type="button" onClick={onBack} className="text-[13px] text-text-3 hover:text-text">
        ← Somewhere else
      </button>
      <h2 className="mt-3 text-lg font-semibold tracking-tight">
        Bring numbers from your Twilio account
      </h2>
      <p className="mb-[18px] mt-1 text-[13px] text-text-2">
        Every business here has its own HandsFreeOS Twilio account. Your number is transferred into
        it, keeping the same number, and we set it up the moment it lands.
      </p>
      <NeverRelease from="your Twilio account" />

      {!twilio.canConnect ? (
        <>
          <Callout tone="neutral" icon={KeyRound} className="mb-4">
            Only your organization’s owners and admins can connect a Twilio account, because one
            account can hold every one of your businesses’ numbers. You can still ask for a number
            to be sent here.
          </Callout>
          <ManualTwilio workspaceId={workspaceId} />
        </>
      ) : (
        <>
          {twilio.connections.map((c) => (
            <div
              key={c.id}
              className="mb-3 flex flex-wrap items-center gap-2 rounded-card border border-border bg-card-2 p-3"
              data-testid={`twilio-connection-${c.id}`}
            >
              <PlugZap className="h-4 w-4 text-text-3" strokeWidth={1.8} />
              <span className="text-[13px] font-medium">{c.friendlyName || 'Twilio account'}</span>
              <span className="font-mono text-xs text-text-3">{c.accountSid}</span>
              {c.status === 'broken' ? (
                <Badge variant="danger">Needs connecting again</Badge>
              ) : null}
              <span className="ml-auto flex gap-2">
                {c.status === 'active' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={loading === c.id}
                    onClick={() => void show(c.id)}
                    data-testid={`twilio-show-${c.id}`}
                  >
                    Show its numbers
                  </Button>
                ) : null}
                <Disconnect workspaceId={workspaceId} connectionId={c.id} />
              </span>
              {c.lastError ? (
                <p className="w-full text-xs text-danger-text">{c.lastError}</p>
              ) : null}
            </div>
          ))}
          {connecting ? (
            <ConnectForm
              workspaceId={workspaceId}
              onConnected={(l) => {
                setListing(l);
                setConnecting(false);
              }}
            />
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConnecting(true)}>
              Connect another Twilio account
            </Button>
          )}
        </>
      )}

      {listing ? (
        <AccountNumbers
          workspaceId={workspaceId}
          listing={listing}
          places={twilio.workspaces}
          onChanged={() => void show(listing.connection.id)}
        />
      ) : null}
    </div>
  );
}

function ConnectForm({
  workspaceId,
  onConnected,
}: {
  workspaceId: string;
  onConnected: (l: TwilioAccountListing) => void;
}) {
  const router = useRouter();
  const id = useId();
  const [accountSid, setAccountSid] = useState('');
  const [withKey, setWithKey] = useState(false);
  const [token, setToken] = useState('');
  const [keySid, setKeySid] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const listing = await connectTwilio({
        workspaceId,
        accountSid: accountSid.trim(),
        ...(withKey
          ? { apiKeySid: keySid.trim(), apiKeySecret: keySecret.trim() }
          : { authToken: token.trim() }),
      });
      // Nothing typed here is kept in the page once it has gone.
      setToken('');
      setKeySecret('');
      onConnected(listing);
      toast.success(
        `Connected. ${listing.numbers.length} number${listing.numbers.length === 1 ? '' : 's'} found.`,
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-border p-4" data-testid="twilio-connect">
      <div className="mb-3 text-[13px] text-text-2">
        Find these in the Twilio console, under <em>Account → API keys &amp; tokens</em>. An API key
        is the safer choice: you can revoke it at any time without touching anything else. We keep
        it encrypted and only ever use it to <strong>read</strong> the numbers in your account —
        nothing in it is changed.
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Account SID" htmlFor={`${id}-sid`} hint="Starts with AC.">
          <Input
            id={`${id}-sid`}
            value={accountSid}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAccountSid(e.target.value)}
            data-testid="twilio-account-sid"
          />
        </Field>
        {withKey ? (
          <>
            <Field label="API key SID" htmlFor={`${id}-key`} hint="Starts with SK.">
              <Input
                id={`${id}-key`}
                value={keySid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKeySid(e.target.value)}
                data-testid="twilio-key-sid"
              />
            </Field>
            <Field label="API key secret" htmlFor={`${id}-secret`}>
              <Input
                id={`${id}-secret`}
                type="password"
                value={keySecret}
                autoComplete="off"
                onChange={(e) => setKeySecret(e.target.value)}
                data-testid="twilio-key-secret"
              />
            </Field>
          </>
        ) : (
          <Field label="Auth token" htmlFor={`${id}-token`}>
            <Input
              id={`${id}-token`}
              type="password"
              value={token}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              data-testid="twilio-auth-token"
            />
          </Field>
        )}
      </div>
      {error ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3">
          {error}
        </Callout>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={connect} loading={busy} data-testid="twilio-connect-submit">
          Connect and show my numbers
        </Button>
        <button
          type="button"
          className="text-xs text-accent-text hover:underline"
          onClick={() => setWithKey((v) => !v)}
        >
          {withKey ? 'Use the auth token instead' : 'Use an API key instead'}
        </button>
      </div>
    </div>
  );
}

function Disconnect({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) {
  const router = useRouter();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!sure)
    return (
      <Button variant="ghost" size="sm" onClick={() => setSure(true)}>
        Disconnect
      </Button>
    );
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs text-text-2">
        Forget this account? Numbers on their way keep coming.
      </span>
      <Button
        variant="danger"
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void disconnectTwilio(workspaceId, connectionId)
            .then(() => router.refresh())
            .catch((e: unknown) => toast.error(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        Disconnect
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setSure(false)}>
        Keep it
      </Button>
    </span>
  );
}

const USED_BY: Record<TwilioAccountNumber['usedBy'], ReactNode> = {
  highlevel: <Badge variant="pending">Used by HighLevel</Badge>,
  handsfreeos: <Badge variant="accent">Pointed at HandsFreeOS</Badge>,
  other: <Badge variant="gray">In use</Badge>,
  nothing: null,
};

/** Every number in the account, and a business to send each one to. */
function AccountNumbers({
  workspaceId,
  listing,
  places,
  onChanged,
}: {
  workspaceId: string;
  listing: TwilioAccountListing;
  places: TwilioConnections['workspaces'];
  onChanged: () => void;
}) {
  if (!listing.numbers.length)
    return (
      <p className="mt-4 text-[13px] text-text-2" data-testid="twilio-numbers-empty">
        There are no numbers in {listing.connection.friendlyName || 'that account'}.
      </p>
    );
  return (
    <div className="mt-5" data-testid="twilio-numbers">
      <h3 className="mb-2 text-[13.5px] font-semibold">
        Numbers in {listing.connection.friendlyName || listing.connection.accountSid}
      </h3>
      <p className="mb-3 text-xs text-text-3">
        Choose the business each number belongs to. A number HighLevel is using today keeps working
        there until the moment it moves.
      </p>
      <div className="flex flex-col divide-y divide-border rounded-card border border-border">
        {listing.numbers.map((n) => (
          <AccountNumberRow
            key={n.sid}
            workspaceId={workspaceId}
            connectionId={listing.connection.id}
            number={n}
            places={places}
            onChanged={onChanged}
          />
        ))}
      </div>
      {listing.truncated ? (
        <p className="mt-2 text-xs text-text-3">
          Showing the first {listing.numbers.length}. Talk to us to bring over more at once.
        </p>
      ) : null}
    </div>
  );
}

function AccountNumberRow({
  workspaceId,
  connectionId,
  number: n,
  places,
  onChanged,
}: {
  workspaceId: string;
  connectionId: string;
  number: TwilioAccountNumber;
  places: TwilioConnections['workspaces'];
  onChanged: () => void;
}) {
  const router = useRouter();
  const [target, setTarget] = useState(
    places.some((p) => p.id === workspaceId) ? workspaceId : (places[0]?.id ?? workspaceId),
  );
  const [busy, setBusy] = useState(false);

  async function bring() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/number_import.start', {
          body: {
            workspaceId: target,
            e164: n.e164,
            source: 'twilio',
            connectionId,
            sourceAccountSid: n.accountSid,
            sourceNumberSid: n.sid,
          },
        }),
      );
      const name = places.find((p) => p.id === target)?.name ?? 'that business';
      toast.success(
        target === workspaceId
          ? `Watching for ${n.display}. Your transfer request is ready to copy.`
          : `Watching for ${n.display} in ${name}. Its transfer request is on that business’s Texting & calls page.`,
      );
      onChanged();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
      data-testid={`twilio-number-${n.e164}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px]">{n.display}</span>
          <Badge variant="gray">{n.numberType === 'toll_free' ? 'Toll-free' : 'Local'}</Badge>
          {USED_BY[n.usedBy]}
        </div>
        <div className="mt-0.5 text-xs text-text-3">
          {[n.friendlyName !== n.e164 ? n.friendlyName : null, n.accountName]
            .filter(Boolean)
            .join(' · ') || n.accountSid}
        </div>
      </div>
      {n.heldBy ? (
        <Badge variant="ok">
          {n.heldBy.workspaceName
            ? `Already in ${n.heldBy.workspaceName}`
            : 'Already on HandsFreeOS'}
        </Badge>
      ) : n.comingTo ? (
        <Badge variant="pending">On its way to {n.comingTo.workspaceName}</Badge>
      ) : (
        <span className="flex items-center gap-2">
          {places.length > 1 ? (
            <Select
              selectSize="sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label={`Business for ${n.display}`}
              data-testid={`twilio-target-${n.e164}`}
            >
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Button size="sm" onClick={bring} loading={busy} data-testid={`twilio-bring-${n.e164}`}>
            Bring it here
          </Button>
        </span>
      )}
    </div>
  );
}

/** Not an owner or admin of the organization: ask for a number to be sent, and we watch for it. */
function ManualTwilio({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const id = useId();
  const [raw, setRaw] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    const e164 = normalizePhone(raw);
    if (!e164) {
      setError('Enter the number with its area code.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/number_import.start', {
          body: {
            workspaceId,
            e164,
            source: 'twilio',
            ...(from.trim() ? { sourceAccountSid: from.trim() } : {}),
          },
        }),
      );
      toast.success('We are watching for it. Your transfer request is ready to copy.');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="twilio-manual">
      <Field label="The number" htmlFor={`${id}-n`} className="w-full sm:w-56" error={error}>
        <Input
          id={`${id}-n`}
          value={raw}
          inputMode="tel"
          onChange={(e) => setRaw(e.target.value)}
        />
      </Field>
      <Field
        label="Account SID it is in (optional)"
        htmlFor={`${id}-from`}
        className="w-full sm:w-72"
      >
        <Input id={`${id}-from`} value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Button onClick={start} loading={busy}>
        Start watching for it
      </Button>
    </div>
  );
}

// ---------- numbers already in the business's own account ----------

/**
 * The numbers sitting in this business's own HandsFreeOS Twilio account that are not set up here yet.
 *
 * A transfer finished straight through Twilio's or HighLevel's support, without anybody starting one here first,
 * leaves the number in the account with nobody watching for it: still pointed at its old owner, and nowhere in
 * HandsFreeOS. "Set it up here" starts the same import as any number already in Twilio, and its first look finds
 * the number there and sets it up within seconds. Looked for on request, not on every visit: it asks Twilio.
 */
export function OwnAccountNumbers({ workspaceId }: { workspaceId: string }) {
  const [listing, setListing] = useState<OwnAccountListing | null>(null);
  const [looking, setLooking] = useState(false);
  const version = useLiveVersion(['phone_number', 'number_import']);

  const look = useCallback(
    async (quietly = false) => {
      if (!quietly) setLooking(true);
      try {
        setListing(await listOwnNumbers(workspaceId));
      } catch (e) {
        if (!quietly) toast.error(errorMessage(e));
      } finally {
        if (!quietly) setLooking(false);
      }
    },
    [workspaceId],
  );

  // Once shown, the list follows what happens next: a number that is set up here leaves it.
  const shown = listing !== null;
  useEffect(() => {
    if (shown && version > 0) void look(true);
  }, [shown, version, look]);

  const movingFromHighLevel = listing?.numbers.some(
    (n) => n.usedBy === 'highlevel' && n.state !== 'elsewhere',
  );
  return (
    <div data-testid="own-numbers">
      <Button
        size="sm"
        variant="secondary"
        loading={looking}
        onClick={() => void look()}
        data-testid="own-numbers-look"
      >
        <Search className="h-3.5 w-3.5" strokeWidth={1.8} />
        {listing ? 'Look again' : 'Find numbers already in this account'}
      </Button>
      {listing && !listing.numbers.length ? (
        <p className="mt-3 text-[13px] text-text-2" data-testid="own-numbers-empty">
          {listing.alreadyHere
            ? 'Every number in this account is already set up here.'
            : 'There are no numbers in this account yet. When Twilio or HighLevel says yours has moved, look again.'}
        </p>
      ) : null}
      {listing?.numbers.length ? (
        <>
          <div className="mt-3 flex flex-col divide-y divide-border rounded-card border border-border">
            {listing.numbers.map((n) => (
              <OwnNumberRow
                key={n.sid}
                workspaceId={workspaceId}
                accountSid={listing.accountSid!}
                number={n}
                onChanged={() => void look(true)}
              />
            ))}
          </div>
          {movingFromHighLevel ? (
            <p className="mt-2 text-xs text-text-3">
              A number used by HighLevel keeps working there until you set it up here. From then on,
              its calls and texts come to HandsFreeOS.
            </p>
          ) : null}
          {listing.truncated ? (
            <p className="mt-2 text-xs text-text-3">
              Showing the first {listing.numbers.length}. Talk to us to set up more at once.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function OwnNumberRow({
  workspaceId,
  accountSid,
  number: n,
  onChanged,
}: {
  workspaceId: string;
  accountSid: string;
  number: OwnAccountNumber;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setUp() {
    setBusy(true);
    try {
      unwrap(
        n.state === 'coming' && n.importId
          ? await apiBrowser().POST('/v1/commands/number_import.check_now', {
              body: { workspaceId, importId: n.importId },
            })
          : await apiBrowser().POST('/v1/commands/number_import.start', {
              body: {
                workspaceId,
                e164: n.e164,
                source: 'twilio',
                sourceAccountSid: accountSid,
                sourceNumberSid: n.sid,
              },
            }),
      );
      toast.success(`Setting up ${n.display}. Its calls and texts come here in a moment.`);
      onChanged();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
      data-testid={`own-number-${n.e164}`}
      data-state={n.state}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px]">{n.display}</span>
          <Badge variant="gray">{n.numberType === 'toll_free' ? 'Toll-free' : 'Local'}</Badge>
          {USED_BY[n.usedBy]}
        </div>
        {n.friendlyName && n.friendlyName !== n.e164 ? (
          <div className="mt-0.5 text-xs text-text-3">{n.friendlyName}</div>
        ) : null}
        {n.state === 'elsewhere' ? (
          <p className="mt-1 text-xs text-danger-text">
            Another business on HandsFreeOS still has this number, so it can’t be set up here.
            Contact support and we’ll sort out which business it belongs to.
          </p>
        ) : null}
      </div>
      {n.state === 'elsewhere' ? null : (
        <Button
          size="sm"
          onClick={() => void setUp()}
          loading={busy}
          data-testid={`own-number-setup-${n.e164}`}
        >
          {n.state === 'coming' ? 'Set it up now' : 'Set it up here'}
        </Button>
      )}
    </div>
  );
}

// ---------- numbers on their way ----------

const SETUP: Record<
  NumberImportInfo['setup'],
  { word: string; tone: 'pending' | 'ok' | 'danger' | 'member' }
> = {
  waiting_for_transfer: { word: 'Waiting for the transfer', tone: 'pending' },
  live: { word: 'Live here', tone: 'ok' },
  failed: { word: 'Could not finish', tone: 'danger' },
  cancelled: { word: 'Stopped', tone: 'member' },
};

const TEXTING: Record<
  NumberImportInfo['texting'],
  { word: string; tone: 'pending' | 'ok' | 'danger' | 'member' }
> = {
  needs_registration: { word: 'Not registered yet', tone: 'member' },
  in_review: { word: 'With the carriers', tone: 'pending' },
  approved: { word: 'Approved', tone: 'ok' },
  rejected: { word: 'Turned down', tone: 'danger' },
};

function textingSentence(i: NumberImportInfo): string {
  const registration =
    i.numberType === 'toll_free' ? 'toll-free verification' : 'A2P 10DLC registration';
  switch (i.texting) {
    case 'approved':
      return i.setup === 'live'
        ? 'Texts go out from it.'
        : 'Your registration already covers it, so texts go out the moment it lands.';
    case 'in_review':
      return `Your ${registration} is with the carriers. Calls work meanwhile; texts start once they approve.`;
    case 'rejected':
      return `The carriers turned down your ${registration}. Fix it in the registration below — calls keep working.`;
    default: {
      // A local registration doesn't need the number here, so it can go while the number travels.
      const now =
        i.numberType === 'local' && i.status === 'waiting'
          ? ' You can send it now, under Register for texting below, so texts go out the moment it lands.'
          : ' Calls work without it.';
      return i.source === 'highlevel'
        ? `HighLevel’s registration does not move with the number, so it needs a ${registration} here.${now}`
        : `It needs a ${registration} here before texts can go out.${now}`;
    }
  }
}

/**
 * Every number on its way here, each with **two statuses, side by side**: the number itself (waiting for the
 * transfer, then live) and its texting registration. Owners copy the transfer request from here.
 */
export function ImportsCard({
  workspaceId,
  businessName,
  imports,
}: {
  workspaceId: string;
  businessName: string;
  imports: readonly NumberImportInfo[];
}) {
  const router = useRouter();
  // HandsFreeOS's parent Twilio account, which HighLevel asks for beside the sub-account. Only the worker
  // knows it.
  const [parentSid, setParentSid] = useState<string | null>(null);
  const waiting = imports.some((i) => i.status === 'waiting');
  useEffect(() => {
    if (!waiting) return;
    void phoneAccountState(workspaceId)
      .then((a) => setParentSid(a.parentAccountSid))
      .catch(() => setParentSid(null));
  }, [waiting, workspaceId]);
  // The destination account is made a moment after an import starts; look again until it is there.
  const preparing = imports.some((i) => i.status === 'waiting' && !i.destinationAccountSid);
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(timer);
  }, [preparing, router]);

  // What is still coming, what could not finish, and what landed lately — a number that just arrived still has
  // its texting registration to show beside it. After a fortnight it is simply one of the business's numbers.
  const [now] = useState(() => Date.now());
  const shown = imports.filter(
    (i) =>
      i.status === 'waiting' ||
      i.status === 'failed' ||
      (i.status === 'complete' &&
        !!i.completedAt &&
        now - new Date(i.completedAt).getTime() < 14 * 24 * 60 * 60 * 1000),
  );
  if (!shown.length) return null;
  return (
    <Card className="max-w-[820px] p-5 md:p-7" data-testid="imports-card">
      <h2 className="text-lg font-semibold tracking-tight">
        {shown.every((i) => i.status === 'complete')
          ? 'Numbers you brought over'
          : 'Numbers on their way here'}
      </h2>
      <p className="mb-4 mt-1 text-[13px] text-text-2">
        Transferred inside Twilio, keeping the same number. We look for each one every few minutes
        and set it up the moment it lands.
      </p>
      <div className="flex flex-col gap-3">
        {shown.map((i) => (
          <ImportRow
            key={i.id}
            workspaceId={workspaceId}
            item={i}
            businessName={businessName}
            parentSid={parentSid}
          />
        ))}
      </div>
    </Card>
  );
}

function ImportRow({
  workspaceId,
  item: i,
  businessName,
  parentSid,
}: {
  workspaceId: string;
  item: NumberImportInfo;
  businessName: string;
  parentSid: string | null;
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const setup = SETUP[i.setup];
  const texting = TEXTING[i.texting];
  // Picked from the business's own account (Settings → Texting & calls → Phone & texting): it is already where
  // it is going, so there is nothing to ask anybody to send.
  const alreadyThere = !!i.sourceAccountSid && i.sourceAccountSid === i.destinationAccountSid;
  return (
    <div
      className="rounded-card border border-border bg-card-2 p-4"
      data-testid={`import-row-${i.id}`}
      data-setup={i.setup}
      data-texting={i.texting}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">{i.display}</span>
        <span className="text-xs text-text-3">from {SOURCE_WORD[i.source]}</span>
      </div>

      <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-[150px_1fr]">
        <dt className="text-text-3">Phone number</dt>
        <dd className="flex flex-col gap-1">
          <span>
            <Badge variant={setup.tone} data-testid="import-setup">
              {setup.word}
            </Badge>
          </span>
          <span className="text-text-2">
            {i.setup === 'live'
              ? 'Calls, texts and delivery updates come to HandsFreeOS. Test it: call it and text it from your own phone, and send a text from the inbox.'
              : i.setup === 'waiting_for_transfer'
                ? alreadyThere
                  ? 'It’s already in your HandsFreeOS Twilio account. We’re setting it up.'
                  : `Waiting for ${i.source === 'highlevel' ? 'HighLevel' : 'Twilio'} to send it to your HandsFreeOS Twilio account.${
                      i.lastCheckedAt ? ` Last looked ${formatDate(i.lastCheckedAt)}.` : ''
                    }`
                : (i.lastError ?? 'It could not be set up.')}
          </span>
        </dd>
        <dt className="text-text-3">Texting registration</dt>
        <dd className="flex flex-col gap-1">
          <span>
            <Badge variant={texting.tone} data-testid="import-texting">
              {texting.word}
            </Badge>
          </span>
          <span className="text-text-2">{textingSentence(i)}</span>
        </dd>
      </dl>

      {i.status === 'waiting' && i.hostedInTwilio === false ? (
        <Callout tone="warning" icon={CircleAlert} className="mt-3">
          The carrier lookup says this number is with {i.carrierName ?? 'another carrier'}, not
          Twilio. A number outside Twilio cannot be sent account to account — a carrier port moves
          it instead.
        </Callout>
      ) : null}
      {i.status === 'waiting' && i.lastError ? (
        <Callout tone="warning" icon={Clock} className="mt-3">
          {i.lastError}
        </Callout>
      ) : null}

      {i.status === 'waiting' && !alreadyThere ? (
        i.destinationAccountSid ? (
          <TransferRequest item={i} businessName={businessName} parentSid={parentSid} />
        ) : (
          <p className="mt-3 flex items-center gap-2 text-[13px] text-text-2" role="status">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            Getting your HandsFreeOS Twilio account ready to receive it…
          </p>
        )
      ) : null}

      {i.status === 'waiting' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={checking}
            onClick={() => {
              setChecking(true);
              void apiBrowser()
                .POST('/v1/commands/number_import.check_now', {
                  body: { workspaceId, importId: i.id },
                })
                .then((r) => {
                  unwrap(r);
                  toast.success('Looking for it now.');
                  setTimeout(() => router.refresh(), 2000);
                })
                .catch((e: unknown) => toast.error(errorMessage(e)))
                .finally(() => setChecking(false));
            }}
            data-testid={`import-check-${i.id}`}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
            It should be there — look now
          </Button>
          <StopWatching workspaceId={workspaceId} item={i} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What to send, and to whom: HighLevel's support for an LC Phone number, Twilio's for the business's own.
 * Written here rather than by the API, because HighLevel asks for HandsFreeOS's parent Account SID beside the
 * sub-account's, and only the worker knows it.
 */
function TransferRequest({
  item: i,
  businessName,
  parentSid,
}: {
  item: NumberImportInfo;
  businessName: string;
  parentSid: string | null;
}) {
  const id = useId();
  const [cutover, setCutover] = useState('');
  const text = transferRequestText({
    source: i.source,
    display: i.display,
    toAccountSid: i.destinationAccountSid!,
    parentAccountSid: parentSid,
    fromAccountSid: i.sourceAccountSid,
    businessName,
    cutoverWindow: cutover,
  });
  const sid = (label: string, value: string, testId: string) => (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="w-48 text-text-3">{label}</span>
      <span className="font-mono" data-testid={testId}>
        {value}
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label={`Copy the ${label}`}
        onClick={() => void copy(value, label)}
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
      </Button>
    </div>
  );
  return (
    <div
      className="mt-3 rounded-card border border-border bg-card p-3"
      data-testid="transfer-request"
    >
      <div className="text-[13px] font-medium">
        {i.source === 'highlevel'
          ? 'Send this to HighLevel support'
          : 'Ask Twilio to transfer it between your accounts'}
      </div>
      <p className="mt-1 text-xs text-text-2">
        {i.source === 'highlevel' ? (
          <>
            Open a HighLevel support ticket and paste this in. Their support coordinates the move
            and tells you when it is live in Twilio (
            <a
              href={HIGHLEVEL_MOVE_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-accent-text hover:underline"
            >
              HighLevel’s guide
            </a>
            ).
          </>
        ) : (
          'From the Twilio console of the account the number is in, open a support request for a phone number transfer between accounts and paste this in. Twilio may ask the owner of each account to confirm.'
        )}{' '}
        Keep the number active in the meantime — do not release it.
      </p>
      <div className="mt-2 flex flex-col gap-1">
        {parentSid ? sid('Twilio Account SID', parentSid, 'transfer-parent') : null}
        {sid(
          parentSid ? 'Destination sub-account SID' : 'Send it to Account SID',
          i.destinationAccountSid!,
          'transfer-destination',
        )}
      </div>
      <div className="mt-2 max-w-sm">
        <Field
          label="Preferred cutover window"
          htmlFor={`${id}-cutover`}
          hint="When the move suits you, like “a weekday after 6 PM Central”."
        >
          <Input
            id={`${id}-cutover`}
            value={cutover}
            maxLength={120}
            onChange={(e) => setCutover(e.target.value)}
            data-testid="transfer-cutover"
          />
        </Field>
      </div>
      <Textarea
        className="mt-2 font-mono text-xs"
        rows={11}
        readOnly
        value={text}
        aria-label="The transfer request"
      />
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        onClick={() => void copy(text, 'Request')}
        data-testid={`transfer-copy-${i.id}`}
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
        Copy the request
      </Button>
    </div>
  );
}

function StopWatching({ workspaceId, item }: { workspaceId: string; item: NumberImportInfo }) {
  const router = useRouter();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!sure)
    return (
      <Button variant="ghost" size="sm" onClick={() => setSure(true)}>
        <X className="h-3.5 w-3.5" strokeWidth={1.8} />
        Stop watching
      </Button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-text-2">
        Stop watching for {item.display}? Nothing changes where it is today — if you already asked
        for the transfer, ask for it to be called off too.
      </span>
      <Button
        variant="danger"
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void apiBrowser()
            .POST('/v1/commands/number_import.cancel', {
              body: { workspaceId, importId: item.id },
            })
            .then((r) => {
              unwrap(r);
              router.refresh();
            })
            .catch((e: unknown) => toast.error(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        Stop watching
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setSure(false)}>
        Keep watching
      </Button>
    </span>
  );
}
