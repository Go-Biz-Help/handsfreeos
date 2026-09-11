'use client';
import { Check, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { Role } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { grantable } from './roles';

export function InviteDialog({
  workspaceId,
  myRole,
  defaultOpen,
}: {
  workspaceId: string;
  myRole: Role;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!!defaultOpen);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ email: string; role: Role } | null>(null);
  const options = grantable(myRole);

  function reset() {
    setEmail('');
    setRole('member');
    setError(null);
    setSent(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
      return setError('Enter a valid email address.');
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/membership.invite', {
          body: { workspaceId, email: email.trim(), role },
        }),
      );
      setSent({ email: out.email, role: out.role });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation')
        setError('Enter a valid email address.');
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <Button onClick={() => setOpen(true)} data-testid="invite-open">
        <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
        Invite teammate
      </Button>
      {sent ? (
        <DialogContent
          title="Invitation sent"
          description={`${sent.email} will join as ${options.find((o) => o.value === sent.role)?.label ?? sent.role} once they accept the link in their email.`}
        >
          <div
            className="mt-4 flex items-center gap-3 rounded-menu bg-success-soft px-3.5 py-3 text-[13px] text-success-text"
            data-testid="invite-sent"
          >
            <Check className="h-[18px] w-[18px]" strokeWidth={2} />
            The link works once and expires in 7 days. You can resend or revoke it from the pending
            list.
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={reset}>
              Invite another
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      ) : (
        <DialogContent
          title="Invite a teammate"
          description="They will get an email with a link that works once and expires in 7 days."
        >
          <form onSubmit={submit} className="mt-5 flex flex-col gap-4" noValidate>
            <Field label="Email address" htmlFor="invite-email" error={error}>
              <Input
                id="invite-email"
                type="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                invalid={!!error}
                autoFocus
                data-testid="invite-email"
              />
            </Field>
            <div>
              <Label>Role</Label>
              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Role">
                {options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={role === o.value}
                    data-testid={`invite-role-${o.value}`}
                    onClick={() => setRole(o.value)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-menu border border-border-strong bg-card px-3.5 py-3 text-left',
                      role === o.value && 'border-accent bg-accent-soft ring-1 ring-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
                        role === o.value ? 'border-accent' : 'border-border-strong',
                      )}
                      aria-hidden
                    >
                      {role === o.value ? (
                        <span className="h-2 w-2 rounded-full bg-accent" />
                      ) : null}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{o.label}</span>
                      <span className="text-[13px] text-text-3">{o.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} data-testid="invite-send">
                Send invite
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
