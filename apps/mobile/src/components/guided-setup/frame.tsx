import { GUIDED_SETUP_WORDS as W, type GuidedSetupKey } from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ArrowLeft, Check, CircleAlert, PartyPopper } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The guided setups' frame on the phone (the owner, 22 Nov 2026: every setting set up one question at a time), as
 * the web's components/guided-setup/frame.tsx at phone size, with the same names: one question a screen under
 * "Question 3 of 5", how far along, Saved beside Finish later, the picks as tiles with the best one marked, Back
 * and Next at the bottom, and the answers saved as they are given (guided_setup.save_draft), so someone who leaves
 * comes back to them. The email setup is the first to use it; each setup brings its own questions.
 */
export type SavedState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Keeps a setup's answers as they change: a moment after the last change, and at once when asked (`flush`, before
 * leaving a screen). `answers` null saves nothing (the setup is finished, or not started). A save that fails says so
 * beside Finish later and is tried again with the next change.
 */
export function useGuidedDraft(
  workspaceId: string,
  setup: GuidedSetupKey,
  answers: Record<string, unknown> | null,
  opts: { readonly hadDraft: boolean },
) {
  const [state, setState] = React.useState<SavedState>(opts.hadDraft ? 'saved' : 'idle');
  const text = answers ? JSON.stringify(answers) : null;
  const saved = React.useRef<string | null>(opts.hadDraft ? text : null);
  const latest = React.useRef<string | null>(text);
  latest.current = text;
  const running = React.useRef<Promise<void>>(Promise.resolve());
  const stopped = React.useRef(false);

  const save = React.useCallback(async () => {
    // One at a time, each sending the newest answers: a slow save never lands on top of a newer one.
    const job = running.current.then(async () => {
      const body = latest.current;
      if (stopped.current || body === null || body === saved.current) return;
      setState('saving');
      try {
        unwrap(
          await api.POST('/v1/commands/guided_setup.save_draft', {
            body: { workspaceId, setup, answers: JSON.parse(body) as Record<string, unknown> },
          }),
        );
        saved.current = body;
        setState('saved');
      } catch {
        setState('error');
      }
    });
    running.current = job;
    return job;
  }, [workspaceId, setup]);

  React.useEffect(() => {
    if (text === null || text === saved.current) return;
    const timer = setTimeout(() => void save(), 700);
    return () => clearTimeout(timer);
  }, [text, save]);
  // Leaving by the phone's own Back, or a swipe, presses no button: what was just answered is still kept.
  React.useEffect(() => () => void save(), [save]);

  /** Forget the saved answers (finished, or Start over). Nothing more is saved until `resume`. */
  const clear = React.useCallback(async () => {
    stopped.current = true;
    await running.current;
    saved.current = null;
    setState('idle');
    try {
      unwrap(
        await api.POST('/v1/commands/guided_setup.clear_draft', { body: { workspaceId, setup } }),
      );
    } catch {
      // Left behind, it is only an old draft: the setup ignores one that no longer fits.
    }
  }, [workspaceId, setup]);
  const resume = React.useCallback(() => {
    stopped.current = false;
  }, []);

  return { state, flush: save, clear, resume };
}

/** The green tick and "Saved" beside Finish later. */
export function SavedMark({ state }: { state: SavedState }) {
  if (state === 'idle') return null;
  const failed = state === 'error';
  return (
    <View
      className="flex-row items-center gap-1"
      role="status"
      accessibilityLabel={failed ? `${W.notSaved}. ${W.notSavedHint}` : W.saved}
      aria-busy={state === 'saving'}
      testID={`guided-saved-${state}`}
    >
      <Icon
        as={failed ? CircleAlert : Check}
        className={cn(
          'size-3.5',
          failed ? 'text-warning-text' : 'text-success',
          state === 'saving' && 'opacity-40',
        )}
        strokeWidth={failed ? 2 : 2.5}
      />
      <Text className={cn('text-[12.5px]', failed ? 'text-warning-text' : 'text-text-2')}>
        {failed ? W.notSaved : W.saved}
      </Text>
    </View>
  );
}

