import { IDEA_STATUS_WORDS, IDEAS_WORDS, votingOpenFor } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Check, ChevronDown } from '@/components/icons';
import { VoteButton } from '@/components/ideas/vote-button';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { ideaCommands, useIdeaAreas, useSimilarIdeas } from '@/ideas/use-ideas';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

/**
 * Sharing an idea from the phone, with the web's words. While somebody types a title, the ideas already on the board
 * that sound like it come up under it with a vote button, because a vote on the idea that exists counts for more than
 * a second copy of it. They can still share theirs: sometimes it only sounds the same.
 *
 * It goes straight out rather than into the queue of changes, as Get help does: an idea that sat on the phone until it
 * found a signal would miss the ideas it repeats, so the screen says plainly that it needs one.
 */
export default function ShareIdea() {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const areas = useIdeaAreas();
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [areaId, setAreaId] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const similar = useSimilarIdeas(title);
  const choosable = areas.filter((a) => !a.archived);
  const area = areas.find((a) => a.id === areaId) ?? null;

  const send = async () => {
    if (title.trim().length < 3) return setProblem(IDEAS_WORDS.needsTitle);
    if (!areaId) return setProblem(IDEAS_WORDS.needsArea);
    if (!online) return setProblem(IDEAS_WORDS.needsSignal);
    setProblem(null);
    setBusy(true);
    try {
      const out = await ideaCommands.share({
        workspaceId: business.id,
        title: title.trim(),
        body: body.trim(),
        areaId,
      });
      toast.show(IDEAS_WORDS.shared(out.number));
      // The form closes and the idea opens over the board, so Back from it goes to the board, not the form.
      if (router.canGoBack()) router.back();
      router.push(businessHref(business.id, `ideas/${out.ideaId}`) as Href);
    } catch (e) {
      setProblem(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Screen
      title={IDEAS_WORDS.share}
      leading="back"
      back={businessHref(business.id, 'ideas')}
      testID="share-idea-screen"
    >
      <Card className="gap-4 px-3.5 py-4">
        <Text className="text-[13px] leading-5 text-text-2">{IDEAS_WORDS.shareIntro}</Text>
        <View className="gap-1.5">
          <Label>{IDEAS_WORDS.titleLabel}</Label>
          <Input
            value={title}
            onChangeText={setTitle}
            placeholder={IDEAS_WORDS.titlePlaceholder}
            maxLength={140}
            autoCorrect
            testID="idea-title"
          />
        </View>

        {similar.length ? (
          <View
            className="gap-2 rounded-card border border-border bg-card-2 p-3"
            testID="idea-similar"
          >
            <Text className="text-[13px] font-medium">{IDEAS_WORDS.similar}</Text>
            {similar.map((s) => (
              <View key={s.id} className="flex-row items-center gap-3">
                <VoteButton
                  ideaId={s.id}
                  voted={s.voted}
                  count={s.voteCount}
                  open={votingOpenFor(s.status)}
                />
                <Pressable
                  role="link"
                  className="min-w-0 flex-1 active:opacity-70"
                  onPress={() => router.push(businessHref(business.id, `ideas/${s.id}`) as Href)}
                >
                  <Text className="text-sm font-medium" numberOfLines={2}>
                    {s.title}
                  </Text>
                  <Text className="text-xs text-text-3">
                    {`#${s.number} · ${IDEA_STATUS_WORDS[s.status]}`}
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View className="gap-1.5">
          <Label>{IDEAS_WORDS.bodyLabel}</Label>
          <TextInput
            value={body}
            onChangeText={setBody}
            multiline
            numberOfLines={6}
            maxLength={5000}
            textAlignVertical="top"
            accessibilityLabel={IDEAS_WORDS.bodyLabel}
            className="min-h-[120px] rounded-menu border border-border-strong bg-card p-3 font-sans text-base text-text"
            testID="idea-body"
          />
          <Text className="text-[12.5px] text-text-3">{IDEAS_WORDS.bodyHint}</Text>
        </View>

        <View className="gap-1.5">
          <Label>{IDEAS_WORDS.areaLabel}</Label>
          <Pressable
            role="button"
            accessibilityLabel={`${IDEAS_WORDS.areaLabel} ${area?.name ?? IDEAS_WORDS.pickArea}`}
            onPress={() => setPicking(true)}
            className="h-12 flex-row items-center rounded-menu border border-border-strong bg-card px-3.5 active:bg-card-2"
            testID="idea-area"
          >
            <Text className={cn('flex-1 text-base', !area && 'text-text-3')} numberOfLines={1}>
              {area?.name ?? IDEAS_WORDS.pickArea}
            </Text>
            <Icon as={ChevronDown} className="size-4 text-text-3" />
          </Pressable>
        </View>

        {problem ? <FieldError testID="idea-problem">{problem}</FieldError> : null}
        <Button onPress={() => void send()} loading={busy} testID="idea-submit">
          {IDEAS_WORDS.shareButton}
        </Button>
      </Card>

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title={IDEAS_WORDS.areaLabel}
        scroll
        testID="idea-area-sheet"
      >
        <View className="gap-1">
          {choosable.map((a) => {
            const chosen = a.id === areaId;
            return (
              <Pressable
                key={a.id}
                role="radio"
                accessibilityState={{ checked: chosen }}
                onPress={() => {
                  setAreaId(a.id);
                  setPicking(false);
                }}
                testID={`idea-area-${a.id}`}
                className={cn(
                  'min-h-12 flex-row items-center gap-3 rounded-control px-3 py-2 active:bg-card-2',
                  chosen && 'bg-accent-soft',
                )}
              >
                <View className="min-w-0 flex-1">
                  <Text className={cn('text-[15px]', chosen && 'font-medium text-accent-text')}>
                    {a.name}
                  </Text>
                  {a.description ? (
                    <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
                      {a.description}
                    </Text>
                  ) : null}
                </View>
                {chosen ? <Icon as={Check} className="size-4 text-accent-text" /> : null}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </Screen>
  );
}
