import { useLocalSearchParams } from 'expo-router';

import { JobsScreen } from '@/addons/contractor/jobs';

/** Jobs: the person's visits today and the business's jobs, with the web's `?filter=` and `?q=`. */
export default function ContractorJobsRoute() {
  const { filter, q } = useLocalSearchParams<{ filter?: string; q?: string }>();
  return <JobsScreen filter={filter} q={q} />;
}