/**
 * One screen of a guided setup: "Question 3 of 5" and the setup's name in the top bar, Saved and Finish later at
 * its right, how far along under it, then the question with its answers, and the footer pinned at the bottom (over
 * the keyboard while it's up).
 */
export function GuidedPage({
  screen,
  kicker,
  settingUp,
  progress,
  title,
  hint,
  banner,
  footer,
  saved,
  onLeave,
  leaveLabel = W.finishLater,
  leaving = false,
  scroller,
  testID = 'guided-setup',
  children,
}: {
  /** The screen's key, for its testID: `email-guided-screen-readers`. */
  screen: string;
  /** "Question 3 of 5", or "Check it over". */
  kicker: string;
  /** The setup's name, under it: "Your email". Left out where the top line already says it (Done). */
  settingUp?: string | undefined;
  /** How far along; null where it isn't one of the questions (the last step, Done). */
  progress: { readonly at: number; readonly of: number } | null;
  title: string;
  hint?: string | undefined;
  /** Over the question: "Welcome back", or the number that was taken. */
  banner?: React.ReactNode;
  /** Back and Next, or nothing where the screen has its own buttons. */
  footer: React.ReactNode | null;
  saved: SavedState;
  onLeave: () => void;
  /** "Close" once there is nothing left to finish. */
  leaveLabel?: string;
  leaving?: boolean;
  scroller?: React.RefObject<ScrollView | null>;
  testID?: string;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const bottom = keyboard ? keyboard + (Platform.OS === 'android' ? insets.bottom : 0) : 0;
  return (
    <Screen
      title={kicker}
      {...(settingUp ? { subtitle: settingUp } : {})}
      leading="none"
      trailing={
        <View className="flex-row items-center gap-1.5 pr-1">
          <SavedMark state={saved} />
          <Button
            variant="ghost"
            size="sm"
            onPress={onLeave}
            loading={leaving}
            testID="guided-leave"
          >
            {leaveLabel}
          </Button>
        </View>
      }
      ask={false}
      scroll={false}
      testID={testID}
    >
      {progress ? (
        <View
          className="h-1 bg-card-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.of}
          aria-valuenow={progress.at}
        >
          <View
            className="h-full bg-accent"
            style={{ width: `${(progress.at / Math.max(progress.of, 1)) * 100}%` }}
          />
        </View>
      ) : null}
      <View className="flex-1" style={{ paddingBottom: bottom }}>
        <ScrollView
          ref={scroller}
          className="flex-1"
          contentContainerClassName="gap-5 px-4 pb-8 pt-5"
          keyboardShouldPersistTaps="handled"
          testID={`${testID}-scroll`}
        >
          {banner}
          <View className="gap-1.5" testID={`${testID}-screen-${screen}`}>
            <Text variant="heading">{title}</Text>
            {hint ? <Text variant="lead">{hint}</Text> : null}
          </View>
          {children}
        </ScrollView>
        {footer ? (
          <View
            className="gap-2 border-t border-border bg-card px-4 pt-3"
            style={{ paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 12) }}
          >
            {footer}
          </View>
        ) : (
          <View style={{ height: keyboard ? 0 : insets.bottom }} />
        )}
      </View>
    </Screen>
  );
}

