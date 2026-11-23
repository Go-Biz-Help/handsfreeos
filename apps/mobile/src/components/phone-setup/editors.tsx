import {
  PHONE_SETUP_GREETING_MAX,
  PHONE_SETUP_MAX_PHONES,
  PHONE_SETUP_RING_SECONDS,
  PHONE_SETUP_WORDS as W,
  phoneSetupClock,
  phoneSetupDefaultGreeting,
  type PhoneSetupAnswers,
  type PhoneSetupContext,
  type PhoneSetupTeammateMode,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChoiceField, TextArea, Tick } from '@/components/ai-setup/fields';
import { ChoiceTile, Choices, GuidedNote } from '@/components/guided-setup/frame';
import { Globe, Phone, Plus, Trash } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { PHONE_SETUP_PHONE_WORDS as PW } from '@/phone-setup/words';

/**
 * The phone number setup's three questions about what the number does, on the phone, as the web's
 * phone-setup/editors.tsx: what rings, what happens when nobody picks up, and quiet hours. Same words, same answers.
 * Settings → Texting & calls (where the web opens them again behind Change) stays on the web.
 */
export interface PhoneEditorProps {
  readonly answers: PhoneSetupAnswers;
  readonly set: (patch: Partial<PhoneSetupAnswers>) => void;
  /** What stopped Next, by the answer it is about (phoneSetupProblems). */
  readonly problems: Readonly<Record<string, string>>;
  readonly ctx: PhoneSetupContext;
}

