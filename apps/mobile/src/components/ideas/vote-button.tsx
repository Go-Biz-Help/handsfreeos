import { IDEAS_WORDS } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronUp } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { ideaCommands } from '@/ideas/use-ideas';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * A vote for an idea, and taking it back, as the web's button does it: it changes on the press and puts itself right
 * if HandsFreeOS says otherwise, so a board of fifty ideas never waits on a round trip to show a vote. The vote is
 * given from the business the person has open. A closed idea (done, not planned, merged) shows its count and no
 * button. `onVoted` hands the answer to the screen, so the list it came from says the same.
 */
export function VoteButton({
  ideaId,
  voted,
  count,
  open = true,
  size = 'md',
  onVoted,
}: {
  ideaId: string;
  voted: boolean;
  count: number;
  open?: boolean;
  size?: 'md' | 'lg';
  onVoted?: (answer: { voted: boolean; voteCount: number }) => void;
}) {
  const { business } = useBusiness();
  const [mine, setMine] = React.useState(voted);
  const [shown, setShown] = React.useState(count);
  const [busy, setBusy] = React.useState(false);
  // A fresher answer from HandsFreeOS is the truth.
  React.useEffect(() => {
    setMine(voted);
    setShown(count);
  }, [voted, count]);

  const press = async () => {
    if (busy || !open) return;
    const next = !mine;
    setBusy(true);
    setMine(next);
    setShown((n) => Math.max(0, n + (next ? 1 : -1)));
    try {
      const answer = await ideaCommands.vote(ideaId, business.id, next);
      setMine(answer.voted);
      setShown(answer.voteCount);
      onVoted?.({ voted: answer.voted, voteCount: answer.voteCount });
    } catch (e) {
      setMine(!next);
      setShown((n) => Math.max(0, n + (next ? -1 : 1)));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const big = size === 'lg';
  const box = cn(
    'items-center justify-center rounded-control border',
    big ? 'h-16 w-14' : 'h-14 w-12',
  );
  if (!open)
    return (
      <View
        className={cn(box, 'border-border bg-card-2')}
        accessibilityLabel={`${IDEAS_WORDS.votes(shown)}. ${IDEAS_WORDS.votingClosed}`}
        testID="idea-votes"
      >
        <Icon as={ChevronUp} className="size-4 text-text-3" />
        <Text className="text-sm font-semibold text-text-2">{String(shown)}</Text>
      </View>
    );
  return (
    <Pressable
      role="button"
      onPress={() => void press()}
      accessibilityLabel={mine ? IDEAS_WORDS.unvote(shown) : IDEAS_WORDS.vote(shown)}
      accessibilityState={{ selected: mine, busy }}
      hitSlop={4}
      testID="idea-vote"
      className={cn(
        box,
        mine
          ? 'border-accent bg-accent-soft active:opacity-80'
          : 'border-border bg-card active:bg-card-2',
      )}
    >
      <Icon
        as={ChevronUp}
        className={cn('size-4', mine ? 'text-accent-text' : 'text-text')}
        strokeWidth={mine ? 2.25 : 1.75}
      />
      <Text
        className={cn(
          'font-semibold',
          big ? 'text-base' : 'text-sm',
          mine ? 'text-accent-text' : 'text-text',
        )}
        testID="idea-vote-count"
      >
        {String(shown)}
      </Text>
    </Pressable>
  );
}