/** One pick: a radio tile, with Best on the one most businesses should take, and its own questions when picked. */
export function ChoiceTile({
  selected,
  onSelect,
  title,
  icon,
  hint,
  best,
  disabled,
  testID,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  /** Before the title, where a picture helps tell the picks apart: a lock for "Only me". */
  icon?: LucideIcon | undefined;
  hint?: string | undefined;
  best?: string | undefined;
  disabled?: boolean | undefined;
  testID?: string;
  /** Shown inside the tile while it is picked. */
  children?: React.ReactNode;
}) {
  return (
    <View
      className={cn(
        'rounded-menu border',
        selected ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
        disabled && 'opacity-60',
      )}
    >
      <Pressable
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled}
        accessibilityLabel={title}
        disabled={disabled}
        onPress={onSelect}
        testID={testID}
        className={cn(
          'flex-row items-start gap-3 rounded-menu px-4 py-3.5',
          !selected && 'active:bg-card-2',
        )}
      >
        <View
          className={cn(
            'mt-0.5 size-[18px] items-center justify-center rounded-full border-[1.5px]',
            selected ? 'border-accent' : 'border-border-strong',
          )}
        >
          {selected ? <View className="size-2.5 rounded-full bg-accent" /> : null}
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-2">
            {icon ? <Icon as={icon} className="size-4 text-text-2" /> : null}
            <Text className="shrink text-[15px] font-semibold">{title}</Text>
            {best ? <Badge variant="ok">{best}</Badge> : null}
          </View>
          {hint ? <Text className="text-[13px] leading-[18px] text-text-2">{hint}</Text> : null}
        </View>
      </Pressable>
      {selected && children ? <View className="gap-3 px-4 pb-4">{children}</View> : null}
    </View>
  );
}

/** The picks of one question, read out as a group. */
export function Choices({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View role="radiogroup" accessibilityLabel={label} className="gap-2.5">
      {children}
    </View>
  );
}

/** Back and Next under a question, with what stopped Next above them. */
export function GuidedFooter({
  onBack,
  onNext,
  nextLabel = W.next,
  busy = false,
  error,
  testID = 'guided',
}: {
  onBack?: (() => void) | undefined;
  onNext: () => void;
  nextLabel?: string;
  busy?: boolean;
  error?: string | null | undefined;
  testID?: string;
}) {
  return (
    <>
      {error ? <FieldError testID={`${testID}-error`}>{error}</FieldError> : null}
      <View className="flex-row items-center gap-3">
        {onBack ? (
          <Button
            variant="ghost"
            icon={ArrowLeft}
            onPress={onBack}
            disabled={busy}
            testID={`${testID}-back`}
          >
            {W.back}
          </Button>
        ) : null}
        <Button className="flex-1" onPress={onNext} loading={busy} testID={`${testID}-next`}>
          {nextLabel}
        </Button>
      </View>
    </>
  );
}

/** "Welcome back, Blake. Your answers from Friday are still here." with Start over, asked twice. */
export function WelcomeBack({
  line,
  onStartOver,
}: {
  line: string;
  /** Clears the answers; null where there is nothing to start over. */
  onStartOver: (() => void) | null;
}) {
  const [asking, setAsking] = React.useState(false);
  if (asking && onStartOver)
    return (
      <View
        className="gap-2.5 rounded-menu bg-card-2 px-3.5 py-3"
        role="alert"
        testID="guided-start-over-ask"
      >
        <Text className="text-[13.5px] leading-[19px]">{W.startOverConfirm}</Text>
        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onPress={() => setAsking(false)}
            testID="guided-start-over-no"
          >
            Keep my answers
          </Button>
          <Button size="sm" onPress={onStartOver} testID="guided-start-over-yes">
            {W.startOver}
          </Button>
        </View>
      </View>
    );
  return (
    <View
      className="gap-2 rounded-menu bg-accent-soft px-3.5 py-3"
      role="status"
      testID="guided-welcome-back"
    >
      <View className="flex-row items-start gap-2.5">
        <Icon as={PartyPopper} className="mt-0.5 size-4 text-accent-text" />
        <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-accent-text">{line}</Text>
      </View>
      {onStartOver ? (
        <Pressable
          role="button"
          onPress={() => setAsking(true)}
          hitSlop={{ top: 8, bottom: 8 }}
          className="self-start pl-[26px]"
          testID="guided-start-over"
        >
          <Text className="text-[13.5px] font-medium text-accent-text underline">
            {W.startOver}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A grey note under the picks: what happens either way, or how to find out. */
export function GuidedNote({ children }: { children: React.ReactNode }) {
  return <View className="gap-2 rounded-menu bg-card-2 px-3.5 py-3">{children}</View>;
}
