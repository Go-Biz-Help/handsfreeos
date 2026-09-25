'use client';
import type { ActivityPeriod, TeammateActivity, TeammateGet } from '@/lib/ai-team/types';
import { TeammateActivityView } from './activity';
import { TeammateTabShell } from './tab-shell';

const NO_ACTIVITY: TeammateActivity = {
  counters: {
    runsToday: 0,
    repliedToday: 0,
    draftedToday: 0,
    handedOffToday: 0,
    failedToday: 0,
    bookedToday: 0,
    pendingDrafts: 0,
    needsPerson: 0,
    handledByAi: 0,
  },
  runs: [],
  nextCursor: null,
};

/** The Activity tab: the teammate's header and History, then its runs. */
export function TeammateActivityTab({
  workspaceId,
  data,
  period,
  activity,
}: {
  workspaceId: string;
  data: TeammateGet;
  /** The runs' period, from the page's address. */
  period: ActivityPeriod;
  activity: TeammateActivity | null;
}) {
  return (
    <TeammateTabShell
      workspaceId={workspaceId}
      data={data}
      emptyBody="Its replies, hand-offs and bookings show here once it’s working."
      testId="teammate-activity-tab"
    >
      {data.teammate ? (
        <TeammateActivityView
          workspaceId={workspaceId}
          name={data.teammate.name}
          timeZone={data.catalogs.timeZone}
          period={period}
          usage={data.catalogs.aiUsage}
          initial={activity ?? NO_ACTIVITY}
        />
      ) : null}
    </TeammateTabShell>
  );
}
