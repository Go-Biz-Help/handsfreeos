import type { Playbook, StandoutRef } from '@hfos/core/addons/socialcontent/shapes';
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { View } from 'react-native';

import { RefreshCw } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { workerPost } from '@/lib/worker';

import { NeedsSignal, Note, useAct, useSocialcontentAnswer, useSocialcontentContext } from './kit';
import { StandoutLinks } from './post-card';

/**
 * The Playbook on the phone, as on the web (docs/socialcontent.md, part 3): what works for the creators studied,
 * written by the AI from its notes on their standouts, in sections of things to do, each with why it works and the
 * standouts it came from. It's written on its own once a few standouts are noted; **Write it again** writes it now.
 * It needs signal.
 */

export interface PlaybookData {
  readonly playbook: Playbook;
  readonly examples: readonly StandoutRef[];
}

export function PlaybookScreen() {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const answer = useSocialcontentAnswer<PlaybookData>(
    async () =>
      unwrap(
        await api.POST('/v1/queries/socialcontent.playbook.get', { body: { workspaceId: ws } }),
      ),
    `socialcontent-playbook:${ws}`,
    W.playbook.title,
  );
  const { busy, act } = useAct(answer.reload);
  return (
    <PlaybookBody
      data={answer.data}
      error={answer.error}
      online={ctx.online}
      writing={busy === 'write'}
      onRetry={answer.reload}
      onWrite={() =>
        void act(
          'write',
          () =>
            workerPost<{ sections: number }>(
              '/v1/addons/socialcontent/actions/socialcontent.playbook.write',
              { workspaceId: ws, input: {} },
            ),
          W.playbook.done,
        )
      }
    />
  );
}

export function PlaybookBody({
  data,
  error,
  online,
  writing,
  onRetry,
  onWrite,
}: {
  data: PlaybookData | null;
  error: string | null;
  online: boolean;
  writing: boolean;
  onRetry: () => void;
  onWrite: () => void;
}) {
  const playbook = data?.playbook ?? null;
  const byId = React.useMemo(
    () => new Map((data?.examples ?? []).map((e) => [e.id, e])),
    [data?.examples],
  );
  const since = playbook ? playbook.noted - playbook.standouts : 0;
  return (
    <Screen title={W.playbook.title} leading="back" testID="socialcontent-playbook">
      <Note>{W.playbook.intro}</Note>
      {playbook ? (
        <>
          {playbook.noted > 0 ? (
            <Button
              variant="secondary"
              icon={RefreshCw}
              loading={writing}
              disabled={!online}
              onPress={onWrite}
              testID="socialcontent-playbook-write"
            >
              {writing ? W.playbook.writing : W.playbook.write}
            </Button>
          ) : null}
          {playbook.writtenAt === null || !playbook.sections.length ? (
            <Note testID="socialcontent-playbook-none">{W.playbook.none}</Note>
          ) : (
            <>
              <Card className="gap-2 p-4">
                {playbook.summary ? (
                  <Text className="text-[14.5px] leading-[22px]">{playbook.summary}</Text>
                ) : null}
                <Text className="text-[12.5px] text-text-3" testID="socialcontent-playbook-when">
                  {W.playbook.written(daysAgo(playbook.writtenAt) ?? '', playbook.standouts)}
                  {since > 0 ? ` ${W.playbook.newSince(since)}` : ''}
                </Text>
              </Card>
              {playbook.sections.map((s) => (
                <Card key={s.title} className="gap-3 p-4" testID="socialcontent-playbook-section">
                  <Text className="text-[15px] font-semibold">{s.title}</Text>
                  {s.items.map((i, n) => (
                    <View key={`${n}:${i.do}`} className="flex-row gap-3">
                      <View className="mt-0.5 size-5 items-center justify-center rounded-full bg-accent-soft">
                        <Text className="text-[11.5px] font-semibold text-accent-text">
                          {n + 1}
                        </Text>
                      </View>
                      <View className="min-w-0 flex-1 gap-1">
                        <Text className="text-[14px] font-medium leading-[19px]">{i.do}</Text>
                        {i.why ? (
                          <Text className="text-[13px] leading-[18px] text-text-2">{i.why}</Text>
                        ) : null}
                        <StandoutLinks
                          label={W.playbook.examples}
                          ids={i.examples}
                          examples={byId}
                        />
                      </View>
                    </View>
                  ))}
                </Card>
              ))}
            </>
          )}
        </>
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="socialcontent-playbook-needs-signal" />
      ) : null}
    </Screen>
  );
}
