'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';

export function ProfileForm({ user }: { user: Me['user'] }) {
  const router = useRouter();
  const [name, setName] = useState(user.fullName);
  const [saved, setSaved] = useState(user.fullName);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== saved && name.trim().length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/user.update_profile', {
          body: { fullName: name.trim() },
        }),
      );
      setSaved(name.trim());
      toast.success('Profile saved.');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate data-testid="profile-form">
      <h2 className="text-lg font-semibold tracking-tight">Profile</h2>
      <div className="mt-[18px] flex items-center gap-4">
        <Avatar name={saved || user.email} seed={user.id} size="lg" />
        <span className="text-xs text-text-3">Your initials stand in for a photo for now.</span>
      </div>
      <div className="mt-[18px] flex flex-col gap-3.5">
        <Field label="Full name" htmlFor="full-name">
          <Input
            id="full-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </Field>
        <Field
          label="Email"
          htmlFor="email"
          hint="Changing your email re-verifies it. Coming with security settings."
        >
          <div className="relative">
            <Input id="email" value={user.email} readOnly />
            <Badge variant="ok" className="absolute right-2.5 top-[9px]">
              Verified
            </Badge>
          </div>
        </Field>
      </div>
      <div className="mt-[18px] flex justify-end">
        <Button type="submit" disabled={!dirty} loading={busy}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
