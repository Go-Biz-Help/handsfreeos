'use client';
import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { supabaseBrowser } from '@/lib/supabase/client';

export function PasswordSection({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 12) return setError('Use at least 12 characters.');
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();
    // Re-authenticate with the current password first: proves it is really you and refreshes the session.
    const check = await supabase.auth.signInWithPassword({ email, password: current });
    if (check.error) {
      setBusy(false);
      return setError('That current password is not right.');
    }
    const { error } = await supabase.auth.updateUser({ password: next });
    setBusy(false);
    if (error) return setError(error.message);
    setOpen(false);
    setCurrent('');
    setNext('');
    toast.success('Password updated.');
  }

  return (
    <div>
      <div className="flex items-center gap-3.5 py-3.5">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-menu bg-card-2 text-text-2">
          <Lock className="h-[18px] w-[18px]" strokeWidth={1.5} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">Password</span>
          <span className="text-[13px] text-text-3">Used together with your email</span>
        </span>
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Change'}
        </Button>
      </div>
      {open ? (
        <form onSubmit={submit} className="flex flex-col gap-3 pb-4 pl-[50px] pt-1" noValidate>
          <Field label="Current password" htmlFor="pw-current">
            <Input
              id="pw-current"
              type="password"
              inputSize="sm"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field
            label="New password"
            htmlFor="pw-next"
            error={error}
            hint="At least 12 characters."
          >
            <Input
              id="pw-next"
              type="password"
              inputSize="sm"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              invalid={!!error}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!current || next.length < 12} loading={busy}>
              Update password
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
