'use client';

/**
 * Events near you on Today (docs/outreach.md decision 188, the owner's pick 7a): the events the person's computer read
 * near them this week on the network shown, coming up, the soonest first, so they can go in person. Each with when and
 * where as its page said, who hosts it, Open (the event's own page) and Not going (`outreach.event.skip`). Nothing is
 * pressed on the event: going is theirs to do.
 */
import { EVENT_WORDS, type TodayEvent } from '@hfos/core/addons/outreach/events-near';
import { ExternalLink, X } from 'lucide-react';
import { useState } from 'react';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useAct } from './use-act';

export function EventsCard({
  workspaceId,
  events,
}: {
  workspaceId: string;
  events: readonly TodayEvent[];
}) {
  // Put aside here: gone at once, before the page reloads.
  const [gone, setGone] = useState<readonly string[]>([]);
  const { busy, act } = useAct();
  const shown = events.filter((e) => !gone.includes(e.id));
  if (!shown.length) return null;
  const skip = (eventId: string) =>
    void act(`skip-${eventId}`, async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.event.skip', {
          body: { workspaceId, eventId },
        }),
      );
      setGone((g) => [...g, eventId]);
    });
  return (
    <section aria-labelledby="today-events-title" className="space-y-3" data-testid="today-events">
      <div className="space-y-1">
        <h2 id="today-events-title" className="text-lg font-semibold tracking-tight">
          {EVENT_WORDS.title}
          <span className="font-medium text-text-3"> · {shown.length.toLocaleString()}</span>
        </h2>
        <p className="text-[13px] text-text-2">{EVENT_WORDS.about}</p>
      </div>
      {shown.map((e) => {
        const hosted = EVENT_WORDS.hosted(e.hosts);
        const people = EVENT_WORDS.people(e.people);
        return (
          <Card key={e.id} className="space-y-2 p-4" data-testid={`today-event-${e.id}`}>
            <div className="space-y-0.5">
              <p className="text-[15px] font-semibold">{e.name}</p>
              {e.when ? <p className="text-[13px] text-text-2">{e.when}</p> : null}
              {e.place ? <p className="text-[13px] text-text-2">{e.place}</p> : null}
              {hosted ? <p className="text-[13px] text-text-3">{hosted}</p> : null}
              {people ? <p className="text-[13px] text-text-3">{people}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={e.url}
                target="_blank"
                rel="noreferrer"
                className={buttonClassName({ size: 'sm', variant: 'secondary' })}
                data-testid="today-event-open"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                {EVENT_WORDS.open}
              </a>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => skip(e.id)}
                data-testid="today-event-skip"
              >
                <X className="size-3.5" aria-hidden />
                {EVENT_WORDS.skip}
              </Button>
            </div>
          </Card>
        );
      })}
    </section>
  );
}
