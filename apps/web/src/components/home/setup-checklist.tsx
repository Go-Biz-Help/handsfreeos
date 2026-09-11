'use client';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { publicEnv } from '@/lib/env';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

interface Task {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  action?: { label: string; href: string };
}

export function SetupChecklist({
  workspaceId,
  invited,
  canInvite,
}: {
  workspaceId: string;
  invited: boolean;
  canInvite: boolean;
}) {
  const [passkey, setPasskey] = useState<boolean | null>(null);
  const [google, setGoogle] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string>('');

  useEffect(() => {
    const supabase = supabaseBrowser();
    void (async () => {
      const { data } = await supabase.auth.getUser();
      setEmail(data.user?.email ?? '');
      setGoogle((data.user?.identities ?? []).some((i) => i.provider === 'google'));
      if (publicEnv.passkeysEnabled) {
        const list = await supabase.auth.passkey.list();
        setPasskey((list.data?.length ?? 0) > 0);
      } else setPasskey(false);
    })();
  }, []);

  const tasks: Task[] = [
    {
      key: 'email',
      title: 'Confirm your email',
      detail: email ? `${email} is verified` : 'Verified',
      done: true,
    },
    {
      key: 'business',
      title: 'Create your business',
      detail: 'Done. Details are on the right.',
      done: true,
    },
    {
      key: 'invite',
      title: 'Invite your team',
      detail: 'Owners, admins and members each get the right access',
      done: invited,
      ...(canInvite
        ? { action: { label: 'Invite', href: `/app/w/${workspaceId}/members?invite=1` } }
        : {}),
    },
    ...(publicEnv.passkeysEnabled
      ? [
          {
            key: 'passkey',
            title: 'Add a passkey',
            detail: 'Sign in with Touch ID or Face ID instead of a password',
            done: passkey === true,
            action: { label: 'Add passkey', href: `/app/w/${workspaceId}/settings#passkeys` },
          },
        ]
      : []),
    {
      key: 'google',
      title: 'Connect Google sign-in',
      detail: 'One click to sign in on any device',
      done: google === true,
      action: { label: 'Connect', href: `/app/w/${workspaceId}/settings#google` },
    },
  ];
  const doneCount = tasks.filter((t) => t.done).length;

  return (
    <div data-testid="setup-checklist">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Finish setting up</h2>
        <Badge variant="gray">
          {doneCount} of {tasks.length} done
        </Badge>
      </div>
      <p className="text-[13px] text-text-2">
        A few minutes now saves you from doing this in the middle of a busy day.
      </p>
      <div className="mb-1.5 mt-4 h-1.5 overflow-hidden rounded-full bg-card-2">
        <div
          className="h-full origin-left rounded-full bg-accent transition-transform"
          style={{ transform: `scaleX(${doneCount / tasks.length})` }}
        />
      </div>
      <ul className="flex flex-col">
        {tasks.map((t) => (
          <li
            key={t.key}
            className="flex items-center gap-3.5 border-b border-border py-3.5 last:border-b-0"
          >
            <span
              className={cn(
                'flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border-[1.5px]',
                t.done ? 'border-success bg-success text-white' : 'border-border-strong',
              )}
              aria-hidden
            >
              {t.done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('font-medium', t.done && 'text-text-2 line-through')}>
                {t.title}
              </span>
              <span className="text-[13px] text-text-3">{t.detail}</span>
            </span>
            {!t.done && t.action ? (
              <ButtonLink size="sm" href={t.action.href}>
                {t.action.label}
              </ButtonLink>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
