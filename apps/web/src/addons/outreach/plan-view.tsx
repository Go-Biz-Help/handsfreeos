'use client';
/**
 * Today's Plan (docs/outreach.md, decision 195): what the person's computer will do today on the network shown, and
 * about when. Where the day stands in a line, what they asked for that goes first, what's coming in order with rough
 * times, and what it has done so far. HandsFreeOS works it out from where the extension said its day is up to, with
 * the rules the extension follows (packages/core/src/addons/outreach/plan.ts). A row that's coming can be told
 * something from its menu (step 3, ./plan-change.tsx): Do now, Skip today or Move to a time, and what was skipped or
 * moved is listed under the rows with Put back. It asks for the plan again every minute, when the computer, the day,
 * an ask or a change to the plan is heard, and at once after a press here, never the whole page (the owner's pick,
 * 23 Nov 2026).
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import {
  PLAN_STANDS,
  PLAN_WORDS,
  planCountsLine,
  planMoreWords,
  planTone,
  planWhen,
} from '@hfos/core/addons/outreach/plan';
import { PLAN_CHANGE_UI } from '@hfos/core/addons/outreach/plan-changes';
import { PLATFORMS } from '@hfos/core/addons/outreach/playbooks';
import { useCallback, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { useAskedAgain } from './live-view';
import { PlanMoveBox, PlanRowMenu, usePlanChange } from './plan-change';
import type { Plan } from './types';

const TONES: Record<ReturnType<typeof planTone>, BadgeVariant> = {
  good: 'ok',
  waiting: 'accent',
  warn: 'pending',
  plain: 'gray',
};

/**
 * What moves the plan: the computer's state and steps, a day pressed, an ask made or ended, the settings, and a row
 * changed (here, on the phone, or by the Assistant).
 */
const PLAN_MOVED_BY = [
  'outreach_computer',
  'outreach_day',
  'outreach_ask',
  'outreach_automation',
  'outreach_plan_change',
] as const;

