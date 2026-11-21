import { EVENT_WORDS, type TodayEvent } from '@hfos/core/addons/outreach/events-near';
import * as React from 'react';
import { View } from 'react-native';

import { ExternalLink, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

import { Note, openOutside, Part } from './kit';

/**
 * Events near you on the phone's Today (docs/outreach.md, decision 188; the owner's pick 7a), as the web's Today has
 * it (apps/web's events-card.tsx): the events the person's computer read near them this week on the network shown,
 * coming up, the soonest first, so they can go in person. Each with when and where as its page said, who hosts it,
 * **Open** (the event's own page) and **Not going**. Nothing is pressed on the event. The words are core's
 * (`EVENT_WORDS`).
 */
export function EventsPart({
  events,
  onSkip,
}: {
  events: readonly TodayEvent[];
  onSkip?: (eventId: string) => void;
}) {
  if (!events.length) return null;
  return (
    <Part
      title={`${EVENT_WORDS.title} · ${events.length.toLocaleString('en-US')}`}
      about={EVENT_WORDS.about}
      testID="today-events"
    >
      {events.map((e) => {
        const hosted = EVENT_WORDS.hosted(e.hosts);
        const people = EVENT_WORDS.people(e.people);
        return (
          <Card key={e.id} className="gap-2 px-4 py-3.5" testID={`today-event-${e.id}`}>
            <Text className="text-[15px] font-semibold">{e.name}</Text>
            {e.when ? <Note>{e.when}</Note> : null}
            {e.place ? <Note>{e.place}</Note> : null}
            {hosted ? <Note>{hosted}</Note> : null}
            {people ? <Note>{people}</Note> : null}
            <View className="flex-row flex-wrap gap-2 pt-1">
              <Button
                size="md"
                variant="secondary"
                icon={ExternalLink}
                onPress={() => openOutside(e.url)}
                testID="today-event-open"
              >
                {EVENT_WORDS.open}
              </Button>
              {onSkip ? (
                <Button
                  size="md"
                  variant="ghost"
                  icon={X}
                  onPress={() => onSkip(e.id)}
                  testID="today-event-skip"
                >
                  {EVENT_WORDS.skip}
                </Button>
              ) : null}
            </View>
          </Card>
        );
      })}
    </Part>
  );
}
