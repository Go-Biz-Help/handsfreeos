import type { Platform } from '@hfos/core/addons/outreach/networks';
import {
  PLAN_STANDS,
  PLAN_WORDS,
  planCountsLine,
  planMoreWords,
  planTone,
  planWhen,
  rowWords,
  type PlanOutput,
  type PlanRow,
} from '@hfos/core/addons/outreach/plan';
import {
  PLAN_CHANGE_UI as U,
  PLAN_CHANGE_WORDS,
  planMoveTimes,
  type PlanChangeAsk,
} from '@hfos/core/addons/outreach/plan-changes';
import { LIVE_REFETCH_SECONDS } from '@hfos/core/addons/outreach/live';
import { PLATFORMS } from '@hfos/core/addons/outreach/playbooks';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ChangeError } from '@/changes';
import { Ellipsis } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { changePlan } from './actions';
import { NeedsSignal, Note, Part, useOutreachAnswer, useOutreachContext } from './kit';

const TONE_BADGE = { good: 'ok', waiting: 'pending', warn: 'danger', plain: 'gray' } as const;

/**
 * Today's Plan on the phone (docs/outreach.md, decision 195), as the web's: what the person's computer will do today
 * on the network shown and about when. Where the day stands in a line, what they asked for that goes first, what's
 * coming in order with rough times, and what it has done so far. HandsFreeOS works it out from where the extension
 * said its day is up to (packages/core/src/addons/outreach/plan.ts). A row that's coming and can be changed is a
 * button (step 3): it opens a sheet with **Do now**, **Skip today**, the times to move it to, and **Put back** when
 * it was put first or moved. What was skipped or moved is listed under the rows, each with Put back. Every press is
 * `outreach.plan.change`, with signal, and the plan is asked for again after it. Asked for again every minute while
 * it's open; it needs signal.
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
  return (
    <PlanBody
      plan={plan.data}
      many={many}
      onChange={
        ctx.online
          ? async (key, what, time) => {
              const { output } = await changePlan(ctx.workspaceId, platform, key, what, time);
              plan.reload();
              return output.words;
            }
          : undefined
      }
    />
  );
}

/** Sends a change to a row and gives what happened in a line (the answer's own words). */
export type PlanChanger = (key: string, what: PlanChangeAsk, time?: string) => Promise<string>;

