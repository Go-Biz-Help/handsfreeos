import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { PhoneCall } from '@/video-call/phone-call';

/**
 * A HandsFreeOS video call, as /app/w/<business>/call/<id> on the web (docs/video-calls.md, "On the phone"): Join on
 * an appointment, and the push about someone waiting in the call, open it. Full screen, over the tabs.
 */
export default function VideoCallScreen() {
  const { business } = useBusiness();
  const { callId } = useLocalSearchParams<{ callId: string }>();
  return <PhoneCall workspaceId={business.id} callId={callId} />;
}
