import {
  AUTOPILOT_WORDS as A,
  autopilotLine,
  autopilotPlace,
  type AutopilotAnswer,
  type AutopilotOutput,
  type AutopilotPerson,
  type AutopilotPlace,
} from '@hfos/core/addons/outreach/autopilot';
import { PLATFORM_KEYS } from '@hfos/core/addons/outreach/networks';
import { TODAY_KINDS } from '@hfos/core/addons/outreach/today';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { CheckCheck } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Note } from './kit';
import { NetworkName } from './networks';
import { PersonName } from './person-menu';

/**
 * Autopilot's day's list on the phone, on Needs you (docs/outreach.md, decisions 151 and 160; the web's is
 * apps/web/src/addons/outreach/autopilot-list.tsx): the people it plans to reach today whom the person hasn't OK'd
 * yet, grouped by network, the spares last under "If you take anyone off, these go instead". Each name opens the
 * person menu, for Don't pitch or Never contact; each row has **Not today** (or **Put back**); and one button OKs
 * everyone still waiting. Needs you draws it twice, `place` saying which (`autopilotPlace`): first, whole, while
 * someone waits for the OK; otherwise one line at the bottom (`autopilotLine`): when the list comes, that nobody's new,
 * or how it was answered, with **Show** to open the list there. Nothing shows while Autopilot is off. It comes from
 * HandsFreeOS, with signal.
 */

/** An answer about the day's list: OK, Not today or Put back, for the people named, or with OK and none, everyone. */
export type AutopilotAnswerOf = (answer: AutopilotAnswer, profileIds?: string[]) => void;

/** "Wed 8:00 AM", on the business's clock. */
function clockAt(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function AutopilotList({
  list,
  online,
  onAnswer,
  place,
}: {
  list: AutopilotOutput | null;
  online: boolean;
  onAnswer: AutopilotAnswerOf;
  /** Which of the two this is: first on Needs you, or the line at its bottom. */
  place: AutopilotPlace;
}) {
  const [open, setOpen] = React.useState(false);
  if (!list || autopilotPlace(list) !== place) return null;
  const waiting = list.people.filter((p) => p.state === 'waiting');
  const takenOff = list.people.some((p) => p.state === 'not_today' || p.neverContact);
  const main = list.people.filter((p) => !p.spare);
  const spares = list.people.filter((p) => p.spare);
  const rows = (
    <>
      <Rows people={main} online={online} onAnswer={onAnswer} />
      {spares.length ? (
        <>
          <Text className="px-1 pt-2 text-[13px] font-medium text-text-3" testID="autopilot-spares">
            {A.spares}
          </Text>
          <Rows people={spares} online={online} onAnswer={onAnswer} />
        </>
      ) : null}
    </>
  );
  if (place === 'bottom') {
    // Once it's answered, Show opens the list here, to put back someone left Not today.
    const answered = list.made && list.people.length > 0;
    return (
      <View className="gap-2" testID="autopilot-line">
        <Card className="flex-row items-center gap-3 px-4 py-3">
          <View className="flex-1">
            <Note>{autopilotLine(list, (iso) => clockAt(iso, list.timezone))}</Note>
          </View>
          {answered ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => setOpen((was) => !was)}
              testID="autopilot-show"
            >
              {open ? A.hide : A.show}
            </Button>
          ) : null}
        </Card>
        {answered && open ? rows : null}
      </View>
    );
  }
  return (
    <View className="gap-2" testID="autopilot-list">
      <View className="gap-1 px-1">
        <Text className="text-[15px] font-semibold">
          {A.listTitle}
          <Text className="text-text-3"> · {waiting.length.toLocaleString('en-US')}</Text>
        </Text>
        <Note>{A.listAbout}</Note>
      </View>
      <Button
        size="md"
        icon={CheckCheck}
        disabled={!online}
        onPress={() => onAnswer('ok')}
        testID="autopilot-ok-all"
      >
        {takenOff ? A.okRest(waiting.length) : A.okAll(waiting.length)}
      </Button>
      {rows}
    </View>
  );
}

/** One network's people at a time, in the networks' own order. */
function Rows({
  people,
  online,
  onAnswer,
}: {
  people: readonly AutopilotPerson[];
  online: boolean;
  onAnswer: AutopilotAnswerOf;
}) {
  return (
    <>
      {PLATFORM_KEYS.map((platform) => {
        const on = people.filter((p) => p.platform === platform);
        if (!on.length) return null;
        return (
          <Card key={platform} className="gap-1 px-4 py-3" testID={`autopilot-${platform}`}>
            <NetworkName platform={platform} />
            {on.map((p, i) => (
              <Person
                key={p.profileId}
                person={p}
                first={i === 0}
                online={online}
                onAnswer={onAnswer}
              />
            ))}
          </Card>
        );
      })}
    </>
  );
}

function Person({
  person: p,
  first,
  online,
  onAnswer,
}: {
  person: AutopilotPerson;
  first: boolean;
  online: boolean;
  onAnswer: AutopilotAnswerOf;
}) {
  return (
    <View
      className={cn('flex-row items-center gap-3 py-2.5', !first && 'border-t border-border')}
      testID="autopilot-person"
    >
      <View className="flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <PersonName
            who={{
              profileId: p.profileId,
              name: p.name,
              url: p.url,
              platform: p.platform,
              personId: p.personId,
            }}
          />
          {p.neverContact ? (
            <Badge variant="danger">{W.person.neverContact}</Badge>
          ) : p.dontPitch ? (
            <Badge variant="pending">{W.person.dontPitch}</Badge>
          ) : null}
        </View>
        <Note>{[TODAY_KINDS[p.kind], ...p.why].join(' · ')}</Note>
      </View>
      {p.state === 'waiting' ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={!online}
          onPress={() => onAnswer('not_today', [p.profileId])}
          testID="autopilot-not-today"
        >
          {A.notToday}
        </Button>
      ) : p.state === 'not_today' ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={!online}
          onPress={() => onAnswer('waiting', [p.profileId])}
          testID="autopilot-put-back"
        >
          {A.putBack}
        </Button>
      ) : (
        <Text className="text-[13px] text-success-text">{A.okdLine}</Text>
      )}
    </View>
  );
}
