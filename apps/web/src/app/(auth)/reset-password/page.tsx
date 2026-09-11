'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { supabaseBrowser } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 12) {
      setError('Use at least 12 characters.');
      return;
    }
    setBusy(true);
    const { error } = await supabaseBrowser().auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    toast.success('Password updated.');
    router.replace('/app');
    router.refresh();
  }

  return (
    <Card className="w-[440px] max-w-full rounded-dialog p-9">
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
        Choose a new password
      </h1>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
        <Field
          label="New password"
          htmlFor="password"
          error={error}
          hint="At least 12 characters. A short sentence works well."
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            inputSize="lg"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={!!error}
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Update password
        </Button>
      </form>
    </Card>
  );
}