export function PlanCard({
  workspaceId,
  platform,
  plan: first,
  many,
}: {
  workspaceId: string;
  platform: Platform;
  /** The plan the page came with. */
  plan: Plan;
  /** The person works more than one network: the heading names the one shown. */
  many: boolean;
}) {
  const heard = useLiveVersion(PLAN_MOVED_BY, 1500);
  // A press here asks for the plan again at once, without the wait a change heard is given.
  const [pressed, setPressed] = useState(0);
  const { busy, change } = usePlanChange(
    workspaceId,
    platform,
    useCallback(() => setPressed((n) => n + 1), []),
  );
  /** The row whose box for Move to a time is open, by its key. */
  const [moving, setMoving] = useState<string | null>(null);
  const asked = useAskedAgain(
    `${workspaceId}:${platform}`,
    () =>
      apiBrowser()
        .POST('/v1/queries/outreach.plan', { body: { workspaceId, platform } })
        .then((r) => r.data ?? null)
        .catch(() => null),
    heard + pressed,
  );
  // The newer of the page's own and the one asked for since.
  const plan = asked && Date.parse(asked.now) > Date.parse(first.now) ? asked : first;
  const tz = plan.timezone;
  const counts = planCountsLine(plan.counts);
  // An API a deploy behind the web says nothing of changes yet: the rows only show till it catches up.
  const changes = plan.changes ?? [];
  const movingRow = moving === null ? -1 : plan.coming.findIndex((row) => row.key === moving);
  return (
    <div className="max-w-3xl space-y-5" data-testid="today-plan" data-stand={plan.stand}>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            {many ? PLAN_WORDS.titleOn(PLATFORMS[platform]) : PLAN_WORDS.title}
          </h2>
          <Badge variant={TONES[planTone(plan.stand)]} data-testid="plan-stand">
            {PLAN_STANDS[plan.stand]}
          </Badge>
        </div>
        <p className="mt-0.5 text-[12.5px] text-text-3">{PLAN_WORDS.about}</p>
        <p className="mt-3 text-[13.5px]" data-testid="plan-line">
          {plan.line}
        </p>
        {plan.doing ? (
          <p className="mt-1 text-[13px] text-text-2" data-testid="plan-doing">
            {plan.doing}
          </p>
        ) : null}
      </Card>

      {plan.asked.length ? (
        <Card className="p-4" data-testid="plan-asked">
          <h3 className="text-[15px] font-semibold">{PLAN_WORDS.asked}</h3>
          <ul className="mt-3 space-y-2">
            {plan.asked.map((ask) => (
              <li key={ask.askId} className="flex gap-3 text-[13px]">
                <span className="w-[96px] flex-none text-text-3">
                  {ask.working ? PLAN_WORDS.askWorking : PLAN_WORDS.askWaiting}
                </span>
                <span className="min-w-0">{ask.title}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {plan.reported ? (
        <Card className="p-4" data-testid="plan-coming">
          <h3 className="text-[15px] font-semibold">{PLAN_WORDS.coming}</h3>
          {plan.coming.length ? (
            <>
              <p className="mt-0.5 text-[12.5px] text-text-3">{PLAN_WORDS.times}</p>
              <ol className="mt-3 space-y-2" data-testid="plan-rows">
                {plan.coming.map((row, i) => (
                  <li
                    key={`${row.key ?? ''}-${row.at}-${i}`}
                    className="text-[13px]"
                    data-testid="plan-row"
                    data-kind={row.kind}
                    data-changed={row.changed ?? undefined}
                    aria-current={row.now ? 'step' : undefined}
                  >
                    <div className="flex gap-3">
                      <span
                        className={cn(
                          'w-[96px] flex-none tabular-nums text-text-3',
                          row.now && 'font-medium text-success-text',
                        )}
                      >
                        {planWhen(row, tz)}
                      </span>
                      <span className="min-w-0 flex-1">
                        {row.title}
                        {row.who ? <span className="font-medium"> · {row.who}</span> : null}
                        {row.detail ? <span className="text-text-3"> · {row.detail}</span> : null}
                        {row.changed ? (
                          <Badge variant="accent" className="ml-2 align-middle">
                            {row.changed === 'now' ? PLAN_CHANGE_UI.first : PLAN_CHANGE_UI.moved}
                          </Badge>
                        ) : null}
                      </span>
                      <PlanRowMenu
                        row={row}
                        busy={busy !== null}
                        onChange={(what) => {
                          if (row.key) void change(row.key, what);
                        }}
                        onMove={() => setMoving(row.key)}
                      />
                    </div>
                    {row.key && i === movingRow ? (
                      <PlanMoveBox
                        now={plan.now}
                        timeZone={tz}
                        busy={busy === row.key}
                        onMove={async (time) => {
                          if (row.key && (await change(row.key, 'at', time))) setMoving(null);
                        }}
                        onCancel={() => setMoving(null)}
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
              {plan.more > 0 ? (
                <p className="mt-3 text-[13px] text-text-2" data-testid="plan-more">
                  {planMoreWords(plan.more, plan.until, tz)}
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-[13px] text-text-2" data-testid="plan-none">
              {PLAN_WORDS.nothingComing}
            </p>
          )}
          {plan.notes.length ? (
            <ul className="mt-3 space-y-1 border-t border-border pt-3 text-[12.5px] text-text-3">
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {changes.length ? (
        <Card className="p-4" data-testid="plan-changed">
          <h3 className="text-[15px] font-semibold">{PLAN_CHANGE_UI.changed}</h3>
          <ul className="mt-3 space-y-2">
            {changes.map((c) => (
              <li
                key={c.key}
                className="flex items-center gap-3 text-[13px]"
                data-testid="plan-changed-row"
              >
                <span className="min-w-0 flex-1">
                  {c.title}
                  <span className="text-text-3">
                    {' · '}
                    {c.change === 'at' && c.at
                      ? PLAN_CHANGE_UI.movedTo(c.at, tz)
                      : PLAN_CHANGE_UI.skipped}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === c.key}
                  disabled={busy !== null}
                  onClick={() => void change(c.key, 'back')}
                  data-testid="plan-put-back"
                >
                  {PLAN_CHANGE_UI.back}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {plan.done.length || counts ? (
        <Card className="p-4" data-testid="plan-done">
          <h3 className="text-[15px] font-semibold">{PLAN_WORDS.done}</h3>
          {counts ? <p className="mt-2 text-[13px]">{counts}</p> : null}
          {plan.done.length ? (
            <ul className="mt-3 space-y-2">
              {plan.done.map((job) => (
                <li key={job.title} className="text-[13px]">
                  <span className="font-medium">{job.title}</span>
                  {job.line ? <span className="text-text-2"> · {job.line}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
