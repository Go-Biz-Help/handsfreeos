import {
  LOCKBOX_WORDS,
  lockboxLine,
  openingLine,
} from '@hfos/core/addons/realestate/lockbox-words';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { DoorOpen, KeyRound } from '@/components/icons';
import { List, ListLabel } from '@/components/shell/list';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';

import { NeedsSignalCard, useLiveAnswer } from './kit';
import { CheckRow, SignalNote, whenWords } from './subpage';

/**
 * A listing's lockboxes on the phone (board 98, first panel): kind, place and serial, and who opened them, asked
 * from HandsFreeOS while there's signal. The code never comes onto phones: it goes to the confirmed agent by itself,
 * and only the web shows it again.
 */
export function ShowingLockboxes({
  workspaceId,
  dealId,
  today,
  timeZone,
}: {
  workspaceId: string;
  dealId: string;
  today: string;
  timeZone: string;
}) {
  const answer = useLiveAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.lockbox.list', {
          body: { workspaceId, dealId },
        }),
      ),
    `lockboxes:${dealId}`,
    LOCKBOX_WORDS.needsSignal,
  );
  const list = answer.data;
  return (
    <View className="gap-3" testID="re-lockboxes">
      <ListLabel>
        {list ? `${LOCKBOX_WORDS.title}  ${list.lockboxes.length}` : LOCKBOX_WORDS.title}
      </ListLabel>
      {list ? (
        <>
          {list.lockboxes.length ? (
            <List testID="re-lockbox-list">
              {list.lockboxes.map((l) => {
                const line = lockboxLine(l);
                return (
                  <CheckRow
                    key={l.id}
                    icon={KeyRound}
                    label={line.title}
                    line={line.detail}
                    testID={`re-lockbox-${l.id}`}
                  />
                );
              })}
            </List>
          ) : (
            <Card className="p-4">
              <Text className="text-[14px] text-text-2">{LOCKBOX_WORDS.none}</Text>
            </Card>
          )}
          <SignalNote testID="re-lockbox-never">{LOCKBOX_WORDS.phoneNever}</SignalNote>
          {list.openings.length ? (
            <>
              <ListLabel>{LOCKBOX_WORDS.openingsTitle}</ListLabel>
              <List testID="re-lockbox-openings">
                {list.openings.map((o) => {
                  const line = openingLine(o);
                  return (
                    <CheckRow
                      key={o.id}
                      icon={DoorOpen}
                      label={`${whenWords(o.openedAt, today, timeZone)} · ${line.who}`}
                      line={o.booked ? line.detail : null}
                      warning={o.booked ? null : line.detail}
                      testID={`re-lockbox-opening-${o.id}`}
                    />
                  );
                })}
              </List>
            </>
          ) : null}
        </>
      ) : answer.loading ? (
        <ActivityIndicator className="py-4" testID="re-lockboxes-loading" />
      ) : (
        <NeedsSignalCard
          words={answer.error ?? LOCKBOX_WORDS.needsSignal}
          onRetry={answer.reload}
          testID="re-lockboxes-signal"
        />
      )}
    </View>
  );
}
