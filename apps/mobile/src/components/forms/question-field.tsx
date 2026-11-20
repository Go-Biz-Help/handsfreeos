import {
  isSingleCheckbox,
  MAX_QUANTITY,
  money,
  quantityRowsOf,
  quantityTotal,
  quantityTotalWords,
  quantityWorthCents,
  rowPriceCents,
  type AnswerValue,
  type Question,
} from '@hfos/core';
import { Minus, Plus } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * One question, on a phone (M17).
 *
 * The web has its own renderer and this is not it — a phone wants a 48-point tap target and a keyboard that
 * matches the answer, not a copy of a mouse-shaped control. What the two **do** share is the engine: which
 * questions show, whether an answer will do and what the numbers come to are all core's, so this file only
 * ever decides how a question looks.
 *
 * The kinds that need something a phone has and this screen does not — a file, a signature, a card — are not
 * handled here at all; the screen refuses the whole form before it gets this far, because four questions
 * rendered and a fifth silently dropped is worse than an honest "open this one on the web".
 */
export function QuestionField({
  question,
  value,
  onChange,
  problem,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  /** Shown once they have tried to send; core's words, not ours. */
  problem: string | null;
}) {
  const config = question.config as Record<string, unknown>;
  const choices = Array.isArray(config['choices'])
    ? (config['choices'] as { id?: string; label?: string }[])
    : [];

  if (question.type === 'content')
    return (
      <View className="gap-1 py-2">
        {question.title ? <Text className="text-base font-semibold">{question.title}</Text> : null}
        {question.help ? <Text className="text-[13px] text-text-2">{question.help}</Text> : null}
      </View>
    );

  if (isSingleCheckbox(question)) {
    // One box to check: the question is the words beside it. Checked is a yes; unchecked is no answer at all.
    const checked = value === true || value === 'yes';
    return (
      <View className="gap-1.5 py-2" testID={`question-${question.id}`}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={question.title}
          onPress={() => onChange(checked ? null : 'yes')}
          className={cn(
            'min-h-12 flex-row items-center gap-2.5 rounded-menu border px-3',
            checked ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
          )}
          testID={`checkbox-${question.id}`}
        >
          <View
            className={cn(
              'h-[18px] w-[18px] items-center justify-center rounded-[5px] border',
              checked ? 'border-accent bg-accent' : 'border-border-strong',
            )}
          />
          <Text className="flex-1 text-[15px] font-medium">
            {question.title}
            {question.required ? <Text className="text-danger-text"> *</Text> : null}
          </Text>
        </Pressable>
        {question.help ? <Text className="text-[13px] text-text-3">{question.help}</Text> : null}
        {problem ? (
          <Text className="text-[12.5px] text-danger-text" testID={`problem-${question.id}`}>
            {problem}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className="gap-1.5 py-2" testID={`question-${question.id}`}>
      <Text className="text-[15px] font-medium">
        {question.title}
        {question.required ? <Text className="text-danger-text"> *</Text> : null}
      </Text>
      {question.help ? <Text className="text-[13px] text-text-3">{question.help}</Text> : null}

      {question.type === 'quantities' ? (
        <Quantities question={question} value={value} onChange={onChange} />
      ) : question.type === 'yes_no' ? (
        <View className="flex-row items-center gap-3 py-1">
          <Switch
            label={question.title}
            checked={value === true}
            onCheckedChange={(next: boolean) => onChange(next)}
          />
          <Text className="text-[13px] text-text-2">{value === true ? 'Yes' : 'No'}</Text>
        </View>
      ) : question.type === 'choice' || question.type === 'checkboxes' ? (
        <View className="gap-1.5">
          {choices.map((choice, i) => {
            const id = String(choice.id ?? i);
            const picked =
              question.type === 'choice'
                ? value === id
                : Array.isArray(value) && (value as string[]).includes(id);
            return (
              <Pressable
                key={id}
                accessibilityRole={question.type === 'choice' ? 'radio' : 'checkbox'}
                accessibilityState={{ checked: picked }}
                onPress={() => {
                  if (question.type === 'choice') {
                    onChange(picked ? null : id);
                    return;
                  }
                  const was = Array.isArray(value) ? (value as string[]) : [];
                  onChange(picked ? was.filter((x) => x !== id) : [...was, id]);
                }}
                className={cn(
                  'min-h-12 flex-row items-center gap-2.5 rounded-menu border px-3',
                  picked ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
                )}
                testID={`choice-${question.id}-${id}`}
              >
                <View
                  className={cn(
                    'h-[18px] w-[18px] items-center justify-center border',
                    question.type === 'choice' ? 'rounded-full' : 'rounded-[5px]',
                    picked ? 'border-accent bg-accent' : 'border-border-strong',
                  )}
                />
                <Text className="flex-1 text-[15px]">{String(choice.label ?? id)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Input
          value={value === null || value === undefined ? '' : String(value)}
          invalid={!!problem}
          multiline={question.type === 'long_text'}
          className={question.type === 'long_text' ? 'h-28 items-start py-2' : undefined}
          keyboardType={KEYBOARD[question.type] ?? 'default'}
          autoCapitalize={question.type === 'email' ? 'none' : 'sentences'}
          placeholder={
            typeof config['placeholder'] === 'string' ? config['placeholder'] : undefined
          }
          onChangeText={(text) => {
            // Numbers come back as numbers, so core's checks and the form's sums see what they expect; the
            // half-typed states ('', '-', '1.') stay strings until they mean something.
            if (NUMERIC.has(question.type)) {
              const trimmed = text.trim();
              const parsed = Number(trimmed);
              onChange(trimmed === '' ? null : Number.isFinite(parsed) ? parsed : text);
              return;
            }
            onChange(text);
          }}
          testID={`answer-${question.id}`}
        />
      )}

      {problem ? (
        <Text className="text-[12.5px] text-danger-text" testID={`problem-${question.id}`}>
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * How many of each (core's forms/quantities.ts): a row per size, flavour or product with a minus, the count and a
 * plus, big enough for a thumb at a craft fair's table, and the total under them. Only rows above 0 are kept, so
 * taking every row back to 0 is no answer again.
 */
function Quantities({
  question,
  value,
  onChange,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
}) {
  const config = question.config as { unit?: string; showPrices?: boolean };
  const showPrices = config.showPrices !== false;
  const counts: Record<string, number> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, number>) }
      : {};
  const set = (rowId: string, next: number) => {
    const out = { ...counts };
    if (!Number.isFinite(next) || next <= 0) delete out[rowId];
    else out[rowId] = Math.min(Math.floor(next), MAX_QUANTITY);
    onChange(Object.keys(out).length ? out : null);
  };
  const worth = showPrices ? quantityWorthCents(question, counts) : null;
  return (
    <View className="gap-1.5">
      {quantityRowsOf(question).map((row) => {
        const count = counts[row.id] ?? 0;
        const price = showPrices ? rowPriceCents(row) : null;
        return (
          <View
            key={row.id}
            className={cn(
              'min-h-12 flex-row items-center gap-2 rounded-menu border px-3 py-1.5',
              count > 0 ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
            )}
            testID={`quantity-${question.id}-${row.id}`}
          >
            <View className="flex-1">
              <Text className="text-[15px]">{row.label}</Text>
              {price !== null ? (
                <Text className="text-[12px] text-text-3">{money(price)} each</Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`One fewer ${row.label}`}
              disabled={count <= 0}
              onPress={() => set(row.id, count - 1)}
              className={cn(
                'h-10 w-10 items-center justify-center rounded-menu border border-border-strong',
                count <= 0 && 'opacity-40',
              )}
            >
              <Icon as={Minus} className="size-4 text-text-2" />
            </Pressable>
            <Input
              value={count > 0 ? String(count) : ''}
              placeholder="0"
              keyboardType="number-pad"
              textAlign="center"
              accessibilityLabel={`How many ${row.label}`}
              className="h-10 w-14 px-1"
              onChangeText={(text) => set(row.id, text.trim() === '' ? 0 : Number(text))}
              testID={`quantity-input-${question.id}-${row.id}`}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`One more ${row.label}`}
              disabled={count >= MAX_QUANTITY}
              onPress={() => set(row.id, count + 1)}
              className="h-10 w-10 items-center justify-center rounded-menu border border-border-strong"
            >
              <Icon as={Plus} className="size-4 text-text-2" />
            </Pressable>
          </View>
        );
      })}
      <View className="flex-row justify-between pt-0.5">
        <Text className="text-[13px] text-text-2">
          {quantityTotalWords(quantityTotal(counts), config.unit ?? '')}
        </Text>
        {worth !== null ? <Text className="text-[13px] font-medium">{money(worth)}</Text> : null}
      </View>
    </View>
  );
}

const NUMERIC = new Set<Question['type']>(['number', 'money', 'rating', 'scale']);

const KEYBOARD: Partial<
  Record<Question['type'], 'default' | 'numeric' | 'email-address' | 'phone-pad'>
> = {
  number: 'numeric',
  money: 'numeric',
  rating: 'numeric',
  scale: 'numeric',
  email: 'email-address',
  phone: 'phone-pad',
};
