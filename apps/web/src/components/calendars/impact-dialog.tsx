'use client';
import type { Impact, ImpactDecision } from '@hfos/core';
import { AlertTriangle, Info } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { RadioCard } from '@/components/ui/radio-card';

interface Choice {
  readonly title: string;
  readonly description: string;
}

function choices(
  impact: Impact,
  who: string,
  what: string,
): Partial<Record<ImpactDecision, Choice>> {
  if (impact.code === 'resource_removed')
    return {
      keep: {
        title: `Keep ${what} on them`,
        description: 'They still hold it. New bookings don’t need it.',
      },
      cancel_and_notify: {
        title: 'Cancel them and tell the customers',
        description: 'Each customer gets a text, or an email if they don’t get texts.',
      },
    };
  return {
    keep: {
      title: `Keep them with ${who}`,
      description: `${who} still goes to ${impact.count === 1 ? 'it' : 'these'}. New bookings skip ${who}.`,
    },
    reassign: {
      title: 'Reassign them',
      description:
        'We check each one is free for someone else on this calendar first. Any that don’t fit stay as they are.',
    },
    cancel_and_notify: {
      title: 'Cancel them and tell the customers',
      description: 'Each customer gets a text, or an email if they don’t get texts.',
    },
  };
}

/**
 * "Before you save": a change that touches upcoming appointments asks what happens to them. Keeping is
 * always allowed (appointments keep the terms they were booked under).
 */
export function ImpactDialog({
  open,
  impacts,
  calendarName,
  personName,
  resourceName,
  saving,
  onBack,
  onSave,
}: {
  open: boolean;
  impacts: readonly Impact[];
  calendarName: string;
  personName: (userId: string) => string;
  resourceName: (resourceId: string) => string;
  saving: boolean;
  onBack: () => void;
  onSave: (decisions: Record<string, ImpactDecision>) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, ImpactDecision>>({});
  const removed = impacts.filter((i) => i.code === 'member_removed' && i.userId);
  const description = removed.length
    ? `You took ${removed.map((i) => personName(i.userId!).split(/\s+/)[0]).join(' and ')} off ${calendarName}.`
    : 'Some upcoming appointments are affected.';
  const decided = (i: Impact) => decisions[i.key] ?? i.decisions[0] ?? 'keep';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onBack()}>
      <DialogContent
        title="Before you save"
        description={description}
        className="max-h-[90vh] w-[min(560px,calc(100vw-32px))] overflow-y-auto"
      >
        <div className="mt-3.5 flex flex-col gap-5" data-testid="impact-review">
          {impacts.map((impact) => {
            const who = impact.userId ? personName(impact.userId).split(/\s+/)[0]! : 'them';
            const what = impact.resourceId ? resourceName(impact.resourceId) : 'it';
            const options = choices(impact, who, what);
            return (
              <div key={impact.key} className="flex flex-col gap-2">
                <div className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13.5px] text-warning-text">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
                  <strong className="font-semibold">{impact.message}</strong>
                </div>
                {impact.code === 'seats_below_booked' ? (
                  <div className="flex items-start gap-2.5 rounded-menu bg-accent-soft px-3 py-2.5 text-[13px] text-accent-text">
                    <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
                    Those sessions keep everyone already booked. The new seat count applies to new
                    bookings.
                  </div>
                ) : (
                  <div
                    role="radiogroup"
                    aria-label={impact.message}
                    className="flex flex-col gap-2"
                  >
                    {impact.decisions.map((d) => {
                      const c = options[d];
                      if (!c) return null;
                      return (
                        <RadioCard
                          key={d}
                          selected={decided(impact) === d}
                          onSelect={() => setDecisions({ ...decisions, [impact.key]: d })}
                          title={<span className="text-[13px]">{c.title}</span>}
                          description={<span className="text-xs">{c.description}</span>}
                          className="px-3 py-2"
                          testId={`impact-${impact.code}-${d}`}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button
            loading={saving}
            onClick={() => onSave(Object.fromEntries(impacts.map((i) => [i.key, decided(i)])))}
            data-testid="impact-save"
          >
            Save changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
