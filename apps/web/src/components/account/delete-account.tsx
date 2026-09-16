'use client';
import { AlertTriangle, Info, Trash2, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AccountDeletionCheck } from '@/lib/api/types';
import { supabaseBrowser } from '@/lib/supabase/client';

const firstName = (name: string, fallback: string) => name.trim().split(/\s+/)[0] || fallback;

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Delete my account (M10), on Settings → Account and on the public /delete-account page. Typing the email address
 * confirms it. A business the person is the only owner of is named, with the teammate to make an owner and a link to
 * its Members page; an agency is handed to someone who owns one of its businesses right here. The button waits until
 * nothing would be left without an owner. After it, the person is signed out.
 */
export function DeleteAccount({ email, check }: { email: string; check: AccountDeletionCheck }) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  const blockers = [...check.businesses.map((b) => b.name), ...check.agencies.map((a) => a.name)];

  async function remove() {
    setError(null);
    if (!matches) {
      setError('Type your email address exactly as it is on your account.');
      return;
    }
    setDeleting(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/account.delete', {
          body: { confirmEmail: typed.trim() },
        }),
      );
      // HandsFreeOS ends every session in a moment; this browser lets go of its own now.
      await supabaseBrowser()
        .auth.signOut({ scope: 'local' })
        .catch(() => undefined);
      window.location.assign('/sign-in?error=deleted');
    } catch (e) {
      setDeleting(false);
      setError(errorMessage(e));
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="delete-account">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Delete my account</h2>
        <p className="mt-1 text-[13px] text-text-2">
          Your sign-in and your name are removed, and you are signed out everywhere, on the web and
          on your phones. The customers, messages and jobs you worked on stay with each business,
          shown as from a former teammate.
        </p>
      </div>

      {check.businesses.map((b) => (
        <Callout
          key={b.workspaceId}
          tone="warning"
          icon={AlertTriangle}
          data-testid={`only-owner-${b.workspaceId}`}
        >
          <div className="flex flex-col gap-2">
            <span>
              <b className="font-semibold">You’re the only owner of {b.name}.</b>{' '}
              {b.suggestion
                ? `Make ${firstName(b.suggestion.fullName, b.suggestion.email)} or someone else an owner first, so the business isn’t left without one.`
                : 'Invite someone and make them an owner first, so the business isn’t left without one.'}
            </span>
            <span>
              <ButtonLink href={`/app/w/${b.workspaceId}/members`} size="sm">
                <UserRound className="h-3.5 w-3.5" strokeWidth={1.5} />
                Open Members
              </ButtonLink>
            </span>
          </div>
        </Callout>
      ))}

      {check.agencies.map((a) => (
        <AgencyHandOver key={a.organizationId} agency={a} onDone={() => router.refresh()} />
      ))}

      {check.ready && check.handsOver.length > 0 ? (
        <Callout tone="info" icon={Info} data-testid="hands-over">
          {check.handsOver
            .map(
              (h) =>
                `${h.name} stays with ${joinNames(h.to.map((p) => p.fullName || p.email))}, ${h.to.length === 1 ? 'its other owner' : 'its other owners'}.`,
            )
            .join(' ')}
        </Callout>
      ) : null}

      {check.ready ? (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void remove();
          }}
        >
          <Field
            label="Type your email address to confirm"
            htmlFor="delete-confirm-email"
            error={error}
          >
            <Input
              id="delete-confirm-email"
              type="email"
              autoComplete="off"
              placeholder={email}
              value={typed}
              invalid={!!error}
              onChange={(e) => setTyped(e.target.value)}
              className="max-w-[360px]"
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant="danger"
              loading={deleting}
              disabled={!matches}
              data-testid="delete-my-account"
            >
              {deleting ? null : <Trash2 className="h-4 w-4" strokeWidth={1.5} />}
              Delete my account
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="danger" disabled data-testid="delete-my-account">
            <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            Delete my account
          </Button>
          <span className="text-[13px] text-text-3">
            {blockers.length === 1
              ? `Available once someone else owns ${blockers[0]}.`
              : `Available once someone else owns each of ${joinNames(blockers)}.`}
          </span>
        </div>
      )}
    </div>
  );
}

/** An agency the person owns alone: hand it to someone who already owns one of its businesses. */
function AgencyHandOver({
  agency,
  onDone,
}: {
  agency: AccountDeletionCheck['agencies'][number];
  onDone: () => void;
}) {
  const [userId, setUserId] = useState(agency.candidates[0]?.userId ?? '');
  const [busy, setBusy] = useState(false);
  const chosen = agency.candidates.find((c) => c.userId === userId);

  async function handOver() {
    if (!chosen) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/organization.add_owner', {
          body: { organizationId: agency.organizationId, userId: chosen.userId },
        }),
      );
      toast.success(`${chosen.fullName || chosen.email} is now an owner of ${agency.name}`);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Callout
      tone="warning"
      icon={AlertTriangle}
      data-testid={`only-owner-${agency.organizationId}`}
    >
      <div className="flex flex-col gap-2.5">
        <span>
          <b className="font-semibold">You’re the only owner of the agency {agency.name}.</b> Make
          someone who owns one of its businesses an owner of {agency.name} too, so it isn’t left
          without one. They’ll reach{' '}
          {agency.businessCount === 2 ? 'both' : `all ${agency.businessCount}`} of its businesses.
        </span>
        {agency.candidates.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-[12.5px] font-medium">
              Hand {agency.name} to
              <Select
                selectSize="sm"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className="w-[280px] max-w-full bg-card text-text"
                data-testid="agency-new-owner"
              >
                {agency.candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.fullName || c.email}
                    {c.owns.length ? ` · owns ${c.owns.join(', ')}` : ' · admin of the agency'}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => void handOver()}
              data-testid="make-agency-owner"
            >
              Make owner
            </Button>
          </div>
        ) : (
          <span>
            Nobody else owns one of its businesses yet. Make someone an owner of one of them in its
            Members page first.
          </span>
        )}
      </div>
    </Callout>
  );
}