/** A few short choices in a row, one picked. */
function Pills<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testID,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (v: T) => void;
  testID: string;
}) {
  return (
    <View role="radiogroup" accessibilityLabel={label} className="flex-row flex-wrap gap-2">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            role="radio"
            aria-checked={on}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            testID={`${testID}-${o.value}`}
            className={cn(
              'h-10 flex-row items-center justify-center rounded-full border px-3.5',
              on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card active:bg-card-2',
            )}
          >
            <Text
              className={cn('text-[13.5px] font-medium', on ? 'text-accent-text' : 'text-text')}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** What rings when a customer calls: HandsFreeOS always, and up to three cell or desk phones beside it. */
export function RingEditor({ answers: a, set, problems, ctx }: PhoneEditorProps) {
  const phones = a.phones;
  // Ticking "a phone too" opens its first row, so there is somewhere to type straight away.
  React.useEffect(() => {
    if (a.morePhones && phones.length === 0)
      set({ phones: [{ label: '', number: '', enabled: true }] });
  }, [a.morePhones, phones.length]);
  const change = (i: number, patch: Partial<(typeof phones)[number]>) =>
    set({ phones: phones.map((p, at) => (at === i ? { ...p, ...patch } : p)) });

  return (
    <View className="gap-2.5" testID="ring-editor">
      <View className="flex-row items-start gap-3 rounded-menu border border-border bg-card px-4 py-3.5">
        <View className="size-8 items-center justify-center rounded-full bg-card-2">
          <Icon as={Globe} className="size-4 text-text-2" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-[15px] font-semibold">{W.ring.app}</Text>
            <Badge variant="gray">{W.ring.appAlways}</Badge>
          </View>
          <Text className="text-[13px] leading-[18px] text-text-2">{W.ring.appHint}</Text>
        </View>
      </View>

      <Tick
        on={a.morePhones}
        onToggle={() => set({ morePhones: !a.morePhones })}
        title={W.ring.more}
        description={W.ring.moreHint}
        testID="phone-more"
      />
      {a.morePhones ? (
        <View className="gap-4 rounded-menu border border-border bg-card px-4 py-4">
          {phones.map((p, i) => {
            const labelError = problems[`phones.${i}.label`];
            const numberError = problems[`phones.${i}.number`];
            return (
              <View
                key={i}
                role="group"
                accessibilityLabel={p.label.trim() || `Phone ${i + 1}`}
                className={cn('gap-2', i > 0 && 'border-t border-border pt-4')}
              >
                <View className="gap-1.5">
                  <Label>{W.ring.whose}</Label>
                  <Input
                    value={p.label}
                    maxLength={40}
                    placeholder={W.ring.whosePlaceholder}
                    invalid={!!labelError}
                    onChangeText={(v) => change(i, { label: v })}
                    accessibilityLabel={W.ring.whose}
                    testID={`phone-label-${i}`}
                  />
                  <FieldError>{labelError}</FieldError>
                </View>
                <View className="gap-1.5">
                  <Label>{W.ring.its}</Label>
                  <View className="flex-row items-center gap-2">
                    <View className="min-w-0 flex-1">
                      <Input
                        value={p.number}
                        maxLength={40}
                        keyboardType="phone-pad"
                        autoComplete="off"
                        placeholder="(256) 555-0117"
                        invalid={!!numberError}
                        onChangeText={(v) => change(i, { number: v })}
                        accessibilityLabel={W.ring.its}
                        testID={`phone-number-${i}`}
                      />
                    </View>
                    <Pressable
                      role="button"
                      accessibilityLabel={W.ring.remove(p.label.trim())}
                      onPress={() => {
                        const left = phones.filter((_, at) => at !== i);
                        set(left.length ? { phones: left } : { phones: left, morePhones: false });
                      }}
                      hitSlop={6}
                      className="size-11 items-center justify-center rounded-control active:bg-card-2"
                      testID={`phone-remove-${i}`}
                    >
                      <Icon as={Trash} className="size-[18px] text-text-2" />
                    </Pressable>
                  </View>
                  <FieldError>{numberError}</FieldError>
                </View>
              </View>
            );
          })}
          <FieldError>{problems['phones']}</FieldError>
          {phones.length < PHONE_SETUP_MAX_PHONES ? (
            <Button
              variant="secondary"
              size="sm"
              icon={Plus}
              className="self-start"
              onPress={() => set({ phones: [...phones, { label: '', number: '', enabled: true }] })}
              testID="phone-add"
            >
              {phones.length ? W.ring.add : W.ring.addFirst}
            </Button>
          ) : null}

          <View className="gap-2" testID="caller-id">
            <Text className="text-[14px] font-semibold">{W.ring.showsTitle}</Text>
            <Choices label={W.ring.showsTitle}>
              <ChoiceTile
                selected={a.callerId === 'customer'}
                onSelect={() => set({ callerId: 'customer' })}
                title={W.ring.showsCustomer}
                hint={W.ring.showsCustomerHint}
                testID="caller-id-customer"
              />
              <ChoiceTile
                selected={a.callerId === 'business'}
                onSelect={() => set({ callerId: 'business' })}
                title={W.ring.showsBusiness}
                hint={W.ring.showsBusinessHint}
                testID="caller-id-business"
              />
            </Choices>
          </View>
        </View>
      ) : null}
      {a.morePhones ? (
        <View className="flex-row items-start gap-2">
          <Icon as={Phone} className="mt-0.5 size-3.5 text-text-2" />
          <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-text-2">
            {W.ring.press1(ctx.businessName)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const Note = ({ children }: { children: string }) => (
  <Text className="rounded-control bg-card px-3 py-2 text-[13px] leading-[18px] text-text-2">
    {children}
  </Text>
);

/** How long the phones ring, and what a caller gets after that: the AI teammate, the voicemail, or nothing. */
export function MissedEditor({ answers: a, set, problems, ctx }: PhoneEditorProps) {
  const mate = ctx.teammate;
  const name = mate?.name ?? null;
  const usual = phoneSetupDefaultGreeting(ctx.businessName);
  const locked = !!mate && !mate.canManage;
  const when: readonly { value: PhoneSetupTeammateMode; label: string }[] = [
    { value: 'no_answer', label: W.missed.when.no_answer },
    { value: 'after_hours', label: W.missed.when.after_hours },
    { value: 'always', label: W.missed.when.always },
  ];
  const seconds = (PHONE_SETUP_RING_SECONDS as readonly number[]).includes(a.ringSeconds)
    ? PHONE_SETUP_RING_SECONDS
    : [...PHONE_SETUP_RING_SECONDS, a.ringSeconds].sort((x, y) => x - y);

  return (
    <View className="gap-4" testID="missed-editor">
      <View className="gap-2">
        <Text className="text-[14px] font-semibold">{W.missed.ringFor}</Text>
        <Pills
          label={W.missed.ringFor}
          value={a.ringSeconds}
          options={seconds.map((n) => ({ value: n, label: W.missed.seconds(n) }))}
          onChange={(n) => set({ ringSeconds: n })}
          testID="ring-seconds"
        />
        <Text className="text-[13px] leading-[18px] text-text-2">
          {W.missed.rings(a.ringSeconds)}
        </Text>
      </View>
      <Choices label={W.missed.title}>
        <ChoiceTile
          selected={a.then === 'teammate'}
          onSelect={() => set({ then: 'teammate' })}
          title={W.missed.teammate(name)}
          hint={locked ? W.missed.cantManage : W.missed.teammateHint}
          best={locked ? undefined : W.best}
          disabled={locked && a.then !== 'teammate'}
          testID="missed-teammate"
        >
          {!mate ? <Note>{W.missed.noTeammate}</Note> : null}
          {mate && !mate.on ? <Note>{W.missed.teammateOff(mate.name)}</Note> : null}
          <View className="gap-2">
            <Text className="text-[13.5px] font-semibold">{W.missed.whenTitle(name)}</Text>
            <Pills
              label={W.missed.whenTitle(name)}
              value={a.teammateMode}
              options={when}
              onChange={(v) => set({ teammateMode: v })}
              testID="teammate-when"
            />
          </View>
          <Text className="text-[13px] leading-[18px] text-text-2">
            {W.missed.teammateCost(name)}
          </Text>
        </ChoiceTile>
        <ChoiceTile
          selected={a.then === 'voicemail'}
          onSelect={() => set({ then: 'voicemail' })}
          title={W.missed.voicemail}
          hint={W.missed.voicemailHint}
          testID="missed-voicemail"
        >
          <View className="gap-1.5">
            <Label>{W.missed.greeting}</Label>
            <TextArea
              maxLength={PHONE_SETUP_GREETING_MAX}
              value={a.greeting}
              placeholder={usual}
              invalid={!!problems['greeting']}
              onChangeText={(v) => set({ greeting: v })}
              accessibilityLabel={W.missed.greeting}
              testID="voicemail-greeting"
            />
            {problems['greeting'] ? (
              <FieldError>{problems['greeting']}</FieldError>
            ) : (
              <Text className="text-[13px] leading-[18px] text-text-3">
                {a.greeting.trim()
                  ? W.missed.greetingHint
                  : `${PW.greetingEmpty} ${W.missed.greetingHint}`}
              </Text>
            )}
          </View>
        </ChoiceTile>
        <ChoiceTile
          selected={a.then === 'nothing'}
          onSelect={() => set({ then: 'nothing' })}
          title={W.missed.nothing}
          hint={W.missed.nothingHint}
          testID="missed-nothing"
        />
      </Choices>
      <FieldError>{problems['then']}</FieldError>
    </View>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/** When automatic texts wait: overnight, hours they pick, or never. */
export function QuietEditor({
  answers: a,
  set,
  problems,
  timezone,
}: PhoneEditorProps & { timezone: string }) {
  const city = timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone;
  // A time saved off the hour (by the Assistant, say) stays in the list.
  const times = (now: string) =>
    (HOURS.includes(now) ? HOURS : [...HOURS, now].sort()).map((t) => ({
      value: t,
      label: phoneSetupClock(t),
    }));
  return (
    <View className="gap-4" testID="quiet-editor">
      <Choices label={W.quiet.title}>
        <ChoiceTile
          selected={a.quiet === 'night'}
          onSelect={() => set({ quiet: 'night' })}
          title={W.quiet.night}
          hint={W.quiet.nightHint}
          best={W.best}
          testID="quiet-night"
        />
        <ChoiceTile
          selected={a.quiet === 'custom'}
          onSelect={() => set({ quiet: 'custom' })}
          title={W.quiet.custom}
          hint={W.quiet.customHint}
          testID="quiet-custom"
        >
          <View className="flex-row gap-2.5">
            <View className="min-w-0 flex-1 gap-1.5">
              <Label>{W.quiet.stop}</Label>
              <ChoiceField
                value={a.quietStart}
                options={times(a.quietStart)}
                onChange={(v) => set({ quietStart: v ?? a.quietStart })}
                placeholder={PW.pickTime}
                sheetTitle={W.quiet.stop}
                testID="quiet-start"
              />
            </View>
            <View className="min-w-0 flex-1 gap-1.5">
              <Label>{W.quiet.start}</Label>
              <ChoiceField
                value={a.quietEnd}
                options={times(a.quietEnd)}
                onChange={(v) => set({ quietEnd: v ?? a.quietEnd })}
                placeholder={PW.pickTime}
                sheetTitle={W.quiet.start}
                testID="quiet-end"
              />
            </View>
          </View>
          <FieldError>{problems['quietEnd']}</FieldError>
        </ChoiceTile>
        <ChoiceTile
          selected={a.quiet === 'never'}
          onSelect={() => set({ quiet: 'never' })}
          title={W.quiet.never}
          hint={W.quiet.neverHint}
          testID="quiet-never"
        />
      </Choices>
      <FieldError>{problems['quiet']}</FieldError>
      <GuidedNote>
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          {W.quiet.stillCan} {W.quiet.zone(city)}
        </Text>
      </GuidedNote>
    </View>
  );
}
