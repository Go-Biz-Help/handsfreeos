'use client';
import {
  deskSectionLabel,
  STAFF_ROLE_CHOICES,
  SUPPORT_TEAM_WORDS,
  supportInvitationLine,
  supportInviteEmailOk,
  supportPersonLine,
  supportPersonName,
} from '@hfos/core';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Role = 'agent' | 'lead' | 'admin';

const ROLES: readonly { value: Role; label: string; help: string }[] = STAFF_ROLE_CHOICES;

export interface StaffMemberView {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly status: 'active' | 'suspended';
  readonly openTicketCount: number;
}

export interface StaffInvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly invitedByName: string;
  readonly expiresAt: string;
}

export function StaffPage({
  staff,
  invitations,
  canManage,
  meUserId,
  meDisplayName,
  meSignature,
}: {
  staff: readonly StaffMemberView[];
  invitations: readonly StaffInvitationView[];
  canManage: boolean;
  meUserId: string;
  meDisplayName: string;
  meSignature: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const call = (path: string, body: object) =>
    (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
      body,
    }).then(unwrap);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('staff')}</h1>
        {canManage ? <InviteStaff onDone={() => router.refresh()} /> : null}
      </div>
      {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

      <ul className="mt-5 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
        {staff.map((s) => (
          <li
            key={s.userId}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5"
            data-testid={`staff-row-${s.userId}`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {supportPersonName(s)}
                {s.userId === meUserId ? (
                  <span className="text-text-3">{SUPPORT_TEAM_WORDS.youTag}</span>
                ) : null}
              </p>
              <p className="truncate text-[13px] text-text-3">{supportPersonLine(s)}</p>
            </div>
            {canManage && s.userId !== meUserId ? (
              <>
                <select
                  value={s.role}
                  aria-label={SUPPORT_TEAM_WORDS.roleFor(s.email)}
                  onChange={(e) =>
                    run(s.userId, () =>
                      call('/v1/commands/support.staff.set_role', {
                        userId: s.userId,
                        role: e.target.value,
                      }),
                    )
                  }
                  className="h-9 rounded-control border border-border bg-card px-2 text-[13px]"
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  disabled={busy === s.userId}
                  onClick={() =>
                    run(s.userId, () =>
                      call('/v1/commands/support.staff.set_role', {
                        userId: s.userId,
                        status: s.status === 'active' ? 'suspended' : 'active',
                      }),
                    )
                  }
                >
                  {s.status === 'active'
                    ? SUPPORT_TEAM_WORDS.suspend
                    : SUPPORT_TEAM_WORDS.letBackIn}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy === s.userId}
                  onClick={() =>
                    run(s.userId, () =>
                      call('/v1/commands/support.staff.remove', { userId: s.userId }),
                    )
                  }
                >
                  {SUPPORT_TEAM_WORDS.remove}
                </Button>
              </>
            ) : (
              <span className="text-[13px] text-text-3">
                {ROLES.find((r) => r.value === s.role)?.label}
              </span>
            )}
          </li>
        ))}
      </ul>

      {invitations.length ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">{SUPPORT_TEAM_WORDS.waiting}</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{i.email}</p>
                  <p className="text-[13px] text-text-3">{supportInvitationLine(i)}</p>
                </div>
                {canManage ? (
                  <>
                    <Button
                      variant="ghost"
                      disabled={busy === i.id}
                      onClick={() =>
                        run(i.id, () =>
                          call('/v1/commands/support.staff.resend_invitation', {
                            invitationId: i.id,
                          }),
                        )
                      }
                    >
                      {SUPPORT_TEAM_WORDS.sendAgain}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy === i.id}
                      onClick={() =>
                        run(i.id, () =>
                          call('/v1/commands/support.staff.revoke_invitation', {
                            invitationId: i.id,
                          }),
                        )
                      }
                    >
                      {SUPPORT_TEAM_WORDS.cancel}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <MyProfile displayName={meDisplayName} signature={meSignature} />
    </div>
  );
}

/** What customers see on this person's replies. */
function MyProfile({ displayName, signature }: { displayName: string; signature: string }) {
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [sign, setSign] = useState(signature);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/support.staff.save_profile', {
          body: { displayName: name.trim(), signature: sign },
        }),
      );
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form onSubmit={save} className="mt-6 rounded-card border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{SUPPORT_TEAM_WORDS.signOffTitle}</h2>
      <p className="mt-1 text-[13px] text-text-3">{SUPPORT_TEAM_WORDS.signOffDetail}</p>
      <div className="mt-3 flex flex-col gap-3">
        <Field label={SUPPORT_TEAM_WORDS.nameLabel} htmlFor="staff-name">
          <Input
            id="staff-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            placeholder={SUPPORT_TEAM_WORDS.namePlaceholder}
          />
        </Field>
        <Field label={SUPPORT_TEAM_WORDS.signatureLabel} htmlFor="staff-signature">
          <Input
            id="staff-signature"
            value={sign}
            onChange={(e) => {
              setSign(e.target.value);
              setSaved(false);
            }}
            placeholder={SUPPORT_TEAM_WORDS.signaturePlaceholder}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit">{SUPPORT_TEAM_WORDS.save}</Button>
          {saved ? (
            <span className="text-[13px] text-success-text">{SUPPORT_TEAM_WORDS.saved}</span>
          ) : null}
          {error ? <span className="text-[13px] text-danger-text">{error}</span> : null}
        </div>
      </div>
    </form>
  );
}

function InviteStaff({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supportInviteEmailOk(email)) return setError(SUPPORT_TEAM_WORDS.badEmail);
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/support.staff.invite', {
          body: { email: email.trim(), role },
        }),
      );
      setSent(email.trim());
      setEmail('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)} data-testid="staff-invite-open">
        <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
        {SUPPORT_TEAM_WORDS.invite}
      </Button>
      <DialogContent
        title={SUPPORT_TEAM_WORDS.inviteTitle}
        description={SUPPORT_TEAM_WORDS.inviteDetail}
      >
        {sent ? (
          <div className="mt-4">
            <p className="text-sm">
              {SUPPORT_TEAM_WORDS.sentTo} <strong>{sent}</strong>. {SUPPORT_TEAM_WORDS.sevenDays}
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                setSent(null);
                setOpen(false);
              }}
            >
              {SUPPORT_TEAM_WORDS.done}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
            <Field label={SUPPORT_TEAM_WORDS.emailLabel} htmlFor="staff-email">
              <Input
                id="staff-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={SUPPORT_TEAM_WORDS.emailPlaceholder}
                data-testid="staff-invite-email"
              />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{SUPPORT_TEAM_WORDS.whatTheyMayDo}</legend>
              {ROLES.map((r) => (
                <label
                  key={r.value}
                  className="flex cursor-pointer gap-2.5 rounded-menu border border-border px-3 py-2.5"
                >
                  <input
                    type="radio"
                    name="staff-role"
                    value={r.value}
                    checked={role === r.value}
                    onChange={() => setRole(r.value)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium">{r.label}</span>
                    <span className="block text-[13px] text-text-3">{r.help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy} data-testid="staff-invite-send">
                {SUPPORT_TEAM_WORDS.sendInvitation}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {SUPPORT_TEAM_WORDS.cancel}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
