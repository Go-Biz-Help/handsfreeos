/**
 * In your hands on the phone's People tab (`?view=hands`, docs/outreach.md decision 182), as the web's: everyone
 * someone on the team wrote to themselves, or took over, whom the AI sends no messages till someone gives them back.
 * Each row says whose hands and when, with Give back to the AI; Give all back takes the list shown, everyone's or only
 * the person's own. It needs signal. The words are core's (`HANDS_OUTREACH_WORDS`).
 */
import { handsLine, relativeTimeAgo } from '@hfos/core';
import { HANDS_OUTREACH_WORDS as HW, type HandsOutput } from '@hfos/core/addons/outreach/in-hands';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import { NeedsSignal, Note, useOutreachAnswer, useOutreachContext } from './kit';
import { NetworkName } from './networks';
import { PersonMenuScope, PersonName } from './person-menu';

type Whose = 'everyone' | 'mine';

export function HandsScreen() {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [whose, setWhose] = React.useState<Whose>('everyone');
  const answer = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.hands', {
          body: { workspaceId: ws, mine: whose === 'mine', limit: 200 },
        }),
      ),
    `hands:${ws}:${whose}`,
    HW.title,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const giveBack = async (which: string | 'all') => {
    setBusy(which);
    try {
      const { output } = await change('outreach.hands.give_back', {
        workspaceId: ws,
        profileIds: which === 'all' ? [] : [which],
        all: which === 'all',
        mine: which === 'all' && whose === 'mine',
      });
      toast.show(HW.gaveBack(Math.max(1, output.handedBack)));
      answer.reload();
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <PersonMenuScope
      workspaceId={ws}
      online={ctx.online}
      writesContacts={ctx.writesContacts}
      onChanged={answer.reload}
    >
      <HandsBody
        me={ctx.userId}
        whose={whose}
        onWhose={setWhose}
        list={answer.data}
        error={answer.error}
        onRetry={answer.reload}
        online={ctx.online}
        busy={busy}
        onGiveBack={(which) => void giveBack(which)}
      />
    </PersonMenuScope>
  );
}

export function HandsBody({
  me,
  whose,
  onWhose,
  list,
  error,
  onRetry,
  online = true,
  busy = null,
  onGiveBack,
}: {
  me: string | null;
  whose: Whose;
  onWhose: (w: Whose) => void;
  list: HandsOutput | null;
  error: string | null;
  onRetry: () => void;
  online?: boolean;
  busy?: string | null;
  onGiveBack: (which: string | 'all') => void;
}) {
  const people = list?.people ?? [];
  return (
    <OutreachFrame page="people" list={{ list: 'hands' }} testID="outreach-hands">
      <Note>{HW.about}</Note>
      <Segmented
        value={whose}
        onChange={onWhose}
        label={HW.title}
        options={[
          { value: 'everyone', label: HW.everyone },
          { value: 'mine', label: HW.mine },
        ]}
        testID="outreach-hands-whose"
      />
      {error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="outreach-hands-needs-signal" />
      ) : list && !people.length ? (
        <Card className="px-4 py-3.5">
          <Note>{HW.empty}</Note>
        </Card>
      ) : (
        <>
          {people.length ? (
            <Button
              size="md"
              variant="secondary"
              disabled={!online || busy !== null}
              onPress={() => onGiveBack('all')}
              testID="outreach-hands-give-all-back"
            >
              {HW.giveAllBack}
            </Button>
          ) : null}
          {people.map((p) => (
            <Card key={p.profileId} className="gap-2 px-4 py-3.5" testID="outreach-hands-person">
              <View className="flex-row flex-wrap items-center gap-2">
                <PersonName
                  who={{
                    profileId: p.profileId,
                    name: p.name,
                    url: p.url,
                    platform: p.platform,
                    threadKey: p.threadKey,
                    personId: p.personId,
                  }}
                />
                <NetworkName platform={p.platform} />
                {p.ask ? (
                  <Badge variant="pending">
                    <Text>{HW.asksTitle}</Text>
                  </Badge>
                ) : null}
              </View>
              <Text className="text-[13px] text-text-2">
                {handsLine(p, me)} · {relativeTimeAgo(p.lastAt)}
              </Text>
              <Button
                size="md"
                variant="secondary"
                disabled={!online || busy !== null}
                onPress={() => onGiveBack(p.profileId)}
                testID="outreach-hands-give-back"
              >
                {HW.giveBack}
              </Button>
            </Card>
          ))}
          {list && list.total > people.length ? (
            <Note>
              Showing the latest {people.length} of {list.total}.
            </Note>
          ) : null}
        </>
      )}
    </OutreachFrame>
  );
}
