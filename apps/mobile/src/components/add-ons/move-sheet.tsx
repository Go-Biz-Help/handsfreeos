import {
  ADDON_MOVE_WORDS,
  addonAgreeWords,
  addonHoldsLines,
  addonOptionalLine,
  joinNames,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { SheetTile } from '@/components/changes/change-parts';
import { CircleAlert, CirclePause, Trash, Unplug } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import type { AddonImpact } from '@/add-ons/types';
import type { MoveFlow, MoveStep } from '@/add-ons/use-move';
import { ADDON_PHONE_WORDS } from '@/add-ons/words';
import { useColors } from '@/theme';

import { Note } from './addon-bits';

/**
 * The one sheet a move opens. Before turning an add-on off, uninstalling it or deleting its data it asks with core's
 * question and consequence, then says what `addon.impact` found, as the web's page does: HandsFreeOS's question about
 * the add-ons that need it (and a button that says it moves them too), what stops, the ones that do less without it,
 * and what it holds here. Deleting data asks for the add-on's name, typed, as deleting an account asks for the email
 * address. When HandsFreeOS asks about other add-ons after a move, its question goes here too, with a yes that sends
 * the move again. One sheet for all of them, because iOS shows only one at a time: a question that follows another
 * changes what this one says rather than opening a second.
 */
export function AddonMoveSheet({ flow }: { flow: MoveFlow }) {
  // The last question stays drawn while the sheet slides away.
  const last = React.useRef<Exclude<MoveStep, { kind: 'idle' }> | null>(null);
  if (flow.step.kind !== 'idle') last.current = flow.step;
  const step = last.current;
  return (
    <Sheet open={flow.step.kind !== 'idle'} onClose={flow.close} testID="addon-move-sheet">
      {step?.kind === 'confirm' ? (
        <Confirm flow={flow} step={step} />
      ) : step?.kind === 'question' ? (
        <Question flow={flow} step={step} />
      ) : null}
    </Sheet>
  );
}

const TILE: Readonly<
  Record<'disable' | 'uninstall' | 'purge', { icon: LucideIcon; tone: 'warning' | 'danger' }>
> = {
  disable: { icon: CirclePause, tone: 'warning' },
  uninstall: { icon: Unplug, tone: 'danger' },
  purge: { icon: Trash, tone: 'danger' },
};

function Confirm({ flow, step }: { flow: MoveFlow; step: Extract<MoveStep, { kind: 'confirm' }> }) {
  const keyboard = useKeyboardHeight();
  const words = ADDON_MOVE_WORDS[step.action];
  const name = step.view.name;
  const tile = TILE[step.action];
  const purge = step.action === 'purge';
  // The other add-ons it takes with it, which the button names ("Turn off both").
  const others = (flow.impact.data?.needsAgreement ?? []).map(flow.nameOf);
  return (
    <>
      <ScrollView
        className="max-h-[420px]"
        contentContainerClassName="gap-3.5"
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        <View className="flex-row items-start gap-3">
          <SheetTile icon={tile.icon} tone={tile.tone} />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text variant="sheetTitle" testID="addon-confirm-title">
              {words.confirm?.(name) ?? words.button}
            </Text>
            {words.consequence ? (
              <Text className="text-sm leading-5 text-text-2">{words.consequence}</Text>
            ) : null}
          </View>
        </View>
        <Impact flow={flow} action={step.action} />
      </ScrollView>
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-2 pt-4">
        {purge ? (
          <View className="mb-1 gap-1.5">
            <Label>{ADDON_PHONE_WORDS.typeName(name)}</Label>
            <Input
              value={flow.typed}
              onChangeText={flow.setTyped}
              placeholder={name}
              autoCapitalize="none"
              autoCorrect={false}
              invalid={flow.refusedName !== null}
              editable={!flow.sending}
              aria-label={ADDON_PHONE_WORDS.typeName(name)}
              testID="addon-confirm-name"
            />
            <FieldError testID="addon-confirm-name-refused">{flow.refusedName}</FieldError>
          </View>
        ) : null}
        <Button
          variant={step.action === 'disable' ? 'primary' : 'danger'}
          icon={purge ? Trash : undefined}
          loading={flow.sending}
          disabled={!flow.canConfirm}
          onPress={flow.confirm}
          testID="addon-confirm"
        >
          {others.length ? addonAgreeWords(step.action, others) : words.button}
        </Button>
        <Button variant="ghost" onPress={flow.close} testID="addon-confirm-cancel">
          {ADDON_PHONE_WORDS.cancel}
        </Button>
      </View>
    </>
  );
}

/** What the move would do, from `addon.impact`: asked each time the question opens. */
function Impact({ flow, action }: { flow: MoveFlow; action: 'disable' | 'uninstall' | 'purge' }) {
  const colors = useColors();
  const { data, error, loading, reload } = flow.impact;
  if (loading || (!data && !error))
    return (
      <View className="flex-row items-center gap-2 px-0.5" testID="addon-impact-loading">
        <ActivityIndicator size="small" color={colors.text3} />
        <Text className="text-[13px] text-text-3">{ADDON_PHONE_WORDS.checking}</Text>
      </View>
    );
  if (!data)
    return (
      <Note
        tone="danger"
        lines={[error ?? ADDON_PHONE_WORDS.needsSignal]}
        testID="addon-impact-error"
      >
        <Button
          variant="secondary"
          size="sm"
          className="mt-1.5 self-start"
          onPress={reload}
          testID="addon-impact-retry"
        >
          {ADDON_PHONE_WORDS.retry}
        </Button>
      </Note>
    );
  if (data.outcome === 'refused')
    return (
      <Note
        tone="danger"
        lines={[data.refusal?.message ?? ADDON_PHONE_WORDS.cantNow]}
        testID="addon-impact-refused"
      />
    );
  if (data.outcome === 'already')
    return <Note tone="info" lines={[ADDON_PHONE_WORDS.already]} testID="addon-impact-already" />;
  return <Plan impact={data} action={action} />;
}

function Plan({
  impact,
  action,
}: {
  impact: AddonImpact;
  action: 'disable' | 'uninstall' | 'purge';
}) {
  const stops = [...new Set(impact.capabilitiesLost.map((c) => c.label))];
  const lines = [
    stops.length ? `${ADDON_PHONE_WORDS.whatStops}: ${joinNames(stops)}.` : null,
    addonOptionalLine(impact.optionalFor.map((o) => o.name)),
  ].filter((line): line is string => line !== null);
  const holds = addonHoldsLines(action, impact.holds);
  return (
    <View className="gap-2.5" testID="addon-impact">
      {impact.question ? (
        <Note tone="warning" lines={[impact.question]} testID="addon-impact-question" />
      ) : null}
      {lines.length ? <Note tone="info" lines={lines} testID="addon-impact-lines" /> : null}
      {holds.length ? (
        <View className="gap-1" testID="addon-impact-holds">
          <Text className="px-0.5 text-[12px] font-medium text-text-3">
            {ADDON_PHONE_WORDS.whatItHolds}
          </Text>
          <Note tone="info" lines={holds} />
        </View>
      ) : null}
    </View>
  );
}

/** HandsFreeOS's own question about the other add-ons, and a yes that sends the move again with them. */
function Question({
  flow,
  step,
}: {
  flow: MoveFlow;
  step: Extract<MoveStep, { kind: 'question' }>;
}) {
  return (
    <>
      <View className="flex-row items-start gap-3">
        <SheetTile icon={CircleAlert} tone="accent" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="sheetTitle" testID="addon-question">
            {step.question.question}
          </Text>
        </View>
      </View>
      <View className="mt-4 gap-2">
        <Button
          loading={flow.sending}
          disabled={!flow.canConfirm}
          onPress={flow.confirm}
          testID="addon-question-yes"
        >
          {addonAgreeWords(
            step.action,
            step.include.filter((id) => id !== step.view.addonId).map(flow.nameOf),
          )}
        </Button>
        <Button variant="ghost" onPress={flow.close} testID="addon-question-cancel">
          {ADDON_PHONE_WORDS.cancel}
        </Button>
      </View>
    </>
  );
}
