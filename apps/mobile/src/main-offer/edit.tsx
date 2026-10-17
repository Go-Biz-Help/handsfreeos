import {
  MAIN_OFFER_PHONE_WORDS as PW,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  OFFER_STEP_WORDS,
  partWords,
  SCORED_PARTS,
  withPart,
  type MainOfferParts,
  type ScoredPart,
} from '@hfos/core';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { TextArea } from '@/components/ai-setup/fields';
import { Sparkles } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useGrants } from '@/lib/grants';
import { useLiveAnswer } from '@/lib/live-answer';

import {
  draftMoved,
  MAIN_OFFER_MANAGE,
  mainOfferCalls,
  offerAiError,
  type MainOffer,
} from './calls';

/**
 * Edit it myself (design/main-offer, 14): one scored part's boxes, as the builder's step for it asks them, with the
 * AI's fix above. Saving keeps the draft (with none yet, the live version's parts with this change), so the score
 * clears until it's scored again. The method's steps are each a box; adding, taking out and moving a step stay on the
 * web (answered 1). It needs signal, as the Review does.
 */
export function EditPartScreen() {
  const { business } = useBusiness();
  const { permissions } = useGrants();
  const manages = permissions?.includes(MAIN_OFFER_MANAGE) ?? false;
  const { part: asked } = useLocalSearchParams<{ part?: string }>();
  const part = (SCORED_PARTS as readonly string[]).includes(asked ?? '')
    ? (asked as ScoredPart)
    : null;
  const answer = useLiveAnswer(
    part && manages ? () => mainOfferCalls(business.id).get() : null,
    `${business.id}:${part}`,
    PW.needsSignal,
  );
  const offer = answer.data;
  const base = offer?.draft?.parts ?? offer?.live?.parts ?? null;
  const back = businessHref(business.id, 'settings/main-offer');

  return (
    <Screen
      title={part ? OFFER_STEP_WORDS[part].title : W.title}
      subtitle={W.title}
      leading="back"
      back={back}
      scroll={false}
      testID="main-offer-part"
    >
      {!part || !manages ? (
        <Card className="m-4 px-4 py-4">
          <Text className="leading-[22px] text-text-2">{W.askOwner}</Text>
        </Card>
      ) : !offer ? (
        answer.error ? (
          <Card className="m-4 gap-3 px-4 py-4" testID="main-offer-part-trouble">
            <Text className="leading-[22px] text-text-2">{answer.error}</Text>
            <Button variant="secondary" onPress={answer.reload}>
              {PW.tryAgain}
            </Button>
          </Card>
        ) : (
          <View className="items-center py-10">
            <ActivityIndicator />
          </View>
        )
      ) : !base ? (
        <Card className="m-4 px-4 py-4">
          <Text className="leading-[22px] text-text-2">{PW.buildHint}</Text>
        </Card>
      ) : (
        <EditPart
          workspaceId={business.id}
          part={part}
          offer={offer}
          base={base}
          onMoved={answer.reload}
        />
      )}
    </Screen>
  );
}

function EditPart({
  workspaceId,
  part,
  offer,
  base,
  onMoved,
}: {
  workspaceId: string;
  part: ScoredPart;
  offer: MainOffer;
  base: MainOfferParts;
  onMoved: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const step = OFFER_STEP_WORDS[part];
  const boxes = step.boxes.filter((b) => !b.path.startsWith('niche.'));
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(boxes.map((b) => [b.path, partWords(base, b.path)])),
  );
  const [steps, setSteps] = React.useState<string[]>(() => [...(base.method.steps ?? [])]);
  const [busy, setBusy] = React.useState(false);
  // The AI's fix for this part, from the draft's score, or the live version's while there's no draft.
  const score = offer.draft ? offer.draft.score : (offer.live?.score ?? null);
  const fix = score?.parts[part].fix;

  async function save() {
    let next = boxes.reduce((p, b) => withPart(p, b.path, values[b.path] ?? ''), base);
    if (part === 'method') next = { ...next, method: { ...next.method, steps } };
    setBusy(true);
    try {
      await mainOfferCalls(workspaceId).saveDraft(offer.revision, next);
      router.back();
    } catch (e) {
      toast.error(offerAiError(e));
      if (draftMoved(e)) onMoved();
      setBusy(false);
    }
  }

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3.5 p-4 pb-8"
        contentContainerStyle={keyboard ? { paddingBottom: keyboard + 32 } : undefined}
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-[13.5px] leading-[19px] text-text-2">{step.hint}</Text>
        {fix ? (
          <View className="flex-row items-start gap-2 rounded-menu bg-warning-soft px-3.5 py-3">
            <Icon as={Sparkles} className="mt-0.5 size-4 text-warning-text" />
            <Text className="flex-1 text-[14px] leading-[20px] text-warning-text">
              <Text className="text-[14px] font-semibold text-warning-text">{TW.aiFix}</Text> {fix}
            </Text>
          </View>
        ) : null}
        {part === 'method' ? (
          <View className="gap-2.5">
            <Text className="text-[14px] font-medium">{W.steps}</Text>
            {steps.map((words, i) => (
              <View key={i} className="gap-1.5">
                <Text className="text-[13px] text-text-2" nativeID={`offer-step-${i}`}>
                  {W.stepLabel(i + 1)}
                </Text>
                <Input
                  value={words}
                  onChangeText={(t) => setSteps((s) => s.map((x, j) => (j === i ? t : x)))}
                  accessibilityLabelledBy={`offer-step-${i}`}
                  testID={`main-offer-part-step-${i}`}
                />
              </View>
            ))}
            <Text className="text-[12.5px] text-text-3">{PW.stepsOnWeb}</Text>
          </View>
        ) : null}
        {boxes.map((b) => {
          const id = `offer-box-${b.path}`;
          const props = {
            value: values[b.path] ?? '',
            onChangeText: (t: string) => setValues((v) => ({ ...v, [b.path]: t })),
            placeholder: b.placeholder,
            accessibilityLabelledBy: id,
            testID: `main-offer-box-${b.path}`,
          };
          return (
            <View key={b.path} className="gap-1.5">
              <Text className="text-[14px] font-medium" nativeID={id}>
                {b.label}
              </Text>
              {b.long ? <TextArea {...props} /> : <Input {...props} />}
              {b.hint ? <Text className="text-[12.5px] text-text-3">{b.hint}</Text> : null}
            </View>
          );
        })}
        <Text className="text-[12.5px] text-text-3">{PW.saveNote}</Text>
      </ScrollView>
      <View className="border-t border-border bg-card px-4 py-2.5">
        <Button loading={busy} onPress={() => void save()} testID="main-offer-part-save">
          {PW.save}
        </Button>
      </View>
    </View>
  );
}
