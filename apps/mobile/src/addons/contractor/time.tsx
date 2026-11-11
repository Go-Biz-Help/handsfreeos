import { fmtTime } from '@hfos/core';
import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import { durationWords, type TimeKind, type TimeTotals } from '@hfos/core/addons/contractor/time';
import { CONTRACTOR_WORDS as W, TIME_KIND_WORDS } from '@hfos/core/addons/contractor/words';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

import { SectionLabel } from './kit';

/**
 * The time on a job or one of its visits (the owner's decision 10): it starts and stops on its own with the visit's
 * status buttons, and the one thing a tech adds is a break. Take a break shows only while the phone holds their
 * running stretch on this visit, so a press with no signal has a stretch to end. Never what the time cost; fixing
 * time is the office's, on the web.
 */
export function TimeCard({
  title,
  totals,
  mine,
  timeZone,
  breakable,
  waiting,
  onBreak,
}: {
  title: string;
  totals: TimeTotals;
  /** What the person is doing on the clock right now, here. */
  mine: { readonly kind: TimeKind; readonly startedAt: string } | null;
  timeZone: string;
  /** A visit's card, on a job that's still open: the break button belongs here. */
  breakable: boolean;
  waiting: boolean;
  onBreak: (onBreak: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = React.useState(false);
  const any = totals.workSeconds + totals.travelSeconds + totals.breakSeconds > 0;
  const press = async (to: boolean) => {
    setBusy(true);
    await onBreak(to);
    setBusy(false);
  };
  return (
    <View className="gap-1.5" testID="co-time">
      <SectionLabel>{title}</SectionLabel>
      <Card className="gap-2 px-3.5 py-3">
        <Text className="text-[14px] leading-[20px]" testID="co-time-totals">
          {any || totals.running > 0
            ? P.time.totals(
                durationWords(totals.workSeconds),
                durationWords(totals.travelSeconds),
                durationWords(totals.breakSeconds),
              )
            : breakable
              ? W.time.noneForVisit
              : W.time.none}
        </Text>
        {totals.running > 0 ? (
          <Text className="text-[13px] text-text-3">{W.time.onClock(totals.running)}</Text>
        ) : null}
        {mine ? (
          <Text className="text-[13.5px] text-text-2" testID="co-time-mine">
            {P.time.yours(TIME_KIND_WORDS[mine.kind], fmtTime(mine.startedAt, timeZone))}
            {waiting ? ` · ${P.kept.waitingToSend}` : ''}
          </Text>
        ) : null}
        {breakable && mine?.kind === 'work' ? (
          <Button
            variant="secondary"
            size="md"
            loading={busy}
            onPress={() => void press(true)}
            testID="co-break-start"
          >
            {W.time.takeBreak}
          </Button>
        ) : breakable && mine?.kind === 'break' ? (
          <Button size="md" loading={busy} onPress={() => void press(false)} testID="co-break-end">
            {W.time.backToWork}
          </Button>
        ) : (
          <Text className="text-[12.5px] leading-[17px] text-text-3" testID="co-time-hint">
            {breakable ? P.time.notOnClock : P.time.fixOnTheWeb}
          </Text>
        )}
      </Card>
    </View>
  );
}
