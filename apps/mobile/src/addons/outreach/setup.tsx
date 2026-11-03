import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { adviceLeft } from '@hfos/core/addons/outreach/readiness';
import { SET_UP_PAGE_WORDS as U, setupDoneOf } from '@hfos/core/addons/outreach/set-up-page';
import {
  bannerWords,
  outreachSetupPath,
  SETUP_PART_OF,
  SETUP_PARTS,
  SETUP_WORDS,
  type SetupOutput,
  type StepState,
} from '@hfos/core/addons/outreach/setup';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Check, Circle, Clock, RefreshCw } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { openWebPath } from '@/home/open';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { OutreachFrame } from './frame';
import { NeedsSignal, Note, Part, useOutreachAnswer, useOutreachContext } from './kit';
import { GetReadyCard, useReadyProps } from './ready';

/**
 * Social Outreach's Set up page on the phone (docs/outreach.md, decision 129), as on the web: how far the setup has
 * come, with the next step and Carry on (the setup itself is a computer's, so it opens on the web), every step where it
 * stands, and Get ready on each network the person works (./ready.tsx), which was on Today. The add-on's first screen
 * lists it first, with its count, while anything's left (./home.tsx).
 */

const STATE_ICON: Record<StepState, { icon: typeof Check; className: string }> = {
  done: { icon: Check, className: 'text-success' },
  todo: { icon: Circle, className: 'text-text-3' },
  again: { icon: RefreshCw, className: 'text-warning' },
  waiting: { icon: Clock, className: 'text-warning' },
};

export function SetupScreen() {
  const ctx = useOutreachContext();
  const setup = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.setup', { body: { workspaceId: ctx.workspaceId } }),
      ) as SetupOutput,
    `setup:${ctx.workspaceId}`,
    W.title,
  );
  return (
    <SetupBody
      setup={setup.data}
      error={setup.error}
      onRetry={setup.reload}
      onCarryOn={(to) => openWebPath(outreachSetupPath(ctx.workspaceId, to))}
      ready={(platform) => <NetworkReady key={platform} platform={platform} />}
    />
  );
}

/** Get ready on one network: its card, or that they're ready there. */
function NetworkReady({ platform }: { platform: Platform }) {
  const ready = useReadyProps(platform, () => undefined);
  return <ReadyOn platform={platform} {...ready} />;
}

export function ReadyOn({
  platform,
  ...ready
}: { platform: Platform } & React.ComponentProps<typeof GetReadyCard>) {
  const name = PLATFORMS[platform];
  const r = ready.readiness;
  return (
    <View className="gap-2" testID={`setup-ready-${platform}`}>
      <Text className="text-[13.5px] font-semibold text-text-2">{name}</Text>
      {r && r.ready && !adviceLeft(r.items).length ? (
        <Card
          className="flex-row items-center gap-2.5 px-4 py-3"
          testID={`setup-ready-${platform}-done`}
        >
          <Icon as={Check} className="size-[18px] text-success" />
          <Text className="flex-1 text-[14px] text-text-2">{U.readyOn(name)}</Text>
        </Card>
      ) : (
        <GetReadyCard {...ready} />
      )}
    </View>
  );
}

export function SetupBody({
  setup,
  error,
  onRetry,
  onCarryOn,
  ready,
}: {
  setup: SetupOutput | null;
  error: string | null;
  onRetry: () => void;
  /** Opens the setup on the web, at a step. */
  onCarryOn: (to: { step?: NonNullable<SetupOutput['next']>; again?: boolean }) => void;
  /** Get ready on a network. */
  ready: (platform: Platform) => React.ReactNode;
}) {
  if (!setup)
    return (
      <OutreachFrame page="setup" testID="outreach-setup">
        {error ? <NeedsSignal words={error} onRetry={onRetry} testID="setup-needs-signal" /> : null}
      </OutreachFrame>
    );
  const laid = { states: setup.states, networks: setup.networks };
  const { done, of } = setupDoneOf(laid);
  const next = setup.next;
  return (
    <OutreachFrame page="setup" testID="outreach-setup">
      <Card className="gap-2.5 px-4 py-4" testID="setup-next">
        {next ? (
          <Text className="text-[15px] font-semibold">{bannerWords(laid, next)}</Text>
        ) : (
          <Text className="text-[15px] font-semibold" testID="setup-all-done">
            {U.allDone}
          </Text>
        )}
        <Note testID="setup-count">{SETUP_WORDS.progress(done, of)}</Note>
        <View className="h-1.5 rounded-full bg-card-2">
          <View
            className="h-1.5 rounded-full bg-accent"
            style={{ width: `${of ? Math.round((done / of) * 100) : 0}%` }}
          />
        </View>
        <Note>{SETUP_WORDS.onPhone}</Note>
        <View className="flex-row flex-wrap gap-2">
          {next ? (
            <Button size="sm" onPress={() => onCarryOn({ step: next })} testID="setup-carry-on">
              {SETUP_WORDS.carryOn}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onPress={() => onCarryOn({ again: true })}
            testID="setup-again"
          >
            {SETUP_WORDS.again}
          </Button>
        </View>
      </Card>
      <Part title={U.stepsTitle} testID="setup-steps">
        <Card className="px-0 py-0">
          {SETUP_PARTS.flatMap((part) =>
            setup.states
              .filter((s) => SETUP_PART_OF[s.step] === part)
              .map((s, i) => (
                <StepRow
                  key={s.step}
                  name={SETUP_WORDS.main[s.step].name}
                  state={s.state}
                  optional={s.optional}
                  first={part === SETUP_PARTS[0] && i === 0}
                  testID={`setup-step-${s.step}`}
                />
              )),
          )}
          {setup.networks.map((n) => {
            const left = n.steps.filter((s) => s.state !== 'done').length;
            return (
              <StepRow
                key={n.platform}
                name={PLATFORMS[n.platform]}
                state={left ? 'todo' : 'done'}
                detail={
                  left
                    ? SETUP_WORDS.progress(n.steps.length - left, n.steps.length)
                    : SETUP_WORDS.working
                }
                testID={`setup-step-${n.platform}`}
              />
            );
          })}
        </Card>
      </Part>
      <Part title={U.getReadyTitle} about={U.getReadyAbout} testID="setup-ready">
        {setup.networks.length ? (
          <View className="gap-3">{setup.networks.map((n) => ready(n.platform))}</View>
        ) : (
          <Note testID="setup-no-networks">{U.noNetworks}</Note>
        )}
      </Part>
    </OutreachFrame>
  );
}

function StepRow({
  name,
  state,
  optional = false,
  detail,
  first = false,
  testID,
}: {
  name: string;
  state: StepState;
  optional?: boolean;
  detail?: string;
  first?: boolean;
  testID: string;
}) {
  const shown = STATE_ICON[state];
  return (
    <View
      className={cn(
        'min-h-12 flex-row items-center gap-3 px-4 py-3',
        !first && 'border-t border-border',
      )}
      testID={testID}
    >
      <Icon as={shown.icon} className={cn('size-[18px]', shown.className)} />
      <Text className="min-w-0 flex-1 text-[14.5px]">{name}</Text>
      {detail ? <Text className="text-[12.5px] text-text-3">{detail}</Text> : null}
      {optional ? <Badge variant="gray">{SETUP_WORDS.optional}</Badge> : null}
    </View>
  );
}
