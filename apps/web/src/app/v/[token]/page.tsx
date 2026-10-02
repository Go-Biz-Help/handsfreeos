import type { Metadata } from 'next';
import { VideoUploadPage } from '@/components/video-link/upload-page';

/** The link carries the key to send a video into someone's conversation: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Send a video' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function VideoLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VideoUploadPage token={token} />;
}
