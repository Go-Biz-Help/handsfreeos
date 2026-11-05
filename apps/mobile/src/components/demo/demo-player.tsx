import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronDown, Play, Presentation, RotateCcw, X } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { autoNext } from '@/demo/autoplay';
import { useBusinessDemo } from '@/demo/hooks';
import { clearDemoPushes, notificationsAllowed, scheduleDemoPush } from '@/demo/push';
import { findPhoneScene } from '@/demo/scenes';
import { dropDemo, keepDemo, type PhoneDemo } from '@/demo/state';
import type { PhoneDemoPlayer } from '@/demo/world';
import { PHONE_DEMO_WORDS as W } from '@/demo/words';
import { useTeammate } from '@/inbox/use-inbox';

/** What a step can do on the phone, for the scene as it now stands. */
function playerOf(demo: PhoneDemo): PhoneDemoPlayer {
  return {
    demo,
    open: (path) => router.navigate(businessHref(demo.workspaceId, path) as Href),
    push: async (data, inSeconds) => {
      if (!(await notificationsAllowed())) throw new Error(W.notificationsOff);
      try {
        await scheduleDemoPush(data, inSeconds);
      } catch {
        throw new Error(W.pushFailed);
      }
    },
    clearPushes: () => clearDemoPushes().catch(() => undefined),
  };
}

/**
 * The demo player over a business's screens while a scene plays on this phone (src/demo, Admin → Demo player): the
 * step that's next and what to say over it, Next, Back, Start over and Exit. Hidden, it's a small button at the edge,
 * so a screen recording shows only the app. A step can also be played from the scene's notification (Approve, or a
 * tap on it), and the player follows. Play on its own hides it completely and plays each step once its voiceover has
 * been said (`autoplay.ts`), waiting for the notification's press where a step needs one; holding the top edge of the
 * screen stops it.
 */
