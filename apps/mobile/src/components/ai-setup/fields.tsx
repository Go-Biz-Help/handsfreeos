import {
  AI_SETUP_FIELD_WORDS as W,
  AI_SETUP_MAX,
  AI_SETUP_QUESTION_KINDS,
  AI_SETUP_WORDS,
  aiSetupChoicesOf,
  aiSetupProblemAt,
  asksAboutWhoSomeoneIs,
  findIndustry,
  industryLabel,
  isAiSetupQuestionKind,
  newAiSetupQuestion,
  searchIndustries,
  withAiSetupQuestionKind,
  type AiSetupProblems,
  type AiSetupService,
  type AiSetupTopQuestion,
  type IndustryOption,
  type QualifyingQuestion,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import { AI_SETUP_PHONE_WORDS as P } from '@/ai-setup/words';
import { Check, ChevronDown, Plus, Search, Trash } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input, type InputProps } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The pieces quick setup's screens are made of on the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8),
 * as the web's components/ai-setup/fields.tsx draws them: big answers to tap, a website box, the kind of business
 * from a searchable list, and the lists people edit (services, top questions, qualifying questions). Every word is
 * core's (ai-setup/words.ts), but for what only a phone draws (./words.ts).
 */

/** A field's label, the field, then what's wrong with it or a hint. */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label?: string;
  error?: string | null;
  hint?: string | null;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-1.5">
      {label ? <Label>{label}</Label> : null}
      {children}
      {error ? (
        <FieldError>{error}</FieldError>
      ) : hint ? (
        <Text className="text-[13px] leading-[18px] text-text-3">{hint}</Text>
      ) : null}
    </View>
  );
}

/** Several lines of text. */
export function TextArea({ className, ...props }: InputProps) {
  return (
    <Input
      multiline
      textAlignVertical="top"
      className={cn('h-28 items-stretch', className)}
      style={{ paddingTop: 11, paddingBottom: 11 }}
      {...props}
    />
  );
}

