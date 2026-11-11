import {
  fmtTime,
  jobFits,
  jobSteps,
  placeKindOf,
  JOB_STATUS_WORDS,
  type JobStatus,
  type JobStep,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { setJobStatus } from '@/calendar/actions';
import { useIndustry, useVisitJob } from '@/calendar/use-calendar';
import { useBusiness } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { hereOrNull } from '@/lib/location';

type Step = JobStep;
const LABELS: Readonly<Record<Step, string>> = {
  on_the_way: 'On my way',
  in_progress: 'Started',
  waiting_on_parts: 'Waiting on parts',
  done: 'Job done',
};

/**
 * M18: a visit's job on the phone. The tech moves it along — On my way (with where they are, for when the customer
 * should expect them), Started, Waiting on parts, Job done — and the customer gets a text for each.
 *
 * Only on visits the team goes to (at the customer's address, or no place set in a business whose team goes out),
 * and Waiting on parts only where work uses parts: core's `jobFits` and `jobSteps`, which the web follows too.
 */
export function VisitJob({
  appointmentId,
  location,
  timeZone,
}: {
  appointmentId: string;
  /** The visit's saved place, as the phone keeps it. */
  location: string | null;
  timeZone: string;
}) {
  const { business } = useBusiness();
  const job = useVisitJob(appointmentId);
  const industry = useIndustry();
  const [working, setWorking] = React.useState<Step | null>(null);
  const status = (job?.status ?? 'scheduled') as JobStatus;
  if (!jobFits({ locationKind: placeKindOf(location), industry, status })) return null;
  const steps = jobSteps({ industry, status });

  async function tap(step: Step) {
    setWorking(step);
    try {
      const origin = step === 'on_the_way' ? await hereOrNull() : null;
      await setJobStatus({ workspaceId: business.id, appointmentId, status: step, origin });
      toast.show(
        step === 'on_the_way'
          ? origin
            ? 'On your way. The customer gets a text with when you’ll get there.'
            : 'On your way. The customer gets a text (no arrival time without your location).'
          : `${JOB_STATUS_WORDS[step]}. The customer gets a text.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That didn’t go through.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <Card className="px-3.5 py-3" testID="visit-job">
      <View className="mb-1 flex-row items-center justify-between">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          Job
        </Text>
        <Badge>
          {JOB_STATUS_WORDS[status]}
          {job?.pending ? ' · waiting for signal' : ''}
        </Badge>
      </View>
      {status === 'on_the_way' && job?.etaAt ? (
        <Text className="pb-1 text-[13px] text-text-2">
          The customer expects you around {fmtTime(job.etaAt, timeZone)}.
        </Text>
      ) : null}
      {job?.customerNote ? (
        <Text className="pb-1 text-[13px] text-text-2">
          Note for the customer: {job.customerNote}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2 pt-1">
        {steps
          .filter((s) => s !== status)
          .map((s) => (
            <Button
              key={s}
              size="md"
              variant={s === nextOf(status) ? 'primary' : 'secondary'}
              loading={working === s}
              disabled={!!working}
              onPress={() => void tap(s)}
              testID={`job-${s}`}
            >
              {LABELS[s]}
            </Button>
          ))}
      </View>
    </Card>
  );
}

/** The usual next step, shown as the main button. */
function nextOf(status: JobStatus): Step | null {
  switch (status) {
    case 'scheduled':
      return 'on_the_way';
    case 'on_the_way':
      return 'in_progress';
    case 'in_progress':
    case 'waiting_on_parts':
      return 'done';
    default:
      return null;
  }
}
