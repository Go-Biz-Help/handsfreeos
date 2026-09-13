'use client';
import type { CalendarConfig } from '@hfos/core';
import { useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { tellNote, type TellFacts } from '@/lib/calendar/reminders';

/** Whether the workspace can text yet (phone.setup_status), read once per opening; null while unknown. */
export function useTextingReady(workspaceId: string, open: boolean): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/phone.setup_status', { body: { workspaceId } })
      .then(unwrap)
      .then((s) => !cancelled && setReady(s.messagingReady))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, open]);
  return ready;
}

/**
 * "Tell Mike", ticked by default, and under it what Mike will get: "Texts now, then reminders the day before
 * at 4 PM and 2 hours before." The line waits for the calendar's settings and Mike's contact details.
 */
export function TellField({
  name,
  notifications,
  reach,
  checked,
  onChange,
  testId,
}: {
  /** The customer's first name. */
  name: string;
  notifications: CalendarConfig['notifications'] | null;
  reach: Omit<TellFacts, 'name'> | null;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId: string;
}) {
  return (
    <div>
      <Checkbox
        label={<span className="font-medium">Tell {name || 'the customer'}</span>}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      {notifications && reach ? (
        <p className="ml-7 mt-0.5 text-xs text-text-3" data-testid={`${testId}-note`}>
          {tellNote(notifications, { name, ...reach }, checked)}
        </p>
      ) : null}
    </div>
  );
}
