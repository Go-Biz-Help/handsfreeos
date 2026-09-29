'use client';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  LIVE_SOURCES,
  PRIVATE_TOKEN_SOURCES,
  SOURCE_LABELS,
  type MigrationAuthKind,
  type MigrationSourceSystem,
} from '@hfos/core';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, FieldError, Hint } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { publicEnv } from '@/lib/env';

/**
 * Pasting a private token goes straight to the worker, never through the API (0069). The worker is the only
 * process here that can seal a credential, so it is the only one that should ever hold one — and a POST
 * rather than a link, because a token in a URL is a token in a log.
 */
async function pasteToken(input: {
  state: string;
  token: string;
  accountId: string;
}): Promise<{ displayName: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}/migrations/token`, {
      method: 'POST',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error('We couldn’t reach HandsFreeOS. Check your connection and try again.');
  }
  const json = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    displayName?: string | null;
  } | null;
  if (!res.ok)
    throw new Error(json?.error?.message ?? 'That token was not accepted. Check it and try again.');
  return { displayName: json?.displayName ?? null };
}

/**
 * Connecting the CRM a business is leaving. Two things are said before anybody signs in, because both are
 * true and neither is obvious: the look that follows only reads, and the old account is never touched.
 */
export function ConnectSourceButton({
  organizationId,
  workspaceId,
  beforeLeave,
}: {
  organizationId: string;
  /** Set on a business's own Settings page: the connection is then recorded as that business's. */
  workspaceId?: string;
  /** Just before the browser leaves for the old system's sign-in: the setup wizard notes its way back. */
  beforeLeave?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="migration-connect">
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        Connect a CRM
      </Button>
      {open ? (
        <ConnectDialog
          organizationId={organizationId}
          workspaceId={workspaceId}
          beforeLeave={beforeLeave}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function ConnectDialog({
  organizationId,
  workspaceId,
  beforeLeave,
  onOpenChange,
}: {
  organizationId: string;
  workspaceId?: string;
  beforeLeave?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [source, setSource] = useState<MigrationSourceSystem>('gohighlevel');
  const [how, setHow] = useState<MigrationAuthKind>('oauth');
  const [reach, setReach] = useState<'agency' | 'location'>(workspaceId ? 'location' : 'agency');
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = SOURCE_LABELS[source];
  const canPaste = PRIVATE_TOKEN_SOURCES.includes(source);
  const pasting = canPaste && how === 'private_token';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/migration.connect', {
          body: {
            organizationId,
            workspaceId,
            source,
            installKind: reach,
            authKind: pasting ? 'private_token' : 'oauth',
          },
        }),
      );
      if (!pasting) {
        // Off to the old system's own sign-in, through the worker.
        beforeLeave?.();
        window.location.href = `${publicEnv.workerUrl}${out.startPath}`;
        return;
      }
      // The token never goes through the API: it is posted straight to the worker, which seals it.
      const { displayName } = await pasteToken({
        state: out.state,
        token,
        accountId,
      });
      setToken('');
      toast.success(
        displayName
          ? `Connected to ${displayName}. Nothing there has been changed.`
          : `Connected to ${label}. Nothing there has been changed.`,
      );
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="Connect the CRM you're leaving"
        description="We look at what's there and count it. Nothing is brought across until you've seen the list and said yes, and your old account is never changed or cancelled."
      >
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-4"
          noValidate
          data-testid="migration-connect-dialog"
        >
          <Field label="Which system" htmlFor="migration-source">
            <div className="flex flex-col gap-2" id="migration-source">
              {LIVE_SOURCES.map((s) => (
                <RadioCard
                  key={s}
                  selected={source === s}
                  onSelect={() => setSource(s)}
                  title={SOURCE_LABELS[s]}
                  description="Customers, conversations, calendars, money and the rest, counted before anything moves."
                  testId={`migration-source-${s}`}
                />
              ))}
            </div>
          </Field>
          {canPaste ? (
            <Field label="How to connect" htmlFor="migration-how">
              <div className="flex flex-col gap-2" id="migration-how">
                <RadioCard
                  selected={how === 'oauth'}
                  onSelect={() => setHow('oauth')}
                  testId="migration-how-oauth"
                  title={`Sign in to ${label}`}
                  description="The usual way. You approve what we may see, and nobody handles a password or a key."
                />
                <RadioCard
                  selected={how === 'private_token'}
                  onSelect={() => setHow('private_token')}
                  testId="migration-how-token"
                  title="Paste a private token"
                  description="For an account that can't add an app. You make a read-only token in GoHighLevel and paste it here, with the sub-account's Location ID. One business at a time."
                />
              </div>
            </Field>
          ) : null}
          {pasting ? (
            <>
              <Field
                label="Private integration token"
                htmlFor="migration-token"
                hint={
                  <>
                    In {label}: <strong>Settings</strong> → <strong>Private Integrations</strong> →
                    create one, tick the <strong>read</strong> access (View Contacts, and whatever
                    else you want brought across), and copy the token. It is shown once.
                  </>
                }
              >
                <Input
                  id="migration-token"
                  type="password"
                  value={token}
                  maxLength={4000}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="pit-…"
                  onChange={(e) => setToken(e.target.value)}
                  data-testid="migration-token"
                />
              </Field>
              <Field
                label="Location ID"
                htmlFor="migration-location"
                hint={
                  <>
                    The sub-account this token belongs to: <strong>Settings</strong> →{' '}
                    <strong>Business Profile</strong>, or the long code in the address bar after{' '}
                    <code>/location/</code>.
                  </>
                }
                error={error}
              >
                <Input
                  id="migration-location"
                  value={accountId}
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setAccountId(e.target.value)}
                  data-testid="migration-location"
                />
              </Field>
              <Hint>
                We only ever read with it, and it never leaves HandsFreeOS. Delete the private
                integration in {label} whenever you like — after the move is the usual time.
              </Hint>
            </>
          ) : workspaceId ? null : (
            <Field label="What it reaches" htmlFor="migration-reach" error={error}>
              <div className="flex flex-col gap-2" id="migration-reach">
                <RadioCard
                  selected={reach === 'agency'}
                  onSelect={() => setReach('agency')}
                  testId="migration-reach-agency"
                  title="My whole agency"
                  description="Every sub-account you approve. You choose which ones to bring, and where each one lands."
                />
                <RadioCard
                  selected={reach === 'location'}
                  onSelect={() => setReach('location')}
                  testId="migration-reach-location"
                  title="One business"
                  description="A single sub-account."
                />
              </div>
            </Field>
          )}
          {workspaceId && !pasting ? <FieldError>{error}</FieldError> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={pasting && (!token.trim() || !accountId.trim())}
              data-testid="migration-connect-go"
            >
              {pasting ? 'Connect with the token' : `Sign in to ${label}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Starting a migration on a source that is already connected. */
