import {
  GUIDE_WORDS,
  LINK_WORDS,
  PHONE_GUIDE_WORDS,
  progressWords,
  stepTitle,
  stepWords,
} from '@hfos/core';
import * as Linking from 'expo-linking';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Check, CircleAlert, Clock } from '@/components/icons';
import { PhoneTour } from '@/components/onboarding/phone-tour';
import { useBusiness } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import {
  useGettingStarted,
  type OnboardingStatus,
  type OnboardingStep,
} from '@/onboarding/use-getting-started';
import { pushRegistration } from '@/push/device';
import { usePushRegistration } from '@/push/hooks';

/** How many rows besides the next one an owner sees before "See all". */
const FOLDED = 4;

/**
 * Getting started on the phone's Home (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, boards 9 and 10).
 *
 * An owner or admin sees the business's guide, shorter than the web's: the count, the next step with its button,
 * and a few rows under it. A teammate sees "Get set up", their own four rows. The phone does two steps itself (the
 * app, which it is, and its notifications); everything else is easier on a computer, so its button emails the
 * person a link (`onboarding.send_link`). Hidden or finished on the web, it's gone here too.
 */
export function GettingStartedCard({ className }: { className?: string }) {
  const { business, userId } = useBusiness();
  const { status, device, reload } = useGettingStarted(business.id, userId);
  if (!status) return null;
  if (status.complete && !status.view.finishedAt)
    return <SetUp status={status} device={device} reload={reload} className={className} />;
  if (!status.view.show) return null;
  return <Steps status={status} reload={reload} className={className} />;
}

