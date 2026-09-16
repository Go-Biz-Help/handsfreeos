/** The scenarios play phones against the real service: say how to start it rather than time out one by one. */
import { SYNC_URL } from './harness/sync-url';

export default async function assertServiceRunning(): Promise<void> {
  const ready = await fetch(`${SYNC_URL}/probes/liveness`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!ready)
    throw new Error(
      `PowerSync isn't answering at ${SYNC_URL}. Start it (and the local Supabase stack) first: pnpm sync:start`,
    );
}
