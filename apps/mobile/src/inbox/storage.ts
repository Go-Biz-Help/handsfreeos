import { callRecordingFolder, recordingFileIn, TELEPHONY_BUCKET } from '@hfos/core';
import * as React from 'react';

import { supabase } from '@/lib/supabase';
import { useNetwork } from '@/lib/network';

/**
 * Photos in messages and calls' recordings, from Storage as the signed-in person, with signal (the phone's copy holds
 * where each is kept, not the file). Storage's own rules let a person read a business's files only while they can open
 * the business. Links last an hour and are kept that long, so scrolling a thread doesn't ask again.
 */

const LINK_SECONDS = 3600;
/** A link is used for a little less than it lasts. */
const KEEP_MS = (LINK_SECONDS - 300) * 1000;

const links = new Map<string, { url: string; until: number }>();

export async function signedUrl(bucket: string, path: string): Promise<string | null> {
  const key = `${bucket}/${path}`;
  const kept = links.get(key);
  if (kept && kept.until > Date.now()) return kept.url;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, LINK_SECONDS);
  if (error || !data?.signedUrl) return null;
  links.set(key, { url: data.signedUrl, until: Date.now() + KEEP_MS });
  return data.signedUrl;
}

/**
 * A call's recording: its folder is listed to find the file (a voicemail's or a whole call's, MP3 from the carrier,
 * WAV from the stand-in), then signed. Null when there's none, or the person can't read it.
 */
export async function recordingUrl(
  workspaceId: string,
  callId: string,
  voicemail: boolean,
): Promise<string | null> {
  const folder = callRecordingFolder(workspaceId, callId);
  const { data, error } = await supabase.storage.from(TELEPHONY_BUCKET).list(folder);
  if (error || !data) return null;
  const name = recordingFileIn(
    data.map((f) => f.name),
    voicemail,
  );
  return name ? signedUrl(TELEPHONY_BUCKET, `${folder}/${name}`) : null;
}

/** A stored file's link while there's signal (null until it's ready, and with no signal). */
export function useSignedUrl(bucket: string | null, path: string | null): string | null {
  const { online } = useNetwork();
  const [url, setUrl] = React.useState<string | null>(() => {
    if (!bucket || !path) return null;
    const kept = links.get(`${bucket}/${path}`);
    return kept && kept.until > Date.now() ? kept.url : null;
  });
  React.useEffect(() => {
    if (!bucket || !path || !online || url) return;
    let alive = true;
    void signedUrl(bucket, path)
      .then((next) => alive && setUrl(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bucket, path, online, url]);
  return url;
}
