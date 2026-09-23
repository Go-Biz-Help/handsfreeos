import { fmtTime, JOB_STATUS_WORDS, type JobStatus } from '@hfos/core';
import * as Location from 'expo-location';
import * as React from 'react';
import { View } from 'react-native';

import { setJobStatus } from '@/calendar/actions';
import { useVisitJob } from '@/calendar/use-calendar';
import { useBusiness } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';

type Step = 'on_the_way' | 'in_progress' | 'waiting_on_parts' | 'done';
const STEPS: readonly { status: Step; label: string }[] = [
  { status: 'on_the_way', label: 'On my way' },
  { status: 'in_progress', label: 'Started' },
  { status: 'waiting_on_parts', label: 'Waiting on parts' },
  { status: 'done', label: 'Job done' },
];

/**
 * Where the phone is, for On my way's arrival time: asked for the first time it's tapped, one quick reading, and
 * nothing when the tech says no or it takes too long — On my way still goes, without a time.
 */
async function hereOrNull(): Promise<{ lat: number; lng: number } | null> {
  try {
    const asked = await Location.requestForegroundPermissionsAsync();
    if (!asked.granted) return null;
    const got = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    return got ? { lat: got.coords.latitude, lng: got.coords.longitude } : null;
  } catch {
    return null;
  }
}

/**
 * M18: a visit's job on the phone. The tech moves it along — On my way (with where they are, for when the customer
 * should expect them), Started, Waiting on parts, Job done — and the customer gets a text for each.
 */
export function VisitJob({ appointmentId, timeZone }: { appointmentId: string; timeZone: string }) {
  const { business } = useBusiness();
  const job = useVisitJob(appointmentId);
  const [working, setWorking] = React.useState<Step | null>(null);
  const status = (job?.status ?? 'scheduled') as JobStatus;

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
        {STEPS.filter((s) => s.status !== status).map((s) => (
          <Button
            key={s.status}
            size="md"
            variant={s.status === nextOf(status) ? 'primary' : 'secondary'}
            loading={working === s.status}
            disabled={!!working}
            onPress={() => void tap(s.status)}
            testID={`job-${s.status}`}
          >
            {s.label}
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
