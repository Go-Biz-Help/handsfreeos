import { redirect } from 'next/navigation';

/**
 * A HandsFreeOS video call under its business (`videoCallAppPath`, docs/video-calls.md): where the push about someone
 * waiting points, so the phone opens its own call screen. On the web it goes on to the call's own link.
 */
export default async function BusinessVideoCallPage({
  params,
}: {
  params: Promise<{ workspaceId: string; callId: string }>;
}) {
  const { callId } = await params;
  redirect(`/call/${encodeURIComponent(callId)}`);
}