export function PlanBody({
  plan,
  many,
  onChange,
}: {
  plan: PlanOutput;
  many: boolean;
  /** Left out, the rows only show: with no signal, nothing here can be pressed. */
  onChange?: PlanChanger | undefined;
}) {
  const tz = plan.timezone;
  const counts = planCountsLine(plan.counts);
  // An API a deploy behind the app says nothing of changes yet: the rows only show till it catches up.
  const changes = plan.changes ?? [];
  /** The row whose sheet is open, kept while the sheet slides away. */
  const [picked, setPicked] = React.useState<PlanRow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = async (key: string, what: PlanChangeAsk, time?: string) => {
    if (!onChange || busy !== null) return;
    setBusy(key);
    try {
      toast.show(await onChange(key, what, time));
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const canChange = (row: PlanRow) =>
    !!onChange && !!row.key && ((row.can ?? []).length > 0 || !!row.changed);
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
              plan.coming.map((row, i) => {
                const body = (
                  <>
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
                      {row.changed ? (
                        <View className="mt-1 flex-row">
                          <Badge variant="accent" testID="plan-row-changed">
                            <Text>{row.changed === 'now' ? U.first : U.moved}</Text>
                          </Badge>
                        </View>
                      ) : null}
                    </View>
                  </>
                );
                const rowKey = `${row.key ?? ''}:${row.at}:${i}`;
                return canChange(row) ? (
                  <Pressable
                    key={rowKey}
                    role="button"
                    accessibilityLabel={U.menu(rowWords(row))}
                    disabled={busy !== null}
                    onPress={() => {
                      setPicked(row);
                      setOpen(true);
                    }}
                    className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-control px-2 py-1 active:bg-card-2"
                    testID="plan-row"
                  >
                    {body}
                    <Icon as={Ellipsis} className="size-5 text-text-3" />
                  </Pressable>
                ) : (
                  <View key={rowKey} className="flex-row gap-3" testID="plan-row">
                    {body}
                  </View>
                );
              })
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

      {changes.length ? (
        <Part title={U.changed} testID="plan-changed">
          <Card className="gap-2 px-4 py-3.5">
            {changes.map((c) => (
              <View key={c.key} className="flex-row items-center gap-3" testID="plan-changed-row">
                <View className="min-w-0 flex-1">
                  <Text className="text-[14px] leading-[20px]">{c.title}</Text>
                  <Note>{c.change === 'at' && c.at ? U.movedTo(c.at, tz) : U.skipped}</Note>
                </View>
                {onChange ? (
                  <Button
                    size="md"
                    variant="secondary"
                    loading={busy === c.key}
                    disabled={busy !== null}
                    onPress={() => void run(c.key, 'back')}
                    testID="plan-put-back"
                  >
                    {U.back}
                  </Button>
                ) : null}
              </View>
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

      <PlanRowSheet
        row={picked}
        open={open}
        onClose={() => setOpen(false)}
        times={picked ? planMoveTimes(plan.now, tz, plan.until) : []}
        busy={busy !== null}
        onChange={(what, time) => {
          if (picked?.key) void run(picked.key, what, time);
        }}
      />
    </>
  );
}

/**
 * What a row can be told, in a sheet: Do now, Skip today, the times today it can be moved to (every half hour till
 * the day's plan ends), and Put back when a change of the person's is in force on it.
 */
function PlanRowSheet({
  row,
  open,
  onClose,
  times,
  busy,
  onChange,
}: {
  row: PlanRow | null;
  open: boolean;
  onClose: () => void;
  times: readonly { time: string; label: string }[];
  busy: boolean;
  onChange: (what: PlanChangeAsk, time?: string) => void;
}) {
  if (!row) return null;
  const can = row.can ?? [];
  return (
    <Sheet open={open} onClose={onClose} title={rowWords(row)} testID="plan-row-sheet">
      <View className="gap-2">
        {can.includes('now') && row.changed !== 'now' ? (
          <Button disabled={busy} onPress={() => onChange('now')} testID="plan-row-now">
            {PLAN_CHANGE_WORDS.now}
          </Button>
        ) : null}
        {can.includes('skip') ? (
          <Button
            variant="secondary"
            disabled={busy}
            onPress={() => onChange('skip')}
            testID="plan-row-skip"
          >
            {PLAN_CHANGE_WORDS.skip}
          </Button>
        ) : null}
        {row.changed ? (
          <Button
            variant="secondary"
            disabled={busy}
            onPress={() => onChange('back')}
            testID="plan-row-back"
          >
            {U.back}
          </Button>
        ) : null}
        {can.includes('at') ? (
          <View className="mt-1.5 gap-1.5" testID="plan-row-move">
            <Text className="text-[13.5px] font-medium">{PLAN_CHANGE_WORDS.at}</Text>
            {times.length ? (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerClassName="gap-1.5"
                >
                  {times.map((t) => (
                    <Pressable
                      key={t.time}
                      role="button"
                      disabled={busy}
                      onPress={() => onChange('at', t.time)}
                      className="h-11 items-center justify-center rounded-full border border-border-strong bg-card px-3.5 active:bg-card-2"
                      testID={`plan-row-at-${t.time}`}
                    >
                      <Text className="text-[14px] font-medium text-text-2">{t.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Note>{U.timeHint}</Note>
              </>
            ) : (
              <Note testID="plan-row-no-times">{U.noTimes}</Note>
            )}
          </View>
        ) : null}
        <Button variant="ghost" onPress={onClose}>
          {U.cancel}
        </Button>
      </View>
    </Sheet>
  );
}
