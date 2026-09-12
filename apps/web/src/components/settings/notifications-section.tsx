'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { SetRow } from './set-row';

const LABEL = 'Email me when a customer is waiting';

/** Per-person notification choices, saved to the account (so every workspace and device follows them). */
export function NotificationsSection({ initial }: { initial: { unansweredEmail: boolean } }) {
  const [unanswered, setUnanswered] = useState(initial.unansweredEmail);
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    setUnanswered(next);
    setSaving(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/user.update_profile', {
          body: { settings: { notifications: { unansweredEmail: next } } },
        }),
      );
      toast.success(
        next ? 'You’ll get an email when a customer waits' : 'You won’t get these emails',
      );
    } catch (e) {
      setUnanswered(!next);
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Notifications</h2>
      <SetRow
        first
        className="mt-2 pb-0"
        title={LABEL}
        description="When a conversation assigned to you has no reply after 10 minutes. Owners and admins also get it for conversations nobody is assigned to."
      >
        <Switch
          checked={unanswered}
          disabled={saving}
          onChange={(v) => void toggle(v)}
          label={LABEL}
          testId="notify-unanswered"
        />
      </SetRow>
    </div>
  );
}