/** A big pick-one card with a line under its title. */
export function Option({
  on,
  onSelect,
  title,
  description,
  badge,
  testID,
}: {
  on: boolean;
  onSelect: () => void;
  title: string;
  description?: string | null;
  badge?: React.ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      role="radio"
      aria-checked={on}
      accessibilityLabel={title}
      onPress={onSelect}
      testID={testID}
      className={cn(
        'flex-row items-start gap-3 rounded-menu border px-4 py-3.5',
        on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card active:bg-card-2',
      )}
    >
      <View
        className={cn(
          'mt-0.5 size-[18px] items-center justify-center rounded-full border-[1.5px]',
          on ? 'border-accent' : 'border-border-strong',
        )}
      >
        {on ? <View className="size-2.5 rounded-full bg-accent" /> : null}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-[15px] font-semibold">{title}</Text>
          {badge}
        </View>
        {description ? (
          <Text className="text-[13px] leading-[18px] text-text-2">{description}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A big tick-all-that-fit row. */
export function Tick({
  on,
  onToggle,
  title,
  description,
  testID,
}: {
  on: boolean;
  onToggle: () => void;
  title: string;
  description?: string | null;
  testID?: string;
}) {
  return (
    <Pressable
      role="checkbox"
      aria-checked={on}
      accessibilityLabel={title}
      onPress={onToggle}
      testID={testID}
      className={cn(
        'flex-row items-start gap-3 rounded-menu border px-4 py-3.5',
        on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card active:bg-card-2',
      )}
    >
      <View
        className={cn(
          'mt-0.5 size-[18px] items-center justify-center rounded-[5px] border-[1.5px]',
          on ? 'border-accent bg-accent' : 'border-border-strong bg-card',
        )}
      >
        {on ? <Icon as={Check} className="size-3 text-white" strokeWidth={3} /> : null}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-medium">{title}</Text>
        {description ? (
          <Text className="text-[13px] leading-[18px] text-text-2" numberOfLines={3}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A round answer to tap, for a row of them. */
function Pill({
  on,
  label,
  onPress,
  testID,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="radio"
      aria-checked={on}
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      className={cn(
        'h-11 min-w-[64px] flex-row items-center justify-center rounded-full border px-4',
        on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card active:bg-card-2',
      )}
    >
      <Text className={cn('text-[14px] font-medium', on ? 'text-accent-text' : 'text-text-2')}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A pick-one row of round answers. */
export function Pills<T extends string>({
  name,
  legend,
  options,
  labels,
  value,
  onChange,
}: {
  name: string;
  legend?: string;
  options: readonly T[];
  labels: Readonly<Record<T, string>>;
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <View className="gap-2">
      {legend ? <Label>{legend}</Label> : null}
      <View
        className="flex-row flex-wrap gap-2"
        role="radiogroup"
        accessibilityLabel={legend}
        testID={`ai-setup-${name}`}
      >
        {options.map((o) => (
          <Pill
            key={o}
            on={value === o}
            label={labels[o]}
            onPress={() => onChange(o)}
            testID={`ai-setup-${name}-${o}`}
          />
        ))}
      </View>
    </View>
  );
}

/** Yes, No, or skipped (no answer). */
export function YesNo({
  question,
  value,
  onChange,
  testID,
  note = null,
}: {
  question: string;
  value: 'yes' | 'no' | undefined;
  onChange: (value: 'yes' | 'no' | undefined) => void;
  testID: string;
  /** A small line under the question: where the answer came from. */
  note?: string | null;
}) {
  return (
    <View className="gap-2 border-b border-border py-3" testID={testID}>
      <View className="gap-0.5">
        <Text className="text-[15px] leading-[21px]">{question}</Text>
        {note ? (
          <Text className="text-[12.5px] text-text-3" testID={`${testID}-note`}>
            {note}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-2" role="radiogroup" accessibilityLabel={question}>
        <Pill
          on={value === 'yes'}
          label={W.yes}
          onPress={() => onChange('yes')}
          testID={`${testID}-yes`}
        />
        <Pill
          on={value === 'no'}
          label={W.no}
          onPress={() => onChange('no')}
          testID={`${testID}-no`}
        />
        <Pressable
          role="button"
          aria-pressed={value === undefined}
          onPress={() => onChange(undefined)}
          testID={`${testID}-skip`}
          className="h-11 justify-center rounded-full px-3 active:bg-card-2"
        >
          <Text
            className={cn(
              'text-[13.5px] text-text-3',
              value === undefined && 'font-medium text-text-2 underline',
            )}
          >
            {AI_SETUP_WORDS.skip}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The business's website, or "We don’t have one". */
export function WebsiteField({
  value,
  noSite,
  onChange,
  onNoSite,
  hint,
  error,
}: {
  value: string;
  noSite: boolean;
  onChange: (value: string) => void;
  onNoSite: (noSite: boolean) => void;
  hint: string;
  error?: string;
}) {
  return (
    <Field label={W.website} error={error} hint={hint}>
      <Input
        value={value}
        onChangeText={onChange}
        editable={!noSite}
        placeholder="yourbusiness.com"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="url"
        textContentType="URL"
        invalid={!!error}
        accessibilityLabel={W.website}
        testID="ai-setup-website-input"
      />
      <Button
        variant={noSite ? 'secondary' : 'ghost'}
        size="md"
        className={cn('self-start', noSite && 'border-accent bg-accent-soft')}
        aria-pressed={noSite}
        onPress={() => onNoSite(!noSite)}
        testID="ai-setup-no-website"
      >
        {AI_SETUP_WORDS.noWebsite}
      </Button>
    </Field>
  );
}

/** A small button that takes a row out of a list. */
function Remove({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      hitSlop={4}
      className="size-11 items-center justify-center rounded-full active:bg-card-2"
    >
      <Icon as={Trash} className="size-[18px] text-text-3" />
    </Pressable>
  );
}

/** "Add a service", "Add a question". */
function AddRow({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Button
      variant="ghost"
      size="md"
      icon={Plus}
      className="self-start"
      onPress={onPress}
      testID={testID}
    >
      {label}
    </Button>
  );
}

export function ServicesField({
  services,
  onChange,
  problems,
}: {
  services: readonly AiSetupService[];
  onChange: (next: AiSetupService[]) => void;
  problems: AiSetupProblems;
}) {
  const set = (i: number, patch: Partial<AiSetupService>) =>
    onChange(services.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <View className="gap-2" testID="ai-setup-services">
      <Label>{W.services}</Label>
      {services.map((s, i) => (
        <View
          key={i}
          className="flex-row items-start gap-1 rounded-menu bg-card-2 p-2.5"
          testID={`ai-setup-service-${i}`}
        >
          <View className="min-w-0 flex-1 gap-2">
            <Input
              value={s.name}
              onChangeText={(name) => set(i, { name })}
              placeholder={W.serviceName}
              accessibilityLabel={W.serviceName}
              maxLength={120}
              invalid={!!problems[`services.${i}.name`]}
              testID={`ai-setup-service-${i}-name`}
            />
            <FieldError>{problems[`services.${i}.name`]}</FieldError>
            <Input
              value={s.description}
              onChangeText={(description) => set(i, { description })}
              placeholder={W.serviceDescription}
              accessibilityLabel={W.serviceDescription}
              maxLength={500}
              testID={`ai-setup-service-${i}-description`}
            />
          </View>
          <Remove
            label={W.removeService}
            onPress={() => onChange(services.filter((_, j) => j !== i))}
            testID={`ai-setup-service-${i}-remove`}
          />
        </View>
      ))}
      {services.length < AI_SETUP_MAX.services ? (
        <AddRow
          label={W.addService}
          onPress={() => onChange([...services, { name: '', description: '' }])}
          testID="ai-setup-add-service"
        />
      ) : null}
      <FieldError>{problems['services']}</FieldError>
    </View>
  );
}

export function TopQuestionsField({
  value,
  onChange,
  problems,
}: {
  value: readonly AiSetupTopQuestion[];
  onChange: (next: AiSetupTopQuestion[]) => void;
  problems: AiSetupProblems;
}) {
  const set = (i: number, patch: Partial<AiSetupTopQuestion>) =>
    onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <View className="gap-2" testID="ai-setup-top-questions">
      <View className="gap-0.5">
        <Label>{AI_SETUP_WORDS.topQuestions}</Label>
        <Text className="text-[13px] text-text-3">{AI_SETUP_WORDS.topQuestionsHint}</Text>
      </View>
      {value.map((q, i) => (
        <View key={i} className="flex-row items-start gap-1 rounded-menu bg-card-2 p-2.5">
          <View className="min-w-0 flex-1 gap-2">
            <Input
              value={q.question}
              onChangeText={(question) => set(i, { question })}
              placeholder={W.question}
              accessibilityLabel={W.question}
              maxLength={300}
              invalid={!!problems[`topQuestions.${i}.question`]}
              testID={`ai-setup-top-${i}-question`}
            />
            <FieldError>{problems[`topQuestions.${i}.question`]}</FieldError>
            <TextArea
              value={q.answer}
              onChangeText={(answer) => set(i, { answer })}
              placeholder={W.answer}
              accessibilityLabel={W.answer}
              maxLength={5000}
              className="h-24"
              invalid={!!problems[`topQuestions.${i}.answer`]}
              testID={`ai-setup-top-${i}-answer`}
            />
            <FieldError>{problems[`topQuestions.${i}.answer`]}</FieldError>
          </View>
          <Remove
            label={W.removeQuestion}
            onPress={() => onChange(value.filter((_, j) => j !== i))}
            testID={`ai-setup-top-${i}-remove`}
          />
        </View>
      ))}
      {value.length < AI_SETUP_MAX.topQuestions ? (
        <AddRow
          label={W.addQuestion}
          onPress={() => onChange([...value, { question: '', answer: '' }])}
          testID="ai-setup-add-top-question"
        />
      ) : null}
    </View>
  );
}

/**
 * A choice question's choices, typed with commas between them. The words stay as typed while someone types (a
 * trailing comma included); the choices go up with every change, so Next never misses the last one.
 */
function ChoicesInput({
  options,
  onChange,
  testID,
}: {
  options: readonly string[];
  onChange: (options: string[]) => void;
  testID: string;
}) {
  const [text, setText] = React.useState(() => options.join(', '));
  return (
    <Input
      value={text}
      onChangeText={(t) => {
        setText(t);
        onChange(aiSetupChoicesOf(t));
      }}
      placeholder={W.qualifyChoices}
      accessibilityLabel={W.qualifyChoices}
      testID={testID}
    />
  );
}

export function QualifyField({
  questions,
  industry,
  onChange,
  problems,
}: {
  questions: readonly QualifyingQuestion[];
  /** The business's industry: a school may ask about the child it teaches. */
  industry: string | null;
  onChange: (next: QualifyingQuestion[]) => void;
  problems: AiSetupProblems;
}) {
  const set = (i: number, next: QualifyingQuestion) =>
    onChange(questions.map((q, j) => (j === i ? next : q)));
  return (
    <View className="gap-3" testID="ai-setup-qualify">
      {questions.map((q, i) => {
        const problem = aiSetupProblemAt(problems, `questions.${i}`);
        return (
          <View
            key={q.id}
            className="flex-row items-start gap-1 rounded-menu border border-border p-3"
            testID={`ai-setup-qualify-${i}`}
          >
            <Text className="mt-3.5 w-5 text-center text-[13px] font-semibold text-text-3">
              {i + 1}
            </Text>
            <View className="min-w-0 flex-1 gap-2.5">
              <Input
                value={q.question}
                onChangeText={(question) => set(i, { ...q, question })}
                accessibilityLabel={`${W.question} ${i + 1}`}
                maxLength={200}
                invalid={!!problem}
                testID={`ai-setup-qualify-${i}-question`}
              />
              {asksAboutWhoSomeoneIs([q.question, ...q.options].join(' '), industry) ? (
                <FieldError testID={`ai-setup-qualify-${i}-protected`}>
                  {W.qualifyProtected}
                </FieldError>
              ) : null}
              {isAiSetupQuestionKind(q.kind) ? (
                <Pills
                  name={`qualify-${i}-kind`}
                  legend={W.qualifyAnswer}
                  options={AI_SETUP_QUESTION_KINDS}
                  labels={W.qualifyKinds}
                  value={q.kind}
                  onChange={(kind) => set(i, withAiSetupQuestionKind(q, kind))}
                />
              ) : (
                <Text className="text-[13px] text-text-2">
                  {W.qualifyAnswer}: <Text className="text-[13px] font-medium">{q.kind}</Text>
                </Text>
              )}
              {q.kind === 'choice' ? (
                <ChoicesInput
                  options={q.options}
                  onChange={(options) => set(i, { ...q, options })}
                  testID={`ai-setup-qualify-${i}-choices`}
                />
              ) : null}
              <FieldError>{problem}</FieldError>
            </View>
            <Remove
              label={W.removeQuestion}
              onPress={() => onChange(questions.filter((_, j) => j !== i))}
              testID={`ai-setup-qualify-${i}-remove`}
            />
          </View>
        );
      })}
      {questions.length < AI_SETUP_MAX.questions ? (
        <AddRow
          label={W.addQuestion}
          onPress={() => onChange([...questions, newAiSetupQuestion(questions)])}
          testID="ai-setup-add-qualify"
        />
      ) : null}
      <FieldError>{problems['questions']}</FieldError>
    </View>
  );
}

const OTHER = findIndustry('other');

/**
 * The kind of business, picked from core's list (industries.ts) on a sheet: the whole list under its groups, or
 * what fits the words typed ("plumber", "dog", "AC repair"), with Other always last.
 */
export function KindField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (industry: string) => void;
  error?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const label = value ? industryLabel(value) : '';
  return (
    <Field label={W.kind} error={error} hint={W.kindHint}>
      <Pressable
        role="button"
        accessibilityLabel={`${W.kind}: ${label || P.pickKind}`}
        onPress={() => setOpen(true)}
        testID="ai-setup-kind"
        className={cn(
          'h-12 flex-row items-center gap-2 rounded-menu border bg-card px-3.5 active:bg-card-2',
          error ? 'border-danger' : 'border-border-strong',
        )}
      >
        <Text className={cn('min-w-0 flex-1 text-base', !label && 'text-text-3')} numberOfLines={1}>
          {label || P.pickKind}
        </Text>
        <Icon as={ChevronDown} className="size-4 text-text-3" />
      </Pressable>
      <KindSheet
        open={open}
        value={value}
        onClose={() => setOpen(false)}
        onPick={(id) => {
          onChange(id);
          setOpen(false);
        }}
      />
    </Field>
  );
}

function KindSheet({
  open,
  value,
  onClose,
  onPick,
}: {
  open: boolean;
  value: string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  const typed = query.trim().length > 0;
  const options = React.useMemo<IndustryOption[]>(() => {
    const found = searchIndustries(query);
    return typed && OTHER ? [...found, OTHER] : found;
  }, [query, typed]);
  const nothingFits = typed && options.length <= 1;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onClosed={() => setQuery('')}
      title={P.pickKind}
      testID="ai-setup-kind-sheet"
    >
      <View className="mt-3 gap-2" style={keyboard ? { paddingBottom: keyboard } : undefined}>
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder={P.searchKinds}
          accessibilityLabel={P.searchKinds}
          autoCorrect={false}
          returnKeyType="search"
          trailing={<Icon as={Search} className="mr-3 size-4 text-text-3" />}
          testID="ai-setup-kind-search"
        />
        {nothingFits ? (
          <Text className="px-1 text-[13px] leading-[18px] text-text-3">{P.noKindFits}</Text>
        ) : null}
        <ScrollView
          style={{ maxHeight: Math.max(200, height * 0.6 - keyboard) }}
          keyboardShouldPersistTaps="handled"
          testID="ai-setup-kind-list"
        >
          {options.map((option, i) => {
            const heading = !typed && option.group !== options[i - 1]?.group ? option.group : null;
            const on = option.id === value;
            return (
              <React.Fragment key={option.id}>
                {heading ? (
                  <Text variant="group" className="px-1 pb-1 pt-3">
                    {heading}
                  </Text>
                ) : null}
                <Pressable
                  role="radio"
                  aria-checked={on}
                  accessibilityLabel={option.label}
                  onPress={() => onPick(option.id)}
                  testID={`ai-setup-kind-${option.id}`}
                  className={cn(
                    'min-h-11 flex-row items-center gap-2 rounded-control px-2.5 py-2.5 active:bg-card-2',
                    on && 'bg-accent-soft',
                  )}
                >
                  <Text
                    className={cn(
                      'min-w-0 flex-1 text-[15px]',
                      on && 'font-medium text-accent-text',
                    )}
                  >
                    {option.label}
                  </Text>
                  {on ? <Icon as={Check} className="size-4 text-accent-text" /> : null}
                </Pressable>
              </React.Fragment>
            );
          })}
        </ScrollView>
      </View>
    </Sheet>
  );
}
