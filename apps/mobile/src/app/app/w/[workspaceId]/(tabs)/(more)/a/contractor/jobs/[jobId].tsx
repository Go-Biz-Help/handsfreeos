import { useLocalSearchParams } from 'expo-router';

import { JobScreen } from '@/addons/contractor/job';

/** A job: where it stands, its phases, visits, materials, time and notes from the field. */
export default function ContractorJobRoute() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  return <JobScreen jobId={jobId} />;
}