export function DemoPlayerBar() {
  const demo = useBusinessDemo();
  const insets = useSafeAreaInsets();
  const teammate = useTeammate();
  const [hidden, setHidden] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const busyRef = React.useRef(false);
  /** When Play on its own started, while it's on: the player is out of sight and plays the steps itself. */
  const [auto, setAuto] = React.useState<number | null>(null);
  const nextRef = React.useRef<() => Promise<void>>(async () => undefined);

  // Play on its own: the next step once the last one's voiceover has been said, the presenter's press on the
  // notification where a step waits for one, and the player back once the scene is over.
  React.useEffect(() => {
    if (auto === null || !demo || busy) return;
    const scene = findPhoneScene(demo.scene);
    if (!scene) return;
    const plan = autoNext(demo, scene, auto, Date.now());
    if (plan.kind === 'press') return;
    const timer = setTimeout(() => {
      if (plan.kind === 'end') {
        setAuto(null);
        return;
      }
      // A step the presenter acts on (lock the phone now) buzzes, since its cue is out of sight.
      if (scene.steps[demo.steps.length]?.cue) Vibration.vibrate();
      void nextRef.current();
    }, plan.inMs);
    return () => clearTimeout(timer);
  }, [auto, demo, busy]);

  // Made-up messages sign off with the business's own teammate's name, once it's known on the phone.
  React.useEffect(() => {
    if (demo && teammate?.name && demo.steps.length === 0 && demo.teammate !== teammate.name)
      keepDemo({ ...demo, teammate: teammate.name });
  }, [demo, teammate?.name]);

  if (!demo) return null;
  const scene = findPhoneScene(demo.scene);
  if (!scene) return null;
  const done = demo.steps.length;
  const step = scene.steps[done] ?? null;
  const bottom = insets.bottom + 64;

  async function next() {
    if (!demo || !scene || busyRef.current) return;
    const s = scene.steps[demo.steps.length];
    if (!s) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    const moved: PhoneDemo = { ...demo, steps: [...demo.steps, Date.now() - demo.startedAt] };
    keepDemo(moved);
    try {
      await s.run?.(playerOf(moved));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      // The player comes back to say so.
      setAuto(null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function back() {
    if (!demo || !demo.steps.length || busyRef.current) return;
    setProblem(null);
    keepDemo({ ...demo, steps: demo.steps.slice(0, -1) });
    void clearDemoPushes().catch(() => undefined);
  }

  function again() {
    if (!demo || busyRef.current) return;
    setProblem(null);
    keepDemo({ ...demo, steps: [], startedAt: Date.now(), read: [], typed: [] });
    void clearDemoPushes().catch(() => undefined);
    router.navigate(businessHref(demo.workspaceId) as Href);
  }

  nextRef.current = next;

  function exit() {
    void clearDemoPushes().catch(() => undefined);
    dropDemo();
    router.replace('/app/admin/demo' as Href);
  }

  if (auto !== null)
    return (
      <Pressable
        accessibilityLabel={W.autoStop}
        onLongPress={() => setAuto(null)}
        delayLongPress={600}
        style={{
          position: 'absolute',
          top: 0,
          left: '25%',
          right: '25%',
          height: Math.max(insets.top, 24),
        }}
        testID="demo-player-auto"
      />
    );

  if (hidden)
    return (
      <Pressable
        role="button"
        accessibilityLabel={W.show}
        onPress={() => setHidden(false)}
        style={{ position: 'absolute', right: 10, bottom }}
        className="size-11 items-center justify-center rounded-full border border-border-strong bg-card"
        testID="demo-player-show"
      >
        <Icon as={Presentation} className="size-5 text-accent-text" />
      </Pressable>
    );

  return (
    <View
      style={{ position: 'absolute', left: 10, right: 10, bottom }}
      className="gap-2 rounded-card border border-border-strong bg-card p-3"
      testID="demo-player"
    >
      <View className="flex-row items-center gap-2">
        <Icon as={Presentation} className="size-4 text-accent-text" />
        <Text className="min-w-0 flex-1 text-[12.5px] font-semibold text-text-2" numberOfLines={1}>
          {W.scene(scene.number, scene.title)}
        </Text>
        <Text className="text-[12px] text-text-3" testID="demo-player-count">
          {W.step(Math.min(done + 1, scene.steps.length), scene.steps.length)}
        </Text>
        <Pressable
          role="button"
          accessibilityLabel={W.hide}
          onPress={() => setHidden(true)}
          hitSlop={8}
          className="size-8 items-center justify-center"
          testID="demo-player-hide"
        >
          <Icon as={ChevronDown} className="size-4 text-text-2" />
        </Pressable>
      </View>
      {step ? (
        <View className="gap-1" testID="demo-player-step">
          <Text className="text-[15px] font-semibold" testID="demo-player-next-step">
            {step.label}
          </Text>
          <Text className="text-[13px] text-text-2">
            <Text className="text-[13px] font-semibold text-text-2">{W.say}: </Text>
            {step.voiceover}
          </Text>
          {step.cue ? (
            <Text className="text-[13px] font-medium text-accent-text">{step.cue}</Text>
          ) : null}
        </View>
      ) : (
        <View className="gap-1" testID="demo-player-done">
          <Text className="text-[14px] font-medium">{W.done}</Text>
        </View>
      )}
      {problem ? (
        <Text role="alert" className="text-[13px] text-danger-text" testID="demo-player-problem">
          {problem}
        </Text>
      ) : null}
      <View className="flex-row items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onPress={back}
          disabled={busy || done === 0}
          testID="demo-player-back"
        >
          {W.back}
        </Button>
        <Button
          size="sm"
          className="flex-1"
          onPress={() => void next()}
          loading={busy}
          disabled={!step}
          testID="demo-player-next"
        >
          {W.next}
        </Button>
        <Pressable
          role="button"
          accessibilityLabel={W.auto}
          onPress={() => {
            setProblem(null);
            setAuto(Date.now());
          }}
          disabled={busy || !step}
          hitSlop={4}
          className="size-9 items-center justify-center rounded-control border border-border-strong"
          testID="demo-player-play-alone"
        >
          <Icon as={Play} className="size-4 text-accent-text" />
        </Pressable>
        <Pressable
          role="button"
          accessibilityLabel={W.again}
          onPress={again}
          disabled={busy}
          hitSlop={4}
          className="size-9 items-center justify-center rounded-control border border-border-strong"
          testID="demo-player-again"
        >
          <Icon as={RotateCcw} className="size-4 text-text-2" />
        </Pressable>
        <Pressable
          role="button"
          accessibilityLabel={W.exit}
          onPress={exit}
          hitSlop={4}
          className="size-9 items-center justify-center rounded-control border border-border-strong"
          testID="demo-player-exit"
        >
          <Icon as={X} className="size-4 text-text-2" />
        </Pressable>
      </View>
      {step ? <Text className="text-[12px] text-text-3">{W.autoHint}</Text> : null}
    </View>
  );
}