export function StartMigrationButton({
  organizationId,
  workspaceId,
  connectionId,
  sourceLabel,
  onStarted,
}: {
  organizationId: string;
  workspaceId?: string;
  connectionId: string;
  sourceLabel: string;
  /** In place of opening the migration's page: the setup wizard stays where it is while the count runs. */
  onStarted?: (migrationId: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`Off ${sourceLabel}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const created = unwrap(
        await apiBrowser().POST('/v1/commands/migration.create', {
          body: {
            organizationId,
            workspaceId,
            connectionId,
            name: name.trim() || `Off ${sourceLabel}`,
          },
        }),
      );
      // Checked, not fired and forgotten. Unchecked, a refused scan left the migration sitting at
      // "connected" while this said it had started looking, and the only way to find out was the database.
      unwrap(
        await apiBrowser().POST('/v1/commands/migration.scan', {
          body: { organizationId, workspaceId, migrationId: created.migrationId },
        }),
      );
      toast.success('Looking at the old system. This only reads — nothing moves yet.');
      if (onStarted) {
        setOpen(false);
        setBusy(false);
        onStarted(created.migrationId);
        return;
      }
      router.push(
        workspaceId
          ? `/app/w/${workspaceId}/settings/migrations/${created.migrationId}`
          : `/app/org/${organizationId}/migrations/${created.migrationId}`,
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="migration-start">
        Start a migration
      </Button>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent
            title="Start a migration"
            description={`We'll look at ${sourceLabel} and count everything in it. Read-only: nothing is brought across until you say so.`}
          >
            <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
              <Field label="Call it" htmlFor="migration-name" error={error}>
                <Input
                  id="migration-name"
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="migration-name"
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={busy} data-testid="migration-scan-go">
                  Look at {sourceLabel}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
