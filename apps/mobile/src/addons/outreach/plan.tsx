import type { Platform } from '@hfos/core/addons/outreach/networks';
import {
  PLAN_STANDS,
  PLAN_WORDS,
  planCountsLine,
  planMoreWords,
  planTone,
  planWhen,
  type PlanOutput,
} from '@hfos/core/addons/outreach/plan';
import { LIVE_REFETCH_SECONDS } from '@hfos/core/addons/outreach/live';
import { PLATFORMS } from '@hfos/core/addons/outreach/playbooks';
import * as React from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { NeedsSignal, Note, Part, useOutreachAnswer, useOutreachContext } from './kit';

const TONE_BADGE = { good: 'ok', waiting: 'pending', warn: 'danger', plain: 'gray' } as const;

/**
 * Today's Plan on the phone (docs/outreach.md, decision 195), as the web's: what the person's computer will do today
 * on the network shown and about when. Where the day stands in a line, what they asked for that goes first, what's
 * coming in order with rough times, and what it has done so far. HandsFreeOS works it out from where the extension
 * said its day is up to (packages/core/src/addons/outreach/plan.ts); nothing here is pressed yet, it only shows.
 * Asked for again every minute while it's open; it needs signal.
 */
export function PlanPart({ platform, many }: { platform: Platform; many: boolean }) {
  const ctx = useOutreachContext();
  const plan = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.plan', {
          body: { workspaceId: ctx.workspaceId, platform },
        }),
      ),
    `plan:${ctx.workspaceId}:${platform}`,
    PLAN_WORDS.title,
    { everySeconds: LIVE_REFETCH_SECONDS },
  );
  if (!plan.data)
    return plan.error ? (
      <NeedsSignal words={plan.error} onRetry={plan.reload} testID="today-plan-signal" />
    ) : null;
  return <PlanBody plan={plan.data} many={many} />;
}

export function PlanBody({ plan, many }: { plan: PlanOutput; many: boolean }) {
  const tz = plan.timezone;
  const counts = planCountsLine(plan.counts);
  return (
    <>
      <Part
        title={many ? PLAN_WORDS.titleOn(PLATFORMS[plan.platform]) : PLAN_WORDS.title}
        about={PLAN_WORDS.about}
        testID="today-plan"
      >
        <Card className="gap-2 px-4 py-3.5">
          <View className="flex-row">
            <Badge variant={TONE_BADGE[planTone(plan.stand)]} testID="plan-stand">
              <Text>{PLAN_STANDS[plan.stand]}</Text>
            </Badge>
          </View>
          <Text className="text-[14.5px] leading-[21px]" testID="plan-line">
            {plan.line}
          </Text>
          {plan.doing ? <Note testID="plan-doing">{plan.doing}</Note> : null}
        </Card>
      </Part>

      {plan.asked.length ? (
        <Part title={PLAN_WORDS.asked} testID="plan-asked">
          <Card className="gap-2 px-4 py-3.5">
            {plan.asked.map((ask) => (
              <View key={ask.askId} className="flex-row gap-3">
                <Text className="w-[88px] text-[13px] text-text-3">
                  {ask.working ? PLAN_WORDS.askWorking : PLAN_WORDS.askWaiting}
                </Text>
                <Text className="flex-1 text-[14px] leading-[20px]">{ask.title}</Text>
              </View>
            ))}
          </Card>
        </Part>
      ) : null}

      {plan.reported ? (
        <Part
          title={PLAN_WORDS.coming}
          about={plan.coming.length ? PLAN_WORDS.times : null}
          testID="plan-coming"
        >
          <Card className="gap-2 px-4 py-3.5">
            {plan.coming.length ? (
              plan.coming.map((row, i) => (
                <View key={`${row.at}:${i}`} className="flex-row gap-3" testID="plan-row">
                  <Text
                    className={cn(
                      'w-[88px] text-[13px] text-text-3',
                      row.now && 'font-semibold text-success-text',
                    )}
                  >
                    {planWhen(row, tz)}
                  </Text>
                  <View className="min-w-0 flex-1">
                    <Text className="text-[14px] leading-[20px]">
                      {row.title}
                      {row.who ? <Text className="font-semibold"> · {row.who}</Text> : null}
                    </Text>
                    {row.detail ? <Note>{row.detail}</Note> : null}
                  </View>
                </View>
              ))
            ) : (
              <Note testID="plan-none">{PLAN_WORDS.nothingComing}</Note>
            )}
            {plan.more > 0 ? (
              <Note testID="plan-more">{planMoreWords(plan.more, plan.until, tz)}</Note>
            ) : null}
            {plan.notes.map((note) => (
              <Note key={note}>{note}</Note>
            ))}
          </Card>
        </Part>
      ) : null}

      {plan.done.length || counts ? (
        <Part title={PLAN_WORDS.done} testID="plan-done">
          <Card className="gap-2 px-4 py-3.5">
            {counts ? <Text className="text-[14px] leading-[20px]">{counts}</Text> : null}
            {plan.done.map((job) => (
              <View key={job.title} className="gap-0.5">
                <Text className="text-[14px] font-semibold leading-[20px]">{job.title}</Text>
                {job.line ? <Note>{job.line}</Note> : null}
              </View>
            ))}
          </Card>
        </Part>
      ) : null}
    </>
  );
}
