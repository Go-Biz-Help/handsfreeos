import {
  askCodeAlertWords,
  askCodeRanOut,
  ASK_WORDS,
  type AsksOutput,
} from '@hfos/core/addons/outreach/asks';
import * as React from 'react';

import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

import { AskLine, useAskActions, useAsks, type AskActions } from './asks';
import { openOutreach, outreachPath, useOutreachContext } from './kit';

/** Asked again this often while the code's screen is open: the computer takes a code within seconds. */
const CODE_REFETCH_SECONDS = 5;

/**
 * The code a network emailed the person, on a screen of its own (decision 82): where the notification asking for it
 * opens, from the push or the notifications button. Its box takes the keyboard at once. Once the code's run out it
 * has Try again; once the computer's gone on, or the ask ended, it says how it went, and Back returns to Social
 * Outreach.
 */
export function CodeScreen({ askId }: { askId: string | null }) {
  const { workspaceId } = useOutreachContext();
  const asks = useAsks(null, ASK_WORDS.code, askId !== null, CODE_REFETCH_SECONDS);
  const actions = useAskActions(asks.data, asks.reload);
  return (
    <Screen
      title={ASK_WORDS.code}
      leading="back"
      back={outreachPath(workspaceId, 'live') as never}
      testID="outreach-code"
    >
      <CodeBody
        askId={askId}
        asks={asks.data}
        error={asks.error}
        actions={actions}
        onOpenLive={() => openOutreach(workspaceId, 'live')}
      />
    </Screen>
  );
}

/** What the code's screen shows, for the asks HandsFreeOS last answered with. */
export function CodeBody({
  askId,
  asks,
  error,
  actions,
  onOpenLive,
}: {
  askId: string | null;
  asks: AsksOutput | null;
  error: string | null;
  actions: AskActions;
  onOpenLive: () => void;
}) {
  const ask = asks?.asks.find((a) => a.askId === askId) ?? null;
  const ranOut = ask !== null && askCodeRanOut(ask);
  const waiting = ask !== null && (ask.state === 'code' || ranOut);
  if (asks && ask)
    return (
      <Card className="gap-3 px-4 py-5">
        {waiting ? (
          <Text className="text-[17px] font-semibold" testID="outreach-code-title">
            {askCodeAlertWords(ask.platform, ranOut).title}
          </Text>
        ) : (
          <Text className="text-[14.5px] leading-[21px] text-text-2" testID="outreach-code-gone">
            {ASK_WORDS.codeGone}
          </Text>
        )}
        <AskLine asks={asks} ask={ask} actions={actions} named={!waiting} focusCode />
      </Card>
    );
  if (!asks && !error) return null;
  return (
    <Card className="gap-3 px-4 py-5">
      <Text className="text-[14.5px] leading-[21px] text-text-2" testID="outreach-code-none">
        {error ?? ASK_WORDS.codeNone}
      </Text>
      <Button variant="secondary" onPress={onOpenLive} testID="outreach-code-open-live">
        {ASK_WORDS.openLive}
      </Button>
    </Card>
  );
}
