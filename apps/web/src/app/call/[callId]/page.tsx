import type { Metadata } from 'next';
import { LinkCall } from '@/components/video-call/link-call';
import { getMe } from '@/lib/api/server';
import { getServerSession } from '@/lib/supabase/server';

/** A HandsFreeOS video call's own link (docs/video-calls.md): never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Video call' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function VideoCallPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  // Signed in, they join as themselves; signed out, or an account that's gone, they ask to be let in.
  const session = await getServerSession();
  const me = session ? await getMe().catch(() => null) : null;
  const name = me ? me.user.fullName.trim() || me.user.email.split('@')[0]! : null;
  // What each of their businesses runs and lets them do: the coach beside the video, in the call's business.
  const businesses = (me?.workspaces ?? []).map((w) => ({
    id: w.id,
    addons: w.addons,
    permissions: w.permissions,
  }));
  return <LinkCall callId={callId} teammate={name ? { name, businesses } : null} />;
}
