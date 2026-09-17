'use client';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LIVE_SOURCES, SOURCE_LABELS, type MigrationSourceSystem } from '@hfos/core';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { publicEnv } from '@/lib/public-env';

/**
 * Connecting the CRM a business is leaving. Two things are said before anybody signs in, because both are
 * true and neither is obvious: the look that follows only reads, and the old account is never touched.
 */
export function ConnectSourceButton({ organizationId }: { organizationId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="migration-connect">
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        Connect a CRM
      </Button>
      {open ? <ConnectDialog organizationId={organizationId} onOpenChange={setOpen} /> : null}
    </>
  );
}

function ConnectDialog({
  organizationId,
  onOpenChange,
}: {
  organizationId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState<MigrationSourceSystem>('gohighlevel');
  const [reach, setReach] = useState<'agency' | 'location'>('agency');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/migration.connect', {
          body: { organizationId, source, installKind: reach },
        }),
      );
      // Off to the old system's own sign-in, through the worker.
      window.location.href = `${publicEnv.workerUrl}${out.startPath}`;
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
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate data-testid="migration-connect-dialog">
          <Field label="Which system">
            <div className="flex flex-col gap-2">
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
          <Field label="What it reaches" error={error}>
            <div className="flex flex-col gap-2">
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} data-testid="migration-connect-go">
              Sign in to {SOURCE_LABELS[source]}
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
  connectionId,
  sourceLabel,
}: {
  organizationId: string;
  connectionId: string;
  sourceLabel: string;
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
          body: { organizationId, connectionId, name: name.trim() || `Off ${sourceLabel}` },
        }),
      );
      await apiBrowser().POST('/v1/commands/migration.scan', {
        body: { organizationId, migrationId: created.migrationId },
      });
      toast.success('Looking at the old system. This only reads — nothing moves yet.');
      router.push(`/app/org/${organizationId}/migrations/${created.migrationId}`);
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
                <Button type="submit" busy={busy} data-testid="migration-scan-go">
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