function Steps({
  status,
  reload,
  className,
}: {
  status: OnboardingStatus;
  reload: () => void;
  className?: string;
}) {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const push = usePushRegistration();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [all, setAll] = React.useState(false);
  const [touring, setTouring] = React.useState(false);
  const owner = status.audience === 'business';

  /** One command at a time, with signal; the guide asks again when it's done. */
  const act = async (key: string, run: () => Promise<string | null>) => {
    if (!online) return toast.error(PHONE_GUIDE_WORDS.needsSignal);
    setBusy(key);
    try {
      const said = await run();
      if (said) toast.show(said);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const skip = (step: OnboardingStep, skipped: boolean) =>
    act(`skip-${step.key}`, async () => {
      unwrap(
        await api.POST('/v1/commands/onboarding.skip', {
          body: { workspaceId: business.id, step: step.key, skipped },
        }),
      );
      return null;
    });
  const sendLink = (step: OnboardingStep) =>
    act(step.key, async () => {
      const out = unwrap(
        await api.POST('/v1/commands/onboarding.send_link', {
          body: { workspaceId: business.id, step: step.key },
        }),
      );
      return out.sent ? LINK_WORDS.sent(out.email) : LINK_WORDS.alreadySent(out.email);
    });
  const notifications = async () => {
    // Turned off in the phone's settings: only the phone's settings can turn them back on.
    if (push.permission === 'denied' && !push.canAskAgain) {
      toast.show(PHONE_GUIDE_WORDS.notificationsOff);
      await Linking.openSettings();
      return;
    }
    setBusy('notifications');
    try {
      await pushRegistration.ask();
      reload();
    } finally {
      setBusy(null);
    }
  };

  /** A step's one button: what the phone does itself, else "Email me a link". */
  const action = (step: OnboardingStep, primary: boolean) => {
    if (step.key === 'app') return null;
    if (step.key === 'notifications')
      return (
        <Button
          size="sm"
          variant={primary ? 'primary' : 'secondary'}
          loading={busy === 'notifications'}
          onPress={() => void notifications()}
          testID="getting-started-notifications-on"
        >
          {push.permission === 'denied' && !push.canAskAgain
            ? PHONE_GUIDE_WORDS.openSettings
            : (stepWords(step).action ?? GUIDE_WORDS.skip)}
        </Button>
      );
    return (
      <Button
        size="sm"
        variant={primary ? 'primary' : 'secondary'}
        loading={busy === step.key}
        onPress={() => void sendLink(step)}
        testID={`getting-started-${step.key}-link`}
      >
        {LINK_WORDS.action}
      </Button>
    );
  };

  const next = status.steps.find((s) => s.key === status.next) ?? null;
  const rest = status.steps.filter((s) => s !== next);
  const shown = owner && !all ? rest.slice(0, FOLDED) : rest;

  return (
    <Card className={cn('gap-3 px-3.5 pb-2 pt-3.5', className)} testID="getting-started">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-[17px] font-semibold">
          {owner ? GUIDE_WORDS.title : GUIDE_WORDS.teammateTitle}
        </Text>
        <Badge variant="gray" testID="getting-started-count">
          {progressWords(status)}
        </Badge>
      </View>
      {owner ? null : (
        <Text className="-mt-1.5 text-[13.5px] text-text-2">{GUIDE_WORDS.teammateIntro}</Text>
      )}
      <View
        className="h-1.5 overflow-hidden rounded-full bg-card-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={status.total}
        aria-valuenow={status.done}
      >
        <View
          className="h-full rounded-full bg-accent"
          style={{ width: `${status.total ? (status.done / status.total) * 100 : 100}%` }}
        />
      </View>

      {next ? (
        <View
          className="gap-2 rounded-[12px] bg-accent-soft px-3 py-3"
          testID="getting-started-next"
        >
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-3">
            {GUIDE_WORDS.next}
          </Text>
          <View className="gap-0.5">
            <Text className="text-[15px] font-semibold">{stepTitle(next.key, next.note.name)}</Text>
            <Text className="text-[13.5px] leading-[19px] text-text-2">
              {next.key === 'app' || next.key === 'notifications' || next.state !== 'todo'
                ? stepWords(next, status.answers).detail
                : LINK_WORDS.easierDetail}
            </Text>
          </View>
          <View className="flex-row flex-wrap items-center gap-2">
            {action(next, true)}
            <Button
              size="sm"
              variant="ghost"
              loading={busy === `skip-${next.key}`}
              onPress={() => void skip(next, true)}
              testID={`getting-started-${next.key}-skip`}
            >
              {GUIDE_WORDS.skip}
            </Button>
          </View>
        </View>
      ) : null}

      <View>
        {shown.map((step) => (
          <Row
            key={step.key}
            step={step}
            answers={status.answers}
            action={action(step, false)}
            busy={busy === `skip-${step.key}`}
            onUndo={() => void skip(step, false)}
          />
        ))}
      </View>

      <View className="flex-row flex-wrap items-center justify-between gap-2">
        {owner && rest.length > FOLDED ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={() => setAll((v) => !v)}
            testID="getting-started-all"
          >
            {all ? GUIDE_WORDS.showFewer : GUIDE_WORDS.showAll(status.steps.length)}
          </Button>
        ) : (
          <View />
        )}
        {status.view.tourDoneAt ? null : (
          <Button
            size="sm"
            variant="ghost"
            onPress={() => setTouring(true)}
            testID="getting-started-tour"
          >
            {PHONE_GUIDE_WORDS.tour}
          </Button>
        )}
      </View>
      <PhoneTour open={touring} onClose={() => setTouring(false)} onTaken={reload} />
    </Card>
  );
}

/** One step: where it stands, and its one button while it's still to do. */
function Row({
  step,
  answers,
  action,
  busy,
  onUndo,
}: {
  step: OnboardingStep;
  answers: OnboardingStatus['answers'];
  action: React.ReactNode;
  busy: boolean;
  onUndo: () => void;
}) {
  const words = stepWords(step, answers);
  const done = step.state === 'done';
  const open = step.state === 'todo' || step.state === 'needs_fix';
  return (
    <View
      className="flex-row items-center gap-3 border-t border-border py-3"
      testID={`getting-started-${step.key}`}
      accessibilityState={{ checked: done }}
    >
      <View
        className={cn(
          'size-6 items-center justify-center rounded-full border-[1.5px]',
          done
            ? 'border-success bg-success'
            : step.state === 'waiting'
              ? 'border-warning bg-warning-soft'
              : step.state === 'needs_fix'
                ? 'border-danger bg-danger-soft'
                : 'border-border-strong',
          step.state === 'skipped' && 'border-dashed',
        )}
      >
        {done ? <Icon as={Check} className="size-3.5 text-white" strokeWidth={2.5} /> : null}
        {step.state === 'waiting' ? (
          <Icon as={Clock} className="size-3.5 text-warning-text" strokeWidth={2} />
        ) : null}
        {step.state === 'needs_fix' ? (
          <Icon as={CircleAlert} className="size-3.5 text-danger-text" strokeWidth={2} />
        ) : null}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={cn(
            'text-[15px] font-medium',
            (done || step.state === 'skipped') && 'text-text-3',
          )}
        >
          {stepTitle(step.key, step.note.name)}
        </Text>
        <Text className="text-[12.5px] leading-[17px] text-text-3" numberOfLines={2}>
          {step.key === 'app' && done ? PHONE_GUIDE_WORDS.appDone : words.detail}
        </Text>
      </View>
      {words.badge ? <Badge variant="pending">{words.badge}</Badge> : null}
      {open ? action : null}
      {step.state === 'skipped' ? (
        <Pressable
          onPress={onUndo}
          disabled={busy}
          hitSlop={10}
          testID={`getting-started-${step.key}-undo`}
        >
          <Text className="text-[13.5px] font-medium text-accent-text">{GUIDE_WORDS.undo}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The last step done or skipped: "You're set up", once, and Done puts it away. A business set up before the guide
 * existed (no answers, nothing skipped) never needed it, so it finishes without a word, as on the web.
 */
function SetUp({
  status,
  device,
  reload,
  className,
}: {
  status: OnboardingStatus;
  device: { app: true; notifications?: boolean; signIn?: boolean };
  reload: () => void;
  className?: string;
}) {
  const { business } = useBusiness();
  const [busy, setBusy] = React.useState(false);
  const quiet = status.audience === 'business' && !status.answers && status.skipped === 0;
  const finish = React.useCallback(
    async () =>
      unwrap(
        await api.POST('/v1/commands/onboarding.finish', {
          body: { workspaceId: business.id, device },
        }),
      ),
    [business.id, device],
  );
  const sent = React.useRef(false);
  React.useEffect(() => {
    if (!quiet || sent.current) return;
    sent.current = true;
    void finish()
      .then(reload)
      .catch(() => undefined);
  }, [quiet, finish, reload]);
  if (quiet) return null;
  const skipped = status.steps
    .filter((s) => s.state === 'skipped')
    .map((s) => stepTitle(s.key, s.note.name));
  return (
    <Card
      className={cn('flex-row items-start gap-3 px-3.5 py-3.5', className)}
      testID="getting-started-done"
    >
      <View className="size-9 items-center justify-center rounded-[10px] bg-success-soft">
        <Icon as={Check} className="size-[18px] text-success-text" strokeWidth={2} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-[15px] font-semibold">{GUIDE_WORDS.finishedTitle}</Text>
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          {GUIDE_WORDS.finishedDetail(skipped)}
        </Text>
        <View className="mt-1 flex-row">
          <Button
            size="sm"
            loading={busy}
            onPress={() => {
              setBusy(true);
              finish()
                .then(reload)
                .catch((e: unknown) => toast.error(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
            testID="getting-started-finish"
          >
            {GUIDE_WORDS.finishedDone}
          </Button>
        </View>
      </View>
    </Card>
  );
}
