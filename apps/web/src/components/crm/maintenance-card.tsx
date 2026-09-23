'use client';
/**
 * A customer's regular services (Automations' "Maintenance due"): each service they've had, how often it's
 * due and why (their own schedule, their plan, the service), when next, and where the reminders stand. A
 * person can give them their own schedule, stop reminding them, or go back to the default.
 */
import { everyMonthsWords } from '@hfos/core';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { formatDateOnly } from '@/lib/format';
import { useLiveVersion } from '@/lib/realtime/live-provider';

type Line = {
  serviceId: string;
  serviceName: string;
  lastVisitOn: string | null;
  everyMonths: number | null;
  source: 'customer' | 'plan' | 'service' | null;
  planName: string | null;
  serviceMonths: number | null;
  dueOn: string | null;
  bookedAhead: boolean;
  reminder: { dueOn: string; sentCount: number; status: string; lastSentAt: string | null } | null;
};

const CHOICES = [1, 2, 3, 4, 6, 9, 12, 18, 24];

/** "Every 6 months (the service's)", "Never (their own)", "Every year (their plan, Comfort Club)". */
function scheduleWords(l: Line): string {
  const how = l.everyMonths ? everyMonthsWords(l.everyMonths) : 'Not reminded';
  const whose =
    l.source === 'customer'
      ? 'just for them'
      : l.source === 'plan'
        ? `their plan${l.planName ? `, ${l.planName}` : ''}`
        : l.source === 'service'
          ? 'the service’s'
          : null;
  return `${how.charAt(0).toUpperCase()}${how.slice(1)}${whose ? ` (${whose})` : ''}`;
}

function statusWords(l: Line): string | null {
  if (l.bookedAhead) return 'Booked';
  const r = l.reminder;
  if (!r || r.dueOn !== l.dueOn) return null;
  if (r.status === 'card') return 'Texted twice, not booked';
  if (r.status === 'booked') return 'Booked';
  if (r.status === 'reminding') return r.sentCount === 1 ? 'Reminded once' : 'Reminded twice';
  return null;
}

export function MaintenanceCard({
  workspaceId,
  personId,
  canEdit,
}: {
  workspaceId: string;
  personId: string;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<Line[] | null>(null);
  const changes = useLiveVersion(['person', 'appointment']);
  const load = useCallback(async () => {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/maintenance.for_person', {
          body: { workspaceId, personId },
        }),
      );
      setItems(out.items as Line[]);
    } catch {
      setItems((had) => had ?? []);
    }
  }, [workspaceId, personId]);
  useEffect(() => {
    void load();
  }, [load, changes]);

  async function change(l: Line, value: string) {
    const every = value === 'default' || value === 'never' ? value : Number(value);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/maintenance.set_schedule', {
          body: { workspaceId, personId, serviceId: l.serviceId, every },
        }),
      );
      toast.success(
        every === 'never'
          ? `They won’t be reminded about ${l.serviceName}.`
          : every === 'default'
            ? `${l.serviceName} follows the default again.`
            : `${l.serviceName}: ${everyMonthsWords(every)}, just for them.`,
      );
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (!items?.length) return null;
  return (
    <Card className="p-4 md:p-5" data-testid="maintenance-card">
      <h3 className="mb-2 text-[15px] font-semibold">Regular services</h3>
      <ul className="flex flex-col gap-3">
        {items.map((l) => {
          const status = statusWords(l);
          const value =
            l.source === 'customer' ? (l.everyMonths ? String(l.everyMonths) : 'never') : 'default';
          return (
            <li
              key={l.serviceId}
              className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0"
              data-testid={`maintenance-${l.serviceName}`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-medium">{l.serviceName}</span>
                {l.dueOn ? (
                  <span className="whitespace-nowrap text-[12.5px] text-text-2">
                    Due {formatDateOnly(l.dueOn)}
                  </span>
                ) : null}
              </span>
              <span className="text-[12.5px] text-text-2">
                {l.lastVisitOn ? `Last done ${formatDateOnly(l.lastVisitOn)} · ` : ''}
                {scheduleWords(l)}
                {status ? ` · ${status}` : ''}
              </span>
              {canEdit ? (
                <Select
                  selectSize="sm"
                  aria-label={`How often ${l.serviceName} is due for them`}
                  value={value}
                  onChange={(e) => void change(l, e.target.value)}
                  data-testid={`maintenance-schedule-${l.serviceName}`}
                >
                  <option value="default">
                    {l.planName
                      ? 'As their plan says'
                      : l.serviceMonths
                        ? `As the service says (${everyMonthsWords(l.serviceMonths)})`
                        : 'As the service says (doesn’t repeat)'}
                  </option>
                  {CHOICES.map((n) => (
                    <option key={n} value={String(n)}>
                      {everyMonthsWords(n).replace(/^e/, 'E')}, just for them
                    </option>
                  ))}
                  <option value="never">Never remind them</option>
                </Select>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
